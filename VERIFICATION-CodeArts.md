# CodeArts 修复 — 验证记录

日期：2026-10-27
目标：`C:\Users\ccc\.dsh\profiles\desktop\node_modules\dsh-our-free-model`（2.5.8，由 `dsh-ofm-codearts-pin` 钉住）

## 1. 故障现象（真实会话事件）

从 `~/.dsh/sessions/**/session.v4.jsonl.zstd` 解压出的 `turn/end` 事件：

```
2026-10-27T09:42:47.835Z  codearts/deepseek-v4.1-flash  error  [UNKNOWN] CodeArts 签名传输已停止
2026-10-27T09:48:27.180Z  codearts/deepseek-v4.1-flash  error  [UNKNOWN] CodeArts 签名传输已停止
2026-10-27T10:03:17.465Z  qodercn/dfmodel                error  [UNKNOWN] CodeArts 签名传输已停止
```

同一天 `codearts` 的 token-ledger 计数：`requests 66 / errors 22`（前一日 `8 / 2`、`30 / 0`）。
触发点是 2026-10-27 18:20 那次 DSH 升级重启（`settings.json` 的 `reloadedAt=1793096423793`）。

## 2. 根因

`pack.js` 的 `apply()`：

```js
const signedNetwork = createDirectFetch({ outlet: config.outlet });
const detachSignedNetwork = attachDirectFetch(signedNetwork.fetch);
ctx.effect(() => () => {
  detachSignedNetwork();
  void signedNetwork.close();          // ← 关闭 lifetime
});
...
const service = new CodeArtsAuth(ctx, { fetcher: signedNetwork.fetch });   // 捕获实例
  fetchImpl: signedNetwork.fetch,                                          // 捕获实例
  codeartsFetcher: signedNetwork.fetch                                    // 捕获实例
```

`close()` 里的 `lifetime.abort(new DOMException("CodeArts 签名传输已停止", "AbortError"))`
就是错误原文的来源。而适配器注册在内核 `llm` 服务里不会随 fiber 一起消失：

```js
function registerAdapterIdempotent(llm, providers, adapter, warn) {
  try { return llm.registerAdapter(providers, target); }
  catch (error) {
    if (!isDuplicateRegistrationError(error)) throw error;
    warn?.(`... 已注册（插件 fiber 重启竞态），保留现有路由并跳过本次注册`);
    return void 0;
  }
}
```

所以 fiber 重建一次之后，请求仍走上一代适配器 → 它的 fetch 指向已 abort 的 lifetime → 第一次调用即抛错。

## 3. 诊断期间同时发现的第二个缺陷（revision 1 遗留）

线上 `pack.js`：`rewriteTencentContentFingerprints(` 出现 **2** 次，函数定义 **0** 次。
revision 1 的 `direct-system-rewrite` 成功注入、`content-fingerprints` 却因锚点消失而 drifted
——因为 2.5.8 已经没有 `CONTENT_FINGERPRINTS` / `TENCENT_PROVIDERS`。
结果是 `BuddyAdapter.buildBody` 调用未定义标识符：同渠道的请求会变成 `ReferenceError`。

## 4. 修改内容（patch revision 2）

`vendor/channel-pack/pack.js`：

- `var signedLane = globalThis[Symbol.for("our-free-model.signed-lane")] ??= { fetch: void 0 };`
  —— 进程级、symbol 键，OFM 热重载清理模块缓存后依然存在。
- `apply()` 在 dispose 前发布 `signedLane.fetch = signedNetwork.fetch`，并生成
  `signedFetch` 闭包，每次调用都重读 lane。
- dispose 只在 lane 仍指向自己时才清空，避免把后继传输「反发布」。
- 三个使用方改为 `signedFetch`：`new CodeArtsAuth(...)`、`fetchImpl:`、`codeartsFetcher:`。
- 删除 revision 1 注入的 `rewriteTencentContentFingerprints` 块（`legacy-direct-rewrite`）。

## 5. 验证

| 项 | 结果 |
| --- | --- |
| `node --check pack.js` | exit 0 |
| 线上 `rewriteTencentContentFingerprints(` 计数 | 0 |
| `signedLane` 声明 | 1 |
| `signedFetch` 使用方 | 3 |
| `/dsh-tencent-channel-fix` 状态 | `patchRevision 2`, `patchedCount 3` |
| 插件测试套件 | 31 tests / 31 pass / 0 fail |
| 真实代码驱动的 fiber 重启复现 | 保留的旧适配器 **能** 到达后继传输（修复前抛 `transport stopped`） |
| 钉住→修复的启动顺序模拟 | 修复能在 pristine 字节之上重新落地，`node --check` 通过 |

## 6. 生效条件

DSH 进程启动于 `2026-10-27 18:20:49`，补丁写入于 `20:56:41` —— **正在运行的进程内存里仍是旧代码**。
需要重启一次 DSH，新代码才会被加载；下次启动时插件会自行复检并报告 `3/3`。

## 7. 回滚

每个被改文件写入前都留了 `.dsh-tencent-channel-fix.bak`：

```bash
# 用插件自带的还原（取最新备份）
node -e "import('dsh-tencent-channel-fix/patcher').then(m=>console.log(m.restorePatches(m.resolveTarget({}))))"
```

或直接复制：
`pack.js.2026-10-27T12-56-41-897Z.dsh-tencent-channel-fix.bak` → `pack.js`

`dsh-ofm-codearts-pin` 也会在下次启动时把 `pack.js` 还原成 manifest 钉住的 2.5.8 原版
（sha256 `3ccaaed171c5...`），随后 `dsh-tencent-channel-fix` 重新打补丁 —— 两条路都能回到原状。
