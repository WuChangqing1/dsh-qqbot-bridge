// dsh-qqbot-bridge -- a DSH host plugin.
//
// QQ official bot private chats -> the EXISTING DS Bot team sessions.
// No replacement agents, no duplicated system prompts, no writes to state.json,
// no second QQ gateway.
//
// ── Service wiring (why this shape) ────────────────────────────────────────
// Cordis 4 separates the two service operations:
//   * `ctx.provide(name, value)` registers a NEW service, owned by the calling
//     fiber. It returns a disposer, and the service disappears when the fiber
//     unloads, which is what makes reload and teardown safe.
//   * `ctx.set(name, value)` may only OVERWRITE a service some fiber already
//     provided. Calling it first throws
//     `cannot set property "<name>" without provide`.
// An earlier version used `ctx.set` for both halves of this plugin, which is
// exactly why the host reported `2 entries did not activate`.
//
// ── Why `inject` is empty (and how the wait is still safe) ─────────────────
// Cordis suspends a plugin whose DECLARED services never appear, silently: the
// fiber sits in `pending`, `apply()` is never called, and nothing the plugin
// owns can report why. That turned "the gateway service never arrived" into an
// invisible state. `apply()` therefore declares nothing, runs unconditionally,
// and does the waiting itself with `ctx.inject([...])` plus a watchdog that
// names each service it is still missing. The dependency is unchanged; only the
// silence is.
//
// ── Why every lifecycle line also hits the console ─────────────────────────
// A DSH host mounts no console exporter for `ctx.logger`, so
// `ctx.logger.info(...)` lands in an in-memory ring buffer and is never shown
// (see ./host-log.js for the full evidence). Activation facts therefore go
// through `createHostLog()` as well, and the same facts are written to
// `<dataDir>/bridge-status.json` (see ./status.js) so they survive the terminal.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import Schema from '@deepseek-ai/schemastery'

import { createBridge } from './bridge.js'
import { createRegistry } from './registry.js'
import { createRouter, routingFile } from './router.js'
import { createDelivery } from './deliver.js'
import { createLogger } from './log.js'
import { createHostLog, describeError } from './host-log.js'
import { createStatusWriter } from './status.js'
import { resolveAdapter } from './adapter.js'
import { createRejectedLog, rejectedFile } from './rejected-log.js'

const require = createRequire(import.meta.url)
/** This package's own version, reported in the status document. */
const VERSION = require('../package.json').version

export const name = 'qqbot-bridge'

/**
 * Services the bridge needs before it can carry a single message, in the order
 * an operator should read them.
 *
 * `sessionController` and `sessions` belong to DSH itself; `qqbot` is published
 * by the locally forked @tencent-connect/dsh-qqbot. The bridge consumes it with
 * `ctx.inject`, so it never opens a second gateway.
 */
export const REQUIRED_SERVICES = ['sessionController', 'sessions', 'qqbot']

/**
 * Deliberately EMPTY. See the header: a declared-but-absent service suspends the
 * plugin with no diagnostic at all, so the wait is done imperatively instead,
 * where it can be logged. Exported (rather than omitted) so the loader, the
 * tests and `--dump-config` all agree on the same declaration.
 */
export const inject = []

/** How often the watchdog re-announces services that have not arrived yet. */
export const WATCHDOG_INTERVAL_MS = 10_000

export const Config = Schema.object({
  statePath: Schema.string().description('DS Bot state.json (read-only). Defaults to <DSH_HOME>/bot/state.json'),
  dataDir: Schema.string().description('where the bridge stores its routing table. Defaults to <DSH_HOME>/qqbot-bridge'),
  allowOpenIds: Schema.array(Schema.string())
    .default([])
    .description('QQ OpenIDs allowed to use the bridge. EMPTY MEANS NOBODY: this fails closed on purpose'),
  allowGroups: Schema.boolean().default(false).description('serve QQ group messages (v1: private chats only)'),
  allowGroupIds: Schema.array(Schema.string()).default([]).description('group OpenIDs allowed when allowGroups is true'),
  defaultBot: Schema.string().default('').description('Bot that receives a message from a peer with no switch yet'),
  replyTimeoutMs: Schema.number().default(600_000).description('how long to wait for a Bot turn before telling the user'),
  queueMax: Schema.number().default(4).description('per-peer queued messages'),
  textChunkLimit: Schema.number().default(4500).description('max characters per QQ message'),
  dedupeWindowMs: Schema.number().default(300_000).description('QQ message-id de-duplication window'),
  watchdogIntervalMs: Schema.number()
    .default(10_000)
    .description('how often to re-announce required services that have not arrived yet'),
  debug: Schema.boolean().default(false),
})

/**
 * Mount the bridge.
 *
 * Every phase is announced twice: on the console through `host-log` (which no
 * host can swallow) and in `<dataDir>/bridge-status.json` through `status`.
 * A throw is reported before it propagates, so the host's own activation audit
 * and this plugin's own record agree about the failure.
 *
 * @param {object} ctx    the plugin fiber's context
 * @param {object} config the validated plugin config
 */
export async function apply(ctx, config = {}) {
  const host = createHostLog()
  const report = createReport(ctx, config)
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const statePath = config.statePath && config.statePath !== '' ? config.statePath : join(dshHome, 'bot', 'state.json')
  const dataDir = config.dataDir && config.dataDir !== '' ? config.dataDir : join(dshHome, 'qqbot-bridge')
  const allowOpenIds = normalizeAllowList(config.allowOpenIds)

  host.info('apply() entered (plugin v%s)', VERSION)

  const status = createStatusWriter({
    dataDir,
    statePath,
    version: VERSION,
    allowOpenIds,
    config,
  })
  // Create the data directory and the status document NOW. Nothing else in the
  // bridge writes to disk until the first message, so without this a healthy
  // bridge leaves no trace and looks exactly like a plugin that never loaded.
  await status.publish('loading', { waitingFor: missingServices(ctx) })

  host.info('data dir: %s', dataDir)
  host.info('status file: %s', status.file)
  host.info('state file (read-only): %s', statePath)
  host.info(
    'allowOpenIds: %s configured%s',
    String(allowOpenIds.length),
    allowOpenIds.length === 0 ? ' -- FAIL CLOSED, every QQ peer is refused' : '',
  )
  if (allowOpenIds.length === 0) {
    report.warn('allowOpenIds is empty: every QQ message will be refused (this is the intended fail-closed default)')
    report.warn('To find your own OpenID: send any private message to the QQ bot, then run')
    report.warn('  node scripts/show-openids.mjs        # prints the refused ids from %s', rejectedFile(dataDir))
    report.warn('Add the right one to allowOpenIds in the profile patch and restart.')
    report.warn('Refused peers are recorded only; the bridge never allowlists anything by itself.')
  }

  // The registration lives on THIS fiber. `ctx.provide` returns a disposer and
  // Cordis removes the service when the plugin unloads, so a reload cannot leave
  // a stale `qqbotBridge` behind. It is a placeholder for now; the live bridge
  // replaces the value once the QQ transport is wired.
  if (typeof ctx.provide !== 'function') {
    throw new Error('this dsh runtime has no ctx.provide(); the bridge needs Cordis 4')
  }
  const state = { bridge: undefined, transportOk: false, transport: undefined }
  const disposeService = ctx.provide('qqbotBridge', {
    /** True once the bridge itself is running, whatever the transport state. */
    get available() {
      return state.bridge !== undefined
    },
    /** True only when the QQ transport is actually usable. */
    get transportOk() {
      return state.transportOk === true
    },
    /** The live bridge, or undefined while the QQ transport is not wired. */
    get bridge() {
      return state.bridge
    },
    /** Services still missing, so a waiting host can be diagnosed remotely. */
    waitingFor: () => missingServices(ctx),
    status: () =>
      state.bridge === undefined
        ? { available: false, transportOk: false, waitingFor: missingServices(ctx), reason: 'QQ transport not wired yet' }
        : {
            ...state.bridge.status(),
            transport: state.transport,
            transportOk: state.transportOk === true,
            waitingFor: [],
          },
    identity: { name, sourceKind: 'qqbot-bridge' },
  })
  if (typeof disposeService !== 'function') {
    throw new Error('ctx.provide("qqbotBridge", ...) did not return a disposer')
  }
  host.info('provided the "qqbotBridge" service')

  // Keep the record honest across load/unload cycles. The disposer is async and
  // returns the pending write, so Cordis waits for the `stopped` phase to land
  // before the plugin is considered unloaded -- a reader that looks immediately
  // after a reload must not see a stale `running`.
  ctx.effect(() => async () => {
    host.info('unloaded: the "qqbotBridge" service is being unregistered')
    await status.publish('stopped', { available: false, transportOk: false, waitingFor: [] })
  }, 'qqbot-bridge: status teardown')

  // If a required service never arrives, say so -- repeatedly, and by name.
  // Cordis would wait forever without a word; that silence is the bug this
  // watchdog exists to prevent.
  const watchdogMs = Number.isFinite(config.watchdogIntervalMs) && config.watchdogIntervalMs > 0
    ? config.watchdogIntervalMs
    : WATCHDOG_INTERVAL_MS
  let wired = false
  const watchdog = setInterval(() => {
    if (wired) return
    const missing = missingServices(ctx)
    if (missing.length === 0) return
    host.warn('still waiting for service(s): %s -- the bridge is loaded but cannot carry messages yet', missing.join(', '))
    void status.publish('waiting', { waitingFor: missing, available: false, transportOk: false })
  }, watchdogMs)
  if (typeof watchdog.unref === 'function') watchdog.unref()
  ctx.effect(() => () => clearInterval(watchdog), 'qqbot-bridge: service watchdog')

  host.info('waiting for service(s): %s', REQUIRED_SERVICES.join(', '))
  ctx.inject(REQUIRED_SERVICES, async injected => {
    wired = true
    clearInterval(watchdog)
    host.info('all required services arrived; wiring the bridge to the running QQ gateway')
    try {
      const bridge = await startBridge({
        ctx: injected,
        service: typeof injected.get === 'function' ? injected.get('qqbot') : injected.qqbot,
        config,
        report,
        host,
        status,
        statePath,
        dataDir,
        state,
      })
      void bridge
    } catch (error) {
      if (isTeardownRace(error)) {
        // The host unloaded this plugin while bring-up was still in flight.
        // That is a normal shutdown, not a failure: the teardown effect has
        // already detached everything and recorded the `stopped` phase, so
        // overwriting it with `failed` would be a lie.
        host.info('bridge bring-up cancelled: the host unloaded the plugin while it was starting')
        return
      }
      host.error('the bridge could not start: %s', describeError(error))
      await status.publish('failed', { lastError: describeError(error) })
      throw error
    }
  })
}

/**
 * True when a Cordis call failed only because the fiber was disposed mid-flight.
 *
 * Cordis reports this as `CordisError('INACTIVE_EFFECT')`, which carries
 * `code === 'INACTIVE_EFFECT'`; the message is matched too so the check survives
 * an error that crossed a package boundary.
 */
function isTeardownRace(error) {
  if (error === null || error === undefined) return false
  if (error.code === 'INACTIVE_EFFECT') return true
  return /inactive context/i.test(String(error.message ?? error))
}

/** A logger that writes to BOTH the structured channel and the console. */
function createReport(ctx, config) {
  const logger = createLogger(ctx.logger, name, config.debug === true)
  const host = createHostLog()
  return {
    info: (...args) => {
      logger.info(...args)
      host.info(...args)
    },
    warn: (...args) => {
      logger.warn(...args)
      host.warn(...args)
    },
    error: (...args) => {
      logger.error(...args)
      host.error(...args)
    },
    // Debug stays on the structured channel only: it is opt-in chatter, and
    // mirroring it would drown the console lines an operator is looking for.
    debug: (...args) => logger.debug(...args),
  }
}

/** Keep only usable allowlist entries; an empty result means "nobody". */
function normalizeAllowList(value) {
  if (!Array.isArray(value)) return []
  return value.filter(entry => typeof entry === 'string' && entry !== '')
}

/** The declared services this context cannot see yet. */
function missingServices(ctx) {
  if (ctx === undefined || typeof ctx.get !== 'function') return [...REQUIRED_SERVICES]
  return REQUIRED_SERVICES.filter(service => ctx.get(service, false) === undefined)
}

/**
 * Wire the bridge now that the QQ gateway is available.
 *
 * @param {object} options
 * @param {object} options.ctx      the injected fiber's context (owns the cleanup)
 * @param {object} options.service  the `qqbot` service published by the forked plugin
 * @param {object} options.config   plugin config
 * @param {object} options.report   fan-out logger (ctx.logger + console)
 * @param {object} options.host     console-only logger
 * @param {object} options.status   the on-disk status writer
 * @param {string} options.statePath
 * @param {string} options.dataDir
 * @param {{bridge: object|undefined}} options.state shared with the published service
 */
async function startBridge({ ctx, service, config, report, host, status, statePath, dataDir, state }) {
  // Registered BEFORE the first `await`. Bring-up is asynchronous, so a host can
  // unload this fiber while it is still in flight; calling `ctx.effect` after
  // that throws `INACTIVE_EFFECT` and would leave a half-attached bridge with
  // nothing to detach it. The body is filled in once there is something to
  // dispose, and the disposer reads it at unload time.
  let teardown = () => {}
  ctx.effect(() => () => teardown(), 'qqbot-bridge: lifecycle')

  const registry = createRegistry({ statePath })
  await registry.refresh(true)
  if (registry.bots.length === 0) {
    report.warn('no Bots found in %s: is DS Bot (ds-bot) installed and has the team been created?', statePath)
  } else {
    host.info('team: %s', registry.bots.map(bot => `${bot.name}(${bot.id})`).join(', '))
  }

  const router = createRouter({
    file: routingFile(dataDir),
    fallback: () => {
      const named = registry.find(config.defaultBot) ?? registry.mainBot()
      return named?.name ?? ''
    },
  })
  await router.load()

  const rejectedLog = createRejectedLog({ file: rejectedFile(dataDir) })
  await rejectedLog.load()

  const delivery = createDelivery({
    sessionController: ctx.sessionController,
    sessions: ctx.sessions,
    createUserMessage: await resolveCreateUserMessage(ctx, report),
    logger: report,
  })

  const adapter = resolveAdapter({
    ctx,
    service,
    debug: config.debug === true,
    logger: report,
    warn: text => report.warn('%s', text),
    info: text => report.info('%s', text),
  })

  const bridge = createBridge({ adapter, registry, router, delivery, logger: report, config, rejectedLog })
  bridge.start(ctx)
  state.bridge = bridge
  state.transport = adapter.name
  state.transportOk = adapter.available() === true

  /** Everything an operator needs, without a single credential. */
  const record = () => ({
    available: true,
    transportOk: state.transportOk === true,
    transport: adapter.name,
    transportDescription: adapter.diagnostics?.describe?.() ?? '',
    waitingFor: [],
    ...bridge.status(),
  })

  await status.publish('running', record())
  host.info('STARTED: transport=%s | snapshot=%s | data=%s', adapter.name, status.file, dataDir)

  // Keep the roster fresh even while the bridge is idle, so /团队 and the
  // command table never go stale between messages, and keep the status
  // document's timestamps alive so "is it still running?" is answerable.
  const timer = setInterval(() => {
    void registry.refresh()
    void status.publish('running', record())
  }, 30_000)
  if (typeof timer.unref === 'function') timer.unref()

  // From here on, unloading the plugin detaches everything above.
  teardown = () => {
    clearInterval(timer)
    bridge.stop()
    state.bridge = undefined
    state.transport = undefined
    state.transportOk = false
    host.info('bridge stopped (QQ transport detached)')
  }

  host.info('bridge ready: %s', bridge.status().access)
  return bridge
}

/**
 * `createUserMessage` comes from @deepseek-ai/dsh-llm, which the host resolves
 * through its own package table. If that resolution is unavailable, fall back
 * to building the same shape directly -- `createMessage` only attaches an id,
 * deep-freezes and clones, so a hand-built equivalent is observationally equal.
 */
async function resolveCreateUserMessage(ctx, report) {
  try {
    const module = await import('@deepseek-ai/dsh-llm')
    if (typeof module.createUserMessage === 'function') return module.createUserMessage
  } catch (error) {
    report.warn('could not import createUserMessage from @deepseek-ai/dsh-llm (%s); using the built-in builder', describeError(error))
  }
  return createUserMessageFallback
}

/** Shape-compatible fallback for `createUserMessage`. */
function createUserMessageFallback({ content, source }) {
  return deepFreeze({
    id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: structuredClone(content),
    source: structuredClone(source),
  })
}

/** Deep-freeze a plain JSON structure, the way createMessage does. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const inner of Object.values(value)) {
    if (inner !== null && typeof inner === 'object') deepFreeze(inner)
  }
  return Object.freeze(value)
}
