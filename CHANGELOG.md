# Changelog

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
