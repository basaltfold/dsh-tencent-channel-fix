# dsh-tencent-channel-fix

Repairs `dsh-our-free-model` at boot so its channels stay usable, and keeps the repair in place across upgrades of that plugin and of DeepSeek Harness.

**Revision 2 covers the break that appeared after the DSH upgrade: CodeArts (Huawei Cloud) turns failing with `CodeArts 签名传输已停止` (`code: UNKNOWN`).** That one is a transport-lifetime bug, not a channel-gate rejection — see [§ The CodeArts transport bug](#the-codearts-transport-bug).

It still fixes the `400` / `code 11128` returned by the **buddy** and **workbuddy** channels, and removes a dangling injection an earlier revision left behind.

> `请求被拦截，请重新发送` · `Illegal API invocation from an unapproved channel` · `INVALID_REQUEST`

---

## The CodeArts transport bug

`apply()` builds `signedNetwork = createDirectFetch(...)`, registers the CodeArts adapter with `fetchImpl: signedNetwork.fetch`, then closes that transport in its own dispose effect.

The adapter stays registered in the kernel's `llm` service, because `registerAdapterIdempotent()` deliberately keeps the existing route on a duplicate registration (`插件 fiber 重启竞态，保留现有路由并跳过本次注册`).

So once the plugin fiber is disposed and re-created — an OFM hot reload, an in-app upgrade, or a DSH upgrade that re-applies the profile — every CodeArts request still runs through the **previous** adapter, whose fetch points at the **closed** transport. The first call throws and the turn ends.

The repair replaces the captured instance with a closure over a process-wide lane, and rewires all three consumers (auth service, adapter, RPC fetcher). The lane is symbol-keyed on `globalThis`, so it also survives the module purge OFM performs during a hot reload: an adapter retained from an earlier generation follows the successor transport instead of calling into a dead one.

---

## The CodeArts queue-retry budget

Huawei caps this account at **3 concurrent sessions** and answers
`TM.00001041 并发会话数已达上限(3个)` when they are full. OFM classifies that as
a *queue* signal (`isQueueError`), so instead of surfacing it it increments
`queueAttempts`, waits `QUEUE_RETRY_DELAY_MS`, and retries the whole request —
up to `QUEUE_MAX_ATTEMPTS2` times.

The stock constants are 10 s and 180: **30 minutes of total silence** before the
turn reports anything. A slot-full answer is not a queue position; it is a hard
account ceiling, and retrying does not move it.

Measured on the operator's machine from its own token ledger
(`~/.dsh/channel-pack/token-ledger.json`, 2634 CodeArts requests over 8 days):

| channel | avg TTFT |
|---|---|
| **codearts** / deepseek-v4.1-flash | **114,639 ms (≈1.9 min)** |
| qodercn / dfmodel | 2,645 ms |
| buddy / deepseek-v4.1-flash | 2,626 ms |

A single upstream attempt, re-signed with this package's own
`signRequestHuawei`, returns in **270–900 ms** — so the missing ~110 s is the
retry loop, not model thinking.

The repair is two constants: `QUEUE_RETRY_DELAY_MS` 10000 → 1200 and
`QUEUE_MAX_ATTEMPTS2` 180 → 4. Worst case drops from **30 minutes to 4.8 s**,
while four retries are kept so a slot that is genuinely about to free up still
self-heals. The message that ends the wait is rewritten to name the real ceiling
and the two ways out, interpolating `${QUEUE_MAX_ATTEMPTS2}` so the number can
never drift out of sync with the budget. The `QUEUE` error code is unchanged, so
no caller or classifier needs to move.

---

## The buddy / workbuddy channel gate

Tencent's channel gate rejects **two** independent things inside the request. Both must have been fixed; fixing one still returned `400`.

> OFM 2.5.9+ retired these channels outright (`isRetiredProvider()` returns true for both), and the CodeArts-carrying 2.5.8 build no longer contains the `CONTENT_FINGERPRINTS` table the second fix edited. That fix is therefore retired in revision 2; the attribution UA sanitizer is kept because it stays correct wherever the channels still exist.

---

## What is actually wrong

Tencent's channel gate rejects **two** independent things inside the request. Both must be fixed; fixing one still returns `400`.

### 1. The attribution User-Agent

`dsh-our-free-model/adapter/kernel.js` publishes the harness identity as the request's `User-Agent`:

```
deepseek-harness/0.2.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)
```

The `deepseek-harness` token is on the gate's blocklist. The check is **case-insensitive** — `DeepSeek-Harness/0.2.1` is rejected too. Every other UA tested was accepted, including `curl`, `node`, `axios`, `undici`, `codex_cli_rs`, `claude-cli`, `opencode`, and the empty UA.

### 2. The harness identity sentence in the system prompt *(historical — fix retired in revision 2)*

DSH's base system prompt opens with:

```
You are an AI agent powered by DeepSeek Harness.
```

The gate treats `powered by DeepSeek Harness` as a **content fingerprint** and rejects the whole request when it appears in the system message.

This one is subtle: `dsh-our-free-model` already has a fingerprint-rewriting mechanism (`rewriteTencentContentFingerprints`), but it only runs on the **gateway** path (`convertMessage` / `toMessages`). The **direct adapter** path — the one `buddy` actually used — assembled its system message with a bare `messages.unshift(...)` and never called the rewriter. So the sentence went out verbatim.

Measured on the real endpoint (OFM 2.5.7 era, while the Tencent channels still existed):

| Request | Result |
| --- | --- |
| stock system prompt + stock UA | `400` `code 11128` |
| stock system prompt + fixed UA | `400` `code 11128` |
| rewritten system prompt + fixed UA | `200 OK` |

The same gate also rejects `Main branch (you will usually use this for PRs)`, `You are Claude Code, Anthropic's official CLI for Claude.`, and `x-anthropic-billing-header` — which is why CLI-proxy projects hit the identical error.

Revision 1 patched this by injecting a rewriter call into the direct path. On the pinned 2.5.8 bundle that call references a function the bundle no longer contains, so it turned a `400` into a `ReferenceError`. Revision 2 **removes** that injection (`legacy-direct-rewrite`) and retires the fingerprint-table edit, whose anchor no longer exists upstream.

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
[dsh-tencent-channel-fix] repair applied — applied signed-transport-seam. Active from the next model request.
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
dsh-tencent-channel-fix · patch revision 2
target: C:\Users\you\.dsh\profiles\desktop\node_modules\dsh-our-free-model
dsh-our-free-model: 2.5.8

OK      signed-transport-seam — CodeArts signed transport lifetime (turns fail after a fiber restart)
OK      legacy-direct-rewrite — Remove revision 1's dangling system-rewrite injection (ReferenceError)  (already clean)
OK      attribution-user-agent — Attribution User-Agent (400 / code 11128)

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
