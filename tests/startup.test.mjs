// Startup behaviour of the bridge, on a REAL Cordis Context.
//
// These tests drive the real `apply()` -- config validation, service
// registration, transport discovery, the injected bring-up -- rather than a
// hand-rolled fake. The fake is what hid the original defect: it treated
// `ctx.set` as plain assignment, so `ctx.set('qqbotBridge', ...)` passed every
// unit test while the live host refused to activate the plugin with
// `cannot set property "qqbotBridge" without provide`.
//
// The QQ transport is a stub here; `cordis-activation.test.mjs` covers the
// genuine forked plugin.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  BRIDGE_ENTRY,
  BRIDGE_CONFIG,
  fakeQqbotService,
  provideHostServices,
  realContext,
  realContextSkip,
  startBridgePlugin,
  tempTeam,
  waitForBridge,
} from './cordis-harness.mjs'

/** The plugin module loads only when its bare imports are reachable. */
const loadPlugin = async () => {
  try {
    return { module: await import(BRIDGE_ENTRY) }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) }
  }
}

const loaded = await loadPlugin()
const loadSkip = loaded.module === undefined ? `plugin entry not loadable here: ${loaded.reason}` : false
/** Any real-Context test needs both the module and the real Context. */
const skip = loadSkip === false ? realContextSkip : loadSkip

test('the plugin entry exports the cordis contract the loader expects', { skip: loadSkip }, () => {
  const { module } = loaded
  assert.equal(module.name, 'qqbot-bridge')
  assert.ok(Array.isArray(module.inject), 'inject must be an array of service names')
  // Deliberately empty: a declared-but-absent service suspends a Cordis plugin
  // with NO diagnostic (the fiber sits in `pending` and `apply()` never runs).
  // The same dependency is expressed imperatively instead, where a watchdog can
  // name every service that has not arrived yet.
  assert.deepEqual(module.inject, [], 'the plugin must not declare services it would silently wait for')
  assert.deepEqual(module.REQUIRED_SERVICES, ['sessionController', 'sessions', 'qqbot'])
  assert.equal(typeof module.WATCHDOG_INTERVAL_MS, 'number')
  assert.equal(typeof module.Config, 'function', 'Config must be a schemastery schema')
  assert.equal(typeof module.apply, 'function')
})

test('the Config schema accepts the profile values and keeps Chinese defaults', { skip: loadSkip }, () => {
  const { module } = loaded
  const resolved = module.Config(BRIDGE_CONFIG({ statePath: 'x', dataDir: 'y' }))
  assert.deepEqual(resolved.allowOpenIds, ['openid-allowed'])
  assert.equal(resolved.defaultBot, '管家', 'a CJK default must survive schema resolution')
  assert.equal(resolved.replyTimeoutMs, 60_000)
  assert.deepEqual(module.Config({}).allowOpenIds, [], 'an omitted allowlist must stay empty, not become a wildcard')
})

test('apply() activates on a real Context and publishes qqbotBridge', { skip }, async () => {
  const ctx = await realContext()
  const hostDisposers = provideHostServices(ctx)
  const team = await tempTeam()
  const qqbotDispose = ctx.provide('qqbot', fakeQqbotService())
  try {
    await startBridgePlugin(ctx, BRIDGE_CONFIG({ statePath: team.statePath, dataDir: team.dataDir }))

    // The regression: this used to throw "cannot set property ... without provide".
    const published = ctx.get('qqbotBridge')
    assert.ok(published !== undefined, 'apply must publish qqbotBridge')
    assert.equal(published.identity.name, 'qqbot-bridge')

    const wired = await waitForBridge(ctx)
    assert.equal(wired.available, true, 'the bridge must wire itself once the QQ transport is available')

    const status = wired.status()
    assert.equal(status.bots.length, 4, 'the four real Bots must be discovered from state.json')
    assert.deepEqual(status.bots.map(bot => bot.name), ['管家', '设计师', '程序员', '聊天搭子'])
    assert.equal(status.sourceKind, 'qqbot-bridge')
  } finally {
    qqbotDispose()
    for (const dispose of hostDisposers) dispose()
    await team.cleanup()
  }
})

test('apply() installs its pre-handler into the fork and routes a message', { skip }, async () => {
  const ctx = await realContext()
  const hostDisposers = provideHostServices(ctx)
  const team = await tempTeam()
  const service = fakeQqbotService()
  const qqbotDispose = ctx.provide('qqbot', service)
  try {
    await startBridgePlugin(ctx, BRIDGE_CONFIG({ statePath: team.statePath, dataDir: team.dataDir }))
    const wired = await waitForBridge(ctx)
    assert.equal(wired.available, true)
    assert.equal(service.preHandlerCount, 1, 'the bridge must register exactly one pre-handler')

    // Deliver a QQ message the way the fork's wrapper middleware does.
    const consumed = service.deliver({
      message: {
        messageId: 'cordis-startup-1',
        kind: 'c2c',
        senderId: 'openid-allowed',
        content: '/团队',
        replyTarget: { scope: 'c2c', targetId: 'openid-allowed', msgId: 'cordis-startup-1' },
      },
      replyTarget: { scope: 'c2c', targetId: 'openid-allowed', msgId: 'cordis-startup-1' },
    })
    assert.equal(consumed, true, 'the bridge must own the message')
    // `/团队` answers through a tracked background task; drain it.
    await wired.bridge.drain()

    const reply = service.sent.map(entry => entry.content).join('\n')
    assert.match(reply, /团队共 4 个 Bot/)
    for (const name of ['管家', '设计师', '程序员', '聊天搭子']) assert.match(reply, new RegExp(name))
  } finally {
    qqbotDispose()
    for (const dispose of hostDisposers) dispose()
    await team.cleanup()
  }
})

test('apply() records a refused OpenID instead of reaching a Bot', { skip }, async () => {
  const ctx = await realContext()
  const hostDisposers = provideHostServices(ctx)
  const team = await tempTeam()
  const service = fakeQqbotService()
  const qqbotDispose = ctx.provide('qqbot', service)
  try {
    await startBridgePlugin(
      ctx,
      BRIDGE_CONFIG({ statePath: team.statePath, dataDir: team.dataDir, allowOpenIds: [] }),
    )
    const wired = await waitForBridge(ctx)
    assert.match(wired.status().access, /denied/)

    const consumed = service.deliver({
      message: {
        messageId: 'cordis-startup-2',
        kind: 'c2c',
        senderId: 'openid-stranger',
        content: '你好',
        replyTarget: { scope: 'c2c', targetId: 'openid-stranger', msgId: 'cordis-startup-2' },
      },
      replyTarget: { scope: 'c2c', targetId: 'openid-stranger', msgId: 'cordis-startup-2' },
    })
    assert.equal(consumed, true, 'a refused peer must not fall through to the stock agent')
    assert.equal(service.sent.length, 0, 'a refused peer gets no reply')
    await wired.bridge.drain()

    const candidates = join(team.dataDir, 'rejected-openids.json')
    for (let attempt = 0; attempt < 100 && !existsSync(candidates); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(existsSync(candidates), true, 'the refused OpenID must be recorded for first-time setup')
    const parsed = JSON.parse(await readFile(candidates, 'utf8'))
    assert.equal(parsed.rejected[0].openId, 'openid-stranger')
  } finally {
    qqbotDispose()
    for (const dispose of hostDisposers) dispose()
    await team.cleanup()
  }
})

test('apply() reports a service without the extension point instead of pretending to work', { skip }, async () => {
  const ctx = await realContext()
  const hostDisposers = provideHostServices(ctx)
  const team = await tempTeam()
  const qqbotDispose = ctx.provide('qqbot', fakeQqbotService({ withExtensionPoint: false }))
  try {
    await startBridgePlugin(ctx, BRIDGE_CONFIG({ statePath: team.statePath, dataDir: team.dataDir }))
    const wired = await waitForBridge(ctx, { attempts: 40 })
    // The service exists but carries no extension point: the bridge itself runs,
    // but it must not claim a working QQ transport.
    assert.equal(wired.available, true, 'the bridge is running')
    assert.equal(wired.transportOk, false, 'a service without the extension point is not a usable transport')
    assert.match(String(wired.status().transport), /unavailable/i)
  } finally {
    qqbotDispose()
    for (const dispose of hostDisposers) dispose()
    await team.cleanup()
  }
})

test('the bridge activates and stays inert when qqbot never appears', { skip }, async () => {
  const ctx = await realContext()
  const hostDisposers = provideHostServices(ctx)
  const team = await tempTeam()
  try {
    await startBridgePlugin(ctx, BRIDGE_CONFIG({ statePath: team.statePath, dataDir: team.dataDir }))
    // Activation must NOT depend on the optional transport: a plugin that never
    // activates would give the operator no diagnostic at all.
    const published = ctx.get('qqbotBridge')
    assert.ok(published !== undefined, 'the plugin must activate even without its optional transport')
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(published.available, false)
    assert.match(String(published.status().reason), /not wired/i)
  } finally {
    for (const dispose of hostDisposers) dispose()
    await team.cleanup()
  }
})

test('apply() reports a missing Bot team rather than failing', { skip }, async () => {
  const ctx = await realContext()
  const hostDisposers = provideHostServices(ctx)
  const team = await tempTeam({ version: 1, mainBotIds: [], bots: {}, rooms: {}, revision: 1 })
  const qqbotDispose = ctx.provide('qqbot', fakeQqbotService())
  try {
    await startBridgePlugin(ctx, BRIDGE_CONFIG({ statePath: team.statePath, dataDir: team.dataDir }))
    const wired = await waitForBridge(ctx)
    assert.equal(wired.available, true)
    assert.equal(wired.status().bots.length, 0)
  } finally {
    qqbotDispose()
    for (const dispose of hostDisposers) dispose()
    await team.cleanup()
  }
})
