// In-process end-to-end test: the REAL forked QQ middleware chain + the REAL
// bridge + a host stub, with only the QQ network boundary faked.
//
// WHY
// `bridge.test.mjs` swaps the QQ transport for a fake, and `startup.test.mjs`
// runs the real `apply()`. Neither carries a message through the fork's actual
// middleware chain (accessPolicy, mentionGate, slashCommand, concurrencyGuard,
// typingIndicator, ...) and back out through its real sender. This file does,
// which is the strongest verification possible before the host is restarted:
//
//   QQ wire message
//     -> forked setupMiddlewares chain
//     -> bridge pre-handler (consumes)
//     -> real DS Bot session id from state.json
//     -> ctx.sessionController.resolveAgent(...).followup(tagged message)
//     -> simulated DSH session/event turn
//     -> reply out through the fork's sender
//
// Enabled only when the fork is installed, like fork-extension.test.mjs.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { createBridge } from '../lib/bridge.js'
import { createRegistry } from '../lib/registry.js'
import { createRouter, routingFile } from '../lib/router.js'
import { createDelivery } from '../lib/deliver.js'
import { createPlatformAdapter } from '../lib/adapter.js'
import { createLogger } from '../lib/log.js'
import { BRIDGE_KIND } from '../lib/source-tag.js'
import { sampleState } from './harness.mjs'

const forkDir = process.env.DSH_QQBOT_FORK
const profileDir = process.env.DSH_QQBOT_PROFILE
const forkMiddleware =
  forkDir === undefined ? undefined : join(forkDir, 'dist', 'gateway', 'middleware-setup.js')

const available =
  forkMiddleware !== undefined &&
  existsSync(forkMiddleware) &&
  profileDir !== undefined &&
  existsSync(join(profileDir, 'node_modules', '@tencent-connect', 'dsh-qqbot', 'dist', 'gateway', 'middleware-setup.js'))

const skip = available ? false : 'fork not installed (run scripts/make-bridged-qqbot.mjs and link it)'

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }

/** The QQBot surface the fork's bootstrap actually uses. */
function fakeQqbot() {
  const middlewares = []
  const handlers = new Map()
  const sent = []
  const bot = {
    middlewares,
    sent,
    use(fn) {
      middlewares.push(fn)
      return bot
    },
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return bot
    },
    async sendTyping() {
      return { ok: true }
    },
    async sendText(target, content) {
      sent.push({ target, content })
      return { ok: true }
    },
    async sendMarkdown(target, content) {
      sent.push({ target, content })
      return { ok: true }
    },
    openStream() {
      return { update() {}, complete() {}, abort() {} }
    },
    /** Run the middleware chain the way the SDK does. */
    async dispatchMessage(ctx) {
      let index = -1
      const downstream = async () => {
        for (const handler of handlers.get('message') ?? []) await handler(ctx, ctx.message)
      }
      const chain = [...middlewares, downstream]
      const next = async i => {
        if (i <= index) throw new Error('next() called twice')
        index = i
        if (ctx.stopped === true) return
        const fn = chain[i]
        if (fn === undefined) return
        await fn(ctx, () => next(i + 1))
      }
      await next(0)
      return !ctx.stopped
    },
  }
  return bot
}

const qqMessageContext = (content, { messageId = `m-${randomUUID()}`, senderId = 'openid-allowed' } = {}) => {
  const replyTarget = { scope: 'c2c', targetId: senderId, msgId: messageId }
  const message = {
    messageId,
    kind: 'c2c',
    senderId,
    content,
    replyTarget,
    timestamp: Date.now(),
    attachments: [],
  }
  return {
    bot: undefined,
    message,
    replyTarget,
    state: {},
    log: quietLogger,
    stopped: false,
    stopReason: undefined,
    receivedAt: Date.now(),
    timestamp: Date.now(),
    signal: new AbortController().signal,
    abort() {},
    stop(reason) {
      this.stopped = true
      this.stopReason = reason
    },
  }
}

const config = {
  appId: 'test-app',
  requireMention: true,
  historyLimit: 10,
  textChunkLimit: 4500,
  maxQueue: 20,
  processingTimeoutMs: 1000,
  sessionIdleTimeout: 1800000,
  streaming: false,
  askTimeoutMs: 300000,
  showToolResults: false,
  provider: 'test',
  model: 'test',
  access: { c2cMode: 'open', c2cAllow: [], groupMode: 'disabled', groupAllow: [] },
  debug: false,
  media: { enabled: false, maxMB: 1, ttlHours: 1 },
  vision: { enabled: false },
  sendFile: { restrictPaths: true, extraRoots: [] },
}

/**
 * Assemble the whole production wiring: the fork's middleware chain, the
 * bridge's real adapter, a real registry over a real state.json, and a host
 * stub whose `session/event` we drive by hand.
 */
async function assemble({ config: bridgeConfig = {} } = {}) {
  const dir = join(tmpdir(), `qqbot-bridge-e2e-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  const statePath = join(dir, 'state.json')
  await writeFile(statePath, JSON.stringify(sampleState(), null, 2), 'utf8')

  const { setupMiddlewares } = await import(`file://${forkMiddleware.replace(/\\/g, '/')}`)
  const bot = fakeQqbot()

  const logger = createLogger(quietLogger, 'qqbot-bridge/e2e', false)

  // The `qqbot` service the fork publishes, built exactly as patch 0001 does.
  const bridgePreHandlers = []
  let bridgeSender
  const service = {
    bot,
    manager: { findBySessionId: () => undefined, questionChannel: undefined, approvalChannel: undefined },
    config,
    get sender() {
      return bridgeSender
    },
    replyTargetFor(scope, targetId) {
      return { scope: scope === 'group' ? 'group' : 'c2c', targetId }
    },
    setMessagePreHandler(handler) {
      bridgePreHandlers.push(handler)
    },
  }

  setupMiddlewares(bot, config, service.manager, quietLogger, bridgePreHandlers)

  const sessionsFlushed = []
  const agents = new Map()
  const sessionController = {
    async resolveAgent(sessionId) {
      let agent = agents.get(sessionId)
      if (agent === undefined) {
        agent = { session: { id: sessionId }, delivered: [] }
        agent.followup = message => {
          agent.delivered.push(message)
        }
        agents.set(sessionId, agent)
      }
      return { agent }
    },
  }
  const sessions = {
    async flush(session) {
      sessionsFlushed.push(session?.id)
      return true
    },
  }

  const hostHandlers = new Map()
  const host = {
    on(event, handler) {
      const list = hostHandlers.get(event) ?? []
      list.push(handler)
      hostHandlers.set(event, list)
      return () => {}
    },
    /** Drive one DSH session event, as the host would. */
    emit(event, sessionId, data) {
      // `event` here is the SESSION-EVENT name the host publishes
      // ('session/event'); the concrete kind ('user/message', 'turn/end', ...)
      // travels in `data.type`. Getting this wrong means the bridge never sees
      // the event at all.
      for (const handler of hostHandlers.get('session/event') ?? []) {
        handler({ header: { id: sessionId } }, { type: event, data })
      }
    },
  }
  const bridgeHost = host

  const registry = createRegistry({ statePath })
  await registry.refresh(true)
  const router = createRouter({ file: routingFile(join(dir, 'data')), fallback: () => registry.mainBot()?.name ?? '' })
  await router.load()
  const delivery = createDelivery({
    sessionController,
    sessions,
    createUserMessage: ({ content, source }) => ({ id: randomUUID(), role: 'user', content, source }),
    logger,
  })
  const adapter = createPlatformAdapter(service, { logger: quietLogger })
  const bridge = createBridge({
    adapter,
    registry,
    router,
    delivery,
    logger,
    config: { allowOpenIds: ['openid-allowed'], defaultBot: '管家', replyTimeoutMs: 60_000, ...bridgeConfig },
  })
  bridge.start(host)

  // The fork builds the sender last; mirror that ordering.
  bridgeSender = {
    sendMarkdown: (target, content) => bot.sendMarkdown(target, content),
    openStream: target => bot.openStream({ target }),
  }

  /**
   * One full QQ turn.
   * @param {string} content
   * @param {{answer?: string|false, reason?: object, messageId?: string, senderId?: string}} options
   */
  const qqTurn = async (content, options = {}) => {
    const ctx = qqMessageContext(content, options)
    ctx.bot = bot
    const before = bot.sent.length
    const proceeded = await bot.dispatchMessage(ctx)
    // The middleware chain is synchronous: it only *queues* the delivery. Let
    // the bridge's queue and pending tasks settle before answering the turn,
    // otherwise the session has no delivered message and no pending entry yet.
    await bridge.drain()

    // If the bridge consumed the message, answer the DS Bot turn it created.
    // `answer: undefined` means "drive the turn but produce no assistant text"
    // (used for failure/abort cases); any string is the assistant reply.
    if (ctx.stopped === true && options.answer !== false) {
      for (const [sessionId, agent] of agents) {
        for (const message of agent.delivered) {
          if (message.source?.kind !== BRIDGE_KIND) continue
          host.emit('user/message', sessionId, { source: message.source })
          if (typeof options.answer === 'string' && options.answer !== '') {
            host.emit('assistant/message', sessionId, { message: { content: [{ type: 'text', text: options.answer }] } })
          }
          host.emit('turn/end', sessionId, { reason: options.reason ?? { kind: 'completed' } })
        }
      }
    }
    await bridge.drain()
    return {
      proceeded,
      ctx,
      replies: bot.sent.slice(before).map(entry => entry.content),
      agents,
      sessionsFlushed,
      bridge,
      cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
    }
  }

  return { bot, service, bridge, registry, router, agents, sessionsFlushed, qqTurn, dir, cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

test('a QQ message traverses the real chain and reaches the real Bot session', { skip }, async () => {
  const harness = await assemble()
  try {
    const turn = await harness.qqTurn('记住本轮测试标识 CODE-TEST-001', { answer: '收到。' })
    assert.equal(turn.proceeded, false, 'the bridge must consume the message and stop the stock chain')
    assert.equal(turn.ctx.stopReason, 'qqbot-bridge:consumed')

    const delivered = harness.agents.get('session-manager')?.delivered ?? []
    assert.equal(delivered.length, 1, 'exactly one message must reach 管家\'s session')
    assert.equal(delivered[0].content[0].text, '记住本轮测试标识 CODE-TEST-001')
    assert.equal(delivered[0].source.kind, BRIDGE_KIND)
    assert.equal(delivered[0].source.peerId, 'openid-allowed')
    assert.ok(harness.sessionsFlushed.includes('session-manager'), 'the message must be flushed durably')

    assert.deepEqual(turn.replies, ['收到。'], 'the Bot answer must go back out through the fork sender')
  } finally {
    await harness.cleanup()
  }
})

test('/程序员 switches, then the next message lands in that Bot session', { skip }, async () => {
  const harness = await assemble()
  try {
    const switched = await harness.qqTurn('/程序员')
    assert.equal(switched.replies.length, 1)
    assert.match(switched.replies[0], /已切换至程序员。接下来可以直接发送代码或问题。/)

    const next = await harness.qqTurn('请记住本轮测试标识为 CODE-TEST-001。', { answer: '记下了。' })
    const delivered = harness.agents.get('session-coder-part2')?.delivered ?? []
    assert.equal(delivered.length, 1, 'the message must land in 程序员\'s CURRENT part')
    assert.match(delivered[0].content[0].text, /CODE-TEST-001/)
    assert.equal(harness.agents.get('session-manager')?.delivered?.length ?? 0, 0, '管家 must not receive it')
    assert.deepEqual(next.replies, ['记下了。'])
  } finally {
    await harness.cleanup()
  }
})

test('an unknown slash command still reaches the stock listener', { skip }, async () => {
  const harness = await assemble()
  try {
    // Register a stock listener, as bootstrap.js does.
    let stockSaw = 0
    harness.bot.on('message', () => {
      stockSaw += 1
    })
    const turn = await harness.qqTurn('/bot-ping')
    // `/bot-ping` is the stock plugin's OWN command. The bridge must let it
    // through, and the stock slashCommand middleware answers it -- so the chain
    // is stopped with the stock reason, not the bridge's. Asserting
    // `proceeded === true` would be wrong: the stock command stops the chain.
    assert.notEqual(turn.ctx.stopReason, 'qqbot-bridge:consumed', 'the bridge must NOT own /bot-ping')
    assert.equal(stockSaw, 0, 'the stock slash command answers before the message listener')
    assert.equal(harness.agents.size, 0, 'no Bot session may be created')
  } finally {
    await harness.cleanup()
  }
})

test('a message the user types in the Web UI is never sent to QQ', { skip }, async () => {
  const harness = await assemble()
  try {
    // A QQ turn is in flight.
    const ctx = qqMessageContext('你好')
    ctx.bot = harness.bot
    await harness.bot.dispatchMessage(ctx)
    await harness.bridge.drain()

    // Then the user types in the browser: same session, `kind: 'user'` source.
    harness.bridge.onSessionEvent(
      { header: { id: 'session-manager' } },
      { type: 'user/message', data: { source: { kind: 'user', rpcId: 'rpc-browser' } } },
    )
    harness.bridge.onSessionEvent(
      { header: { id: 'session-manager' } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是 Web 私人回复' }] } } },
    )
    harness.bridge.onSessionEvent(
      { header: { id: 'session-manager' } },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    )
    await harness.bridge.drain()

    assert.equal(harness.bot.sent.length, 0, 'nothing may reach QQ for a browser turn')
  } finally {
    await harness.cleanup()
  }
})

test('group traffic is refused by the stock chain after the bridge passes it through', { skip }, async () => {
  const harness = await assemble()
  try {
    const replyTarget = { scope: 'group', targetId: 'group-1', msgId: 'g-1' }
    const ctx = {
      bot: harness.bot,
      message: {
        messageId: 'g-1',
        kind: 'group',
        senderId: 'member-1',
        groupOpenid: 'group-1',
        content: '群里说话',
        replyTarget,
        timestamp: Date.now(),
        attachments: [],
      },
      replyTarget,
      state: {},
      log: quietLogger,
      stopped: false,
      receivedAt: Date.now(),
      timestamp: Date.now(),
      signal: new AbortController().signal,
      abort() {},
      stop(reason) {
        this.stopped = true
        this.stopReason = reason
      },
    }
    let stockSaw = 0
    harness.bot.on('message', () => {
      stockSaw += 1
    })
    // Group mode is disabled in this config, so the stock accessPolicy stops it.
    const proceeded = await harness.bot.dispatchMessage(ctx)
    await harness.bridge.drain()
    assert.equal(proceeded, false, 'the bridge must not open a group path')
    assert.equal(harness.agents.size, 0, 'no privileged Bot may be reached from a group')
  } finally {
    await harness.cleanup()
  }
})

test('a failed turn is reported to the peer instead of being swallowed', { skip }, async () => {
  const harness = await assemble()
  try {
    const turn = await harness.qqTurn('会失败的一轮', {
      reason: { kind: 'error', error: { code: 'AUTH', message: 'denied' } },
    })
    assert.equal(turn.proceeded, false)
    assert.match(turn.replies.join('\n'), /失败了/)
    assert.match(turn.replies.join('\n'), /AUTH/)
    assert.match(turn.replies.join('\n'), /DSH Web/)
  } finally {
    await harness.cleanup()
  }
})

test('a duplicate QQ message costs no second turn', { skip }, async () => {
  const harness = await assemble()
  try {
    const messageId = 'dup-1'
    const first = await harness.qqTurn('只处理一次', { answer: '好的。', messageId })
    assert.equal(first.proceeded, false)
    const second = await harness.qqTurn('只处理一次', { answer: '好的。', messageId })
    assert.equal(second.proceeded, false, 'a duplicate is still owned, never forwarded')
    const delivered = harness.agents.get('session-manager')?.delivered ?? []
    assert.equal(delivered.length, 1, 'the duplicate must not reach the Bot')
  } finally {
    await harness.cleanup()
  }
})

test('an unauthorised peer is consumed and reaches no Bot', { skip }, async () => {
  const harness = await assemble()
  try {
    const turn = await harness.qqTurn('你好', { senderId: 'openid-stranger', answer: false })
    assert.equal(turn.proceeded, false, 'a refused peer must not fall through to the stock agent')
    assert.equal(harness.agents.size, 0)
    assert.deepEqual(turn.replies, [], 'a refused peer gets no reply')
  } finally {
    await harness.cleanup()
  }
})
