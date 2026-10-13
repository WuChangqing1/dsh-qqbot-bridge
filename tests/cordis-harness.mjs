// Shared helpers for the tests that must run on a REAL Cordis Context.
//
// A hand-rolled fake context is what let the original startup bug ship: it
// implemented `ctx.set` as a plain assignment, so `ctx.set('qqbot', ...)`
// looked fine in every unit test while the real host refused to activate the
// plugin with `cannot set property "qqbot" without provide`. These helpers use
// the genuine `@deepseek-ai/cordis` Context so that class of bug cannot hide.

import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { sampleState } from './harness.mjs'

export const CHECKOUT = process.env.DSH_CHECKOUT ?? 'D:/CodingData/Github/deepseek-harness'
export const CORDIS_ENTRY = join(CHECKOUT, 'vendor', 'cordis', 'lib', 'index.js')
export const FORK_DIR = process.env.DSH_QQBOT_FORK ?? 'D:/CodingData/Github/dsh/dsh-bridged-qqbot'
export const FORK_MIDDLEWARE = join(FORK_DIR, 'dist', 'gateway', 'middleware-setup.js')
export const FORK_BOOTSTRAP = join(FORK_DIR, 'dist', 'gateway', 'bootstrap.js')
export const BRIDGE_ENTRY = new URL('../lib/index.js', import.meta.url).href
/** The bridge project root, as a native path. */
export const BRIDGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

// ── the layer that actually decides whether a plugin loads ─────────────────
// Everything above runs on a hand-built Cordis Context, which is already much
// stronger than the fake context that let the original bug ship -- but it still
// does not answer "does the host's Loader even mount this bundle?". These point
// at DSH's OWN composition and boot code, so a test can answer that too.
export const APP_BOOT_ENTRY = join(CHECKOUT, 'packages', 'boot', 'app-boot', 'lib', 'index.js')
export const CLI_INSTALL_ANCHOR = join(CHECKOUT, 'apps', 'cli', 'package.json')
export const DSH_HOME_DIR = process.env.DSH_HOME ?? join(homedir(), '.dsh')
export const WEB_PROFILE_DIR = join(DSH_HOME_DIR, 'profiles', 'web')

export const appBootAvailable = existsSync(APP_BOOT_ENTRY)
export const profileAvailable = existsSync(join(WEB_PROFILE_DIR, 'package.json'))
/** Why a DSH-composition test is skipped, or false when it can run. */
export const appBootSkip = appBootAvailable ? false : `dsh app-boot not built at ${APP_BOOT_ENTRY}`
/** Why a real-profile test is skipped, or false when it can run. */
export const profileSkip = !appBootAvailable
  ? appBootSkip
  : profileAvailable
    ? false
    : `no web profile at ${WEB_PROFILE_DIR}`

/** DSH's own boot/composition entry points. */
export const loadAppBoot = () => import(fileUrl(APP_BOOT_ENTRY))

export const cordisAvailable = existsSync(CORDIS_ENTRY)
export const forkAvailable = existsSync(FORK_MIDDLEWARE) && existsSync(FORK_BOOTSTRAP)

/** Why a real-Context test is skipped, or false when it can run. */
export const realContextSkip = cordisAvailable ? false : `real cordis not found at ${CORDIS_ENTRY}`
/** Why a fork-dependent test is skipped, or false when it can run. */
export const forkSkip = !cordisAvailable
  ? realContextSkip
  : forkAvailable
    ? false
    : `fork not generated at ${FORK_DIR}`

export const fileUrl = path => pathToFileURL(path).href

export const quietLogger = { info() {}, warn() {}, error() {}, debug() {} }

/** The genuine Cordis Context, created in isolation. */
export const realContext = async () => {
  const { Context } = await import(fileUrl(CORDIS_ENTRY))
  return new Context()
}

/**
 * Provide the services both plugins legitimately depend on.
 *
 * `sessionController` and `sessions` are in the bridge's declared `inject`; a
 * fiber that never sees them simply never activates, which would make a test
 * silently check nothing.
 */
export const provideHostServices = ctx => {
  const disposers = []
  disposers.push(
    ctx.provide('agents', {
      create: async () => ({ id: 'stub-agent', session: { id: 'stub-session' } }),
      resume: async () => ({ id: 'stub-agent', session: { id: 'stub-session' } }),
      get: () => undefined,
    }),
  )
  disposers.push(ctx.provide('tools', { register: () => () => {}, execute: async () => ({}) }))
  disposers.push(ctx.provide('llm', { resolveModelInfo: () => undefined, listProviders: () => [] }))
  disposers.push(ctx.provide('attachments', { save: async () => ({ id: 'stub' }) }))
  disposers.push(ctx.provide('userQuestions', { ask: async () => ({}) }))
  disposers.push(ctx.provide('sessionTitle', { rename: async () => {} }))
  disposers.push(ctx.provide('workspaceRegistry', { get: () => undefined, archiveSession: async () => {} }))
  disposers.push(ctx.provide('sessions', { flush: async () => true }))
  disposers.push(
    ctx.provide('sessionController', {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }),
      prompt: async () => ({ accepted: true }),
    }),
  )
  return disposers
}

/** A temp DS Bot team on disk, so the registry has real work to do. */
export const tempTeam = async (state = sampleState()) => {
  const dir = join(tmpdir(), `qqbot-bridge-cordis-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  const statePath = join(dir, 'state.json')
  await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
  return {
    dir,
    statePath,
    dataDir: join(dir, 'data'),
    write: async next => writeFile(statePath, JSON.stringify(next, null, 2), 'utf8'),
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  }
}

/** Keep the QQ SDK off the network for every fork test. */
export const withOfflineSdk = async fn => {
  const previousBase = process.env.QQBOT_BASE_URL
  process.env.QQBOT_BASE_URL = 'http://127.0.0.1:9'
  try {
    return await fn()
  } finally {
    if (previousBase === undefined) delete process.env.QQBOT_BASE_URL
    else process.env.QQBOT_BASE_URL = previousBase
  }
}

export const BRIDGE_CONFIG = overrides => ({
  allowOpenIds: ['openid-allowed'],
  defaultBot: '管家',
  allowGroups: false,
  replyTimeoutMs: 60_000,
  queueMax: 4,
  textChunkLimit: 4500,
  debug: false,
  ...overrides,
})

/** Load the fork's compiled entry points. */
export const forkEntries = async () => ({
  index: await import(fileUrl(join(FORK_DIR, 'dist', 'index.js'))),
  bootstrap: await import(fileUrl(FORK_BOOTSTRAP)),
})

/** The config the fork ships with, minus credentials. */
export const forkConfig = overrides => ({
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
  ...overrides,
})

/**
 * Run the fork's `bootstrapGateway` inside a plugin fiber.
 *
 * The fiber matters twice over: it owns the `ctx.provide('qqbot', ...)`
 * registration (so disposing it is what proves unregistration on unload), and
 * the fork's lifecycle effect — which stops the QQBot SDK — only runs on
 * dispose. Without that the SDK keeps its reconnect timers alive and the test
 * process never exits.
 */
export const runForkInFiber = async (ctx, bootstrapGateway, overrides = {}) => {
  const fiber = ctx.plugin({
    inject: ['agents'],
    async apply(fiberCtx) {
      await bootstrapGateway(fiberCtx, fiberCtx.agents, forkConfig(overrides), quietLogger)
    },
  })
  await fiber
  return fiber
}

/** A fake `qqbot` service, recording what the bridge registers with it. */
export const fakeQqbotService = ({ withExtensionPoint = true } = {}) => {
  const sent = []
  const handlers = []
  const service = {
    sent,
    handlers,
    sender: { sendMarkdown: async (target, content) => sent.push({ target, content }) },
    manager: {},
    config: { appId: 'stub' },
    replyTargetFor: (scope, targetId) => ({ scope, targetId }),
    /** How many pre-handlers the bridge registered (diagnostics). */
    get preHandlerCount() {
      return handlers.length
    },
  }
  if (withExtensionPoint) {
    service.setMessagePreHandler = handler => {
      handlers.push(handler)
      return () => {
        const at = handlers.indexOf(handler)
        if (at !== -1) handlers.splice(at, 1)
      }
    }
  }
  /** Deliver one QQ message through the pre-handlers, as the fork's wrapper does. */
  service.deliver = mCtx => {
    for (const handler of handlers) {
      if (handler(mCtx) === true) return true
    }
    return false
  }
  return service
}

/** Start the bridge plugin on a real Context. */
export const startBridgePlugin = async (ctx, config) => {
  const plugin = await import(BRIDGE_ENTRY)
  const fiber = ctx.plugin({ inject: plugin.inject, apply: (fiberCtx, cfg) => plugin.apply(fiberCtx, cfg) }, config)
  await fiber
  return { plugin, fiber }
}

/**
 * Wait until the bridge reports itself wired, or give up.
 * @returns {Promise<object|undefined>} the published `qqbotBridge` service
 */
export const waitForBridge = async (ctx, { attempts = 100, delayMs = 10 } = {}) => {
  const published = ctx.get('qqbotBridge')
  for (let attempt = 0; attempt < attempts && published?.available !== true; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return published
}
