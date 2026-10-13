# 测试

## 一次性跑完

```powershell
cd D:\CodingData\Github\dsh\dsh-qqbot-bridge
node scripts/run-tests.mjs
```

`node --test` 在本机沙箱下会因「piped stdio 子进程」被拒而 `spawn EPERM`，
所以 runner 用 `stdio: 'inherit'` 逐文件起进程，输出与 node:test 一致。

## 11 个文件 / 112 个用例

| 文件 | 依赖 | 说明 |
| --- | --- | --- |
| `access.test.mjs` | 无 | 白名单 fail-closed、通配符显式化、群聊默认关闭 |
| `adapter.test.mjs` | 无 | 扩展点安装、消费/放行、监听器异常隔离、target 归一化、日志擦洗 |
| `bridge.test.mjs` | 无 | 端到端行为（见下） |
| `chunk.test.mjs` | 无 | 长文本分段 |
| `commands.test.mjs` | 无 | 指令解析与回落 |
| `registry.test.mjs` | 无 | 只读解析 state.json、当前 part 变化 |
| `rejected-log.test.mjs` | 无 | 被拒 OpenID 记录（不授权） |
| `router.test.mjs` | 无 | OpenID 路由持久化 |
| `state.test.mjs` | 无 | 去重、队列、回复关联 |
| `startup.test.mjs` | **需要模块链接** | 真的调 `apply()`：Config 校验、适配器选择、预处理器装配 |
| `fork-extension.test.mjs` | **需要已安装的 fork** | 在真实构建产物上验证扩展点语义 |

### `startup.test.mjs` 需要的模块链接

宿主的解析器会给每个插件供给 `@deepseek-ai/*`。脱离宿主单独跑 `apply()` 时，
项目的 `node_modules` 里需要有这两个包（否则该文件会明确 skip，不会误报通过）：

```powershell
New-Item -ItemType Directory -Force D:\CodingData\Github\dsh\dsh-qqbot-bridge\node_modules\@deepseek-ai | Out-Null
New-Item -ItemType Junction D:\CodingData\Github\dsh\dsh-qqbot-bridge\node_modules\@deepseek-ai\schemastery -Target D:\CodingData\Github\deepseek-harness\vendor\schemastery
New-Item -ItemType Junction D:\CodingData\Github\dsh\dsh-qqbot-bridge\node_modules\@deepseek-ai\dsh-llm     -Target D:\CodingData\Github\deepseek-harness\packages\llm\llm
```

`node_modules/` 已被 `.gitignore` 忽略，所以这两个 junction 不会被提交。
宿主本身不需要它们——宿主用自己的解析器。

### `fork-extension.test.mjs` 需要已安装的 fork

```powershell
$env:DSH_QQBOT_FORK    = 'D:\CodingData\Github\dsh\dsh-bridged-qqbot'
$env:DSH_QQBOT_PROFILE = 'C:\Users\All_in\.dsh\profiles\web'
node tests/fork-extension.test.mjs
```

未安装 fork 时该文件全部 skip。

## 环境核查脚本

```powershell
# 宿主解析器能否供给桥接的裸导入（不需要重启，见脚本头部说明）
node scripts/verify-host-resolution.mjs

# 读出被拒绝的 QQ OpenID（用于第一次配置白名单）
node scripts/show-openids.mjs
```

## 为什么 `bridge.test.mjs` 用假适配器

它跑的是真实 `createBridge`，只把 QQ 传输换成假件。假件的 `deliver()` **故意**
与 `lib/adapter.js` 的语义完全一致：同步调用监听器并返回布尔「是否接管」。
这一点很关键——早期版本的假件返回的是桥接内部的判定字符串，掩盖了一个会让
QQ 官方 agent 和桥接**同时回复同一条消息**的真实 bug。任何改动的假件都必须
保持这个契约。
