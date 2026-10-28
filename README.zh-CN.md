# dsh-tencent-channel-fix

在启动时修复 `dsh-our-free-model`，让它的渠道保持可用，并在该插件与 DeepSeek Harness 升级后自动重打。

**revision 2 针对的是 DSH 升级后新出现的问题：CodeArts（华为云）渠道报 `CodeArts 签名传输已停止`（`code: UNKNOWN`）。** 这是传输对象的生命周期 bug，不是渠道网关的拒绝——见 [§ CodeArts 传输 bug](#codearts-传输-bug)。

它同时继续修 **buddy** / **workbuddy** 渠道的 `400` / `code 11128`，并清掉上一版留下的一个悬空注入。

> `请求被拦截，请重新发送` · `Illegal API invocation from an unapproved channel` · `INVALID_REQUEST`

---

## CodeArts 传输 bug

`apply()` 先 `signedNetwork = createDirectFetch(...)`，把 CodeArts 适配器用 `fetchImpl: signedNetwork.fetch` 注册上去，然后在自己的 dispose 里关闭这个传输对象。

而适配器仍留在内核的 `llm` 服务里——`registerAdapterIdempotent()` 遇到重复注册时会**故意保留已存在的路由**（`插件 fiber 重启竞态，保留现有路由并跳过本次注册`）。

于是只要插件 fiber 被销毁并重建一次（OFM 热重载、应用内升级，或 DSH 升级后重新应用 profile），CodeArts 请求仍然走**上一代**适配器，而它的 fetch 指向**已关闭**的传输对象。第一次调用就抛异常，这一轮直接失败。

修复方式是把「捕获的实例」换成「对一条进程级通道的闭包」，并改写全部三个使用方（鉴权服务、适配器、RPC fetcher）。通道用 symbol 挂在 `globalThis` 上，所以 OFM 热重载清理模块缓存时它也依然存在：上一代留下的适配器会跟随新一代传输，而不是调用一个已经死掉的。

---

## CodeArts 的排队重试预算

华为云给这个账号的并发会话上限是 **3 个**，占满就返回
`TM.00001041 并发会话数已达上限(3个)`。OFM 把它归类为「排队」信号
（`isQueueError`），于是不向上报错，而是递增 `queueAttempts`、
等 `QUEUE_RETRY_DELAY_MS`、再把整条请求重来 —— 最多 `QUEUE_MAX_ATTEMPTS2` 次。

默认值是 10 秒和 180 次：**整整 30 分钟一个字都不吐**，然后才报错。
但「槽位已满」不是排队位置，它是账号的硬上限，重试并不会让它挪动。

在操作者本机实测（数据来自它自己的 token 账本
`~/.dsh/channel-pack/token-ledger.json`，8 天 2634 次 CodeArts 请求）：

| 通道 | 平均首字 |
|---|---|
| **codearts** / deepseek-v4.1-flash | **114,639 ms（≈1.9 分钟）** |
| qodercn / dfmodel | 2,645 ms |
| buddy / deepseek-v4.1-flash | 2,626 ms |

而单次上游请求（用本包自带的 `signRequestHuawei` 重新签名后直连测量）
只要 **270~900 ms** 就返回 —— 所以说，消失的那 110 秒全在重试循环里，
不是模型在思考。

修复只动两个常量：`QUEUE_RETRY_DELAY_MS` 10000 → 1200、
`QUEUE_MAX_ATTEMPTS2` 180 → 4。最坏等待从 **30 分钟降到 4.8 秒**，
同时保留 4 次重试 —— 对「马上就要空出来」的槽位仍能自愈。
收尾的那句文案也改了：说清真实上限和两个可选动作，
并用 `${QUEUE_MAX_ATTEMPTS2}` 插值，以后调预算数字不会失同步。
错误码仍是 `QUEUE`，调用方和分类器都不用改。

---

## buddy / workbuddy 的渠道网关

渠道网关同时拒绝了请求里的**两个**独立内容，只修一个仍然是 `400`。

> OFM 2.5.9+ 已彻底下架这两个渠道（`isRetiredProvider()` 对两者都返回 true），而仍带 CodeArts 的 2.5.8 构建里也已经没有第二个修复所编辑的 `CONTENT_FINGERPRINTS` 表。因此该修复在 revision 2 中退役；归属 UA 的清洗保留——在渠道仍然存在的环境里它依然是正确的。

### 1. 归属 User-Agent

`dsh-our-free-model/adapter/kernel.js` 把 harness 身份当作 `User-Agent` 发出去：

```
deepseek-harness/0.2.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)
```

`deepseek-harness` 这个 token 在黑名单上，且**大小写不敏感**——`DeepSeek-Harness/0.2.1` 一样被拦。实测其它所有 UA 都放行，包括 `curl`、`node`、`axios`、`undici`、`codex_cli_rs`、`claude-cli`、`opencode` 和空 UA。

### 2. 系统提示词里的身份句

DSH 的基础 system prompt 开头是：

```
You are an AI agent powered by DeepSeek Harness.
```

网关把 `powered by DeepSeek Harness` 当作**内容指纹**，出现在 system 里就整条拒绝。

这一点很隐蔽：`dsh-our-free-model` 本来就有指纹改写机制（`rewriteTencentContentFingerprints`），但它**只在网关路径**（`convertMessage` / `toMessages`）里调用。而 `buddy` 走的是**直连 adapter 路径**，那里的 system 拼装是裸的 `messages.unshift(...)`，从来没调过改写器——所以那句话原样发了出去。

真机实测：

| 请求 | 结果 |
| --- | --- |
| 原版 system + 原版 UA | `400` `code 11128` |
| 原版 system + 已修 UA | `400` `code 11128` |
| 改写 system + 已修 UA | `200 OK` |

同一道校验还会拦 `Main branch (you will usually use this for PRs)`、`You are Claude Code, Anthropic's official CLI for Claude.` 和 `x-anthropic-billing-header`——这也是各类 CLI 代理项目撞到同一个报错的原因。本插件只修 DSH 自己会发的这两处。

---

## 为什么做成插件，而不是打个补丁

两处缺陷都是 `dsh-our-free-model` 里的文本。它的更新器是整文件覆盖，手工改的东西在下次更新时必然丢失——**这个 bug 上次就是这么复发的**：先手工修好，插件一升级又回来了，再修一次。

所以这个插件改成**每次启动重打**：

- 只写一次，在 `apply()` 里、任何模型请求之前——`pack.js` 和 `adapter/kernel.js` 是被那个插件懒加载的，写入远早于模块缓存。
- **幂等**：已修的文件靠 marker 识别，逐字节不动。
- **认漂移**：上游把锚点挪走时，该 patch 跳过并报告，不硬改、不写一半。
- **失败自还原**：写前备份、写后 `node --check`，任何一步失败就还原原文件。

于是 `dsh-our-free-model` 升级不再是回归，而是一次自愈。

---

## 安装

```bash
dsh plugin add dsh-tencent-channel-fix
```

或直接从本仓库装：

```bash
dsh plugin add github:basaltfold/dsh-tencent-channel-fix
```

重启一次 DSH，启动日志会出现其中一条：

```
[dsh-tencent-channel-fix] repair applied — applied signed-transport-seam. Active from the next model request.
[dsh-tencent-channel-fix] repair incomplete (upstream dsh-our-free-model changed) — drifted ...
```

---

## 命令

### `/tencent-fix`

| 参数 | 作用 |
| --- | --- |
| （空）/ `status` | 三个 patch 的状态、解析到的目标目录与版本 |
| `apply` | 立刻强制重打，打印哪些落地、哪些漂移 |
| `restore` | 用最新备份还原，撤销修复 |
| `why` | 在对话里给出根因说明 |

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

同样的状态，JSON 格式，仅限本机回环。非 `GET` 返回 `405`；写操作只走斜杠命令。

---

## 配置

可选，写在 bundle row 里：

```yaml
- insert:
    - id: tencent-channel-fix
      name: 'dsh-tencent-channel-fix'
      config:
        autoApply: true    # false = 只报漂移，永不写入
        target: ''         # 显式指定 dsh-our-free-model 目录
        verbose: false     # 连无需改动的启动也打日志
```

`target` 为空时自动解析：`${profile}/node_modules/dsh-our-free-model` → Node 自身解析路径 → `~/.dsh/profiles/*/node_modules/`。

---

## 作用范围

- 只碰两个文件，都在 `dsh-our-free-model` 里：`adapter/kernel.js` 与 `vendor/channel-pack/pack.js`。
- 其它一切不动：provider、model row、路由、凭据、DSH 本体文件。
- 内容改写是**按 provider 收敛**的（`pack.js` 内 `TENCENT_PROVIDERS = ["buddy", "workbuddy"]`），其它渠道原样透传。
- 归属仍然有效：UA 依然存在、非空、保留版本号——只去掉了被拦的 token 和 URL。

---

## 验证

```bash
npm test        # 29 个用例，不联网，不碰真实安装
```

测试在临时目录里按两个文件的**实际出厂形态**造目标（`kernel.js` 是 LF，`pack.js` 是 CRLF），覆盖幂等、行尾保持、歧义检测、逐 patch 漂移、dry-run、备份还原；还会用 `new Function` 抽出注入的 `sanitizeAttributionUserAgent` 并断言其真实输出。

想对真实安装做只读确认：

```bash
node -e "import('dsh-tencent-channel-fix/patcher').then(m => console.log(m.formatStatus(m.resolveTarget({}))))"
```

---

## 兼容性

DSH `>= 0.2.0-rc.1`。已在 `0.2.0-rc.2`、`0.2.1-rc.2`、`0.2.1-rc.3` 上验证，搭配 `dsh-our-free-model` `2.5.8`（revision 2 下 3/3）。

若将来 `dsh-our-free-model` 挪了锚点，`/tencent-fix status` 会把它标成 `drifted` 并给出原因，且跳过而不硬改。到新文件里重新提取锚点，更新 `lib/patcher.js` 的 `PATCHES` 即可。

---

## 相关

- [buddy-proxy#14](https://github.com/wnddd839/buddy-proxy/issues/14) — 同一道网关校验，作者确认触发点是系统提示词用词，不是请求头
- [magpie#182](https://github.com/yetone/magpie/issues/182) — 同样的 `11128`，同样原因

## 许可

MIT
