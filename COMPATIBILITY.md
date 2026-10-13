# 兼容性文档 — dsh-qqbot-bridge

## 一、已验证的版本矩阵

| 组件 | 版本 | 状态 |
| --- | --- | --- |
| DeepSeek Harness | 0.2.1-alpha.1 | 已按其源码核实所有接口 |
| DS Bot (`ds-bot`) | 0.1.2 | 已逐文件读源码核实 |
| @tencent-connect/dsh-qqbot | 0.5.0 | 已逐文件读 dist 核实；需要补丁 0001 |
| @tencent-connect/qqbot-nodejs | ^1.0.4（随插件安装） | 已核实中间件与事件语义 |
| Node | ^22.19.0 \|\| >=24.0.0 | 本机 v22.19.0 通过 |

## 二、桥接依赖的 DSH 契约

这些是**公开 Host API**，不是内部实现细节。升级 DSH 时应重点回归：

| 契约 | 位置 | 桥接用途 |
| --- | --- | --- |
| `ctx.on('session/event', (session, event) => …)` | `packages/core/session` | 收集 `assistant/message`、感知 `turn/end` |
| `event.data.source`（`user/message`） | `packages/core/session` | 判定本轮是否由桥接触发 |
| `ctx.sessionController.resolveAgent(sessionId)` → `{agent}` \| `{error}` | `packages/api/session-controller/src/agent.ts:170` | 拿到 live agent（冷会话自动 resume） |
| `agent.followup(message)` / `agent.session` | `packages/core/agent` | 投递消息 |
| `ctx.sessions.flush(session)` | `packages/core/session/src/index.ts:1190` | 落盘后再报成功 |
| `createUserMessage({ content, source })` | `@deepseek-ai/dsh-llm` | 构造消息；`source` 为桥接自有 kind |
| `MessageSourceMap` 声明合并 | `@deepseek-ai/dsh-llm` | 让自有 `source.kind` 合法（DS Bot 的 `'bot'`、官方 `'user-rpc'` 同样做法） |
| `ctx.provide(name, value)` | Cordis | 首次注册服务（发布 `qqbotBridge` 供诊断）；返回 disposer，卸载自动注销 |
| `ctx.get(name, false)` | Cordis | 服务不存在时返回 `undefined` 而不是抛错 |
| `ctx.inject([...names], cb)` | Cordis | 等待服务出现；**不要**用插件级 `inject` 声明会一直缺席的服务（见下） |
| `ctx.effect(fn, label)` | Cordis | 生命周期与定时刷新；fiber 已 dispose 时抛 `INACTIVE_EFFECT`（`error.code`） |
| Cordis logger 的导出器 | `vendor/cordis/src/logger.ts` | **默认只有内存环形缓冲**，没有控制台导出器（见「日志通道」） |
| `@deepseek-ai/schemastery` 的 `Schema.object/union/array/boolean/number/string` | 宿主提供 | 配置校验 |

**不使用**：`/api/bot` HTTP 端点（需浏览器 cookie，且会把内部接口暴露给 QQ 侧）、`ctx.sessionController.prompt`（无法自定义 `source`，这正是 Web/QQ 无法区分的原因，见 `lib/source-tag.js`）、任何 `state.json` 写操作。

## 三、桥接依赖的 DS Bot 契约

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| Bot 的 `id` = 首个会话段的 sessionId，永不改变 | `store.js:196-206` | 作为稳定键使用 |
| **当前**会话是 `bots[id].sessionId`，长对话换 part 时会变 | `parts.js:706-731` | **每次发送前重读**，绝不长期缓存 |
| 旧 part 记在 `bots[id].segments[]` | `store.js:211-214` | 只在诊断里用到 |
| `state.json` 路径 `<DSH_HOME>/bot/state.json`，原子写 + `state.lock` | `index.js:42`、`store.js:36-53`、`167-182` | 只读，尊重锁 |
| 投给旧 part 的消息会被 `agent/pre-step` 转发到当前 part 并 reject 那一轮 | `parts.js:752-759` | 因此必须重读，否则答复会落在别处 |
| 群聊当前会话是 `room.sessions[botId]` | `store.js:215-220` | v1 未使用（群聊关闭） |

DS Bot **没有** `Config` schema、没有 `ctx.provide`、没有 websocket、没有事件总线导出，`rt` 是 `apply` 内的闭包局部对象 —— 外部无法复用其内部函数，这是本桥接只依赖上面这些公开契约的原因。

## 四、桥接依赖的 QQ 插件契约（fork 后）

`scripts/make-bridged-qqbot.mjs` 生成的服务：

| 成员 | 语义 |
| --- | --- |
| `setMessagePreHandler(handler)` | 安装 pre-handler；`handler(mCtx)` 返回 `true` 表示已接管（短路），否则放行。**同一个 handler 重复安装是替换而非报错**（热重载会再调一次），返回一个移除该 handler 的 disposer |
| `sender.sendMarkdown(target, content, opts?)` | 与插件内部同一条出站路径，含被动回复三级兜底与限额 |
| `replyTargetFor(scope, targetId)` | 构造 `{scope, targetId}`，msgId 由官方 sender 自行解析 |
| `preHandlerCount` | 当前已安装的 pre-handler 数量（诊断用） |
| `manager` / `bot` / `config` | 原样暴露，供诊断与后续扩展 |

`mCtx` 形状（官方 SDK，未改动）：`{ message, replyTarget, state, stop(reason), stopped, signal }`；`message` 含 `messageId`、`kind`、`senderId`（= 真实 `user_openid`）、`groupOpenid`、`content`。

### 服务注册（Cordis 4）

这是本补丁最关键、也最容易写错的一点。Cordis 4 把两种操作分得很清：

| 调用 | 语义 |
| --- | --- |
| `ctx.provide(name, value)` | **注册新服务**，归当前 fiber 所有，返回 disposer；fiber 卸载时服务自动注销 |
| `ctx.set(name, value)` | **只能覆盖已被某个 fiber provide 的服务**；否则抛 `cannot set property "<name>" without provide` |
| `ctx.get(name, strict?)` | 读取服务；`strict: false` 时服务不存在返回 `undefined` 而不是抛错 |

fork 与桥接两侧原先都误用了 `ctx.set` 做首次注册，因此宿主启动时报出
`cannot set property "qqbot" without provide` 与
`cannot set property "qqbotBridge" without provide`，结果是
`2 entries did not activate`——QQ 网关与桥接都没起来。现在：

* fork 用 `ctx.provide('qqbot', …)`（见 `patches/0001`）；
* 桥接用 `ctx.provide('qqbotBridge', …)` 发布自己，并用
  `ctx.inject(['sessionController', 'sessions', 'qqbot'], …)` **等待**三个服务
  全部可用后才装配传输层——服务消失时回调随之停止，所以桥接不会持有一个已被注销的服务。

`tests/cordis-activation.test.mjs` 在**真实 `@deepseek-ai/cordis` Context** 上覆盖
了这些语义：注册、覆盖、注销、重复加载不冲突、以及两条原始报错的精确复现。

#### 为什么插件级 `inject` 是空的

Cordis 对**声明了但永远不出现**的服务依赖，处理方式是**静默挂起**：fiber 停在
`pending`，`apply()` 根本不会被调用，插件自己一句话都说不出来。宿主虽然会在启动审计里
打印 `warning: 1 entry did not activate … pending (waiting for service: x)`，但插件侧
完全失声。

所以 `lib/index.js` 的 `export const inject` 是空数组，`apply()` 无条件运行，
真正的等待交给 `ctx.inject(REQUIRED_SERVICES, …)`，并配一个看门狗
（`watchdogIntervalMs`，默认 10s）反复打印：

```
[qqbot-bridge] waiting for service(s): sessionController, sessions, qqbot
[qqbot-bridge] still waiting for service(s): qqbot -- the bridge is loaded but cannot carry messages yet
```

依赖关系没有变，变的只是「等待期间不再无声」。

### 日志通道（DSH 没有挂 Cordis 控制台日志导出器）

这是本项目第二轮卡点的根因，升级 DSH 时必须回归：

| 事实 | 证据 |
| --- | --- |
| Cordis 的 `LoggerService` 默认只注册**一个内存环形缓冲导出器** | `vendor/cordis/src/logger.ts`：构造函数里 `self.exporter({ colors: 3, export: message => { buffer.push(message) } })` |
| 要打到终端，必须额外挂 `@deepseek-ai/cordis-plugin-logger-console`（`ConsoleExporter` 构造时调用 `ctx.logger.exporter(this)`） | `vendor/logger-console/src/shared.ts` |
| **没有任何 DSH bundle、也没有 CLI 依赖挂它** | 全部 `packages/bundle/*/cordis.patch.yml` 无 `logger` 行；`apps/cli/package.json` 不依赖该包；`--dump-config` 的最终配置树里也没有 |
| DSH 自己的端到端夹具承认这一点：观察者必须手动挂导出器**并且**排空 `ctx.logger.buffer` 才能看到插件日志 | `apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts`（"HMR reports through Cordis logger exporters"） |

结论：在 `dsh web` 里，**只走 `ctx.logger` 的日志等于没写**——它进缓冲区，永不显示。
这正是「插件其实启动成功、启动输出里却一行 `[qqbot-bridge]` 都没有」的原因。

因此桥接的生命周期信息走 `lib/host-log.js`（直接 `console.log/warn/error`，前缀
`[qqbot-bridge]`），同时仍然发给 `ctx.logger` 供挂了导出器的宿主使用，两条通道共用
`lib/log.js` 的脱敏器。第二重记录是 `<dataDir>/bridge-status.json`（`lib/status.js`），
`apply()` 一开始就创建数据目录并写下它。

`tests/loader-composition.test.mjs` 会断言最终配置树里确实没有控制台导出器；
`tests/loader-boot-activation.test.mjs` 则在真实 `boot()` 流程里抓取控制台输出，
保证「激活一定看得见」这件事有回归保护。

## 五、与官方插件行为的差异（有意为之）

| 项 | 官方插件 | 本桥接 |
| --- | --- | --- |
| 空白名单 | 翻译成 `['*']` → 全部放行 | **拒绝所有人** |
| 未知斜杠指令 | `next()` → 当成聊天发给 agent | 识别为不属于桥接，原样交回官方；纯中文的给「没有这个 Bot」 |
| 会话 | 每个 QQ 用户自建独立 session | 复用**已有 Bot 的 session** |
| 群聊 | 支持（`requireMention`） | v1 关闭，群消息原样交回官方链路 |
| 流式 | c2c 默认开启 | v1 完整回复模式 |

## 六、升级注意

* **升级 `@tencent-connect/dsh-qqbot`**：必须重新生成 fork（补丁按字符串锚点定位，锚点变了脚本会明确报错并拒绝写入，不会写出半成品）。
* **升级 DSH**：重点回归 `resolveAgent`、`session/event` 的事件名与 `turn/end` 的 `reason` 形状、`createUserMessage` 的签名。
* **升级 DS Bot**：重点回归 `state.json` 的结构（`bots` / `mainBotIds` / `revision`）与「当前 part」写在哪。若 `bots[].sessionId` 改名，改 `lib/registry.js` 一处即可。
* 本插件零运行时依赖，因此不受 npm 生态升级影响。

## 七、其它插件的兼容性

只读、无耦合。特别确认：

* 不修改 DSH 内核（`D:\CodingData\Github\deepseek-harness` 全程只读）。
* 不触碰 `dsh-bot-skin`、`dsh-cost-meter`、`kunpet-plugin`、`dsh-kun-liko-pet` 等目录。
* profile 层只新增两个 `link:` 依赖与一个 bundle 名；`dsh-skin managed` 段未被改动。
* DS Bot 的四个 Bot、团队记忆、聊天历史、皮肤配置全程未修改。
