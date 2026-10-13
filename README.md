# dsh-qqbot-bridge

**English** · [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-139%20passing-brightgreen.svg)](TEST-REPORT.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](#contributing)

> Route QQ private messages into the AI team sessions you **already** have in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — same session id, same memory, same permissions. No second QQ gateway, no copy-pasted system prompt.

```
        QQ app                          ┌─ DSH Web UI ─┐
           │                            │  程序员 chat  │
    private message                     └──────▲───────┘
           ▼                                   │  the same session
   ┌───────────────────────────────────────────┴──────────────────────────┐
   │  dsh-qqbot-bridge  →  the Bot's REAL session (history + memory + ...) │
   └──────────────────────────────────────────────────────────────────────┘
```

---

## The problem

You already run a **team of agents** inside DSH: several Bots, each with its own long-lived
session, its own role instructions, its own long-term memory, its own tools and workspace.
You want to talk to them **from QQ**.

The obvious approach — *"write a QQ bot that calls the model with the same system prompt"* —
silently throws away everything that made the team worth building: the conversation history,
the memory files, the permissions, the workspace, the resume-after-restart behaviour.
You end up with a stranger wearing the same name.

This project does not do that. It **delivers a QQ message into the session that Bot already
has**, and relays the Bot's answer back to QQ.

## What makes it different

| | Typical QQ ⇄ LLM bridge | **dsh-qqbot-bridge** |
|---|---|---|
| Identity | Copies the system prompt | **Reuses the real session** — `sessionController.resolveAgent(sessionId)` then `agent.followup(createUserMessage({ source }))` |
| Context | Starts from scratch | The Bot's actual history, memory, tools and workspace |
| Web ⇄ QQ | Two disconnected worlds | **One session**: start on QQ, continue in the Web UI, same context |
| QQ gateway | Opens its own connection | **Borrows** the one the official plugin already runs — no second login, no credential race |
| Allowlist | `[]` often means *everyone* | `[]` means **nobody** (fail-closed); refused peers are only *recorded*, never auto-granted |
| Observability | Silence when it breaks | Console lines **and** `bridge-status.json` — "did it load?" always has an answer |
| Official commands | Frequently swallowed | `/bot-ping`, `/bot-status`, … keep working |
| Long conversations | Pins one session id | Re-reads `state.json` before every send, so a session that rolls over to a new part keeps working |
| Group chats | Often on by default | Off, and group traffic is handed back to the stock chain untouched |

Every row above is backed by a test or a real run log — see [`TEST-REPORT.md`](TEST-REPORT.md).

## How it works

```
QQ private message
      │
      ▼
@tencent-connect/dsh-qqbot   (stock plugin + a tiny local fork, patch 0001)
      │   owns the only QQ websocket, holds the credentials
      │   publishes: ctx.provide('qqbot', { setMessagePreHandler, sender, replyTargetFor, … })
      ▼
dsh-qqbot-bridge   (this project — consumes the service, never opens a socket)
      │   1. allowlist gate      (empty ⇒ refuse everyone, record the OpenID only)
      │   2. command router      /管家 /设计师 /程序员 /聊天 /团队 /当前   → routing.json
      │   3. per-OpenID FIFO queue + message-id de-duplication
      │   4. read state.json (READ-ONLY) for that Bot's CURRENT session id
      │   5. sessionController.resolveAgent(sessionId) → agent.followup(msg)
      ▼
the Bot's real DSH session          ← the very same one the Web UI shows
      │   msg.source.kind = 'qqbot-bridge'   (so QQ and Web turns are distinguishable)
      ▼
ctx.on('session/event') collects the answer, turn/end closes it
      │
      ▼
back to QQ (chunked, with honest failure and timeout messages)
```

The bridge registers **one** Cordis service of its own (`qqbotBridge`) so an operator can ask
a live host what it is doing.

### Why a fork of the QQ plugin is required

The stock `@tencent-connect/dsh-qqbot` keeps its `QQBot` instance, `SessionManager` and
outbound sender inside local variables and **registers no Cordis service at all**, so an
external plugin cannot send on the same connection, cannot intercept the middleware chain,
and cannot learn which OpenID a message came from. Starting a second gateway with the same
AppID would race the first one for the event stream.

So the only clean option is a **minimal local fork**, and patch 0001 adds exactly two things:

| File | Change |
|---|---|
| `dist/gateway/middleware-setup.js` | one optional `preHandlers` argument, inserted at the **front** of the middleware chain |
| `dist/gateway/bootstrap.js` | `ctx.provide('qqbot', { setMessagePreHandler, sender, replyTargetFor, manager })` |

No existing statement is modified, and a host that never calls the extension point behaves
exactly as before. Rollback is one dependency range in the profile manifest.
Full evidence in [`patches/0001-qqbot-extension-point.md`](patches/0001-qqbot-extension-point.md).

## Quick start

Prerequisites: DSH with the Web profile, the stock QQ plugin installed and already bound to
your AppID, and DS Bot with your team created.

```bash
# 1. self-check (zero runtime dependencies — no install needed)
node scripts/run-tests.mjs
node scripts/audit-constraints.mjs
node scripts/verify-host-resolution.mjs

# 2. generate the local fork (finds the installed stock package automatically,
#    or pass --from <dir>)
node scripts/make-bridged-qqbot.mjs --out ../dsh-bridged-qqbot
(cd ../dsh-bridged-qqbot && pnpm install --prefer-offline)   # pnpm does not do this for linked packages

# 3. point your Web profile at the fork and mount this bridge (see the diff first)
node scripts/install-profile.mjs --fork ../dsh-bridged-qqbot --project . --dry-run
node scripts/install-profile.mjs --fork ../dsh-bridged-qqbot --project .

# 4. stop dsh, then install inside the profile
cd ~/.dsh/profiles/web && pnpm install

# 5. start dsh again. You should see the bridge announce itself:
#    [qqbot-bridge] apply() entered (plugin v0.1.0)
#    [qqbot-bridge] allowOpenIds: 0 configured -- FAIL CLOSED, every QQ peer is refused
#    [qqbot-bridge] provided the "qqbotBridge" service
#    [qqbot-bridge] STARTED: transport=dsh-qqbot-bridge/qq | snapshot=...
```

Then allowlist yourself:

```bash
# send any private message to the bot on QQ (it will be refused, on purpose), then:
node scripts/show-openids.mjs          # prints the OpenID that was recorded
# put it into ~/.dsh/profiles/web/cordis.patch.yml -> allowOpenIds: ["YOUR_OPENID"]
```

Editing `cordis.patch.yml` is picked up by DSH's config hot reload — **no restart needed**.

## Using it from QQ

| Command | Effect |
|---|---|
| `/管家` `/设计师` `/程序员` `/聊天` | switch which Bot you are talking to (persisted per OpenID) |
| `/团队` | list the team |
| `/当前` | show who you are talking to |
| anything else | delivered to the current Bot; its answer comes back to QQ |

## Configuration

All of it lives in **your** profile patch, never in this repository:

```yaml
- id: qqbot-bridge
  config:
    allowOpenIds: []        # EMPTY MEANS NOBODY. Add only your own OpenID.
    defaultBot: 管家         # who receives a message from a peer with no switch yet
    allowGroups: false      # v1 is private chats only
    replyTimeoutMs: 600000  # how long to wait for a Bot turn before telling the user
    queueMax: 4             # per-peer queued messages
    textChunkLimit: 4500    # max characters per QQ message
    debug: false
    # statePath / dataDir default to <DSH_HOME>/bot/state.json and <DSH_HOME>/qqbot-bridge
```

`appId` / `appSecret` stay in the **official plugin's** config block, untouched. This project
never reads, stores or logs them.

## Two Cordis/DSH surprises worth reading about

Both of these cost real debugging time, and both are now pinned by tests.

**1. `ctx.set` is not registration.** In Cordis 4, `ctx.provide(name, value)` registers a new
service and returns a disposer; `ctx.set(name, value)` may only *overwrite* a service someone
already provided, and otherwise throws `cannot set property "<name>" without provide`. Both
halves of this project originally used `ctx.set`, which is why the host reported
`2 entries did not activate`. A hand-written fake context with `set = assignment` hid it
perfectly — hence the real-`Context` tests in this repo.

**2. A declared-but-absent `inject` suspends a plugin in total silence.** The fiber just sits
in `pending`, `apply()` is never called, and the plugin cannot explain itself. So this
plugin declares **no** dependencies at the plugin level, runs `apply()` unconditionally, and
does its waiting with `ctx.inject([...])` plus a watchdog that names every service still
missing.

**3. …and DSH mounts no console exporter for the Cordis logger.** `LoggerService` installs
exactly one default sink: an in-memory ring buffer. Printing needs
`@deepseek-ai/cordis-plugin-logger-console`, which no DSH bundle depends on — so in `dsh web`,
`ctx.logger.info(...)` is *invisible*. That is how a perfectly healthy bridge managed to look
like a plugin that had never loaded. Lifecycle facts therefore go to the console directly
(`lib/host-log.js`) and to `<dataDir>/bridge-status.json` (`lib/status.js`). DSH's own e2e
fixtures confirm the contract: their observer has to attach an exporter *and* drain
`ctx.logger.buffer` to see plugin output.

## Diagnostics

```bash
node scripts/bridge-status.mjs   # is it loaded? running + transportOk ⇒ exit code 0
node scripts/show-openids.mjs    # who was refused?
node scripts/run-tests.mjs       # full regression
```

`<DSH_HOME>/qqbot-bridge/bridge-status.json` is written the moment `apply()` runs — before the
first message — and holds `phase` (`loading` / `waiting` / `running` / `failed` / `stopped`),
`available`, `transport`, `transportOk`, `allowOpenIdsCount`, `failClosed`, `waitingFor`,
`bots`, timestamps and `lastError`. It contains **counts, never credentials**.

## Tests

```bash
node scripts/run-tests.mjs
# files: 15, failed: 0        (# tests 139 / pass 139 / fail 0)
```

They are not mocks pretending to be a host:

* **real `@deepseek-ai/cordis` `Context`** for the service-registration semantics;
* **real `boot()` from `@deepseek-ai/dsh-app-boot`** — the very function `dsh web` runs — for
  activation, console output and teardown;
* **real `loadProfile` + `composeEntries`** over the installed Web profile for the layer that
  actually decides whether a bundle is mounted at all;
* **the real forked middleware chain** for end-to-end routing.

Tests that need a DSH checkout, the fork, or an installed profile **skip with a reason**
instead of failing, so the suite also runs on a bare clone.

Deep dive: [`TEST-REPORT.md`](TEST-REPORT.md) · contracts: [`COMPATIBILITY.md`](COMPATIBILITY.md).

## Security model

* **Fail closed.** An empty `allowOpenIds` refuses every peer.
* **No automatic grants.** A refused OpenID is *written down* (so you can copy it into your
  own config yourself) and nothing else. The bridge never adds itself to the allowlist.
* **No credential handling.** `appSecret` stays in the official plugin's config; the bridge
  owns no socket and opens no connection of its own.
* **Read-only on DS Bot.** `state.json` is read, never written; its lock and atomicity are
  respected.
* **No browser shortcuts.** No `/api/bot`, no forged cookies, no bypassing the Web UI's auth.
* **Credentials are scrubbed from every log line** (`lib/log.js`), and OpenIDs are shortened
  unless `debug` is on.
* `scripts/audit-constraints.mjs` checks all of the above mechanically.

## Project layout

| Path | Purpose |
|---|---|
| `lib/index.js` | plugin entry: `name` / `inject` / `Config` / `apply` / service waiting + watchdog |
| `lib/host-log.js` | the always-visible console channel |
| `lib/status.js` | writes `<dataDir>/bridge-status.json`, creates the data directory |
| `lib/bridge.js` | ownership verdict, routing, queues, reply correlation, error handling |
| `lib/adapter.js` | the borrowed-gateway transport (and an explicitly failing fallback) |
| `lib/deliver.js` | delivery into the real session, with its own `source` tag |
| `lib/registry.js` | read-only `state.json` parsing, including part rollover |
| `lib/router.js` · `lib/access.js` · `lib/commands.js` | per-OpenID routing, fail-closed allowlist, command parsing |
| `scripts/` | fork generator, profile installer/rollback, status, audit, test runner |
| `patches/` | the fork patch, with the evidence behind every inserted line |

## Uninstall

```bash
node scripts/rollback-profile.mjs --dry-run   # show the diff
node scripts/rollback-profile.mjs             # restore the stock plugin
cd ~/.dsh/profiles/web && pnpm install        # then restart dsh
```

Your Bots, team memory, chat history, skins and the bridge's data directory are untouched.

## Contributing

Issues and PRs are welcome. The one rule that matters: **tests must run against the real
host**, not a hand-written fake — a fake context is exactly what let the original activation
bug ship green. If a test cannot reach the real thing here, make it *skip with a reason*.

## Credits & licence

* Built for [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) and
  [@tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot).
* Not affiliated with DeepSeek or Tencent. The fork is generated locally from *your own*
  installed copy; no third-party code is redistributed here.
* [MIT](LICENSE)
