# 测试报告 — dsh-qqbot-bridge 0.1.0

时间：2026-10-13
宿主：DeepSeek Harness 0.2.1-alpha.1 · DS Bot 0.1.2 · @tencent-connect/dsh-qqbot 0.5.0
Node：v22.19.0

## 一、结果汇总

命令：`node scripts/run-tests.mjs`（每个测试文件独立进程，无需 `pnpm install`）

| 测试文件 | 用例 | 通过 | 跳过 | 覆盖范围 |
| --- | --- | --- | --- | --- |
| `access.test.mjs` | 7 | 7 | 0 | 白名单 fail-closed、通配符显式化、群聊默认关闭、昵称不作身份 |
| `adapter.test.mjs` | 14 | 14 | 0 | 扩展点安装、消费/放行语义、监听器异常隔离、target 归一化、不可用适配器的显式失败、日志擦洗 |
| `bridge.test.mjs` | 25 | 25 | 0 | 端到端：进真实会话、回复回传、Web 消息不回传、Bot 中继不回传、指令路由、去重、越权拒绝、失败/中断/超时上报、分段、part 切换、多用户隔离 |
| `chunk.test.mjs` | 7 | 7 | 0 | 分段上限、超长单行硬切、代码块与表格不被切断、零上限保护 |
| `commands.test.mjs` | 12 | 12 | 0 | 四个必测指令、带文本切换、未知指令回落、中文名 not-found、重命名重注册 |
| `cordis-activation.test.mjs` | 8 | 8 | 0 | **真实 Cordis Context 上的服务注册语义**：`ctx.set` 报错精确复现、`provide` 注册/`set` 覆盖/dispose 注销、fork 发布服务、pre-handler 幂等与可移除、卸载注销、桥接激活与重载不冲突 |
| `e2e-fork.test.mjs` | 8 | 8 | 0 | **真实 fork 中间件链 + 真实桥接端到端**：往返、切换后落点、官方命令放行、Web 不泄漏、群聊不放行、失败上报、去重、越权 |
| `fork-extension.test.mjs` | 5 | 5 | 0 | fork 扩展点语义：链首执行、`true` 短路、`false` 放行到 stock 监听器、早于 stock accessPolicy、补丁标记 |
| `loader-composition.test.mjs` | 7 | 7 | 0 | **真实 profile 组合层（决定插件会不会被加载）**：`loadProfile` + `composeEntries`（DSH 自己的代码）解析真实 `profiles/web`，断言 bundle 顺序、bundle patch 存在且指向本工作区、最终配置树里 `qqbot-bridge` 行存在且 `name` 未被补丁吃掉、profile 覆盖整段 `config`（另用合成层做无副作用验证）、该 `config` 能通过插件自己的 schema、以及最终配置树里没有 Cordis 控制台日志导出器 |
| `loader-boot-activation.test.mjs` | 4 | 4 | 0 | **真实 `boot()` 流程**（`dsh web` 用的就是它）：Loader 装载夹具 + 本插件真实入口，断言 `[qqbot-bridge]` 控制台输出、fiber 处于 ACTIVE、`qqbotBridge` 可用、`bridge-status.json` 内容；缺服务时断言看门狗按名字复述等待；卸载后 phase 变 `stopped` 且服务注销 |
| `registry.test.mjs` | 9 | 9 | 0 | 只读解析 state.json、当前 part 变化、主 Bot、缺失/损坏文件不致命、名单变更通知 |
| `rejected-log.test.mjs` | 7 | 7 | 0 | 被拒 OpenID 记录与计数、最新优先、容量上限、重启恢复、损坏容错 |
| `router.test.mjs` | 5 | 5 | 0 | OpenID 路由持久化与重启恢复、Bot 消失后清理、损坏文件容错 |
| `startup.test.mjs` | 9 | 9 | 0 | **真实 Cordis Context 上跑真实 `apply()`**：Config schema 校验、`inject` 必须为空、`REQUIRED_SERVICES` 声明、`ctx.provide('qqbotBridge')` 发布、等待三个服务后装配传输层、预处理器接管消息、空名单拒绝并记录、无扩展点/无服务时的如实上报 |
| `state.test.mjs` | 13 | 13 | 0 | 去重窗口与容量、队列 FIFO/并发/拒绝、回复关联 FIFO/超时/放弃 |
| **合计** | **139** | **139** | **0** | 全部通过（fork 已重建，模块链接已就位） |

`fork-extension.test.mjs`、`e2e-fork.test.mjs`、`cordis-activation.test.mjs` 在未安装 fork 时自动 skip，安装后自动启用——它们跑的是**真实构建产物**上的真实中间件链与真实 Cordis Context。
`loader-composition.test.mjs` 在找不到 DSH checkout 或 `profiles/web` 时自动 skip。

### 测试过程中发现并修掉的真实缺陷

| 缺陷 | 影响 | 发现方式 |
| --- | --- | --- |
| **服务首次注册误用 `ctx.set()`**（fork 的 `qqbot`、桥接的 `qqbotBridge`） | 宿主启动报 `cannot set property "qqbot"/"qqbotBridge" without provide`，`2 entries did not activate`——QQ 网关与桥接**都没起来** | 真实宿主重启后的启动日志。所有单元测试都用一个把 `set` 当作赋值的假上下文，因此完全没发现 |
| 补丁把服务块插在 `const bot = new QQBot(...)` **之前** | `Cannot access 'bot' before initialization`（暂时性死区），插件仍无法激活 | 修完 `provide` 后立即被 `cordis-activation.test.mjs` 抓到 |
| fork 的 `setMessagePreHandler` 重复调用会抛错 | 热重载后网关将**没有**任何 pre-handler | 设计复查时发现；已改为替换语义并返回 disposer |
| 假上下文把 `ctx.set` 实现成普通赋值 | 掩盖了上面第一条致命缺陷，让 120 个测试全绿 | 真实宿主报警后才暴露；已用真实 Cordis Context 重写 `startup.test.mjs` 并新增 `cordis-activation.test.mjs` |
| **补丁的预处理器在 `setupMiddlewares` 里立即遍历数组注册**，而桥接是在网关启动时（之后）才 `setMessagePreHandler` | **扩展点完全失效**——官方 agent 会处理每一条本该由桥接接管的 QQ 消息 | `e2e-fork` 走真实中间件链时暴露；已改为「注册一个 wrapper，消息到达时再解析列表」 |
| 适配层把判定结果转成布尔，`Boolean('passthrough') === true` | **桥接吞掉所有消息**，包括官方 `/bot-ping`、`/new`、`/model` 等命令 | 同上；已改为严格 `=== true` |
| 桥接未把「是否接管」回传给适配层 | QQ 官方 agent 与桥接**同时回复同一条消息** | `startup.test.mjs` 的完整 `apply()` 路径 |
| 假适配器 `deliver()` 返回判定字符串、生产返回布尔 | 上述缺陷被假件掩盖，单测全绿 | 对照 `lib/adapter.js` 真实契约时发现；已统一 |
| `drain` 属性指向 `queue.drain()` 而非联合 drain | 测试无法确定性等待旁路任务 | 集成测试时序性失败 |
| `/法务` 这类中文指令被放行给官方 agent | 用户看到官方 agent 的回答而非「没有这个 Bot」 | 补 `/法务` 用例 |
| `pnpm install` 清掉 fork 的运行时依赖（link + hoisted linker 行为） | QQ 网关无法启动 | 安装后逐个 import 验证 |
| 测试把 `user/message`（事件类型）当成宿主订阅键 `session/event` | 端到端测试假失败 | 逐步插桩定位；生产代码一直正确 |
| **DSH 没有挂 Cordis 控制台日志导出器**，`ctx.logger` 只进内存环形缓冲 | 桥接**其实已经启动成功**，启动输出里却一行 `[qqbot-bridge]` 都没有，看起来像插件从未加载；数据目录也没被创建（原先只在首次写路由/拒绝记录时才 `mkdir`），进一步加深误判 | 用 DSH 自己的 `boot()` 起一个夹具，再手动 `ctx.logger.exporter()` 才看到那 11 行日志。修复：`lib/host-log.js` 直接写控制台 + `lib/status.js` 在 `apply()` 里立即建目录并写状态文件 |
| 插件级 `inject: ['sessionController', 'sessions']` 一旦有服务缺席，Cordis **静默挂起**，`apply()` 不会被调用，插件一句话都说不出 | 「服务没来」和「插件没加载」在观测上完全无法区分 | 复查 Cordis `Fiber` 状态机时发现。修复：`inject` 改为空数组，等待交给 `ctx.inject([...])` + 看门狗复述 `waitingFor` |
| 卸载/热重载与装配竞态：被卸载后 `ctx.effect()` 抛 `INACTIVE_EFFECT` | 会把一次正常卸载误记成 `phase: failed`，并且半装配的桥接没人拆除 | 新增的 `loader-boot-activation.test.mjs` 立刻抓到。修复：生命周期 effect **在第一个 `await` 之前**注册，`INACTIVE_EFFECT` 按正常关闭处理，teardown disposer 改为 async 并等待状态落盘 |

## 二、关键验收项与证据

规格要求「从 QQ 发消息 → 进入现有 Bot 会话 → 回复回传 → Web 可见 → 上下文连续」。自动化层面的对应：

| 验收点 | 测试 | 断言 |
| --- | --- | --- |
| 消息进入**已存在**的会话 | `a QQ message enters the existing 管家 session` | 只创建 1 个 agent，落在 `session-manager` |
| 不是伪装身份 | 同上 | `message.source.kind === 'qqbot-bridge'`，`peerId` 正确 |
| 回复回传 QQ | `the Bot answer is relayed back to the QQ peer` | QQ 侧收到 Bot 原文 |
| **Web 消息绝不外泄** | `a Web message is never relayed to QQ` | `sent.length === 0` |
| **Bot 内部中继绝不外泄** | `another Bot's internal relay is never relayed to QQ` | `sent.length === 0` |
| `/团队` 返回已有四个 Bot | `/团队 lists the existing four Bots` | 文案含「团队共 4 个 Bot」及四个名字 |
| `/程序员` 切换并确认 | `/程序员 switches and confirms…` | 回复与规格逐字一致 |
| 切换后进入程序员会话 | `after a switch the next message goes to that Bot session` | `session-coder-part2` 收到，管家没有 |
| 上下文连续（part 变化） | `the session is re-read so a part switch keeps working` | 新 part 收到，旧 part 未被再写 |
| 多用户不串线 | `two peers get their own answers, never each other` | A 看不到 B 的回答 |
| 越权拒绝 | `an unauthorised OpenID is consumed silently…` | 无人收到、无回复、有 warn 日志 |
| 空白名单全拒绝 | `an empty allowlist refuses everyone` | 0 个 agent |
| 未知指令不执行 | `an unknown slash command falls through…` | 0 个 agent，verdict 为 `passthrough` |
| 群里不路由高权限 Bot | `group messages are never routed…` | 0 个 agent |
| 失败诚实上报 | `a failed turn is reported honestly…` | 回复含「失败了」「AUTH」「DSH Web」 |
| 无人回答时提示去 Web | `a waiting peer is told to look in DSH Web…` | 超时后 QQ 收到提示 |
| 长文分段 | `a long answer is split into QQ-sized chunks` | 3 段，每段 ≤ 100 |

## 三、尚未自动化验证的部分（需要真实环境）

这些**没有**被上面的测试覆盖，必须在重启后用真实的 QQ 客户端验证：

1. **真实 QQ 往返**：QQ 私聊 `/团队` 收到回复、`/程序员` 切换确认、消息进入 Web 里程序员的会话、在 Web 里追问测试标识能接上。
2. **插件加载**：重启后终端应出现
   `[qqbot-bridge] apply() entered` / `provided the "qqbotBridge" service` /
   `STARTED: transport=dsh-qqbot-bridge/qq`，并且
   `C:\Users\All_in\.dsh\qqbot-bridge\bridge-status.json` 的 `phase` 为 `running`。
   这同时验证了 `@deepseek-ai/schemastery` 由宿主解析器供给、以及宿主确实加载了最新构建产物。
   一条命令即可判定：`node scripts/bridge-status.mjs`。
3. **重启恢复**：重启 DSH 后 `routing.json` 里的选择仍然有效（持久化本身已有单测）。
4. **网络异常**：断网、网关重连期间的行为（依赖 QQ SDK 自身重连）。
5. **工具审批**：QQ 触发的轮次若要求审批，审批卡会出现在 DSH Web（走 DSH 原生链，桥接未改动该路径）。
6. **回归**：Maid Atelier、DS Bot、DS-Bot-Skin、KunPet、Cost Meter 未被破坏——需要重启后人工确认侧边栏与各面板正常。

## 四、本机环境限制（对测试方式的影响）

* 当前会话文件策略为 `workspace-write`，工作区为 `C:\Users\All_in\.dsh\bot\workspace`；`D:\CodingData\Github\dsh\` 需要提权才能写入。
* `node --test` 在本机沙箱下因「piped stdio 子进程」被拒而 `spawn EPERM`，因此改用 `node <file>` / `stdio: 'inherit'` 的 runner。这是环境限制，不是代码问题。
* `pnpm`/`npx` 在本机沙箱下会因 npm cache 在沙箱外而 EPERM；插件设计为零运行时依赖，所以自测不需要它们。

## 五、如何复现

```powershell
cd D:\CodingData\Github\dsh\dsh-qqbot-bridge
node scripts/run-tests.mjs
# 期望：files: 15, failed: 0
```

安装 fork 后（两个环境变量都设上，否则 fork 相关的 13 条会 skip）：

```powershell
$env:DSH_QQBOT_FORK = 'D:\CodingData\Github\dsh\dsh-bridged-qqbot'
$env:DSH_QQBOT_PROFILE = 'C:\Users\All_in\.dsh\profiles\web'
node scripts/run-tests.mjs
# 期望：# tests 139 / # pass 139 / # fail 0 / # skipped 0
```

只跑这一轮新增的「宿主加载层」测试：

```powershell
node tests/loader-composition.test.mjs    # 真实 profile 组合层
node tests/loader-boot-activation.test.mjs # 真实 boot() 流程
```
