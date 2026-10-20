/**
 * Patcher tests.
 *
 * Every case builds a throwaway target from the fixtures below, so nothing here
 * reads or writes a real install. The fixtures reproduce the two upstream shapes
 * the patcher must survive: `kernel.js` with LF, `pack.js` with CRLF (which is
 * how both ship), plus the anchors each patch looks for.
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

/** Minimal stand-in for `vendor/channel-pack/pack.js`, in the shape it ships. */
function packStock() {
  return `var TENCENT_PROVIDERS = ["buddy", "workbuddy"];
var CONTENT_FINGERPRINTS = [
  {
    find: "Main branch (you will usually use this for PRs)",
    replace: "Main branch (PRs usually go here)",
    note: "stock"
  }
];
function escapeRegExp(value) {
  return value.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
}
var COMPILED = CONTENT_FINGERPRINTS.map((rule) => ({
  pattern: new RegExp(escapeRegExp(rule.find), "gi"),
  replace: rule.replace
}));
function isTencentContentFingerprintProvider(provider) {
  return TENCENT_PROVIDERS.includes(provider);
}
function rewriteTencentContentFingerprints(text, provider) {
  if (!isTencentContentFingerprintProvider(provider)) return text;
  let out = text;
  for (const rule of COMPILED) out = out.replace(rule.pattern, rule.replace);
  return out;
}
var BuddyAdapter = class {
  async buildBody(options) {
    const messages = serializeMessages2(options.messages, imageUrls);
    if (options.system !== void 0 && options.system.length > 0) {
      messages.unshift({ role: "system", content: options.system });
    }
    return messages;
  }
};
var CodeArtsAdapter = class {
  async buildBody(options) {
    if (options.system !== void 0 && options.system.length > 0) {
      messages.unshift({ role: "system", content: options.system });
    }
  }
};
`;
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

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe('patch definitions', () => {
  it('exposes a positive revision', () => {
    assert.equal(typeof PATCH_REVISION, 'number');
    assert.ok(PATCH_REVISION >= 1);
  });

  it('gives every patch a unique id, a file, and at least one marker', () => {
    const ids = new Set();
    for (const patch of PATCHES) {
      assert.equal(ids.has(patch.id), false, `duplicate id ${patch.id}`);
      ids.add(patch.id);
      assert.ok(patch.file.length > 0);
      assert.ok(Array.isArray(patch.markers) && patch.markers.length > 0);
      assert.ok(Array.isArray(patch.edits) && patch.edits.length > 0);
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
  it('reports a stock target as pending on every patch', () => {
    const target = makeTarget();
    const states = inspect(target);
    assert.equal(states.length, PATCHES.length);
    for (const state of states) assert.equal(state.state, 'pending', `${state.id} should be pending`);
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
    assert.equal(packPatches.length, 2);
    for (const state of packPatches) assert.equal(state.state, 'drifted');
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
      'var CONTENT_FINGERPRINTS = [',
      'var CONTENT_FINGERPRINTS = [\nvar CONTENT_FINGERPRINTS = [',
    );
    const state = inspect(makeTarget({ pack })).find(
      (entry) => entry.id === 'content-fingerprints',
    );
    assert.equal(state.state, 'drifted');
    assert.match(state.detail, /ambiguous/);
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
    assert.equal(report.applied.length, PATCHES.length);
    assert.equal(report.changed, true);
    assert.equal(formatStatus(target).includes(`${PATCHES.length}/${PATCHES.length} patches in place.`), true);
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

  it('adds the rejected fingerprints ahead of the stock rule', () => {
    const target = makeTarget();
    applyPatches(target, { stamp: 'fp' });
    const source = readFileSync(join(target, 'vendor', 'channel-pack', 'pack.js'), 'utf8');

    const identity = source.indexOf('find: "powered by DeepSeek Harness"');
    const url = source.indexOf('find: "github.com/deepseek-ai/deepseek-harness"');
    const stock = source.indexOf('find: "Main branch (you will usually use this for PRs)"');
    assert.equal(identity > 0, true);
    assert.equal(url > identity, true);
    assert.equal(stock > url, true, 'stock rule must stay last so the array stays valid');
  });

  it('rewrites only the direct path, leaving the other adapter alone', () => {
    const target = makeTarget();
    applyPatches(target, { stamp: 'direct' });
    const source = readFileSync(join(target, 'vendor', 'channel-pack', 'pack.js'), 'utf8');

    // One rewrite loop, in BuddyAdapter's buildBody.
    assert.equal(source.split('rewriteTencentContentFingerprints(systemContent').length - 1, 1);
    // CodeArtsAdapter's unshift must be untouched: no loop inside its body.
    const codeArts = source.slice(source.indexOf('var CodeArtsAdapter = class'));
    assert.equal(codeArts.includes('rewriteTencentContentFingerprints(systemContent'), false);
  });

  it('is idempotent', () => {
    const target = makeTarget();
    applyPatches(target, { stamp: 'first' });
    const afterFirst = readFileSync(join(target, 'vendor', 'channel-pack', 'pack.js'), 'utf8');

    const second = applyPatches(target, { stamp: 'second' });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.errors, []);
    assert.equal(second.changed, false);
    assert.equal(second.alreadyPatched.length, PATCHES.length);
    assert.equal(readFileSync(join(target, 'vendor', 'channel-pack', 'pack.js'), 'utf8'), afterFirst);
  });

  it('preserves CRLF line endings', () => {
    const target = makeTarget({ newline: '\r\n' });
    applyPatches(target, { stamp: 'crlf' });
    const source = readFileSync(join(target, 'vendor', 'channel-pack', 'pack.js'), 'utf8');

    const crlf = (source.match(/\r\n/g) ?? []).length;
    const lone = (source.match(/(?<!\r)\n/g) ?? []).length;
    assert.equal(lone, 0, 'no LF may be introduced into a CRLF file');
    assert.ok(crlf > 0);
  });

  it('preserves LF line endings', () => {
    const target = makeTarget({ newline: '\n' });
    applyPatches(target, { stamp: 'lf' });
    const source = readFileSync(join(target, 'vendor', 'channel-pack', 'pack.js'), 'utf8');
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
    assert.equal(report.applied.includes('content-fingerprints'), true);
  });

  it('does not write in dry-run mode', () => {
    const target = makeTarget();
    const before = readFileSync(join(target, 'vendor', 'channel-pack', 'pack.js'), 'utf8');
    const report = applyPatches(target, { dryRun: true });

    assert.equal(report.applied.length, PATCHES.length);
    assert.equal(report.changed, false);
    assert.equal(readFileSync(join(target, 'vendor', 'channel-pack', 'pack.js'), 'utf8'), before);
    for (const state of inspect(target)) assert.equal(state.state, 'pending');
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
    const stockPack = readFileSync(join(target, 'vendor', 'channel-pack', 'pack.js'), 'utf8');

    applyPatches(target, { stamp: 'restore1' });
    assert.equal(formatStatus(target).includes('0/'), false);

    const result = restorePatches(target);
    assert.deepEqual(result.errors, []);
    assert.equal(result.restored.length, 2);
    assert.equal(readFileSync(join(target, 'vendor', 'channel-pack', 'pack.js'), 'utf8'), stockPack);
    for (const state of inspect(target)) assert.equal(state.state, 'pending', state.id);
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
    assert.match(text, /0\/3 patches in place\./);
    assert.match(text, new RegExp(`revision ${PATCH_REVISION}`));
  });

  it('marks an earlier equivalent form as such', () => {
    const pack = packStock().replace(
      '    return messages;',
      '    messages[0] = { ...messages[0], content: rewriteTencentContentFingerprints(messages[i].content, this.product.id) };\n    return messages;',
    );
    const target = makeTarget({ pack });
    const state = inspect(target).find((entry) => entry.id === 'direct-system-rewrite');
    assert.equal(state.state, 'patched');
    assert.equal(state.note, 'earlier equivalent form');
  });
});
