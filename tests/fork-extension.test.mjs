// Integration test for the FORKED QQ plugin's extension point.
//
// Enabled only when the fork has been generated AND installed as a profile
// dependency (its own bare imports resolve through that profile):
//   node scripts/make-bridged-qqbot.mjs --out <dir>
//   # link it in profiles/web/package.json, then pnpm install
//   DSH_QQBOT_FORK=<dir> DSH_QQBOT_PROFILE=<profile dir> node tests/fork-extension.test.mjs
//
// It proves the contract dsh-qqbot-bridge depends on:
//   1. a pre-handler runs BEFORE the stock middleware chain;
//   2. returning true stops the chain, so the stock 'message' listener never runs;
//   3. returning false lets the chain reach the stock 'message' listener.
//
// The fixture is a complete-enough QQBot stand-in: the stock chain really runs
// (accessPolicy, mentionGate, slashCommand, concurrencyGuard, typingIndicator,
// quoteRef, attachmentProcessor, envelopeFormatter), so this test would catch a
// patch that only looks right.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const forkDir = process.env.DSH_QQBOT_FORK
const profileDir = process.env.DSH_QQBOT_PROFILE
const forkMiddleware = forkDir === undefined ? undefined : join(forkDir, 'dist', 'gateway', 'middleware-setup.js')
const forkBootstrap = forkDir === undefined ? undefined : join(forkDir, 'dist', 'gateway', 'bootstrap.js')

const installedPath =
  profileDir === undefined
    ? undefined
    : join(profileDir, 'node_modules', '@tencent-connect', 'dsh-qqbot', 'dist', 'gateway', 'middleware-setup.js')

const available =
  forkMiddleware !== undefined &&
  forkBootstrap !== undefined &&
  existsSync(forkMiddleware) &&
  existsSync(forkBootstrap) &&
  installedPath !== undefined &&
  existsSync(installedPath)

const skip = available
  ? false
  : 'fork not installed (run scripts/make-bridged-qqbot.mjs, link it into the profile, then pnpm install)'

/** A complete-enough stand-in for the SDK's QQBot. */
function fakeBot() {
  const middlewares = []
  const handlers = new Map()
  const calls = { typing: 0, text: 0, markdown: 0 }
  const bot = {
    middlewares,
    calls,
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
      calls.typing += 1
      return { ok: true }
    },
    async sendText() {
      calls.text += 1
      return { ok: true }
    },
    async sendMarkdown() {
      calls.markdown += 1
      return { ok: true }
    },
    openStream() {
      return { update() {}, complete() {}, abort() {} }
    },
    /** Run the chain exactly the way the SDK does. */
    async dispatch(ctx) {
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

const inboxMessage = (content = 'hello') => {
  const replyTarget = { scope: 'c2c', targetId: 'openid-a', msgId: 'm-1' }
  return {
    messageId: 'm-1',
    kind: 'c2c',
    senderId: 'openid-a',
    content,
    replyTarget,
    timestamp: Date.now(),
    attachments: [],
  }
}

const messageCtx = (content = 'hello') => {
  const message = inboxMessage(content)
  return {
    bot: undefined,
    message,
    replyTarget: message.replyTarget,
    state: {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
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

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }
const load = () => import(`file://${forkMiddleware.replace(/\\/g, '/')}`)

/** Build a bot whose chain carries the fork's pre-handler plus an optional probe. */
const build = async ({ preHandler, probe, config: overrides }) => {
  const { setupMiddlewares } = await load()
  const bot = fakeBot()
  const manager = { questionChannel: undefined, approvalChannel: undefined, findBySessionId: () => undefined }
  setupMiddlewares(
    bot,
    overrides === undefined ? config : { ...config, ...overrides },
    manager,
    quietLogger,
    preHandler === undefined ? [] : [preHandler],
  )
  if (probe !== undefined) bot.use(probe)
  return bot
}

const run = async (bot, content = 'hello') => {
  const ctx = messageCtx(content)
  ctx.bot = bot
  const proceeded = await bot.dispatch(ctx)
  return { ctx, proceeded }
}

test('the fork accepts a pre-handler argument', { skip }, async () => {
  const { setupMiddlewares } = await load()
  assert.match(String(setupMiddlewares), /preHandlers/)
})

test('a pre-handler that returns true consumes the message', { skip }, async () => {
  const seen = []
  const bot = await build({
    preHandler: ctx => {
      seen.push(ctx.message.messageId)
      return true
    },
  })
  bot.on('message', () => seen.push('stock-listener'))
  const { ctx, proceeded } = await run(bot)

  assert.equal(proceeded, false, 'the chain must be stopped')
  assert.equal(ctx.stopped, true)
  assert.equal(ctx.stopReason, 'qqbot-bridge:consumed')
  assert.deepEqual(seen, ['m-1'], 'the pre-handler ran and the stock listener did not')
})

test('a pre-handler that returns false lets the chain reach the stock listener', { skip }, async () => {
  const seen = []
  const bot = await build({
    preHandler: ctx => {
      seen.push(`pre:${ctx.message.messageId}`)
      return false
    },
    probe: async (ctx, next) => {
      seen.push('probe')
      return next()
    },
  })
  bot.on('message', () => seen.push('stock-listener'))

  const { ctx, proceeded } = await run(bot)
  assert.equal(proceeded, true)
  assert.equal(ctx.stopped, false)
  assert.deepEqual(seen, ['pre:m-1', 'probe', 'stock-listener'], 'passing through keeps the stock behaviour')
})

test('the pre-handler runs before the stock access policy can refuse', { skip }, async () => {
  // With c2c disabled, the stock accessPolicy stops the chain early. The
  // pre-handler sits at position 0, so it has already run by then -- which is
  // what lets the bridge apply its own fail-closed allowlist rather than being
  // limited to the plugin's policy.
  const seen = []
  const bot = await build({
    preHandler: ctx => {
      seen.push(`pre:${ctx.message.senderId}`)
      return false
    },
    config: { access: { c2cMode: 'disabled', c2cAllow: [], groupMode: 'disabled', groupAllow: [] } },
  })
  bot.on('message', () => seen.push('stock-listener'))

  const { ctx } = await run(bot)
  assert.deepEqual(seen, ['pre:openid-a'], 'the pre-handler ran, then the stock chain refused the message')
  assert.equal(ctx.stopped, true, 'the stock policy still stops the chain for messages the bridge passes through')
})

test('the generated fork carries its patch marker', { skip }, async () => {
  const { readFile } = await import('node:fs/promises')
  const marker = join(forkDir, 'PATCH-0001-APPLIED.md')
  assert.equal(existsSync(marker), true, 'a generated fork carries a patch marker')
  const text = await readFile(marker, 'utf8')
  assert.match(text, /Patch 0001 applied/)
  assert.match(text, /setMessagePreHandler/)
})
