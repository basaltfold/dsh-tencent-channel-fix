/**
 * dsh-tencent-channel-fix — host half.
 *
 * Repairs the `buddy` / `workbuddy` channel 400 (`code=11128`, "Illegal API
 * invocation from an unapproved channel") inside the `dsh-our-free-model`
 * plugin, and keeps it repaired across upgrades of that plugin and of DSH.
 *
 * See `lib/patcher.js` for the two defects, the exact anchors, and the measured
 * evidence. This file is the plugin shell: it schedules the repair at boot,
 * exposes status over HTTP, and gives the operator a slash command to inspect,
 * force, or undo it.
 *
 * ## Why it runs at boot
 *
 * Both defects are text inside `dsh-our-free-model`. Its updater rewrites those
 * files wholesale, so any hand edit is lost on the next update — the exact way
 * this bug came back the first time. Repairing on every boot makes an upgrade a
 * self-healing event instead of a regression.
 *
 * The patch is applied during `apply`, before any model request: `pack.js` and
 * `adapter/kernel.js` are imported lazily by that plugin on first use, so a boot
 * -time write lands well ahead of the module cache. Nothing here touches a
 * provider, a route, or a credential.
 */

import {
  PATCH_REVISION,
  TARGET_PACKAGE,
  applyPatches,
  candidateTargets,
  formatStatus,
  inspect,
  resolveTarget,
  restorePatches,
  targetVersion,
} from './patcher.js'

export const name = 'dsh-tencent-channel-fix'

/** Slash command that reports and controls the repair. */
const COMMAND_NAME = 'tencent-fix'

/** HTTP prefix for read-only status. */
const ROUTE_BASE = '/dsh-tencent-channel-fix'

const DEFAULTS = {
  /** Disable the boot-time repair (status endpoints keep working). */
  autoApply: true,
  /** Explicit `dsh-our-free-model` directory; resolved automatically when unset. */
  target: '',
  /** Log every step, including files that needed no change. */
  verbose: false,
}

function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const read = (key) => {
    const value = source[key]
    return value !== null && typeof value === 'object' && typeof value.get === 'function'
      ? value.get()
      : value
  }
  return {
    autoApply: read('autoApply') !== false,
    target: typeof read('target') === 'string' ? read('target').trim() : DEFAULTS.target,
    verbose: read('verbose') === true,
  }
}

function makeLogger(ctx, verbose) {
  const write = (level, message) => {
    try {
      const logger = ctx.logger
      const sink = logger !== undefined && logger !== null ? logger[level] : undefined
      if (typeof sink === 'function') {
        sink.call(logger, `[dsh-tencent-channel-fix] ${message}`)
        return
      }
    } catch {
      // Logger unusable — fall through to console rather than losing the message.
    }
    // eslint-disable-next-line no-console
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
      `[dsh-tencent-channel-fix] ${message}`,
    )
  }
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    debug: (message) => {
      if (verbose) write('info', message)
    },
  }
}

/** Compact one-line summary of an apply report, for the boot log. */
function summarize(report) {
  const parts = []
  if (report.applied.length > 0) parts.push(`applied ${report.applied.join(', ')}`)
  if (report.alreadyPatched.length > 0) parts.push(`already in place ${report.alreadyPatched.join(', ')}`)
  if (report.drifted.length > 0) {
    parts.push(`drifted ${report.drifted.map((entry) => `${entry.id} (${entry.detail ?? 'unknown'})`).join('; ')}`)
  }
  if (report.errors.length > 0) parts.push(`errors ${report.errors.join('; ')}`)
  return parts.length > 0 ? parts.join(' | ') : 'nothing to do'
}

/**
 * Run the repair once.
 *
 * Returns a structured outcome so the slash command can render it without
 * re-reading the files.
 */
function runRepair(ctx, config, log) {
  const target = resolveTarget(config)
  if (target === undefined) {
    const where = candidateTargets(config).join('\n  ')
    log.warn(
      `${TARGET_PACKAGE} is not installed in any known location; nothing to repair. Searched:\n  ${where}`,
    )
    return { ok: false, reason: 'target-missing', target: undefined }
  }

  const version = targetVersion(target)
  log.debug(`target ${target} (${TARGET_PACKAGE} ${version ?? 'unknown version'})`)

  if (!config.autoApply) {
    const states = inspect(target)
    log.info(`autoApply is off; patch state: ${states.map((s) => `${s.id}=${s.state}`).join(', ')}`)
    return { ok: true, reason: 'auto-apply-off', target, version, report: undefined }
  }

  const report = applyPatches(target)
  if (report.errors.length > 0) {
    log.error(`repair failed, files restored from backup — ${summarize(report)}`)
  } else if (report.drifted.length > 0) {
    log.warn(
      `repair incomplete (upstream ${TARGET_PACKAGE} changed) — ${summarize(report)}. ` +
        'Run /' + COMMAND_NAME + ' for details.',
    )
  } else if (report.applied.length > 0) {
    log.info(`repair applied — ${summarize(report)}. Active from the next model request.`)
  } else {
    log.debug(`no repair needed — ${summarize(report)}`)
  }
  return { ok: report.errors.length === 0, reason: 'applied', target, version, report }
}

function sendJson(response, status, payload) {
  try {
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    })
    response.end(JSON.stringify(payload))
  } catch {
    // Client hung up mid-write; nothing to recover.
  }
}

/** Status payload shared by the HTTP route and the slash command. */
function buildStatus(config) {
  const target = resolveTarget(config)
  if (target === undefined) {
    return {
      ok: false,
      patchRevision: PATCH_REVISION,
      targetPackage: TARGET_PACKAGE,
      target: null,
      version: null,
      searched: candidateTargets(config),
      patches: [],
      patchedCount: 0,
    }
  }
  const patches = inspect(target)
  return {
    ok: true,
    patchRevision: PATCH_REVISION,
    targetPackage: TARGET_PACKAGE,
    target,
    version: targetVersion(target) ?? null,
    patches,
    patchedCount: patches.filter((entry) => entry.state === 'patched').length,
  }
}

/** Slash-command text: status block plus the drift guidance when relevant. */
function renderStatus(config) {
  const status = buildStatus(config)
  if (status.ok === false) {
    return [
      `dsh-tencent-channel-fix · patch revision ${PATCH_REVISION}`,
      `${TARGET_PACKAGE} was not found. Searched:`,
      ...status.searched.map((dir) => `  ${dir}`),
      '',
      `Install ${TARGET_PACKAGE}, or set \`target\` in this plugin entry to its directory.`,
    ].join('\n')
  }
  const lines = [formatStatus(status.target)]
  const drifted = status.patches.filter((entry) => entry.state === 'drifted')
  if (drifted.length > 0) {
    lines.push(
      '',
      'A drifted patch means the anchor text is no longer in the upstream file, so',
      'the repair was skipped rather than forced. Re-derive the anchor from the new',
      `file, then update \`PATCHES\` in lib/patcher.js (revision ${PATCH_REVISION}).`,
    )
  }
  if (status.patchedCount < status.patches.length) {
    lines.push('', `Run /${COMMAND_NAME} apply to attempt the repair now.`)
  }
  return lines.join('\n')
}

/** Register the slash command, tolerating a profile with no commands service. */
function installCommand(ctx, config, subject) {
  ctx.inject(['commands'], (scoped) => {
    scoped.effect(
      () =>
        scoped.commands.register({
          name: COMMAND_NAME,
          description:
            'Report or repair the buddy/workbuddy channel 400 (code 11128) in dsh-our-free-model',
          input: { hint: '[status|apply|restore|why]' },
          recordInput: false,
          handler: (invocation) => {
            const argument = String(invocation?.rawInput ?? '').trim().toLowerCase()
            const words = argument.split(/\s+/).filter((word) => word !== '')
            const action = words.length === 0 ? 'status' : words[0]

            if (action === 'status' || action === 'check') {
              return { kind: 'success', text: renderStatus(config) }
            }

            if (action === 'why' || action === 'help') {
              return { kind: 'success', text: WHY_TEXT }
            }

            if (action === 'apply' || action === 'fix' || action === 'repair') {
              const target = resolveTarget(config)
              if (target === undefined) {
                return {
                  kind: 'error',
                  text: `${TARGET_PACKAGE} was not found. Searched:\n  ${candidateTargets(config).join('\n  ')}`,
                }
              }
              const report = applyPatches(target)
              const lines = [
                formatStatus(target),
                '',
                `applied: ${report.applied.length === 0 ? '(none)' : report.applied.join(', ')}`,
                `already in place: ${report.alreadyPatched.length === 0 ? '(none)' : report.alreadyPatched.join(', ')}`,
              ]
              if (report.drifted.length > 0) {
                lines.push(`drifted: ${report.drifted.map((entry) => `${entry.id} (${entry.detail ?? 'unknown'})`).join('; ')}`)
              }
              if (report.errors.length > 0) {
                lines.push(`errors: ${report.errors.join('; ')}`)
                return { kind: 'error', text: lines.join('\n') }
              }
              if (report.applied.length > 0) {
                lines.push('', 'Restart DSH so the patched adapter files are loaded.')
              }
              return { kind: 'success', text: lines.join('\n') }
            }

            if (action === 'restore' || action === 'undo' || action === 'revert') {
              const target = resolveTarget(config)
              if (target === undefined) {
                return { kind: 'error', text: `${TARGET_PACKAGE} was not found.` }
              }
              const result = restorePatches(target)
              if (result.restored.length === 0 && result.errors.length === 0) {
                return {
                  kind: 'error',
                  text: `No ${TARGET_PACKAGE} backup found — nothing to restore.`,
                }
              }
              const lines = [`restored: ${result.restored.join(', ') || '(none)'}`]
              if (result.errors.length > 0) lines.push(`errors: ${result.errors.join('; ')}`)
              lines.push('', 'Restart DSH to drop the patched adapter files.')
              return {
                kind: result.errors.length > 0 ? 'error' : 'success',
                text: lines.join('\n'),
              }
            }

            return {
              kind: 'error',
              text: `Unknown action "${action}". Use status, apply, restore, or why.`,
            }
          },
        }),
      'dsh-tencent-channel-fix:command',
    )
  })
  void subject
}

/** Read-only HTTP status, loopback only. Mutations stay on the slash command. */
function installRoute(ctx, config) {
  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => {
      const spec = {
        kind: 'prefix',
        path: ROUTE_BASE,
        handler: async (request, response) => {
          const address = request?.socket?.remoteAddress
          const loopback =
            address === '127.0.0.1' ||
            address === '::1' ||
            address === '::ffff:127.0.0.1' ||
            address === undefined
          if (!loopback) {
            sendJson(response, 403, { ok: false, error: 'loopback only' })
            return
          }
          if ((request.method ?? 'GET') !== 'GET') {
            sendJson(response, 405, { ok: false, error: 'read-only; use /' + COMMAND_NAME + ' apply' })
            return
          }
          try {
            sendJson(response, 200, buildStatus(config))
          } catch (error) {
            sendJson(response, 500, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        },
      }
      try {
        return scoped.webServer.register(spec, 'dsh-tencent-channel-fix:status')
      } catch (error) {
        // A profile without a web half is a normal configuration, not a failure.
        try {
          ctx.logger?.warn?.(
            `[dsh-tencent-channel-fix] status route not registered: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        } catch {
          // Nothing further to report with.
        }
        return () => {}
      }
    }, 'dsh-tencent-channel-fix:route')
  })
}

const WHY_TEXT = [
  'What this plugin repairs (patch revision 2)',
  '',
  '## The break you hit: CodeArts (Huawei Cloud) turns fail after an upgrade',
  '',
  '`dsh-our-free-model` (OFM) registers its CodeArts adapter with a fetch bound to',
  'a transport instance, then closes that instance in its own dispose effect. The',
  'adapter stays registered in the kernel\'s `llm` service, because',
  '`registerAdapterIdempotent()` deliberately keeps the existing route when a',
  'duplicate registration arrives ("插件 fiber 重启竞态，保留现有路由并跳过本次注册").',
  '',
  'So once the plugin fiber is disposed and re-created — an OFM hot reload, an',
  'in-app upgrade, or a DSH upgrade that re-applies the profile — every CodeArts',
  'request goes through the OLD adapter, whose fetch points at the CLOSED',
  'transport. The first call throws and the turn ends with',
  '`CodeArts 签名传输已停止` (code UNKNOWN).',
  '',
  'The repair replaces the captured instance with a closure over a process-wide',
  'lane (symbol-keyed on `globalThis`, so it also survives OFM\'s module purge),',
  'and rewires all three consumers — the auth service, the adapter, and the RPC',
  'fetcher. A retained adapter follows the successor transport instead of',
  'calling into a dead one.',
  '',
  '## The cleanup: revision 1 left a landmine',
  '',
  'Revision 1 injected a system-prompt rewriter into the direct adapter path that',
  'called `rewriteTencentContentFingerprints`. That function only exists in OFM',
  'builds carrying `CONTENT_FINGERPRINTS`; the pinned 2.5.8 bundle has neither, so',
  'any request through that path died with `ReferenceError` instead of the HTTP',
  'error the channel gate returned. Revision 2 removes the block.',
  '',
  '## What still applies from revision 1',
  '',
  'OFM 2.5.9+ retired the `buddy` / `workbuddy` channels outright',
  '(`isRetiredProvider()` returns true for both), so the `400 / code 11128`',
  'channel-gate fixes no longer have a live route to protect on this build. The',
  'attribution User-Agent sanitizer is kept — it is harmless when those channels',
  'are absent, and still correct for a profile that routes through them.',
  '',
  'Every edit is an exact, single-occurrence anchor: upstream drift is reported as',
  'DRIFTED and skipped, never forced. Each write is backed up and syntax-checked,',
  'and restored automatically if the check fails. `restore` undoes the last apply.',
].join('\n')

export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const log = makeLogger(ctx, settings.verbose)
  log.debug(`patch revision ${PATCH_REVISION} loading`)

  // Repair first: adapters are imported lazily on first model request, so a
  // write here lands before the module cache can hold the stock text.
  const outcome = runRepair(ctx, settings, log)

  // Guard against a second boot in the same process (hot reload / re-apply):
  // the repair itself is idempotent, but the command and route are not.
  const marker = '__dshTencentChannelFixInstalled'
  if (ctx[marker] === true) {
    log.debug('already installed on this context; skipping command and route')
    return
  }
  try {
    ctx[marker] = true
  } catch {
    // Frozen context — idempotency below still holds because the repair no-ops.
  }

  installCommand(ctx, settings, outcome)
  installRoute(ctx, settings)
}

export default { name, apply }
