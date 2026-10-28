/**
 * dsh-tencent-channel-fix — patcher core.
 *
 * Re-applies the repairs that keep the `dsh-our-free-model` (OFM) channel pack
 * usable from DSH, idempotently, on every boot.
 *
 * ## Why a patcher and not a fork
 *
 * Every defect lives inside `dsh-our-free-model`, and that package is replaced
 * wholesale whenever it self-updates (its updater writes straight into the
 * profile's `node_modules`) or gets pinned back to a payload by
 * `dsh-ofm-codearts-pin`. Anything edited there by hand is silently rolled back
 * by the next update — which is exactly how this bug came back the first time.
 * This plugin owns the knowledge instead: it detects the state, rewrites it,
 * verifies the result with `node --check`, and restores from backup if anything
 * fails. An OFM upgrade or a DSH upgrade therefore self-heals on next boot.
 *
 * ## Revision 2 — what changed and why
 *
 * Revision 1 carried two buddy/workbuddy `400 / code 11128` fixes:
 *
 *   1. `adapter/kernel.js` — sanitize the harness attribution User-Agent.
 *   2. `vendor/channel-pack/pack.js` — add rejected system-prompt fingerprints
 *      and rewrite the direct adapter path's system message.
 *
 * Revision 2 retires fix 2 and adds the signed-transport repair, because the
 * environment moved underneath revision 1:
 *
 *   - OFM 2.5.9+ **deleted** the `buddy` / `workbuddy` channels
 *     (`isRetiredProvider()` returns true for both), and the CodeArts-carrying
 *     2.5.8 build no longer contains `CONTENT_FINGERPRINTS` /
 *     `rewriteTencentContentFingerprints` at all. Revision 1's pack.js edits
 *     therefore had no anchor to attach to, so `content-fingerprints` reported
 *     drift while `direct-system-rewrite` *succeeded* and injected a call to a
 *     function that no longer exists anywhere in the bundle.
 *
 *     That injection is worse than useless: `BuddyAdapter.buildBody` referenced
 *     an undefined identifier, so any request routed through it died with
 *     `ReferenceError` instead of the HTTP error the gate returned. Revision 2
 *     detects and **removes** that injected block (`legacy-direct-rewrite`),
 *     which is why that patch carries `absentMeansDone`.
 *
 *   - The break the operator actually hit after the DSH upgrade is on the
 *     **CodeArts (Huawei Cloud)** channel, and it is a transport-lifetime bug
 *     inside OFM, not a channel-gate bug:
 *
 *       `apply()` builds `signedNetwork = createDirectFetch(...)` and registers
 *       the CodeArts adapter with `fetchImpl: signedNetwork.fetch`. Its dispose
 *       effect then calls `signedNetwork.close()`, which aborts that transport's
 *       `lifetime` controller. Meanwhile the adapter stays registered in the
 *       kernel's `llm` service — `registerAdapterIdempotent()` deliberately
 *       keeps the existing route on a duplicate registration
 *       ("插件 fiber 重启竞态，保留现有路由并跳过本次注册").
 *
 *       So after the plugin fiber is disposed and re-created once (an OFM hot
 *       reload, an in-app upgrade, or the DSH upgrade that re-applies the
 *       profile), every CodeArts request still goes through the *previous*
 *       adapter, whose fetch closure points at the *closed* transport. The
 *       first call throws and the turn ends with
 *       `CodeArts 签名传输已停止` (`code: UNKNOWN`).
 *
 *     Revision 2 fixes the lifetime, not the symptom: consumers no longer hold a
 *     transport instance, they hold a closure that re-reads a **process-wide**
 *     lane. Because the lane hangs off `globalThis` (symbol-keyed), it also
 *     survives the module purge OFM performs during a hot reload — an adapter
 *     retained from an earlier generation follows the successor transport
 *     instead of calling into a dead one.
 *
 * Fixture note: `dsh-ofm-codearts-pin` pins OFM back to 2.5.8 because later
 * builds dropped the CodeArts channel entirely. Both the pinned 2.5.8 build and
 * any later build share this transport code, so the repair is written against
 * the shared shape and reports drift rather than forcing an edit when it moves.
 * This bundle is listed after `dsh-ofm-codearts-pin` in the profile, so the pin
 * restores pristine bytes first and this repair re-lands on top.
 *
 * ## Design notes
 *
 * - Anchors are exact, single-occurrence literals, so drift is *detected* and
 *   reported rather than forced. A patched file is never rewritten again.
 * - Line endings are normalised per file: `pack.js` and `kernel.js` ship LF in
 *   the pinned build, and an installed copy may differ. Templates below are
 *   written with `\n` and converted to whatever the target file uses.
 * - Several recognised forms count as patched. An earlier hand-applied variant
 *   of a fix is functionally equivalent; rewriting a working file to enforce one
 *   idiom would risk more than it gains.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bumped whenever the patch bodies below change. */
export const PATCH_REVISION = 4;

/** Bare package name of the plugin we repair. */
export const TARGET_PACKAGE = 'dsh-our-free-model';

const OWN_DIR = dirname(fileURLToPath(import.meta.url));
const BACKUP_SUFFIX = '.dsh-tencent-channel-fix.bak';

/**
 * Replacement for the stock `resolveAttributionUserAgent` return value.
 *
 * A hoisted function declaration so it can be spliced in ahead of its caller.
 */
const SANITIZE_FN = [
  '/**',
  ' * [dsh-tencent-channel-fix] Rewrite the attribution User-Agent into a shape',
  ' * the Tencent channel gate accepts.',
  ' *',
  ' * `copilot.tencent.com` / `www.workbuddy.ai` answer `400 code=11128`',
  ' * ("Illegal API invocation from an unapproved channel") for the stock harness',
  ' * UA `deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`.',
  ' * Only the `deepseek-harness` token and that GitHub URL are rejected — the',
  ' * version is kept so attribution stays meaningful, and the adapter contract',
  ' * (a present, non-empty attribution UA) still holds.',
  ' *',
  ' * Harmless on builds where the Tencent channels are retired; kept so a profile',
  ' * that still routes through them is not left on the rejected UA.',
  ' *',
  ' * @param {string} agent',
  ' * @returns {string}',
  ' */',
  'function sanitizeAttributionUserAgent(agent) {',
  "  const version = /\\/(\\d[\\w.\\-]*)/.exec(agent)?.[1]",
  "  return version === undefined ? 'dsh-our-free-model' : `dsh-our-free-model/${version}`",
  '}',
  '',
  '',
].join('\n');

/**
 * The process-wide signed lane.
 *
 * `globalThis` on purpose: OFM's hot reload purges its own module cache, so a
 * module-level binding would be re-created and a retained adapter would read a
 * different object than the successor. A symbol-keyed global is shared by every
 * generation of the module in this process.
 */
const SIGNED_LANE_DECL = [
  'var directLane = { fetch: null };',
  '// [dsh-tencent-channel-fix] Process-wide signed (CodeArts / Huawei Cloud)',
  '// transport lane. Deliberately on `globalThis` with a symbol key: it must',
  '// survive the module purge OFM performs during its hot reload, so an adapter',
  '// retained across a plugin fiber restart follows the successor transport',
  '// instead of calling into one whose lifetime was already aborted by dispose.',
  'var signedLane = globalThis[Symbol.for("our-free-model.signed-lane")] ??= { fetch: void 0 };',
].join('\n');

/** The stock dispose block in `apply()`, plus the lane publication and closure. */
const APPLY_DISPOSE_ANCHOR = [
  '  const detachSignedNetwork = attachDirectFetch(signedNetwork.fetch);',
  '  ctx.effect(() => () => {',
  '    detachSignedNetwork();',
  '    void signedNetwork.close();',
  '  });',
].join('\n');

const APPLY_DISPOSE_REPLACEMENT = [
  '  const detachSignedNetwork = attachDirectFetch(signedNetwork.fetch);',
  '  // [dsh-tencent-channel-fix] Publish this transport through the process-wide',
  '  // lane and hand every consumer a closure that re-reads it. Dispose still',
  '  // releases this instance, but a consumer created by an earlier `apply()` now',
  '  // follows the successor transport instead of throwing "transport stopped" —',
  '  // which is what broke CodeArts after the plugin fiber was re-created.',
  '  signedLane.fetch = signedNetwork.fetch;',
  '  const signedFetch = (input, init) => {',
  '    const live = signedLane.fetch;',
  '    if (live === void 0) throw new Error("CodeArts signed transport is not ready");',
  '    return live(input, init);',
  '  };',
  '  ctx.effect(() => () => {',
  '    detachSignedNetwork();',
  '    // Only clear the lane if it still points at this instance, so a successor',
  '    // that already published its transport is not un-published by this dispose.',
  '    if (signedLane.fetch === signedNetwork.fetch) signedLane.fetch = void 0;',
  '    void signedNetwork.close();',
  '  });',
].join('\n');

/**
 * Revision 1's direct-path injection, which must be removed.
 *
 * It references `rewriteTencentContentFingerprints`, a function that exists only
 * in OFM builds that still carry `CONTENT_FINGERPRINTS`. On the pinned 2.5.8
 * bundle it is undefined, so the block turns a channel-gate HTTP error into a
 * `ReferenceError`. Matched with its leading newline so removal leaves the stock
 * `if (options.system ...)` statement flush against the following statement.
 */
const LEGACY_INJECT = [
  '',
  '    // [dsh-tencent-channel-fix] The gateway path rewrites channel fingerprints',
  '    // in `convertMessage` / `toMessages`, but this direct adapter path never did,',
  '    // so the stock system prompt went out verbatim and the channel gate answered',
  '    // 400 / code 11128. Rewrite it here too. The rewriter is provider-scoped',
  '    // (`TENCENT_PROVIDERS`), so every non-Tencent channel passes through as-is.',
  '    for (let i = 0; i < messages.length; i++) {',
  '      const systemMessage = messages[i];',
  '      if (systemMessage.role !== "system") continue;',
  '      const systemContent = systemMessage.content;',
  '      if (typeof systemContent === "string") {',
  '        messages[i] = {',
  '          ...systemMessage,',
  '          content: rewriteTencentContentFingerprints(systemContent, this.product.id)',
  '        };',
  '      } else if (Array.isArray(systemContent)) {',
  '        messages[i] = {',
  '          ...systemMessage,',
  '          content: systemContent.map((part) =>',
  '            typeof part?.text === "string"',
  '              ? { ...part, text: rewriteTencentContentFingerprints(part.text, this.product.id) }',
  '              : part',
  '          )',
  '        };',
  '      }',
  '      break;',
  '    }',
].join('\n');

/**
 * One patch = one file plus the markers that report whether it already landed,
 * and the exact, single-occurrence edits that land it.
 *
 * A `find` count of zero means upstream moved on (or, for a cleanup, that the
 * removal already happened); a count of two or more means the anchor became
 * ambiguous. Both are reported as drift instead of being forced, so a partial
 * rewrite can never corrupt the adapter.
 */
/**
 * Revision 3 — the CodeArts queue-retry budget.
 *
 * `CodeArtsAdapter` treats Huawei's `TM.00001041 并发会话数已达上限(3个)` as a
 * *queue* signal, not a failure:
 *
 *   isQueueError()  →  status 400 && body contains "TM.00001041"
 *   →  skips the throw, increments `queueAttempts`
 *   →  `delay(QUEUE_RETRY_DELAY_MS)` and retries the whole request
 *   →  up to `QUEUE_MAX_ATTEMPTS2` times
 *
 * The stock numbers are 10 s and 180, i.e. **30 minutes of total silence**
 * before the turn reports anything. A slot-full answer is not a queue position:
 * it is the account's hard 3-session concurrency ceiling, and retrying does not
 * move it — the harness itself is what holds the slots.
 *
 * Measured on the operator's machine, from its own token ledger
 * (`~/.dsh/channel-pack/token-ledger.json`, 2634 CodeArts requests over 8 days):
 *
 *   codearts / deepseek-v4.1-flash   avg TTFT 114,639 ms  (~1.9 min)
 *   qodercn  / dfmodel               avg TTFT   2,645 ms
 *   buddy    / deepseek-v4.1-flash   avg TTFT   2,626 ms
 *
 * Every individual upstream attempt answers in ~270-900 ms (measured by
 * re-signing requests with this bundle's own `signRequestHuawei`), so the
 * missing ~110 s is the retry loop, not model thinking.
 *
 * 1200 ms × 4 keeps a few cheap retries for a slot that is genuinely about to
 * free up, while capping the worst case at 4.8 s instead of 30 minutes.
 */
const QUEUE_BUDGET_ANCHOR = [
  'var QUEUE_RETRY_DELAY_MS = 1e4;',
  'var QUEUE_MAX_ATTEMPTS2 = 180;',
].join('\n');

const QUEUE_BUDGET_REPLACEMENT = [
  'var QUEUE_RETRY_DELAY_MS = 1200;',
  '// [dsh-tencent-channel-fix] Was 1e4: ten seconds per attempt turned a full',
  '// account concurrency ceiling into minutes of silence in the composer.',
  'var QUEUE_MAX_ATTEMPTS2 = 4;',
  '// [dsh-tencent-channel-fix] Was 180 (30 min worst case). A slot-full answer',
  '// is a hard ceiling, not a queue position, so retrying it many times buys',
  '// nothing the first few attempts have not already proved.',
].join('\n');

/**
 * The message that ends a queue wait, in its stock wording.
 *
 * It has to move with the constants above: once the budget is 4.8 s, a message
 * claiming "after 30 minutes" is a lie and names no cause the operator can act
 * on. The replacement interpolates `QUEUE_MAX_ATTEMPTS2` rather than
 * hard-coding a number, so it stays true if the budget is ever retuned.
 */
const QUEUE_MESSAGE_ANCHOR =
  'throw new LlmError2("codearts: queue wait timed out after 30 minutes", "QUEUE");';

const QUEUE_MESSAGE_REPLACEMENT = [
  'throw new LlmError2(',
  '  // [dsh-tencent-channel-fix] The stock text named a 30-minute budget the',
  '  // retry constants no longer grant, and gave the operator nothing to do',
  '  // about it. Name the real ceiling and the two ways out instead.',
  '  `codearts: \u5E76\u53D1\u4F1A\u8BDD\u69FD\u4F4D\u5DF2\u6EE1\uFF08\u8D26\u53F7\u4E0A\u9650 3 \u4E2A\uFF09\uFF0C\u5DF2\u5C1D\u8BD5 ${QUEUE_MAX_ATTEMPTS2} \u6B21\u4ECD\u672A\u91CA\u653E\u3002`',
  '  + "\u5173\u95ED\u5176\u5B83\u4F1A\u8BDD\u540E\u91CD\u8BD5\uFF0C\u6216\u5207\u6362\u5230\u5176\u5B83\u6A21\u578B\uFF1B"',
  '  + "\u8BE6\u89C1\u8BBE\u7F6E \u2192 Our Free Model \u2192 CodeArts \u8D26\u53F7\u9762\u677F\u3002",',
  '  "QUEUE");',
].join('\n');

/**
 * Revision 4 — the benefit-header slot leak.
 *
 * CodeArtsAdapter decides a model is a "benefit" model from a hard-coded list
 * (CODEARTS_BENEFIT_FALLBACK = ["glm-5.3-flash", "deepseek-v4.1-flash"]) and
 * from codearts_benefit_models.json. For such a model it signs every request
 * with maas_type: benefit.
 *
 * When the account does not hold that entitlement the gateway answers
 * InferHub.4004.200 "benefit not found". The adapter catches it, sets
 * benefitHeaderDropped = true, and retries without the header — which works.
 *
 * The bug is that benefitHeaderDropped is a PER-CALL LOCAL, so the flag is
 * forgotten the moment the call returns. Every later turn pays the same doomed
 * attempt again. On this gateway that attempt is not free:
 *
 *   - a rejected request still opens a session slot (measured: three sequential
 *     calls fill the 3-session ceiling, and a released slot takes ~150 s to
 *     come back);
 *   - so turn 1 succeeds on the retry, turn 2 finds the ceiling full, and from
 *     turn 3 onward every attempt answers TM.00001041.
 *
 * Measured replay of three consecutive turns through one adapter identity after
 * a full drain (170 s):
 *
 *   turn1#1 benefit     -> benefit-missing   (slot burned)
 *   turn1#2 no-benefit  -> OK
 *   turn2#1 benefit     -> benefit-missing   (slot burned)
 *   turn2#2 no-benefit  -> SLOT_FULL
 *   turn3#1 benefit     -> SLOT_FULL
 *
 * The same account, header never sent, six calls spaced 25 s:
 * OK=6, SLOT_FULL=0, first byte 1.1-2.1 s.
 *
 * So the header is not something this account can use, and asking for it every
 * turn produces the "slot full" cascade — including on a brand-new account,
 * which is what made the symptom look impossible.
 *
 * The fix remembers the rejection for the adapter lifetime, so the doomed
 * attempt is paid once instead of once per turn.
 */
const BENEFIT_FLAG_ANCHOR = 'let benefitHeaderDropped = false;';

const BENEFIT_FLAG_REPLACEMENT = [
  'let benefitHeaderDropped = false;',
  '// [dsh-tencent-channel-fix] benefitHeaderDropped below is per-call, so the',
  '// doomed maas_type: benefit attempt was re-paid on EVERY turn. Each rejected',
  '// attempt still consumes one of the account session slots, and a slot takes',
  '// ~150 s to be released, so turn 2 found the ceiling full and turn 3 onward',
  '// never got through. Remember it on the adapter itself: the lease is per',
  '// account, not per request.',
  'if (this.benefitUnsupported === true) benefitHeaderDropped = true;',
].join('\n');

/**
 * Record the rejection where the next call can see it.
 *
 * Anchored on the benefitHeaderDropped = true assignment inside the catch
 * branch, keeping the stock statement and adding the adapter-level flag beside
 * it (the stock continue retries with the header dropped).
 */
const BENEFIT_REMEMBER_ANCHOR = [
  '            benefitHeaderDropped = true;',
  '            continue;',
].join('\n');

const BENEFIT_REMEMBER_REPLACEMENT = [
  '            benefitHeaderDropped = true;',
  '            // [dsh-tencent-channel-fix] Account-level, not call-level: this',
  '            // account has no benefit entitlement, so stop asking on every turn.',
  '            // Without this the rejected attempt burns a session slot each turn',
  '            // and the account ends up reporting a full session ceiling.',
  '            this.benefitUnsupported = true;',
  '            continue;',
].join('\n');

export const PATCHES = [
  {
    id: 'signed-transport-seam',
    title: 'CodeArts signed transport lifetime (turns fail after a fiber restart)',
    file: 'vendor/channel-pack/pack.js',
    markers: ['var signedLane = globalThis[Symbol.for("our-free-model.signed-lane")]'],
    edits: [
      {
        find: 'var directLane = { fetch: null };',
        replace: SIGNED_LANE_DECL,
      },
      {
        find: APPLY_DISPOSE_ANCHOR,
        replace: APPLY_DISPOSE_REPLACEMENT,
      },
      {
        find: '  const service = new CodeArtsAuth(ctx, { fetcher: signedNetwork.fetch });',
        replace: '  const service = new CodeArtsAuth(ctx, { fetcher: signedFetch });',
      },
      {
        find: '    fetchImpl: signedNetwork.fetch,',
        replace: '    fetchImpl: signedFetch,',
      },
      {
        find: '    codeartsFetcher: signedNetwork.fetch',
        replace: '    codeartsFetcher: signedFetch',
      },
    ],
  },
  {
    id: 'legacy-direct-rewrite',
    title: "Remove revision 1's dangling system-rewrite injection (ReferenceError)",
    file: 'vendor/channel-pack/pack.js',
    // Nothing is inserted, so there is no positive marker: the patch is done when
    // its anchor is gone, which `absentMeansDone` below turns into `patched`.
    markers: [],
    absentMeansDone: true,
    edits: [
      {
        find: LEGACY_INJECT,
        replace: '',
      },
    ],
  },
  {
    id: 'codearts-queue-budget',
    title: 'CodeArts queue-retry budget (30 min of silence per slot-full answer)',
    file: 'vendor/channel-pack/pack.js',
    markers: ['var QUEUE_MAX_ATTEMPTS2 = 4;'],
    edits: [
      {
        find: QUEUE_BUDGET_ANCHOR,
        replace: QUEUE_BUDGET_REPLACEMENT,
      },
    ],
  },
  {
    id: 'codearts-queue-message',
    title: 'CodeArts slot-full message (names the cause and the way out)',
    file: 'vendor/channel-pack/pack.js',
    markers: ['已尝试 ${QUEUE_MAX_ATTEMPTS2} 次仍未释放'],
    edits: [
      {
        find: QUEUE_MESSAGE_ANCHOR,
        replace: QUEUE_MESSAGE_REPLACEMENT,
      },
    ],
  },
  {
    id: 'codearts-benefit-remembered',
    title: 'Remember the benefit rejection (each rejected attempt burned a session slot)',
    file: 'vendor/channel-pack/pack.js',
    markers: ['this.benefitUnsupported = true;'],
    edits: [
      {
        find: BENEFIT_REMEMBER_ANCHOR,
        replace: BENEFIT_REMEMBER_REPLACEMENT,
      },
    ],
  },
  {
    id: 'codearts-benefit-skip',
    title: 'Skip the doomed benefit-header attempt once the account rejected it',
    file: 'vendor/channel-pack/pack.js',
    markers: ['if (this.benefitUnsupported === true) benefitHeaderDropped = true;'],
    edits: [
      {
        find: BENEFIT_FLAG_ANCHOR,
        replace: BENEFIT_FLAG_REPLACEMENT,
      },
    ],
  },
  {
    id: 'attribution-user-agent',
    title: 'Attribution User-Agent (400 / code 11128)',
    file: 'adapter/kernel.js',
    markers: ['sanitizeAttributionUserAgent'],
    edits: [
      {
        find: "if (typeof agent === 'string' && agent !== '') return agent",
        replace:
          "if (typeof agent === 'string' && agent !== '') return sanitizeAttributionUserAgent(agent)",
      },
      {
        find: "return 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness)'",
        replace: "return 'dsh-our-free-model/0.1.7'",
      },
      {
        find: 'export async function resolveAttributionUserAgent(logger) {',
        replace: `${SANITIZE_FN}export async function resolveAttributionUserAgent(logger) {`,
      },
    ],
  },
];

/** Count non-overlapping occurrences of a literal. */
function countOf(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Newline the file actually uses.
 *
 * `pack.js` and `kernel.js` ship LF in the pinned build, and an installed copy
 * may differ from upstream, so this is measured per file rather than assumed.
 *
 * @param {string} source
 * @returns {'\n' | '\r\n'}
 */
function detectNewline(source) {
  const crlf = countOf(source, '\r\n');
  if (crlf === 0) return '\n';
  const lf = countOf(source, '\n');
  return crlf * 2 >= lf ? '\r\n' : '\n';
}

/** Re-express a `\n`-separated template in the file's newline style. */
function withNewline(text, newline) {
  return newline === '\n' ? text : text.split('\n').join(newline);
}

/**
 * Candidate install directories for the target package, most specific first.
 *
 * @param {{ target?: string }} [config]
 * @returns {string[]}
 */
export function candidateTargets(config) {
  const seen = new Set();
  const out = [];
  const push = (dir) => {
    if (typeof dir !== 'string' || dir === '') return;
    const absolute = resolve(dir);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    out.push(absolute);
  };

  push(config?.target);
  push(process.env.DSH_OUR_FREE_MODEL_DIR);

  // Sibling of this plugin: <node_modules>/dsh-tencent-channel-fix/lib -> <node_modules>
  push(join(OWN_DIR, '..', '..', TARGET_PACKAGE));

  const dshHome = process.env.DSH_HOME;
  const profiles = dshHome
    ? join(dshHome, 'profiles')
    : join(process.env.HOME || process.env.USERPROFILE || homedir(), '.dsh', 'profiles');
  try {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      push(join(profiles, entry.name, 'node_modules', TARGET_PACKAGE));
    }
  } catch {
    // No profiles directory on this machine — the other candidates still apply.
  }

  return out;
}

/**
 * First candidate directory that actually holds the target package.
 *
 * @param {{ target?: string }} [config]
 * @returns {string | undefined}
 */
export function resolveTarget(config) {
  for (const dir of candidateTargets(config)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return undefined;
}

/** Installed version of the target package, when readable. */
export function targetVersion(target) {
  try {
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Per-patch state.
 *
 * - `patched` — a recognised marker is present, or (`absentMeansDone`) every
 *   anchor is already gone; nothing to do, file untouched.
 * - `pending` — every anchor is present exactly once; an apply will land it.
 * - `drifted` — an anchor is missing or ambiguous; upstream changed the file.
 *
 * @param {string} target
 * @returns {Array<{ id: string, title: string, file: string, state: string, marker?: string, detail?: string }>}
 */
export function inspect(target) {
  const cache = new Map();
  const read = (file) => {
    if (!cache.has(file)) {
      try {
        cache.set(file, readFileSync(join(target, file), 'utf8'));
      } catch {
        cache.set(file, undefined);
      }
    }
    return cache.get(file);
  };

  return PATCHES.map((patch) => {
    const source = read(patch.file);
    const base = { id: patch.id, title: patch.title, file: patch.file };
    if (source === undefined) {
      return { ...base, state: 'drifted', detail: 'file missing' };
    }

    const marker = patch.markers.find((candidate) => source.includes(candidate));
    if (marker !== undefined) {
      return {
        ...base,
        state: 'patched',
        marker,
        note:
          marker === patch.markers[0] || patch.markers.length === 1
            ? undefined
            : 'earlier equivalent form',
      };
    }

    const newline = detectNewline(source);
    const counts = patch.edits.map((edit) => countOf(source, withNewline(edit.find, newline)));
    if (patch.absentMeansDone === true && counts.every((count) => count === 0)) {
      return { ...base, state: 'patched', note: 'already clean' };
    }
    for (const count of counts) {
      if (count === 0) {
        return { ...base, state: 'drifted', detail: 'anchor not found — upstream changed' };
      }
      if (count > 1) {
        return { ...base, state: 'drifted', detail: `anchor is ambiguous (${count} matches)` };
      }
    }
    return { ...base, state: 'pending' };
  });
}

/**
 * `node --check` against the real file, so the nearest `package.json` type applies.
 *
 * Capturing output is tried first for its error text; some confined environments
 * deny the pipe (`EPERM` on the read end) while still permitting the child to
 * run, so the no-capture form is the fallback. Both report the same exit status,
 * which is what actually gates the patch.
 */
function syntaxCheck(file) {
  const piped = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (piped.error === undefined) {
    if (piped.status === 0) return { ok: true };
    const stderr = (piped.stderr || '').trim();
    return { ok: false, message: stderr === '' ? `node --check exited ${piped.status}` : stderr };
  }
  if (piped.error.code !== 'EPERM' && piped.error.code !== 'EACCES') {
    return { ok: false, message: piped.error.message };
  }
  const silent = spawnSync(process.execPath, ['--check', file], {
    stdio: 'ignore',
    timeout: 120_000,
  });
  if (silent.error) return { ok: false, message: silent.error.message };
  if (silent.status === 0) return { ok: true };
  return { ok: false, message: `node --check exited ${silent.status}` };
}

/** Timestamped backup path for one target file. */
function backupPath(file, stamp) {
  return `${file}.${stamp}${BACKUP_SUFFIX}`;
}

/**
 * Apply every pending patch to the target, verifying syntax and restoring from
 * backup if any step fails.
 *
 * @param {string} target
 * @param {{ dryRun?: boolean, stamp?: string }} [options]
 * @returns {{
 *   target: string,
 *   version?: string,
 *   applied: string[],
 *   alreadyPatched: string[],
 *   drifted: Array<{ id: string, detail?: string }>,
 *   errors: string[],
 *   changed: boolean,
 * }}
 */
export function applyPatches(target, options = {}) {
  const stamp = options.stamp ?? new Date().toISOString().replace(/[:.]/g, '-');
  const before = inspect(target);
  const report = {
    target,
    version: targetVersion(target),
    applied: [],
    alreadyPatched: [],
    drifted: [],
    errors: [],
    changed: false,
  };

  for (const state of before) {
    if (state.state === 'patched') report.alreadyPatched.push(state.id);
    if (state.state === 'drifted') report.drifted.push({ id: state.id, detail: state.detail });
  }

  const pending = before.filter((state) => state.state === 'pending');
  if (pending.length === 0) return report;

  // Build every new body up front so a late anchor failure writes nothing.
  const bodies = new Map();
  for (const state of pending) {
    const patch = PATCHES.find((entry) => entry.id === state.id);
    if (patch === undefined) continue;
    let source = bodies.get(patch.file);
    if (source === undefined) source = readFileSync(join(target, patch.file), 'utf8');
    const newline = detectNewline(source);
    for (const edit of patch.edits) {
      const find = withNewline(edit.find, newline);
      if (countOf(source, find) !== 1) {
        report.drifted.push({ id: patch.id, detail: 'anchor vanished while patching' });
        return report;
      }
      source = source.replace(find, () => withNewline(edit.replace, newline));
    }
    bodies.set(patch.file, source);
  }

  if (options.dryRun === true) {
    report.applied = pending.map((state) => state.id);
    return report;
  }

  const touched = [];
  for (const [file, body] of bodies) {
    const absolute = join(target, file);
    const backup = backupPath(absolute, stamp);
    try {
      copyFileSync(absolute, backup);
      touched.push({ absolute, backup });
      writeFileSync(absolute, body, 'utf8');
    } catch (error) {
      report.errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    const check = syntaxCheck(absolute);
    if (!check.ok) {
      report.errors.push(`${file}: syntax check failed — ${check.message}`);
      break;
    }
  }

  if (report.errors.length > 0) {
    for (const { absolute, backup } of touched.reverse()) {
      try {
        copyFileSync(backup, absolute);
      } catch {
        report.errors.push(`${absolute}: restore failed — backup kept at ${backup}`);
      }
    }
    return report;
  }

  const after = inspect(target);
  report.applied = after
    .filter((state) => state.state === 'patched' && !report.alreadyPatched.includes(state.id))
    .map((state) => state.id);
  report.changed = report.applied.length > 0;
  return report;
}

/**
 * Restore every patched file from its newest backup.
 *
 * @param {string} target
 * @returns {{ restored: string[], errors: string[] }}
 */
export function restorePatches(target) {
  const restored = [];
  const errors = [];
  for (const patch of PATCHES) {
    const absolute = join(target, patch.file);
    const dir = dirname(absolute);
    const base = absolute.slice(dir.length + 1);
    let newest;
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.startsWith(`${base}.`) || !entry.endsWith(BACKUP_SUFFIX)) continue;
        const candidate = join(dir, entry);
        if (newest === undefined || statSync(candidate).mtimeMs > statSync(newest).mtimeMs) {
          newest = candidate;
        }
      }
    } catch (error) {
      errors.push(`${patch.file}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (newest === undefined) continue;
    try {
      copyFileSync(newest, absolute);
      restored.push(patch.file);
    } catch (error) {
      errors.push(`${patch.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { restored: [...new Set(restored)], errors };
}

/** Human-readable status block, used by the slash command and the HTTP route. */
export function formatStatus(target) {
  const states = inspect(target);
  const version = targetVersion(target);
  const lines = [
    `dsh-tencent-channel-fix · patch revision ${PATCH_REVISION}`,
    `target: ${target}`,
    `dsh-our-free-model: ${version ?? 'unknown version'}`,
    '',
  ];
  for (const state of states) {
    const badge =
      state.state === 'patched' ? 'OK     ' : state.state === 'pending' ? 'MISSING' : 'DRIFTED';
    const detail = [
      state.note === undefined ? undefined : state.note,
      state.detail,
    ]
      .filter((part) => part !== undefined)
      .join('; ');
    lines.push(
      `${badge} ${state.id} — ${state.title}${detail === '' ? '' : `  (${detail})`}`,
    );
  }
  const patched = states.filter((state) => state.state === 'patched').length;
  lines.push('', `${patched}/${states.length} patches in place.`);
  return lines.join('\n');
}
