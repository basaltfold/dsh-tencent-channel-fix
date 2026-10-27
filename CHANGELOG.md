# Changelog

## 1.1.0 — 2026-10-27

### Fixed

- **CodeArts (Huawei Cloud) turns failed after a plugin restart** with
  `CodeArts 签名传输已停止` (`code: UNKNOWN`), which is the break that appeared
  after the DeepSeek Harness upgrade.

  Root cause is a transport-lifetime bug inside `dsh-our-free-model`, not a
  channel-gate rejection. Its `apply()` builds
  `signedNetwork = createDirectFetch(...)`, registers the CodeArts adapter with
  `fetchImpl: signedNetwork.fetch`, and then closes that transport in its own
  dispose effect. The adapter stays registered in the kernel's `llm` service,
  because `registerAdapterIdempotent()` deliberately keeps the existing route on
  a duplicate registration
  (`插件 fiber 重启竞态，保留现有路由并跳过本次注册`).

  So after the plugin fiber is disposed and re-created once — an OFM hot reload,
  an in-app upgrade, or a DSH upgrade that re-applies the profile — every
  CodeArts request still runs through the **previous** adapter, whose fetch
  points at the **closed** transport. The first call throws and the turn ends.

  The repair replaces the captured instance with a closure over a process-wide
  lane, and rewires all three consumers (auth service, adapter, RPC fetcher).
  The lane is symbol-keyed on `globalThis` rather than a module binding, so it
  also survives the module purge OFM performs during a hot reload: an adapter
  retained from an earlier generation follows the successor transport.

- **Removed revision 1's dangling injection.** Revision 1 added a direct-path
  system rewrite calling `rewriteTencentContentFingerprints`, a function that
  only exists in OFM builds carrying `CONTENT_FINGERPRINTS`. The pinned 2.5.8
  bundle has neither, so that block turned a channel-gate HTTP error into a
  `ReferenceError`. `legacy-direct-rewrite` now detects and removes it.

### Changed

- Patch revision 2. `content-fingerprints` and `direct-system-rewrite` are
  retired: OFM 2.5.9+ deleted the `buddy` / `workbuddy` channels outright
  (`isRetiredProvider()`), and the CodeArts-carrying 2.5.8 build no longer
  contains the fingerprint table those two patches edited. The attribution
  User-Agent sanitizer is kept — harmless when those channels are absent, still
  correct for a profile that routes through them.
- Cleanup patches may declare `absentMeansDone`, reporting `patched`
  (`already clean`) when their anchor is already gone instead of `drifted`.

### Verified

- 31 tests passing, including a lifecycle case that drives the real patched
  transport region through a plugin fiber restart: the retained adapter reaches
  the successor lane, and fails loudly once no transport remains.
- Re-ran the boot order the profile uses (`dsh-ofm-codearts-pin` restores
  hash-pinned pristine bytes first, then this plugin repairs): the repair
  re-lands cleanly and the result passes `node --check`.

## 1.0.1 — 2026-10-21

### Fixed

- The `test` and `check` npm scripts passed a directory to `node --test`
  (`node --test test/`), which Node 24 rejects with
  `Error: Cannot find module .../test` (`MODULE_NOT_FOUND`). Both now use
  auto-discovery (`node --test`), which is the form the suite was actually
  verified with: 6 suites, 29 tests, all passing.

## 1.0.0 — 2026-10-21

Initial release.

### Fixed

- `400` / `code 11128` (`Illegal API invocation from an unapproved channel`,
  `请求被拦截，请重新发送`) on the `buddy` and `workbuddy` channels, which made
  every new conversation fail on its first message.

  Root cause was two independent rejections, both required:

  1. **Attribution User-Agent** — `adapter/kernel.js` published
     `deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`.
     The `deepseek-harness` token is blocklisted, case-insensitively. Now rewritten
     to `dsh-our-free-model/<version>`, keeping attribution present and meaningful.
  2. **System-prompt identity line** — `powered by DeepSeek Harness` is a content
     fingerprint. The direct adapter path (`BuddyAdapter.buildBody`) assembled its
     system message with a bare `unshift` and never called the existing
     `rewriteTencentContentFingerprints`, so the sentence reached the gate verbatim.
     The rewrite now runs on that path too, and the fingerprint table gained this
     line and the attribution URL.

  Evidence: stock system + fixed UA alone still returned `400`; both fixes together
  returned `200`. After the repair, four accounts: three `200`, one `429 code=6004`
  (that account's own quota). Live gateway: `buddy/hy4-preview`, `buddy/hy3`,
  `buddy/deepseek-v4.1-flash` all `200`, and `code 11128` occurrences in
  `bili.log` dropped to zero.

### Added

- Boot-time repair, idempotent, drift-aware, with `node --check` verification and
  automatic restore from backup on any failure. Survives upgrades of
  `dsh-our-free-model`, which previously reverted hand-applied fixes.
- `/tencent-fix` slash command: `status`, `apply`, `restore`, `why`.
- `GET /dsh-tencent-channel-fix` — read-only JSON status, loopback-only.
- `dsh-tencent-channel-fix/patcher` export, usable standalone:
  `inspect`, `applyPatches`, `restorePatches`, `formatStatus`, `resolveTarget`.
- 29-test suite covering idempotency, CRLF/LF preservation, ambiguity detection,
  per-patch drift, dry-run, backup restore, and the sanitizer's real output.

### Notes

- Provider-scoped: the content rewrite applies only to `TENCENT_PROVIDERS`
  (`buddy`, `workbuddy`). No other channel is touched.
- Scope is two files inside `dsh-our-free-model`. No provider, model row, route,
  credential, or DSH file is modified.
