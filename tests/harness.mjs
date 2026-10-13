// Test helpers: a fake QQ adapter, a fake DSH host, and a temporary DS Bot
// team on disk. No gateway, no network, no LLM.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { createBridge } from '../lib/bridge.js'
import { createRegistry } from '../lib/registry.js'
import { createRouter, routingFile } from '../lib/router.js'
import { createDelivery } from '../lib/deliver.js'
import { bridgeSource } from '../lib/source-tag.js'

/** A Bot team shaped exactly like ds-bot's state.json. */
export const sampleState = (overrides = {}) => ({
  version: 1,
  mainBotIds: ['session-manager'],
  bots: {
    'session-manager': {
      id: 'session-manager',
      name: '管家',
      role: '总管家',
      model: 'deepseek-official/deepseek-flash',
      instructions: 'x',
    },
    'session-designer': { id: 'session-designer', name: '设计师', role: '设计师' },
    'session-coder': { id: 'session-coder', name: '程序员', role: '程序员', sessionId: 'session-coder-part2' },
    'session-companion': { id: 'session-companion', name: '聊天搭子', role: '聊天搭子' },
  },
  rooms: {},
  exchanges: [],
  exchangeTables: {},
  questions: {},
  prefs: {},
  revision: 7,
  workspaceId: 'ws-1',
  ...overrides,
})

/** Create a temporary directory holding a state.json. */
export async function tempTeam(state = sampleState()) {
  const dir = await mkdtemp(join(tmpdir(), 'qqbot-bridge-'))
  const statePath = join(dir, 'state.json')
  await mkdir(dir, { recursive: true })
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
  return {
    dir,
    statePath,
    dataDir: join(dir, 'data'),
    async write(next) {
      await writeFile(statePath, JSON.stringify(next, null, 2), 'utf8')
    },
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** The `createUserMessage` shape the delivery path needs. */
export const fakeCreateUserMessage = ({ content, source }) => ({
  id: randomUUID(),
  role: 'user',
  content,
  source,
})

/** A fake `ctx.sessionController` that records deliveries. */
export function fakeSessionController({ failWith } = {}) {
  const calls = []
  const agents = new Map()
  return {
    calls,
    async prompt(request) {
      calls.push(request)
      return { accepted: true }
    },
    async resolveAgent(sessionId) {
      if (failWith !== undefined) return { error: { code: 'session/not-found', message: failWith } }
      let agent = agents.get(sessionId)
      if (agent === undefined) {
        const delivered = []
        agent = {
          session: { id: sessionId },
          delivered,
          followup(message) {
            delivered.push(message)
          },
        }
        agents.set(sessionId, agent)
      }
      return { agent }
    },
    /** Messages actually handed to the agent for a session. */
    delivered(sessionId) {
      return agents.get(sessionId)?.delivered ?? []
    },
    agents,
  }
}

/** A fake `ctx.sessions`. */
export const fakeSessions = () => ({ flushed: [], async flush(session) { this.flushed.push(session?.id) ; return true } })

/** A fake QQ adapter that records what would have been sent. */
export function fakeAdapter() {
  const sent = []
  const listeners = new Set()
  return {
    name: 'test/adapter',
    sent,
    available: () => true,
    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async send({ target, text }) {
      sent.push({ target, text })
    },
    /** Every text sent to one OpenID, joined. */
    textTo(openId) {
      return sent.filter(entry => entry.target?.openId === openId).map(entry => entry.text).join('\n')
    },
    async deliver(raw) {
      // Mirror lib/adapter.js exactly: run the synchronous listeners and return
      // the ownership verdict. `true` means the bridge consumed the message and
      // the stock QQ chain must stop. An earlier version returned the bridge's
      // internal verdict string here, which is precisely why a missing
      // ownership propagation would have gone unnoticed (double replies).
      let handled = false
      for (const listener of listeners) {
        if (listener(raw) === true) handled = true
      }
      return handled
    },
  }
}

/** A fake cordis context: only what the bridge touches. */
export function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler)
      handlers.set(event, list)
      return () => {
        const next = (handlers.get(event) ?? []).filter(entry => entry !== handler)
        handlers.set(event, next)
      }
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
  }
}

/**
 * Assemble a bridge wired to fakes, on a real temporary state.json.
 * @returns {Promise<object>} the harness
 */
export async function harness({ config = {}, state = sampleState(), failWith } = {}) {
  const team = await tempTeam(state)
  const sessionController = fakeSessionController({ failWith })
  const sessions = fakeSessions()
  const adapter = fakeAdapter()
  const ctx = fakeCtx()
  const logs = []
  const logger = {
    info: (...args) => logs.push(['info', args.join(' ')]),
    warn: (...args) => logs.push(['warn', args.join(' ')]),
    error: (...args) => logs.push(['error', args.join(' ')]),
    debug: (...args) => logs.push(['debug', args.join(' ')]),
  }

  const registry = createRegistry({ statePath: team.statePath })
  await registry.refresh(true)
  const router = createRouter({
    file: routingFile(team.dataDir),
    fallback: () => registry.mainBot()?.name ?? '',
  })
  await router.load()
  const delivery = createDelivery({
    sessionController,
    sessions,
    createUserMessage: fakeCreateUserMessage,
    logger,
  })

  const bridge = createBridge({
    adapter,
    registry,
    router,
    delivery,
    logger,
    config: {
      allowOpenIds: ['openid-allowed'],
      defaultBot: '管家',
      queueMax: 4,
      textChunkLimit: 4500,
      replyTimeoutMs: 60_000,
      ...config,
    },
  })
  bridge.start(ctx)

  return {
    team,
    sessionController,
    sessions,
    adapter,
    ctx,
    logs,
    registry,
    router,
    delivery,
    bridge,
    /** A QQ message from the allowed peer. */
    qq(overrides = {}) {
      return {
        messageId: `msg-${randomUUID()}`,
        scope: 'c2c',
        openId: 'openid-allowed',
        content: '你好',
        ...overrides,
      }
    },
    /** Simulate a completed Bot turn on a session. */
    async turn(sessionId, { text, reason = { kind: 'completed' }, source } = {}) {
      const turnSource = source ?? bridgeSource({ requestId: 'x', peerId: 'openid-allowed' })
      ctx.emit('session/event', { header: { id: sessionId } }, { type: 'user/message', data: { source: turnSource } })
      if (text !== undefined) {
        ctx.emit('session/event', { header: { id: sessionId } }, {
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text }] } },
        })
      }
      ctx.emit('session/event', { header: { id: sessionId } }, { type: 'turn/end', data: { reason } })
      // The reply path is fire-and-forget; let it settle.
      await new Promise(resolve => setTimeout(resolve, 0))
    },
    async cleanup() {
      bridge.stop()
      await team.cleanup()
    },
  }
}
