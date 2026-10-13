# dsh-qqbot-bridge

[English](README.md) · **简体中文**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-138%20passing-brightgreen.svg)](TEST-REPORT.md)

把 **QQ 官方机器人的私聊**接进你已有的 **DS Bot 四人团队**。

一条 QQ 私聊消息会进入对应 Bot **真实存在的 DSH 会话**——同一个会话 id、同一套角色指令、同一份长期记忆、同一个模型。Bot 的回复再被送回 QQ。Web 端和 QQ 端看到的是**同一段对话**。

> 不会新建替代 Agent，不会复制 System Prompt 伪装身份，不写入 `state.json`，不启动第二个 QQ 网关。

### 一句话卖点

| | 常见的「QQ ⇄ 大模型」桥 | 本项目 |
| --- | --- | --- |
| 身份 | 复制一段 System Prompt | **复用真实会话**（`resolveAgent` + `agent.followup`） |
| 上下文 | 每次从零开始 | 该 Bot 的真实历史、长期记忆、工作区 |
| Web ⇄ QQ | 两个互不相通的世界 | **一个会话**：QQ 里说一半，Web 里接着问，上下文连续 |
| QQ 网关 | 自己再开一条连接 | **借用**官方插件已在跑的那一条（不抢凭据、不重复登录） |
| 白名单 | 空列表常等于「所有人」 | 空列表等于**没人**（fail closed），被拒者只记录、绝不自动授权 |
| 可观测 | 出问题就是一片沉默 | 控制台日志 + `bridge-status.json`，「到底加载了没」永远有答案 |
| 官方命令 | 常被桥接吞掉 | `/bot-ping`、`/bot-status` 等原样保留 |

> 这不是宣传语：每一条都有测试或真实运行日志撑着，见 [`TEST-REPORT.md`](TEST-REPORT.md)。

---

## 它是怎么工作的

```
QQ 用户
  │  私聊消息
  ▼
@tencent-connect/dsh-qqbot（已装、已激活，持有唯一网关）
  │  ① pre-handler（本地 fork 提供的唯一扩展点）—— 同步判定归属
  ▼
dsh-qqbot-bridge
  │  ② 白名单校验（默认拒绝）→ 指令解析 → 每个 OpenID 一条 FIFO 队列
  │  ③ 读 state.json（只读）拿到该 Bot **当前的**会话 id
  │  ④ sessionController.resolveAgent(sessionId)
  │     → agent.followup(createUserMessage({ source: { kind: 'qqbot-bridge', … } }))
  ▼
DS Bot 真实会话（管家 / 设计师 / 程序员 / 聊天搭子）
  │  ⑤ ctx.on('session/event') 收集 assistant/message，turn/end 收尾
  ▼
回到 QQ（分段、失败可见、超时提示）
```

### 为什么必须给 QQ 插件打一个补丁

官方插件把 `QQBot` 实例、`SessionManager`、出站 `sender` 全部留在函数局部变量里，**没有注册任何 cordis service**，命令注册器用完即弃（见 `patches/0001-qqbot-extension-point.md` 的逐条证据）。因此外部插件：

* 拿不到网关，就无法用同一条连接把文本发回 QQ；
* 插不进中间件，就拦不住原 agent 抢先回答；
* 拿不到「谁发的、回给谁」的 OpenID 映射。

而用同一个 AppID 起第二个网关会与现有连接抢事件流。所以只有两条路：**最小本地 fork**，或在本机做 QQ 协议 MITM 代理。本项目选 fork，且只**新增**两处：

| 文件 | 改动 |
| --- | --- |
| `dist/gateway/middleware-setup.js` | 多一个可选参数 `preHandlers`，插在中间件链**最前面** |
| `dist/gateway/bootstrap.js` | `ctx.provide('qqbot', { setMessagePreHandler, sender, replyTargetFor, manager })` |

原有语句一行未改；没有插件使用扩展点时行为完全不变。回滚＝把 profile 的依赖指回 `^0.5.0`。

---

## QQ 指令

| 指令 | 作用 |
| --- | --- |
| `/管家` `/设计师` `/程序员` `/聊天` | 切换目标 Bot（`/聊天` → 聊天搭子） |
| `/当前` | 查看当前选中的 Bot |
| `/团队` | 列出**已有**的四个 Bot |
| `/帮助` | 指令说明 |
| `/程序员 帮我看看这段代码` | 切换并立刻把后半句发给它 |

切换后回复：`已切换至程序员。接下来可以直接发送代码或问题。`

路由选择以 **QQ OpenID** 为键持久化在 `<dataDir>/routing.json`，重启后恢复。

**不认识的斜杠指令不会被当成 shell 命令，也不会发给 Bot。** `/bot-ping`、`/bot-status`、`/new`、`/model`、`/preset`、`/compact`、`/stop` 等全部原样交回官方插件处理，行为与之前一致。（纯中文的 `/法务` 这类会被识别为「在叫一个不存在的成员」，回一句提示而不是转发。）

---

## 安全

| 项 | 做法 |
| --- | --- |
| 白名单 | **为空 = 拒绝所有人**（fail closed）。官方插件的空名单会被翻译成 `['*']`，本项目刻意不沿用这个语义 |
| 身份 | 只用真实 **OpenID** 比对，绝不使用 QQ 昵称 |
| 未授权用户 | 静默拒绝——回复等于告诉对方这个 AppID 上挂着一个私人桥接 |
| 群聊 | v1 完全关闭，群消息原样交回官方链路，不会路由到高权限 Bot |
| 工具审批 | 完全走 DSH 原生审批链，QQ 不绕过、不模拟批准；QQ 端无法交互时回退到 Web 人工审批 |
| 凭据 | 插件不持有 AppSecret，不写进源码；日志经 `lib/log.js` 擦洗，OpenID 缩短显示 |
| 会话隔离 | 只有带 `source.kind === 'qqbot-bridge'` 标记的轮次才会回传 QQ。**Web 里打的字、其他 Bot 之间的中继，永远不会被发到 QQ** |
| 文件 | 只**读** `state.json`，尊重其锁与版本；不写会话日志 |
| DS Bot 数据 | 不删除、不改动任何 Bot、记忆或历史 |

---

## 配置

`cordis.patch.yml`（本 bundle）默认值，profile 层按 `id: qqbot-bridge` 覆盖：

```yaml
- insert:
    - id: qqbot-bridge
      name: dsh-qqbot-bridge
      config:
        statePath: ''            # 默认 <DSH_HOME>/bot/state.json
        dataDir: ''              # 默认 <DSH_HOME>/qqbot-bridge
        allowOpenIds: []         # 必填你自己的 OpenID；空 = 全拒绝
        defaultBot: 管家
        allowGroups: false
        replyTimeoutMs: 600000
        queueMax: 4
        textChunkLimit: 4500
        debug: false
```

### 第一次使用：把你的 OpenID 加进白名单

桥接**不会**自动放行任何人。安装后的第一次私聊会被拒绝，这是设计行为。

```powershell
# 1. 用手机 QQ 给机器人发任意一条私聊（会被静默拒绝）
# 2. 读出被拒的 OpenID（只记录，不授权）
node scripts/show-openids.mjs
# 3. 把打印出来的 id 填进 <DSH_HOME>/profiles/web/cordis.patch.yml 的 allowOpenIds，例如
#      allowOpenIds: ["ABC123...XYZ"]
```

DSH 会热重载 `cordis.patch.yml`，通常**不需要重启**（改不动再重启）。

候选列表存在 `<dataDir>/rejected-openids.json`（默认 `<DSH_HOME>/qqbot-bridge/`），
权限 0600，最多保留最近 20 条。**它只是记录，不会授予任何权限。**

---

## 安装

先决条件：DS Bot 已装且四个 Bot 已创建；`@tencent-connect/dsh-qqbot` 已装并已绑定 AppID。

下列命令里的 `<本仓库>`、`<fork 目录>` 请替换成你自己的路径（Windows 示例用反斜杠亦可）。

```bash
cd <本仓库>

# 1. 自检（零运行时依赖，不需要 pnpm install）
node scripts/run-tests.mjs               # 15 个文件 / 139 个用例（见 TEST-REPORT.md）
node scripts/check-syntax.mjs            # 全量语法检查
node scripts/audit-constraints.mjs       # 四条硬约束自审
node scripts/verify-host-resolution.mjs  # 宿主能否解析本插件的裸导入

# 2. 生成本地 fork（只新增两处，见 patches/0001）
#    脚本会自动找到已安装的官方包，找不到时用 --from <官方包目录>
node scripts/make-bridged-qqbot.mjs --out <fork 目录>
#    fork 自己的运行时依赖要单独装（pnpm 不会为 link 包代劳）
cd <fork 目录> && pnpm install --prefer-offline
cd <本仓库>

# 3. 让 web profile 使用 fork 与本插件（脚本只改 manifest，先 --dry-run 看差异）
node scripts/install-profile.mjs --fork <fork 目录> --project . --dry-run
node scripts/install-profile.mjs --fork <fork 目录> --project .

# 4. 停掉正在跑的 dsh，然后在 profile 里装依赖
cd <DSH_HOME>/profiles/web && pnpm install

# 5. 重新启动 dsh，终端里应出现：
#    [qqbot-bridge] apply() entered (plugin v0.1.0)
#    [qqbot-bridge] allowOpenIds: 0 configured -- FAIL CLOSED, every QQ peer is refused
#    [qqbot-bridge] provided the "qqbotBridge" service
#    [qqbot-bridge] STARTED: transport=dsh-qqbot-bridge/qq | snapshot=... | data=...
```

---

## 怎么确认「桥接真的加载了」

DSH 没有挂 Cordis 的控制台日志导出器，`ctx.logger` 的输出只会进内存缓冲区
（证据见 `COMPATIBILITY.md` 的「日志通道」一节）。所以桥接的激活状态有**两条**
独立通道，任何一条都足以判断：

1. **终端**：每个生命周期事实都以 `[qqbot-bridge]` 为前缀直接打印；
2. **磁盘**：`<DSH_HOME>/qqbot-bridge/bridge-status.json`，`apply()` 一开始就创建
   目录并写入，不需要等第一条 QQ 消息。

```bash
node scripts/bridge-status.mjs
```

`phase` 的含义：

| phase | 含义 |
| --- | --- |
| `loading` | `apply()` 已进入，正在准备 |
| `waiting` | 插件已加载，但 `waitingFor` 里的服务还没出现（终端每 10s 复述一次） |
| `running` | 桥接已装配，`transport` 是实际使用的传输（正常应为 `dsh-qqbot-bridge/qq`） |
| `failed` | 装配过程中抛错，`lastError` 是原因 |
| `stopped` | 插件已卸载（热重载或退出） |

状态文件里**只有数量，没有任何凭据**：`allowOpenIds` 记数量不记值，`appSecret`
从来不出现。`allowOpenIdsCount: 0` 同时会把 `failClosed` 记为 `true`。

也可以走标准插件安装命令（但 fork 那一步仍需要 `install-profile.mjs`）：

```bash
npx @deepseek-ai/dsh plugin --profile web add <本仓库>
```

---

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 启动日志一行 `[qqbot-bridge]` 都没有 | 先跑 `node scripts/bridge-status.mjs`：文件不存在 = 插件没被加载（查 bundle/patch/`--dump-config`）；文件存在但 `phase=waiting` = 服务没来（看 `waitingFor`）；`phase=running` = 一切正常，只是过去依赖的 `ctx.logger` 在 DSH 里不可见（见 COMPATIBILITY.md「日志通道」） |
| 启动日志 `cannot set property "qqbot" without provide`（或 `"qqbotBridge"`） | 服务注册误用了 `ctx.set`。Cordis 4 里首次注册必须用 `ctx.provide`；重新生成 fork 并确认桥接是最新版本 |
| 启动日志 `2 entries did not activate` | 同上：`im-qqbot` 与 `qqbot-bridge` 都因服务注册失败而未激活 |
| 启动日志 `warning: 1 entry did not activate` + `pending (waiting for service: …)` | 插件级 `inject` 声明了永不出现的服务，Cordis 会静默挂起。本桥接的 `inject` 为空数组，正常情况下不会出现这条 |
| 日志出现 `waiting for service(s): …` 之后没有下文 | 那三个服务里至少一个从没出现；看门狗每 10s 会复述还缺哪些 |
| 日志出现 `No qqbot service on this host` | 官方包没有被 fork 替换。执行安装第 2、3 步 |
| 日志出现 `qqbot service found but it has no setMessagePreHandler` | fork 目录没有生效（依赖没指过去，或没 `pnpm install`） |
| QQ 发消息没反应，且日志有 `refused QQ message` | `allowOpenIds` 没填你的 OpenID，或填错了 |
| 日志有 `queue overflow` | 同一 OpenID 连发超过 `queueMax`（默认 4）条，后面的被丢掉并已提示 |
| Bot 长时间不回 | 到 DSH Web 看那个 Bot 的会话；超过 `replyTimeoutMs` QQ 会收到「请到 DSH Web 查看」 |
| 回复只到 Web 没到 QQ | 该轮不是 QQ 触发的（例如你在 Web 里继续对话），这是设计行为 |

---

## 回滚

```bash
cd <本仓库>

# 先看差异，不写入
node scripts/rollback-profile.mjs --dry-run

# 真正回滚（自动备份 package.json）
node scripts/rollback-profile.mjs

# 停掉 dsh 后装回官方包
cd <DSH_HOME>/profiles/web && pnpm install
```

这一步已在副本上完整演练过：`link:` → `^0.5.0` 往返、插件正确挂载/摘除。

QQ 立刻回到官方插件的普通 Agent 模式。fork 目录和本项目目录都可以直接删掉；
DS Bot 的四个 Bot、团队记忆、聊天历史、皮肤配置全程未被修改。

---

## 目录

| 路径 | 作用 |
| --- | --- |
| `lib/index.js` | 插件入口：`name` / `inject` / `Config` / `apply` / 服务等待与看门狗 |
| `lib/host-log.js` | **必然可见**的控制台通道（DSH 没有 Cordis 控制台日志导出器） |
| `lib/status.js` | 写 `<dataDir>/bridge-status.json`，并顺带创建数据目录 |
| `lib/bridge.js` | 核心：同步归属判定、路由、队列、回复关联、错误处理 |
| `lib/adapter.js` | QQ 传输适配层（借网关 / 不可用时的显式失败） |
| `lib/deliver.js` | 投递进真实会话（带自有 `source` 标记） |
| `lib/source-tag.js` | 消息来源标记的定义与判据 |
| `lib/registry.js` | 只读解析 `state.json`，处理「当前 part」变化 |
| `lib/router.js` | OpenID → Bot 的持久化路由表 |
| `lib/access.js` | 白名单（fail closed） |
| `lib/commands.js` | 指令解析（窄契约，不抢官方命令） |
| `lib/queue.js` | 每 OpenID FIFO |
| `lib/dedupe.js` | 消息 ID 去重 |
| `lib/reply-tracker.js` | 轮次 ↔ 等待者关联 |
| `lib/pending.js` | 旁路任务的收敛等待 |
| `lib/chunk.js` | 长文本分段 |
| `lib/log.js` | 凭据擦洗日志（`ctx.logger` 通道） |
| `lib/rejected-log.js` | 记录被拒 OpenID（仅记录，不授权） |
| `patches/0001-*.md` | fork 补丁说明与回滚 |
| `scripts/make-bridged-qqbot.mjs` | 生成 fork |
| `scripts/install-profile.mjs` | 把 profile 切到 fork + 挂载本插件（幂等、可 `--dry-run`） |
| `scripts/rollback-profile.mjs` | 回滚到官方插件（幂等、可 `--dry-run`） |
| `scripts/bridge-status.mjs` | 读 `bridge-status.json` 回答「桥接到底加载了没」 |
| `scripts/show-openids.mjs` | 打印被拒的 OpenID，供你挑选要加白名单的那个 |
| `scripts/audit-constraints.mjs` | 四条硬约束的机械自审 |
| `scripts/verify-host-resolution.mjs` | 校验宿主解析器能否供给本插件的裸导入 |
| `scripts/run-tests.mjs` | 跑全部测试 |
| `tests/` | 139 个测试，全部通过（见 `TEST-REPORT.md`） |

## 说明

* 本插件按设计**零运行时依赖**（只用 Node 内置模块 + 宿主提供的 `@deepseek-ai/schemastery`），因此不需要 `pnpm install` 就能自测。
* v1 只做私聊文本。图片/语音/文件与群聊预留了扩展位（`lib/adapter.js` 的 target 归一化、`allowGroups`），尚未启用。
* 第一版是完整回复模式，不做流式输出。
