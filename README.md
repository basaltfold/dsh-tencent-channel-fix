# dsh-tencent-channel-fix

Fixes the `400` / `code 11128` returned by the **buddy** and **workbuddy** channels in DeepSeek Harness, and keeps it fixed across upgrades.

> `请求被拦截，请重新发送` · `Illegal API invocation from an unapproved channel` · `INVALID_REQUEST`

Every new conversation dies on the first message, with nothing useful in the error. The message names neither the header nor the sentence that the gate actually rejected.

---

## What is actually wrong

Tencent's channel gate rejects **two** independent things inside the request. Both must be fixed; fixing one still returns `400`.

### 1. The attribution User-Agent

`dsh-our-free-model/adapter/kernel.js` publishes the harness identity as the request's `User-Agent`:

```
deepseek-harness/0.2.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)
```

The `deepseek-harness` token is on the gate's blocklist. The check is **case-insensitive** — `DeepSeek-Harness/0.2.1` is rejected too. Every other UA tested was accepted, including `curl`, `node`, `axios`, `undici`, `codex_cli_rs`, `claude-cli`, `opencode`, and the empty UA.

### 2. The harness identity sentence in the system prompt

DSH's base system prompt opens with:

```
You are an AI agent powered by DeepSeek Harness.
```

The gate treats `powered by DeepSeek Harness` as a **content fingerprint** and rejects the whole request when it appears in the system message.

This one is subtle: `dsh-our-free-model` already has a fingerprint-rewriting mechanism (`rewriteTencentContentFingerprints`), but it only runs on the **gateway** path (`convertMessage` / `toMessages`). The **direct adapter** path — the one `buddy` actually uses — assembled its system message with a bare `messages.unshift(...)` and never called the rewriter. So the sentence went out verbatim.

Measured on the real endpoint:

| Request | Result |
| --- | --- |
| stock system prompt + stock UA | `400` `code 11128` |
| stock system prompt + fixed UA | `400` `code 11128` |
| rewritten system prompt + fixed UA | `200 OK` |

The same gate also rejects `Main branch (you will usually use this for PRs)`, `You are Claude Code, Anthropic's official CLI for Claude.`, and `x-anthropic-billing-header` — which is why CLI-proxy projects hit the identical error. This plugin fixes the two that DSH itself sends.

---

## Why a plugin, and not a patch

Both defects are text inside `dsh-our-free-model`. Its updater rewrites those files wholesale, so a hand edit is lost on its next update — **that is exactly how this bug comes back**. It was fixed by hand once, returned after the plugin updated, and had to be fixed again.

This plugin repairs the two files on every boot instead:

- Written **once**, in `apply()`, before any model request — `pack.js` and `adapter/kernel.js` are imported lazily by that plugin on first use, so the write lands well ahead of the module cache.
- **Idempotent**: a repaired file is detected by marker and left byte-identical.
- **Drift-aware**: if upstream moves an anchor, that patch is skipped and reported — never forced, never half-written.
- **Self-reverting**: files are backed up before writing and `node --check`-ed after; any failure restores the originals.

An upgrade of `dsh-our-free-model` becomes a self-healing event instead of a regression.

---

## Install

```bash
dsh plugin add dsh-tencent-channel-fix
```

Or from this repository:

```bash
dsh plugin add github:basaltfold/dsh-tencent-channel-fix
```

Then restart DSH once. The boot log shows one of:

```
[dsh-tencent-channel-fix] repair applied — applied attribution-user-agent, content-fingerprints, direct-system-rewrite. Active from the next model request.
[dsh-tencent-channel-fix] repair incomplete (upstream dsh-our-free-model changed) — drifted ...
```

---

## Commands

### `/tencent-fix`

| Argument | Effect |
| --- | --- |
| *(none)* / `status` | Patch state for all three patches, plus the resolved target and version |
| `apply` | Force the repair now; prints what landed and what had drifted |
| `restore` | Put the newest backup back, undoing the repair |
| `why` | The root-cause explanation, in-conversation |

```
dsh-tencent-channel-fix · patch revision 1
target: C:\Users\you\.dsh\profiles\desktop\node_modules\dsh-our-free-model
dsh-our-free-model: 2.5.7

OK      attribution-user-agent — Attribution User-Agent (400 / code 11128)
OK      content-fingerprints — Rejected system-prompt fingerprints (400 / code 11128)
OK      direct-system-rewrite — Direct adapter path system rewrite (400 / code 11128)

3/3 patches in place.
```

### `GET /dsh-tencent-channel-fix`

The same status as JSON, loopback-only. `405` for anything but `GET`; mutations stay on the slash command.

---

## Configuration

Optional, in the bundle row:

```yaml
- insert:
    - id: tencent-channel-fix
      name: 'dsh-tencent-channel-fix'
      config:
        autoApply: true    # false = report drift only, never write
        target: ''         # explicit dsh-our-free-model directory
        verbose: false     # log every step, including no-op boots
```

`target` is resolved automatically from the active profile when empty — `${profile}/node_modules/dsh-our-free-model`, then Node's own resolution paths, then `~/.dsh/profiles/*/node_modules/`.

---

## Scope

- Touches exactly two files, both inside `dsh-our-free-model`: `adapter/kernel.js` and `vendor/channel-pack/pack.js`.
- Nothing else changes: no provider, model row, route, credential, or DSH file.
- The content rewrite is **provider-scoped** inside `pack.js` (`TENCENT_PROVIDERS = ["buddy", "workbuddy"]`), so every other channel passes through untouched.
- Attribution stays meaningful: the User-Agent remains present and non-empty and keeps its version — only the blocked token and URL are dropped.

---

## Verify

```bash
npm test        # 29 tests, no network, no real install touched
```

The suite builds targets in a temp directory from fixtures that reproduce both shipped shapes — `kernel.js` in LF, `pack.js` in CRLF — and covers idempotency, line-ending preservation, ambiguity detection, per-patch drift, dry-run, and backup restore. It also extracts the injected `sanitizeAttributionUserAgent` via `new Function` and asserts its real output.

To confirm against a live install without writing anything:

```bash
node -e "import('dsh-tencent-channel-fix/patcher').then(m => console.log(m.formatStatus(m.resolveTarget({}))))"
```

---

## Compatibility

DSH `>= 0.2.0-rc.1`. Verified against `0.2.0-rc.2` and `0.2.1-rc.2` with `dsh-our-free-model` `2.5.6` (stock, 0/3) and `2.5.7` (3/3).

If a future `dsh-our-free-model` moves an anchor, `/tencent-fix status` reports the patch as `drifted` with the reason, and the repair is skipped rather than forced. Re-derive the anchor from the new file and bump `PATCHES` in `lib/patcher.js`.

---

## Related

- [buddy-proxy#14](https://github.com/wnddd839/buddy-proxy/issues/14) — same gate, owner confirms the rejection is triggered by system-prompt wording, not headers
- [magpie#182](https://github.com/yetone/magpie/issues/182) — same `11128`, same cause

## License

MIT
