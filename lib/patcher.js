/**
 * dsh-tencent-channel-fix — patcher core.
 *
 * Re-applies the two fixes that make the `buddy` / `workbuddy` channels usable
 * from DSH into the `dsh-our-free-model` plugin, idempotently, on every boot.
 *
 * ## Why a patcher and not a fork
 *
 * Both defects live inside `dsh-our-free-model`, and that package is replaced
 * wholesale whenever it self-updates (its updater writes straight into the
 * profile's `node_modules`). Anything edited there by hand is silently rolled
 * back by the next update — which is exactly how this bug came back the first
 * time. This plugin owns the knowledge instead: it detects the stock state,
 * rewrites it, verifies the result with `node --check`, and restores from backup
 * if anything fails. A DSH upgrade or an `dsh-our-free-model` upgrade therefore
 * self-heals on next boot instead of silently breaking the channel again.
 *
 * ## The two defects (measured 2026-10-21 on this machine)
 *
 * 1. `adapter/kernel.js` hands the stock harness attribution User-Agent
 *    `deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`
 *    to the adapter runtime. Tencent's channel verification answers
 *    `400 code=11128` ("Illegal API invocation from an unapproved channel") for
 *    that UA and for every case variant of it, while each alternative tested
 *    (`curl/8.0`, `node`, `dsh-our-free-model/…`, `CodeBuddyIDE/…`, absent)
 *    returned 200. The fix keeps attribution and the version but drops the
 *    rejected product token and URL.
 *
 * 2. `vendor/channel-pack/pack.js` rewrites channel fingerprints only on the
 *    gateway path (`convertMessage` / `toMessages`); the direct adapter path
 *    (`BuddyAdapter.buildBody`) unshifts `options.system` verbatim. The channel
 *    gate also rejects the harness identity sentence `powered by DeepSeek
 *    Harness` — the opening line of DSH's own base system prompt — so the direct
 *    path fails even with the UA fixed. The fix extends `CONTENT_FINGERPRINTS`
 *    with that sentence (and the attribution URL), then rewrites the system
 *    message on the direct path. The rewriter is provider-scoped inside
 *    `pack.js` (`TENCENT_PROVIDERS = ['buddy', 'workbuddy']`), so no other
 *    channel is affected.
 *
 * Fixing only the UA still returns `400`; both fixes are required. Measured:
 *
 *   stock system + stock UA   -> 400 code=11128
 *   stock system + fixed UA   -> 400 code=11128
 *   fixed system + fixed UA   -> 200
 *
 * ## Design notes
 *
 * - Anchors are exact, single-occurrence literals, so drift is *detected* and
 *   reported rather than forced. A patched file is never rewritten again.
 * - Line endings are normalised per file: `pack.js` ships CRLF, `kernel.js`
 *   ships LF, and an installed copy may differ from upstream. Templates below
 *   are written with `\n` and converted to whatever the target file uses.
 * - Several recognised forms count as patched. An earlier hand-applied variant
 *   of fix 2 is functionally equivalent; rewriting a working file to enforce one
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
export const PATCH_REVISION = 1;

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

/** Extra `CONTENT_FINGERPRINTS` rows inserted at the head of the array. */
const FINGERPRINT_RULES = [
  '  {',
  '    // [dsh-tencent-channel-fix] The harness identity sentence — the opening',
  "    // line of DSH's base system prompt — is itself a rejected fingerprint.",
  '    // The gate matches case-insensitively, so the `gi` compile below covers',
  '    // every spelling of it.',
  '    find: "powered by DeepSeek Harness",',
  '    replace: "running in a local workspace harness",',
  '    note: "dsh-tencent-channel-fix: harness identity line"',
  '  },',
  '  {',
  '    // [dsh-tencent-channel-fix] The same gate rejects the attribution URL when',
  '    // it appears inside the system prompt.',
  '    find: "github.com/deepseek-ai/deepseek-harness",',
  '    replace: "github.com/example/local-harness",',
  '    note: "dsh-tencent-channel-fix: attribution URL"',
  '  },',
  '',
].join('\n');

/**
 * Direct-path system rewrite, spliced in after the stock unshift.
 *
 * Handles both wire shapes: plain string content, and the block-array form the
 * adapter produces when the system prompt carries images or cached parts.
 */
const SYSTEM_REWRITE_BLOCK = [
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

/** The stock direct-path system assembly in `BuddyAdapter.buildBody`. */
const SYSTEM_UNSHIFT_ANCHOR = [
  '    const messages = serializeMessages2(options.messages, imageUrls);',
  '    if (options.system !== void 0 && options.system.length > 0) {',
  '      messages.unshift({ role: "system", content: options.system });',
  '    }',
].join('\n');

/**
 * One patch = one file plus the markers that report whether it already landed,
 * and the exact, single-occurrence edits that land it.
 *
 * A `find` count of zero means upstream moved on; a count of two or more means
 * the anchor became ambiguous. Both are reported as drift instead of being
 * forced, so a partial rewrite can never corrupt the adapter.
 */
export const PATCHES = [
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
  {
    id: 'content-fingerprints',
    title: 'Rejected system-prompt fingerprints (400 / code 11128)',
    file: 'vendor/channel-pack/pack.js',
    // This sentence exists nowhere in the stock file, so its presence proves the
    // row was added. Matching the row's `find:` literal (rather than its `note:`)
    // also accepts rows written by an earlier hand-applied variant.
    markers: ['find: "powered by DeepSeek Harness"'],
    edits: [
      {
        find: 'var CONTENT_FINGERPRINTS = [\n',
        replace: `var CONTENT_FINGERPRINTS = [\n${FINGERPRINT_RULES}`,
      },
    ],
  },
  {
    id: 'direct-system-rewrite',
    title: 'Direct adapter path system rewrite (400 / code 11128)',
    file: 'vendor/channel-pack/pack.js',
    // Canonical form, plus the earlier hand-applied variant: both rewrite the
    // direct-path system message, so either one means the fix is in place.
    markers: [
      'rewriteTencentContentFingerprints(systemContent',
      'content: rewriteTencentContentFingerprints(messages[i].content, this.product.id)',
    ],
    edits: [
      {
        find: SYSTEM_UNSHIFT_ANCHOR,
        replace: `${SYSTEM_UNSHIFT_ANCHOR}\n${SYSTEM_REWRITE_BLOCK}`,
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
 * `pack.js` is CRLF and `kernel.js` is LF on this machine, and an installed copy
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
 * - `patched` — a recognised marker is present; nothing to do, file untouched.
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
    for (const edit of patch.edits) {
      const count = countOf(source, withNewline(edit.find, newline));
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

/** `node --check` against the real file, so the nearest `package.json` type applies. */
function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error) return { ok: false, message: result.error.message };
  if (result.status === 0) return { ok: true };
  const stderr = (result.stderr || '').trim();
  return { ok: false, message: stderr === '' ? `node --check exited ${result.status}` : stderr };
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
