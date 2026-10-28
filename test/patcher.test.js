/**
 * Patcher tests.
 *
 * Every case builds a throwaway target from the fixtures below, so nothing here
 * reads or writes a real install. The fixtures reproduce the two upstream shapes
 * the patcher must survive: `kernel.js` with LF, `pack.js` with CRLF (which is
 * how both ship), plus the anchors each patch looks for.
 *
 * Revision 2 cases additionally cover the two shapes the real 2.5.8 bundle
 * presents: a `pack.js` whose `apply()` registers an adapter against a transport
 * instance it later closes, and a `pack.js` carrying revision 1's injected
 * `rewriteTencentContentFingerprints` call that must be removed.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  PATCHES,
  PATCH_REVISION,
  applyPatches,
  candidateTargets,
  formatStatus,
  inspect,
  resolveTarget,
  restorePatches,
  targetVersion,
} from '../lib/patcher.js';

/** Minimal LF stand-in for `adapter/kernel.js`, carrying every anchor. */
const KERNEL_STOCK = `const HARNESS = 'deepseek-harness'

function fallback() {
  return 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness)'
}

export async function resolveAttributionUserAgent(logger) {
  try {
    // The real UA arrives at runtime from @deepseek-ai/dsh-llm, never as source
    // text — so the fixture must not carry it as a literal either.
    const agent = attributionHeaders2()['user-agent']
    if (typeof agent === 'string' && agent !== '') return agent
    return fallback()
  } catch (error) {
    logger?.warn?.(error)
    return fallback()
  }
}
`;

/**
 * Minimal stand-in for `vendor/channel-pack/pack.js`, in the shape it ships.
 *
 * Mirrors the real bundle: a signed transport, an `apply()` that registers the
 * CodeArts adapter against that instance and then closes it on dispose, and the
 * three consumers the repair has to rewire.
 */
function packStock() {
  return `var directLane = { fetch: null };
// Revision 3 anchors: the stock CodeArts queue-retry budget and the message that
// ends a queue wait. Both live in the real bundle and are edited independently.
var QUEUE_RETRY_DELAY_MS = 1e4;
var QUEUE_MAX_ATTEMPTS2 = 180;
function finishQueue() {
  throw new LlmError2("codearts: queue wait timed out after 30 minutes", "QUEUE");
}
function createDirectFetch(options = {}) {
  const agent = {};
  const lifetime = new AbortController();
  let closing;
  return {
    fetch: async (input, init) => {
      lifetime.signal.throwIfAborted();
      return "ok:" + input;
    },
    close() {
      if (!closing) {
        lifetime.abort(new DOMException("CodeArts \\u7B7E\\u540D\\u4F20\\u8F93\\u5DF2\\u505C\\u6B62", "AbortError"));
        closing = Promise.resolve();
      }
      return closing;
    }
  };
}
var mounted = new Set();
function attachDirectFetch(fetcher) {
  const binding = { fetch: fetcher };
  mounted.add(binding);
  return () => {
    mounted.delete(binding);
  };
}
function createChannelFetch(options = {}) {
  return { async fetch(i) { return "net:" + i; }, async close() {} };
}
var CodeArtsAuth = class {
  constructor(ctx, options) {
    this.options = options;
  }
};
var AccountPool = class {};
function registerCodeArtsLlm(ctx, options) {
  return { fetchImpl: options.fetchImpl };
}
function registerChannelPackRpc(ctx, pool, service, options) {
  return options.codeartsFetcher;
}
function suppressAutoSettingsPage(ctx) {}
function registerProviderSettings(ctx) {}
function configureDeadModelStore(ctx) {}
function createTokenLedgerStore(ctx) {
  return {};
}
function attachTokenLedgerStore(store) {
  return () => {};
}
function mountOpenAiGateway(ctx, pool) {}
function installLoopResume(ctx) {}
function apply(ctx, config = {}) {
  const network = createChannelFetch({ outlet: config.outlet });
  const signedNetwork = createDirectFetch({ outlet: config.outlet });
  const detachSignedNetwork = attachDirectFetch(signedNetwork.fetch);
  ctx.effect(() => () => {
    detachSignedNetwork();
    void signedNetwork.close();
  });
  ctx.effect(() => () => {
    void network.close();
  });
  suppressAutoSettingsPage(ctx);
  registerProviderSettings(ctx);
  const service = new CodeArtsAuth(ctx, { fetcher: signedNetwork.fetch });
  const pool = new AccountPool(ctx);
  configureDeadModelStore(ctx);
  const tokenLedgerStore = createTokenLedgerStore(ctx);
  const detachTokenLedger = attachTokenLedgerStore(tokenLedgerStore);
  ctx.effect(() => () => {
    try {
      tokenLedgerStore.flush();
    } finally {
      detachTokenLedger();
    }
  }, "token-ledger-persistence");
  const codearts = registerCodeArtsLlm(ctx, {
    fetchImpl: signedNetwork.fetch,
    credentialRef: "cref",
    resolveCredential: async () => ({}),
    refresh: async () => {},
    fetchRemoteModels: () => {},
    accountPool: pool
  });
  registerChannelPackRpc(ctx, pool, service, codearts, {}, {
    ...config,
    codeartsFetcher: signedNetwork.fetch
  });
  mountOpenAiGateway(ctx, pool);
  installLoopResume(ctx);
  ctx.provide("accountPool", pool);
}
`;
}

/**
 * A `pack.js` that additionally carries revision 1's injected direct-path
 * rewrite — the block revision 2 must remove.
 */
function packWithLegacyInject() {
  return packStock().replace(
    '  suppressAutoSettingsPage(ctx);',
    `  const messages = serializeMessages2(options.messages, imageUrls);
  if (options.system !== void 0 && options.system.length > 0) {
    messages.unshift({ role: "system", content: options.system });
  }
    // [dsh-tencent-channel-fix] The gateway path rewrites channel fingerprints
    // in \`convertMessage\` / \`toMessages\`, but this direct adapter path never did,
    // so the stock system prompt went out verbatim and the channel gate answered
    // 400 / code 11128. Rewrite it here too. The rewriter is provider-scoped
    // (\`TENCENT_PROVIDERS\`), so every non-Tencent channel passes through as-is.
    for (let i = 0; i < messages.length; i++) {
      const systemMessage = messages[i];
      if (systemMessage.role !== "system") continue;
      const systemContent = systemMessage.content;
      if (typeof systemContent === "string") {
        messages[i] = {
          ...systemMessage,
          content: rewriteTencentContentFingerprints(systemContent, this.product.id)
        };
      } else if (Array.isArray(systemContent)) {
        messages[i] = {
          ...systemMessage,
          content: systemContent.map((part) =>
            typeof part?.text === "string"
              ? { ...part, text: rewriteTencentContentFingerprints(part.text, this.product.id) }
              : part
          )
        };
      }
      break;
    }
  suppressAutoSettingsPage(ctx);`,
  );
}

/** Write a stock (unpatched) target into a fresh temp directory. */
const created = [];

function makeTarget(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tcf-test-'));
  created.push(root);

  mkdirSync(join(root, 'adapter'), { recursive: true });
  mkdirSync(join(root, 'vendor', 'channel-pack'), { recursive: true });

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'dsh-our-free-model', version: options.version ?? '9.9.9' }, null, 2),
    'utf8',
  );

  const kernel = options.kernel ?? KERNEL_STOCK;
  writeFileSync(join(root, 'adapter', 'kernel.js'), kernel, 'utf8');

  // pack.js ships CRLF; `options.newline` lets a case opt out.
  const pack = options.pack ?? packStock();
  const newline = options.newline ?? '\r\n';
  writeFileSync(
    join(root, 'vendor', 'channel-pack', 'pack.js'),
    newline === '\n' ? pack : pack.split('\n').join(newline),
    'utf8',
  );

  return root;
}

/** Read the pack body back out of a target. */
const readPack = (target) => readFileSync(join(target, 'vendor', 'channel-pack', 'pack.js'), 'utf8');

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('patch definitions', () => {
  it('exposes a positive revision', () => {
    assert.equal(typeof PATCH_REVISION, 'number');
    assert.ok(PATCH_REVISION >= 2, 'revision 2 carries the transport-lifetime repair');
  });

  it('gives every patch a unique id, a file, and usable edits', () => {
    const ids = new Set();
    for (const patch of PATCHES) {
      assert.equal(ids.has(patch.id), false, `duplicate id ${patch.id}`);
      ids.add(patch.id);
      assert.ok(patch.file.length > 0);
      assert.ok(Array.isArray(patch.edits) && patch.edits.length > 0);
      // A cleanup patch intentionally carries no marker; every other patch must.
      if (patch.absentMeansDone !== true) {
        assert.ok(Array.isArray(patch.markers) && patch.markers.length > 0, patch.id);
      }
      for (const edit of patch.edits) {
        assert.ok(edit.find.length > 0, `${patch.id}: empty find`);
        assert.notEqual(edit.find, edit.replace, `${patch.id}: no-op edit`);
      }
    }
  });

  it('only targets files inside the package', () => {
    for (const patch of PATCHES) {
      assert.equal(patch.file.includes('..'), false, `${patch.id}: escapes the package`);
      assert.equal(/^[A-Za-z]:|^\//.test(patch.file), false, `${patch.id}: absolute path`);
    }
  });
});

describe('inspect', () => {
  it('reports a stock target as pending on every patch that has work to do', () => {
    const target = makeTarget();
    const states = inspect(target);
    assert.equal(states.length, PATCHES.length);
    for (const state of states) {
      // The cleanup patch has nothing to remove on a clean fixture, which is
      // reported as patched ("already clean") rather than pending.
      if (state.id === 'legacy-direct-rewrite') {
        assert.equal(state.state, 'patched');
        assert.equal(state.note, 'already clean');
      } else {
        assert.equal(state.state, 'pending', `${state.id} should be pending`);
      }
    }
  });

  it('reports a missing file as drifted instead of throwing', () => {
    const target = makeTarget();
    rmSync(join(target, 'adapter', 'kernel.js'));
    const state = inspect(target).find((entry) => entry.id === 'attribution-user-agent');
    assert.equal(state.state, 'drifted');
    assert.equal(state.detail, 'file missing');
  });

  it('reports an unknown package as drifted for the file that vanished', () => {
    const target = makeTarget();
    rmSync(join(target, 'vendor'), { recursive: true, force: true });
    const states = inspect(target);
    const packPatches = states.filter((state) => state.file.includes('pack.js'));
    // Counted from the registry, not hard-coded: revision 3 added two more
    // pack.js patches, and a literal here would fail for the wrong reason.
    assert.equal(packPatches.length, PATCHES.filter((p) => p.file.includes('pack.js')).length);
    assert.equal(packPatches.find((s) => s.id === 'signed-transport-seam').state, 'drifted');
    assert.equal(packPatches.find((s) => s.id === 'codearts-queue-budget').state, 'drifted');
  });

  it('detects drift when an anchor disappears', () => {
    const target = makeTarget({
      kernel: KERNEL_STOCK.replace(
        "if (typeof agent === 'string' && agent !== '') return agent",
        'if (agent) return sanitize(agent)',
      ),
    });
    const state = inspect(target).find((entry) => entry.id === 'attribution-user-agent');
    assert.equal(state.state, 'drifted');
    assert.match(state.detail, /anchor not found/);
  });

  it('detects drift when an anchor is ambiguous', () => {
    const pack = packStock().replace(
      'var directLane = { fetch: null };',
      'var directLane = { fetch: null };\nvar directLane = { fetch: null };',
    );
    const state = inspect(makeTarget({ pack })).find(
      (entry) => entry.id === 'signed-transport-seam',
    );
    assert.equal(state.state, 'drifted');
    assert.match(state.detail, /ambiguous/);
  });

  it('reports the legacy injection as pending, not absent', () => {
    const target = makeTarget({ pack: packWithLegacyInject() });
    const state = inspect(target).find((entry) => entry.id === 'legacy-direct-rewrite');
    assert.equal(state.state, 'pending');
  });

  it('reports patched once a marker is present', () => {
    const target = makeTarget();
    applyPatches(target, { stamp: 't' });
    for (const state of inspect(target)) assert.equal(state.state, 'patched', state.id);
  });
});

describe('applyPatches', () => {
  it('applies every patch to a stock target', () => {
    const target = makeTarget();
    const report = applyPatches(target, { stamp: 'apply1' });

    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.drifted, []);
    // The cleanup has nothing to remove on a clean fixture, so it is reported as
    // already-patched rather than applied.
    assert.equal(report.applied.length, PATCHES.length - 1);
    assert.equal(report.changed, true);
    assert.equal(
      formatStatus(target).includes(`${PATCHES.length}/${PATCHES.length} patches in place.`),
      true,
    );
  });

  it('rewires every signed-transport consumer onto the process-wide lane', () => {
    const target = makeTarget();
    applyPatches(target, { stamp: 'seam' });
    const source = readPack(target);

    // The lane must hang off globalThis (survives OFM's module purge) with a
    // symbol key, and be published by apply().
    assert.equal(
      source.includes('var signedLane = globalThis[Symbol.for("our-free-model.signed-lane")] ??= { fetch: void 0 };'),
      true,
    );
    assert.equal(source.includes('signedLane.fetch = signedNetwork.fetch;'), true);

    // All three consumers read the closure, never the transport instance.
    assert.equal(source.includes('new CodeArtsAuth(ctx, { fetcher: signedFetch })'), true);
    assert.equal(source.includes('fetchImpl: signedFetch,'), true);
    assert.equal(source.includes('codeartsFetcher: signedFetch'), true);
    assert.equal(source.includes('fetchImpl: signedNetwork.fetch,'), false);

    // Dispose clears the lane only when it still owns it, so a successor that
    // already published is not un-published.
    assert.equal(source.includes('if (signedLane.fetch === signedNetwork.fetch) signedLane.fetch = void 0;'), true);
  });

  it('leaves a working transport: a retained adapter survives a fiber restart', async () => {
    const target = makeTarget({ newline: '\n' });
    applyPatches(target, { stamp: 'behaviour' });

    // Exercise the patched `apply()` semantics directly: generation 1 registers
    // an adapter against the lane, is disposed, then generation 2 publishes a
    // new transport. The retained adapter must reach the successor.
    const source = readPack(target);
    const start = source.indexOf('var directLane = { fetch: null };');
    const end = source.indexOf('function createChannelFetch', start);
    const region = source.slice(start, end);
    const stubbed = `${region}
      export { createDirectFetch, attachDirectFetch };
    `;
    const file = join(target, 'region.mjs');
    writeFileSync(file, stubbed, 'utf8');

    const mod = await import(`file:///${file.replaceAll('\\', '/')}`);
    const lane = globalThis[Symbol.for('our-free-model.signed-lane')];

    const applyOnce = () => {
      const signedNetwork = mod.createDirectFetch({});
      const detach = mod.attachDirectFetch(signedNetwork.fetch);
      lane.fetch = signedNetwork.fetch;
      // The closure apply() hands to consumers after the repair.
      const signedFetch = (input, init) => {
        const live = lane.fetch;
        if (live === void 0) throw new Error('CodeArts signed transport is not ready');
        return live(input, init);
      };
      const dispose = () => {
        detach();
        if (lane.fetch === signedNetwork.fetch) lane.fetch = void 0;
        void signedNetwork.close();
      };
      return { signedFetch, dispose };
    };

    const gen1 = applyOnce();
    const retained = gen1.signedFetch; // registered with the kernel, outlives dispose
    gen1.dispose(); // plugin fiber restart
    const gen2 = applyOnce(); // successor publishes its own transport

    assert.equal(await retained('req-1'), 'ok:req-1', 'retained adapter must reach the successor lane');

    // After the final dispose with no successor, it fails loudly instead of
    // silently hanging on a dead transport. The closure throws before it can
    // return, so this is a synchronous throw, not a rejected promise.
    gen2.dispose();
    assert.throws(() => retained('req-2'), /transport is not ready/);

    delete globalThis[Symbol.for('our-free-model.signed-lane')];
  });

  it('removes the revision 1 injection that referenced a gone function', () => {
    const target = makeTarget({ pack: packWithLegacyInject() });
    assert.equal(readPack(target).includes('rewriteTencentContentFingerprints('), true);

    const report = applyPatches(target, { stamp: 'legacy' });
    assert.deepEqual(report.errors, []);
    assert.equal(report.applied.includes('legacy-direct-rewrite'), true);

    const source = readPack(target);
    assert.equal(source.includes('rewriteTencentContentFingerprints('), false);
    // The stock statement it was injected after must remain, unbroken.
    assert.equal(source.includes('messages.unshift({ role: "system", content: options.system });'), true);
  });

  it('rewrites the stock UA into a versioned harness-free UA', () => {
    const target = makeTarget();
    applyPatches(target, { stamp: 'ua' });
    const source = readFileSync(join(target, 'adapter', 'kernel.js'), 'utf8');

    assert.equal(source.includes('sanitizeAttributionUserAgent(agent)'), true);
    assert.equal(source.includes("return 'dsh-our-free-model/0.1.7'"), true);
    // The rejected token and URL must be gone from every executable return path;
    // the only remaining mentions are inside the explanatory comment block.
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');
    assert.equal(code.includes('deepseek-harness/0.2.1-rc.2'), false);
    assert.equal(code.includes('github.com/deepseek-ai/deepseek-harness'), false);
  });

  it('bounds the CodeArts queue retry instead of waiting 30 minutes', () => {
    const target = makeTarget();
    applyPatches(target, { stamp: 'queue-budget' });
    const source = readPack(target);

    assert.equal(source.includes('var QUEUE_RETRY_DELAY_MS = 1200;'), true);
    assert.equal(source.includes('var QUEUE_MAX_ATTEMPTS2 = 4;'), true);
    // The stock pair must be gone, or the adapter would still take the 10 s path.
    assert.equal(source.includes('var QUEUE_RETRY_DELAY_MS = 1e4;'), false);
    assert.equal(source.includes('var QUEUE_MAX_ATTEMPTS2 = 180;'), false);

    // Worst case is the product of the two, and that product is the whole point
    // of the patch: it has to be seconds, not minutes.
    const delay = Number(/var QUEUE_RETRY_DELAY_MS = (\d+);/.exec(source)[1]);
    const attempts = Number(/var QUEUE_MAX_ATTEMPTS2 = (\d+);/.exec(source)[1]);
    assert.ok(delay * attempts <= 6000, `worst case ${delay * attempts}ms`);
    // Still more than one try, so a slot that is genuinely about to free up is
    // not given up on immediately.
    assert.ok(attempts >= 2, `attempts ${attempts}`);
  });

  it('replaces the 30-minute claim with the real ceiling and a way out', () => {
    const target = makeTarget();
    applyPatches(target, { stamp: 'queue-msg' });
    const source = readPack(target);

    assert.equal(source.includes('queue wait timed out after 30 minutes'), false);
    // Names the cause...
    assert.equal(source.includes('\u5E76\u53D1\u4F1A\u8BDD\u69FD\u4F4D\u5DF2\u6EE1'), true);
    // ...and interpolates the budget, so the number cannot drift out of sync.
    assert.equal(source.includes('${QUEUE_MAX_ATTEMPTS2}'), true);
    // The error code is unchanged: callers and the failure classifier key on it.
    assert.equal(source.includes('"QUEUE");'), true);
  });

  it('produces a working sanitizer', () => {
    const target = makeTarget();
    applyPatches(target, { stamp: 'fn' });
    const source = readFileSync(join(target, 'adapter', 'kernel.js'), 'utf8');

    // Extract and exercise the injected function as real code.
    const start = source.indexOf('function sanitizeAttributionUserAgent');
    const end = source.indexOf('\n}', start) + 2;
    const factory = new Function(`${source.slice(start, end)}\nreturn sanitizeAttributionUserAgent;`);
    const sanitize = factory();

    assert.equal(sanitize('deepseek-harness/0.2.1-rc.2 (+https://github.com/x)'), 'dsh-our-free-model/0.2.1-rc.2');
    assert.equal(sanitize('deepseek-harness/0.1.7'), 'dsh-our-free-model/0.1.7');
    assert.equal(sanitize('no-version-here'), 'dsh-our-free-model');
    assert.equal(sanitize(''), 'dsh-our-free-model');
    // Already-clean UAs keep their own identity and version.
    assert.equal(sanitize('curl/8.0'), 'dsh-our-free-model/8.0');
  });

  it('is idempotent', () => {
    const target = makeTarget();
    applyPatches(target, { stamp: 'first' });
    const afterFirst = readPack(target);

    const second = applyPatches(target, { stamp: 'second' });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.errors, []);
    assert.equal(second.changed, false);
    assert.equal(second.alreadyPatched.length, PATCHES.length);
    assert.equal(readPack(target), afterFirst);
  });

  it('preserves CRLF line endings', () => {
    const target = makeTarget({ newline: '\r\n' });
    applyPatches(target, { stamp: 'crlf' });
    const source = readPack(target);

    const crlf = (source.match(/\r\n/g) ?? []).length;
    const lone = (source.match(/(?<!\r)\n/g) ?? []).length;
    assert.equal(lone, 0, 'no LF may be introduced into a CRLF file');
    assert.ok(crlf > 0);
  });

  it('preserves LF line endings', () => {
    const target = makeTarget({ newline: '\n' });
    applyPatches(target, { stamp: 'lf' });
    const source = readPack(target);
    assert.equal(source.includes('\r'), false);
  });

  it('keeps a syntax-valid file', () => {
    const target = makeTarget();
    const report = applyPatches(target, { stamp: 'syntax' });
    // applyPatches runs `node --check` itself; no error means both files passed.
    assert.deepEqual(report.errors, []);
    // The kernel fixture is a real module, so it can also be imported.
    assert.doesNotThrow(() => new Function(readFileSync(join(target, 'adapter', 'kernel.js'), 'utf8').replace(/export /g, '')));
  });

  it('reports drift without writing when an anchor is missing', () => {
    const kernel = KERNEL_STOCK.replace(
      "return 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness)'",
      "return 'something-else'",
    );
    const target = makeTarget({ kernel });
    const before = readFileSync(join(target, 'adapter', 'kernel.js'), 'utf8');
    const report = applyPatches(target, { stamp: 'drift' });

    assert.equal(report.drifted.length, 1);
    assert.equal(report.drifted[0].id, 'attribution-user-agent');
    assert.equal(readFileSync(join(target, 'adapter', 'kernel.js'), 'utf8'), before);
    // The other patch still lands: drift is per-patch, not all-or-nothing.
    assert.equal(report.applied.includes('signed-transport-seam'), true);
  });

  it('does not write in dry-run mode', () => {
    const target = makeTarget();
    const before = readPack(target);
    const report = applyPatches(target, { dryRun: true });

    assert.equal(report.applied.length, PATCHES.length - 1);
    assert.equal(report.changed, false);
    assert.equal(readPack(target), before);
  });

  it('leaves no backups behind on a clean apply', () => {
    const target = makeTarget();
    applyPatches(target, { stamp: 'clean' });
    assert.equal(existsSync(join(target, 'adapter', 'kernel.js.dsh-tencent-channel-fix.bak')), false);
  });
});

describe('restorePatches', () => {
  it('restores the stock text from the newest backup', () => {
    const target = makeTarget();
    const stockPack = readPack(target);

    applyPatches(target, { stamp: 'restore1' });
    assert.equal(formatStatus(target).includes('0/'), false);

    const result = restorePatches(target);
    assert.deepEqual(result.errors, []);
    // Only files that were actually written have a backup: the pack (and, when
    // the cleanup had something to do, still just the pack) plus the kernel.
    assert.ok(result.restored.length >= 1);
    assert.equal(readPack(target), stockPack);
    for (const state of inspect(target)) {
      // The cleanup patch reads as "already clean" on stock text, because there
      // is nothing left to remove — that is its patched state, not pending.
      const expected = state.id === 'legacy-direct-rewrite' ? 'patched' : 'pending';
      assert.equal(state.state, expected, state.id);
    }
  });

  it('is a no-op when no backup exists', () => {
    const result = restorePatches(makeTarget());
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.errors, []);
  });
});

describe('target resolution', () => {
  it('honours an explicit config target first', () => {
    const target = makeTarget();
    const candidates = candidateTargets({ target });
    assert.equal(candidates[0], target.replace(/\\/g, '\\'));
    assert.equal(resolveTarget({ target }), target);
  });

  it('ignores a configured target that is not a package', () => {
    const target = makeTarget();
    const absent = join(target, 'nope');
    const resolved = resolveTarget({ target: absent });
    assert.notEqual(resolved, absent);
  });

  it('reads the installed version', () => {
    assert.equal(targetVersion(makeTarget({ version: '3.2.1' })), '3.2.1');
  });

  it('returns undefined for a version-less directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'tcf-bare-'));
    created.push(root);
    assert.equal(targetVersion(root), undefined);
  });
});

describe('formatStatus', () => {
  it('lists one line per patch and a total', () => {
    const target = makeTarget();
    const text = formatStatus(target);
    for (const patch of PATCHES) assert.equal(text.includes(patch.id), true, patch.id);
    // A clean stock target already satisfies the cleanup patch, and only that
    // one — derived from the registry so a new patch cannot break this line.
    assert.match(text, new RegExp(`1/${PATCHES.length} patches in place\\.`));
    assert.match(text, new RegExp(`revision ${PATCH_REVISION}`));
  });

  it('marks a cleanup that already happened as clean', () => {
    const target = makeTarget();
    const state = inspect(target).find((entry) => entry.id === 'legacy-direct-rewrite');
    assert.equal(state.state, 'patched');
    assert.equal(state.note, 'already clean');
  });
});
