// Integration tests on a REAL Cordis Context -- no mock context.
//
// These exist because a mock context hides exactly the class of bug that broke
// the live host: `ctx.set(name, value)` looks like service registration but is
// not. In Cordis 4 it may only OVERWRITE a service some fiber already provided,
// and otherwise throws
//
//     cannot set property "<name>" without provide
//
// which is what the host reported for both `im-qqbot` and `qqbot-bridge`,
// leaving "2 entries did not activate". A hand-rolled fake context implements
// `set` as a plain assignment, so every unit test passed while the real host
// refused to start either plugin.
//
// The context here is the genuine `@deepseek-ai/cordis` Context, created in
// isolation so the test needs no DSH installation.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { sampleState } from './harness.mjs'

const CHECKOUT = process.env.DSH_CHECKOUT ?? 'D:/CodingData/Github/deepseek-harness'
const CORDIS_ENTRY = join(CHECKOUT, 'vendor', 'cordis', 'lib', 'index.js')
const FORK_DIR = process.env.DSH_QQBOT_FORK ?? 'D:/CodingData/Github/dsh/dsh-bridged-qqbot'
const FORK_MIDDLEWARE = join(FORK_DIR, 'dist', 'gateway', 'middleware-setup.js')
const FORK_BOOTSTRAP = join(FORK_DIR, 'dist', 'gateway', 'bootstrap.js')

const cordisAvailable = existsSync(CORDIS_ENTRY)
const forkAvailable = existsSync(FORK_MIDDLEWARE) && existsSync(FORK_BOOTSTRAP)
const skip = cordisAvailable
  ? forkAvailable
    ? false
    : `fork not generated at ${FORK_DIR}`
  : `real cordis not found at ${CORDIS_ENTRY}`

const fileUrl = path => pathToFileURL(path).href

/** The genuine Cordis Context, created in isolation. */
const realContext = async () => {
  const { Context } = await import(fileUrl(CORDIS_ENTRY))
  return new Context()
}

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }

/** Provide the services the two plugins legitimately depend on. */
const provideHostServices = ctx => {
  const disposers = []
  const agents = {
    create: async () => ({ id: 'stub-agent', session: { id: 'stub-session' } }),
    resume: async () => ({ id: 'stub-agent', session: { id: 'stub-session' } }),
    get: () => undefined,
  }
  disposers.push(ctx.provide('agents', agents))
  disposers.push(ctx.provide('tools', { register: () => () => {}, execute: async () => ({}) }))
  disposers.push(ctx.provide('llm', { resolveModelInfo: () => undefined, listProviders: () => [] }))
  disposers.push(ctx.provide('attachments', { save: async () => ({ id: 'stub' }) }))
  disposers.push(ctx.provide('userQuestions', { ask: async () => ({}) }))
  disposers.push(ctx.provide('sessionTitle', { rename: async () => {} }))
  disposers.push(ctx.provide('workspaceRegistry', { get: () => undefined, archiveSession: async () => {} }))
  // The bridge declares these two in its `inject`, so a fiber that never sees
  // them would simply never activate -- and the test would be checking nothing.
  disposers.push(ctx.provide('sessions', { flush: async () => true }))
  disposers.push(
    ctx.provide('sessionController', {
      resolveAgent: async sessionId => ({
        agent: { session: { id: sessionId }, followup() {} },
      }),
      prompt: async () => ({ accepted: true }),
    }),
  )
  return disposers
}

/**
 * Load the fork's patches the way the host loads the plugin: its own
 * `cordis.patch.yml` names two entries, and patch 0001 adds the `qqbot` service
 * inside `bootstrapGateway`.
 */
const forkEntries = async () => {
  const index = await import(fileUrl(join(FORK_DIR, 'dist', 'index.js')))
  const bootstrap = await import(fileUrl(FORK_BOOTSTRAP))
  return { index, bootstrap }
}

/** A temp DS Bot team, so the bridge's registry has real work to do. */
const tempTeam = async () => {
  const dir = join(tmpdir(), `qqbot-bridge-cordis-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  const statePath = join(dir, 'state.json')
  await writeFile(statePath, JSON.stringify(sampleState(), null, 2), 'utf8')
  return { dir, statePath, dataDir: join(dir, 'data'), cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

const BRIDGE_CONFIG = overrides => ({
  allowOpenIds: ['openid-allowed'],
  defaultBot: '管家',
  allowGroups: false,
  replyTimeoutMs: 60_000,
  queueMax: 4,
  textChunkLimit: 4500,
  debug: false,
  ...overrides,
})

/**
 * Run the fork's `bootstrapGateway` inside a plugin fiber.
 *
 * The fiber matters for two reasons:
 *   * it owns the `ctx.provide('qqbot', ...)` registration, so disposing it is
 *     what proves the service is unregistered on unload;
 *   * the fork's lifecycle effect (which stops the QQBot SDK) only runs on
 *     dispose. Without it the SDK keeps its reconnect timers alive and the test
 *     process never exits.
 *
 * @returns {Promise<object>} the fiber, already settled
 */
const runForkInFiber = async (ctx, bootstrapGateway, overrides = {}) => {
  const fiber = ctx.plugin({
    inject: ['agents'],
    async apply(fiberCtx) {
      await bootstrapGateway(fiberCtx, fiberCtx.agents, { ...config(), ...overrides }, quietLogger)
    },
  })
  await fiber
  return fiber
}

// ── 1. the exact reported failure mode ─────────────────────────────────────

test('a real Context rejects ctx.set before provide with the host\'s exact error', { skip: !cordisAvailable ? `no cordis at ${CORDIS_ENTRY}` : false }, async () => {
  const ctx = await realContext()
  // This assertion pins the regression: the old code called this and died.
  assert.throws(
    () => ctx.set('qqbot', { anything: true }),
    /cannot set property "qqbot" without provide/,
    'ctx.set must not register a new service',
  )
  assert.throws(
    () => ctx.set('qqbotBridge', { anything: true }),
    /cannot set property "qqbotBridge" without provide/,
    'ctx.set must not register a new service',
  )
})

test('provide registers a service, set only overwrites it, dispose unregisters it', { skip: !cordisAvailable ? `no cordis at ${CORDIS_ENTRY}` : false }, async () => {
  const ctx = await realContext()
  const service = { version: 1 }
  const dispose = ctx.provide('qqbot', service)
  assert.equal(typeof dispose, 'function', 'provide must return a disposer')
  assert.equal(ctx.get('qqbot'), service)
  assert.equal(ctx.qqbot, service, 'the service is also reachable as a context property')

  // Now `set` is legal, because a fiber owns the registration.
  ctx.set('qqbot', { version: 2 })
  assert.deepEqual(ctx.get('qqbot'), { version: 2 })

  dispose()
  assert.equal(ctx.get('qqbot', false), undefined, 'dispose must unregister the service')
})

// ── 2. the fork publishes `qqbot` on a real Context ────────────────────────

/** Put the SDK off the network for every fork test. */
const withOfflineSdk = async fn => {
  const previousBase = process.env.QQBOT_BASE_URL
  process.env.QQBOT_BASE_URL = 'http://127.0.0.1:9'
  try {
    return await fn()
  } finally {
    if (previousBase === undefined) delete process.env.QQBOT_BASE_URL
    else process.env.QQBOT_BASE_URL = previousBase
  }
}

test('the forked QQ plugin publishes its service with provide (no activation error)', { skip }, async () => {
  const ctx = await realContext()
  const disposers = provideHostServices(ctx)
  // Keep the SDK off the network: an unreachable base URL makes `bot.start()`
  // fail fast in a `catch`, which the fork logs and does not propagate.
  await withOfflineSdk(async () => {
    const { bootstrap } = await forkEntries()
    assert.equal(typeof bootstrap.bootstrapGateway, 'function')
    const fiber = await runForkInFiber(ctx, bootstrap.bootstrapGateway, { appId: 'stub-app', appSecret: 'stub-secret' })
    try {
      // The regression: this used to throw "cannot set property ... without provide".
      const qqbot = ctx.get('qqbot')
      assert.ok(qqbot !== undefined, 'the fork must publish the qqbot service')
      assert.equal(typeof qqbot.setMessagePreHandler, 'function')
      assert.equal(typeof qqbot.replyTargetFor, 'function')
      assert.equal(qqbot.config.appId, 'stub-app')
    } finally {
      await fiber.dispose()
      for (const dispose of disposers) dispose()
    }
  })
})

test('the fork\'s pre-handler registration is idempotent and disposable', { skip }, async () => {
  const ctx = await realContext()
  const disposers = provideHostServices(ctx)
  await withOfflineSdk(async () => {
    const { bootstrap } = await forkEntries()
    const fiber = await runForkInFiber(ctx, bootstrap.bootstrapGateway)
    try {
      const qqbot = ctx.get('qqbot')

      const handler = () => false
      const off1 = qqbot.setMessagePreHandler(handler)
      assert.equal(qqbot.preHandlerCount, 1)
      // Registering the SAME handler again must replace, not duplicate: a reload
      // calls this a second time and must not accumulate handlers.
      const off2 = qqbot.setMessagePreHandler(handler)
      assert.equal(qqbot.preHandlerCount, 1, 're-registering the same handler must not duplicate it')
      assert.equal(typeof off1, 'function')
      assert.equal(typeof off2, 'function')
      off2()
      assert.equal(qqbot.preHandlerCount, 0, 'the disposer must remove the handler')
    } finally {
      await fiber.dispose()
      for (const dispose of disposers) dispose()
    }
  })
})

test('disposing the fork fiber unregisters the qqbot service', { skip }, async () => {
  const ctx = await realContext()
  const disposers = provideHostServices(ctx)
  await withOfflineSdk(async () => {
    const { bootstrap } = await forkEntries()
    // Run inside a plugin fiber so the provide is tied to a disposer we control.
    const fiber = await runForkInFiber(ctx, bootstrap.bootstrapGateway)
    assert.ok(ctx.get('qqbot') !== undefined, 'service must be live while the fiber is active')
    await fiber.dispose()
    assert.equal(ctx.get('qqbot', false), undefined, 'unloading the plugin must unregister the service')
    for (const dispose of disposers) dispose()
  })
})

// ── 3. the bridge activates against a real Context ─────────────────────────

test('the bridge activates on a real Context, published service and all', { skip }, async () => {
  const ctx = await realContext()
  const hostDisposers = provideHostServices(ctx)
  const team = await tempTeam()
  // The bridge waits for `qqbot` through ctx.inject, so provide it first --
  // exactly the ordering a host with the forked plugin has.
  const qqbotDispose = ctx.provide('qqbot', {
    bot: { sendMarkdown: async () => ({}) },
    sender: { sendMarkdown: async () => ({}) },
    config: {},
    replyTargetFor: (scope, targetId) => ({ scope, targetId }),
    setMessagePreHandler: () => () => {},
  })
  try {
    const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
    assert.equal(plugin.name, 'qqbot-bridge')
    assert.ok(Array.isArray(plugin.inject))

    const fiber = ctx.plugin({
      inject: plugin.inject,
      apply: (fiberCtx, cfg) => plugin.apply(fiberCtx, cfg),
    }, BRIDGE_CONFIG({ statePath: team.statePath, dataDir: team.dataDir }))
    await fiber

    // The regression: `ctx.provide('qqbotBridge', ...)` must not throw.
    const published = ctx.get('qqbotBridge')
    assert.ok(published !== undefined, 'the bridge must publish qqbotBridge')
    assert.equal(published.identity.name, 'qqbot-bridge')

    // The injected callback runs once qqbot is available; give it a tick.
    for (let attempt = 0; attempt < 100 && published.available !== true; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(published.available, true, 'the bridge must wire itself once the QQ transport is available')
    const status = published.status()
    assert.equal(status.bots.length, 4, 'the real team must be picked up from state.json')
    assert.equal(status.sourceKind, 'qqbot-bridge')
  } finally {
    qqbotDispose()
    for (const dispose of hostDisposers) dispose()
    await team.cleanup()
  }
})

test('unloading the bridge unregisters qqbotBridge and re-loading does not collide', { skip }, async () => {
  const ctx = await realContext()
  const hostDisposers = provideHostServices(ctx)
  const team = await tempTeam()
  const qqbotDispose = ctx.provide('qqbot', {
    sender: { sendMarkdown: async () => ({}) },
    config: {},
    setMessagePreHandler: () => () => {},
  })
  try {
    const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
    const start = () => ctx.plugin({ inject: plugin.inject, apply: (c, cfg) => plugin.apply(c, cfg) }, BRIDGE_CONFIG({ statePath: team.statePath, dataDir: team.dataDir }))

    const first = start()
    await first
    assert.ok(ctx.get('qqbotBridge') !== undefined)

    await first.dispose()
    assert.equal(ctx.get('qqbotBridge', false), undefined, 'unloading must unregister qqbotBridge')

    // A reload must not hit "service has been registered at ...".
    const second = start()
    await second
    assert.ok(ctx.get('qqbotBridge') !== undefined, 'the reloaded bridge must publish its service again')
    await second.dispose()
  } finally {
    qqbotDispose()
    for (const dispose of hostDisposers) dispose()
    await team.cleanup()
  }
})

test('the bridge reports unavailable instead of throwing when qqbot never appears', { skip }, async () => {
  const ctx = await realContext()
  const hostDisposers = provideHostServices(ctx)
  const team = await tempTeam()
  try {
    const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
    const fiber = ctx.plugin({ inject: plugin.inject, apply: (c, cfg) => plugin.apply(c, cfg) }, BRIDGE_CONFIG({ statePath: team.statePath, dataDir: team.dataDir }))
    await fiber

    // qqbot never provided: the plugin still activates (so the operator gets a
    // real diagnostic) but the transport is not wired.
    const published = ctx.get('qqbotBridge')
    assert.ok(published !== undefined, 'the plugin must activate even without its optional transport')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(published.available, false)
    assert.match(String(published.status().reason), /not wired/i)
  } finally {
    for (const dispose of hostDisposers) dispose()
    await team.cleanup()
  }
})

/** The config the fork ships with, minus credentials. */
function config() {
  return {
    appId: 'stub',
    appSecret: 'stub',
    requireMention: true,
    historyLimit: 10,
    textChunkLimit: 4500,
    maxQueue: 20,
    processingTimeoutMs: 1000,
    sessionIdleTimeout: 1_800_000,
    streaming: false,
    askTimeoutMs: 300_000,
    showToolResults: false,
    access: { c2cMode: 'open', c2cAllow: [], groupMode: 'disabled', groupAllow: [] },
    debug: false,
    media: { enabled: false, maxMB: 1, ttlHours: 1 },
    vision: { enabled: false },
    sendFile: { restrictPaths: true, extraRoots: [] },
  }
}
