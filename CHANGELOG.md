# Changelog

## 1.3.0 — 2026-10-28

### Fixed

- **换新账号后仍然报「并发会话数已达上限」——这不是账号的问题，是适配器自己的 bug。**

  `CodeArtsAdapter` 用一份硬编码清单
  （`CODEARTS_BENEFIT_FALLBACK = ["glm-5.3-flash", "deepseek-v4.1-flash"]`）
  判断某模型是不是「benefit 模型」，是的话每个请求都签上 `maas_type: benefit`。

  当账号没有这项权益时网关返回 `InferHub.4004.200 benefit not found`。适配器捕获它、
  设 `benefitHeaderDropped = true`、去掉头重试 —— 这一步是**成功**的。

  问题在于 `benefitHeaderDropped` 是个**每次调用都会重置的局部变量**，函数返回就忘了。
  于是**每一轮对话都要重新付一次这个注定失败的尝试**。而这个网关对失败请求同样收槽位费：

  1. 被拒的请求照样开一个会话槽（实测：3 次连续请求就填满 3 个上限，
     释放一个槽约需 150 秒）；
  2. 于是第 1 轮靠重试成功，第 2 轮发现已经满了，第 3 轮起每次都是
     `TM.00001041 并发会话数已达上限(3个)`。

  实测复现（全新 drain 170 秒后，同一 adapter 身份连续三轮）：

  | 尝试 | 结果 |
  |---|---|
  | turn1 #1 benefit | benefit-missing（烧掉一个槽） |
  | turn1 #2 no-benefit | **OK** |
  | turn2 #1 benefit | benefit-missing（又烧一个） |
  | turn2 #2 no-benefit | SLOT_FULL |
  | turn3 #1 benefit | SLOT_FULL |

  对照：同一账号，**完全不发 benefit 头**，6 次请求间隔 25 秒 ——
  `OK=6, SLOT_FULL=0`，首字 1.1–2.1 秒。

  这就是为什么换了全新账号、明明没有任何并发，仍然立刻报「槽位已满」——
  槽位是被这个每轮重复的失败尝试自己吃掉的。

  修复方式：把这个拒绝记在 **adapter 生命周期**上而不是单次调用上。
  学到一次之后，后续每轮直接跳过那个注定失败的请求。

### Changed

- Patch revision 4。新增两个 `vendor/channel-pack/pack.js` 补丁：
  `codearts-benefit-remembered`、`codearts-benefit-skip`。

### Verified

- 35 项测试通过（新增 2 项：断言拒绝被记住在 adapter 上、且下次调用会预先跳过）。
- 真实安装包上 7 个补丁全部 `patched`，`node --check` 通过。
- 行为验证：打补丁后连续 4 轮，第 1 轮学会，第 2 轮直接跳过 benefit 头（不再多烧槽）。

### Known limitation

- **每轮对话仍固定消耗一个会话槽，服务端上限 3、释放约需 150 秒。**
  这是华为云侧的硬限制，客户端绕不过。本次修复把它从「每轮烧 2 个」
  降到「每轮烧 1 个」—— 可用轮次从 1 轮变成 3 轮，之后仍需等槽位释放。
  想要无上限连续对话，只能换通道。

## 1.2.0 — 2026-10-28

### Fixed

- **CodeArts 首字要等好几分钟。** 根因不在模型，也不在网络：华为云对账号的
  并发会话上限是 3 个，满了会返回 `TM.00001041 并发会话数已达上限(3个)`。
  OFM 把这个错误判成「排队」（`isQueueError`），于是跳过抛错、递增
  `queueAttempts`、`delay(QUEUE_RETRY_DELAY_MS)` 后整条请求重来 ——
  默认 10 秒一次、最多 180 次，**即最坏 30 分钟一个字都不吐**。

  实测（操作者本机 `~/.dsh/channel-pack/token-ledger.json`，8 天 2634 次
  CodeArts 请求）：

  | 通道 | 平均首字 |
  |---|---|
  | codearts / deepseek-v4.1-flash | **114,639 ms（≈1.9 分钟）** |
  | qodercn / dfmodel | 2,645 ms |
  | buddy / deepseek-v4.1-flash | 2,626 ms |

  单次上游请求（复用本包自带的 `signRequestHuawei` 重新签名后直连测量）
  只要 **270~900 ms** 就返回 —— 换句话说，消失的那 110 秒全在重试循环里。

  修复方式是最小改动：`QUEUE_RETRY_DELAY_MS` 10000 → 1200、
  `QUEUE_MAX_ATTEMPTS2` 180 → 4。**最坏等待 30 分钟 → 4.8 秒（快 375 倍）**，
  同时保留 4 次重试，真·瞬时占满仍能自愈。

- **超时文案在撒谎。** 原文案 `queue wait timed out after 30 minutes` 在预算改成
  4.8 秒后已经不成立，且没说清原因和出路。改为直说「并发会话槽位已满（账号上限
  3 个），已尝试 N 次仍未释放」并给出两个动作。次数用
  `${QUEUE_MAX_ATTEMPTS2}` 插值，以后调预算文案不会失同步。
  错误码仍是 `QUEUE`，不动分类器和调用方。

### Changed

- Patch revision 3。新增两个 `vendor/channel-pack/pack.js` 补丁：
  `codearts-queue-budget`、`codearts-queue-message`。
  均为单次精确锚点，锚点消失/重复时报 drift 而不强改。

### Verified

- 33 项测试通过（新增 2 项：分别断言重试预算被压到秒级、文案换成真话）。
- 在真实安装包的临时副本上端到端跑过：两个新补丁落盘、rev2 的签名传输与 UA
  补丁保持完好、二次执行幂等、`node --check` 通过。

### Known limitation

- 快速失败后**不会**自动切到下一个模型。`QUEUE` 不在
  `src/route/classify.js` 的映射表里，落到 unknown → `shouldAdvance()`
  返回 false，combo 链不会因这次失败自动换道。它会明确报错让你换模型，
  但不替你换。若要自动换道，需要用 combo 并确保链上有可用成员。

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
  `apply()` and proves a retained adapter reaches the successor transport.

## 1.0.0 — 2026-10-20

### Added

- Initial release: sanitize the harness attribution User-Agent (400 / code
  11128 on the buddy / workbuddy channels) and repair the channel-fingerprint
  system prompt rewrite.
