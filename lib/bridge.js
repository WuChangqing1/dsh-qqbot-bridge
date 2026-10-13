// The bridge itself: QQ message in, existing DS Bot session, real answer back.
//
// Everything here is transport-agnostic. The QQ side is reached through the
// adapter interface in ./adapter.js, so routing, access control, queueing,
// reply correlation and error handling are all unit-testable without a live
// gateway.
//
// ── Why the inbound path is split in two ───────────────────────────────────
// The QQ SDK runs its middleware chain synchronously: a listener that waits on
// the filesystem before returning would block message dispatch for every QQ
// user. So the bridge decides ownership IMMEDIATELY from memory only (dedupe +
// access + the command table, which is refreshed from the roster whenever the
// roster changes), and then does the real work -- reading state.json for the
// current session part, delivering, waiting for the answer -- off the critical
// path.
//
// Ordering note: `queue` is created before `deliverTalk`, and `onMessage` is
// defined last, because everything below is in const-binding dependency order.

import { randomUUID } from 'node:crypto'
import { createAccess } from './access.js'
import { chunkText } from './chunk.js'
import { createCommands, renderCurrent, renderSwitch, renderTeam } from './commands.js'
import { createDedupe } from './dedupe.js'
import { createPending } from './pending.js'
import { createQueue } from './queue.js'
import { createReplyTracker } from './reply-tracker.js'
import { BRIDGE_KIND } from './source-tag.js'
import { shortId } from './log.js'

/** A `turn/end` reason that means "no answer is coming". */
const NO_REPLY_REASONS = new Set(['aborted', 'cancelled', 'blocked'])

/**
 * @param {object} deps
 * @param {object} deps.adapter   QQ transport adapter (see ./adapter.js)
 * @param {object} deps.registry  Bot registry (./registry.js)
 * @param {object} deps.router    per-OpenID routing (./router.js)
 * @param {object} deps.delivery  session delivery (./deliver.js)
 * @param {object} deps.logger
 * @param {object} deps.config    plugin config
 */
export function createBridge({ adapter, registry, router, delivery, logger, config, rejectedLog }) {
  const access = createAccess(config)
  const commands = createCommands({ bots: registry.commandEntries() })
  const dedupe = createDedupe({ windowMs: config.dedupeWindowMs ?? 300_000 })
  const chunkLimit = config.textChunkLimit ?? 4500
  const replyTimeoutMs = config.replyTimeoutMs ?? 600_000

  registry.onRosterChange(() => {
    commands.setBots(registry.commandEntries())
    // A deleted Bot must not keep a stale pin.
    const known = new Set(registry.bots.map(bot => bot.name))
    for (const name of Object.keys(router.snapshot())) {
      if (!known.has(name)) void router.drop(name)
    }
  })

  /**
   * Per-session in-flight turn state.
   * @type {Map<string, {texts: string[], bridge: boolean}>}
   */
  const turns = new Map()

  const tracker = createReplyTracker({ timeoutMs: replyTimeoutMs, now: config.now })
  // Work started off the synchronous inbound path, made awaitable for tests
  // and for shutdown.
  const pending = createPending({ onError: error => logger.error('background task failed: %s', error) })

  const defaultBotName = () => {
    if (typeof config.defaultBot === 'string' && config.defaultBot !== '') {
      const named = registry.find(config.defaultBot)
      if (named !== undefined) return named.name
    }
    return registry.mainBot()?.name
  }

  /** Send text to a peer, chunked, never throwing into the event loop. */
  const send = async (target, text) => {
    const body = String(text ?? '')
    if (body.trim() === '') return
    for (const chunk of chunkText(body, chunkLimit)) {
      try {
        await adapter.send({ target, text: chunk })
      } catch (error) {
        logger.warn('send to %s failed: %s', shortId(target?.openId), error)
      }
    }
  }

  /** Tell a waiting peer we cannot deliver automatically. Never claim success. */
  const giveUp = async (entry, reason) => {
    if (entry?.replyTarget === undefined) return
    const botName = entry.target ?? 'Bot'
    const waited = replyTimeoutMs >= 60_000 ? `${Math.round(replyTimeoutMs / 60_000)} 分钟` : `${Math.round(replyTimeoutMs / 1000)} 秒`
    await send(
      entry.replyTarget,
      reason === 'timeout'
        ? `${botName} 还在处理，已超过 ${waited}。回复可能在稍后完成，请到 DSH Web 里查看它的会话。`
        : `${botName} 这一轮没有产生可回传的回复，请到 DSH Web 里查看它的会话。`,
    )
  }

  /** Relay one finished turn back to the peer that asked for it. */
  const finishTurn = async (entry, texts, reason) => {
    const answer = texts.join('\n\n').trim()
    const kind = reason?.kind
    if (kind === 'error') {
      const code = reason?.error?.code ?? 'UNKNOWN'
      const detail = typeof reason?.error?.message === 'string' ? reason.error.message.trim().slice(0, 300) : ''
      await send(
        entry.replyTarget,
        `${entry.target} 这一轮失败了（${code}${detail === '' ? '' : `：${detail}`}）。请到 DSH Web 里查看详情。`,
      )
      return
    }
    if (answer === '') {
      await send(
        entry.replyTarget,
        NO_REPLY_REASONS.has(kind)
          ? `${entry.target} 这一轮被中断了，没有产生回复。`
          : `${entry.target} 这一轮没有文本回复，请到 DSH Web 里查看它的会话。`,
      )
      return
    }
    await send(entry.replyTarget, answer)
  }

  /** One FIFO lane per OpenID, so a peer's messages never interleave. */
  const queue = createQueue({
    run: item => runTalk(item),
    max: config.queueMax ?? 4,
    onOverflow: (key, dropped) => logger.warn('queue overflow for %s (dropped %d)', shortId(key), dropped),
  })

  /** Enqueue one talk unit for a peer. Synchronous: the caller returns at once. */
  const deliverTalk = ({ openId, scope, replyTarget, text }) => {
    const result = queue.push(openId, { openId, scope, replyTarget, text })
    if (result === 'rejected') {
      void send(replyTarget, '你的上一条消息还在处理中，请稍等片刻再发。')
      return 'overflow'
    }
    return 'handled'
  }

  /**
   * The queued unit's body: resolve the target Bot's CURRENT session, then
   * deliver into it. The session id is re-read on every send because a long
   * chat moves the Bot on to a fresh part.
   */
  async function runTalk({ openId, scope, replyTarget, text }) {
    await registry.refresh()
    const name = router.current(openId)
    const bot = registry.find(name) ?? registry.mainBot()
    if (bot === undefined) {
      await send(replyTarget, `找不到「${name}」。发送 /团队 查看当前名单。`)
      return
    }
    const sessionId = bot.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      await send(replyTarget, `无法解析 ${bot.name} 的会话，请到 DSH Web 里检查 Bot 团队。`)
      return
    }

    const requestId = randomUUID()
    // Register BEFORE delivering: a short turn may end before submit resolves.
    tracker.add({
      requestId,
      sessionId,
      target: bot.name,
      peerId: openId,
      scope,
      replyTarget,
      // Tracked so a give-up notice is settled by `drain()` instead of firing
      // after the caller believes everything is done.
      onGiveUp: (entry, reason) => pending.run(() => giveUp(entry, reason)),
    })
    try {
      await delivery.submit({ sessionId, text, peerId: openId, scope, requestId })
    } catch (error) {
      tracker.abandon(requestId, 'delivery-failed')
      logger.error('delivery into %s failed: %s', sessionId, error)
      await send(replyTarget, `把消息送进 ${bot.name} 的会话时失败了。这条没有送达，请稍后再试或到 DSH Web 里查看。`)
    }
  }

  /** Only keep the parts of a raw QQ message the bridge cares about. */
  const normalise = raw => {
    const scope = raw?.scope === 'group' ? 'group' : 'c2c'
    const openId = String(raw?.openId ?? '')
    const groupOpenId = raw?.groupOpenId === undefined ? undefined : String(raw.groupOpenId)
    return {
      messageId: String(raw?.messageId ?? ''),
      scope,
      openId,
      ...(groupOpenId === undefined ? {} : { groupOpenId }),
      content: String(raw?.content ?? '').trim(),
      replyTarget: raw?.replyTarget ?? { scope, openId },
    }
  }

  /**
   * The synchronous ownership decision. Returns 'handled' when the bridge has
   * taken responsibility for the message, 'passthrough' when the stock plugin
   * must handle it exactly as before. Never throws, never awaits.
   *
   * @returns {'handled'|'passthrough'}
   */
  const handleMessage = raw => {
    let message
    try {
      message = normalise(raw)
    } catch (error) {
      logger.error('malformed QQ message: %s', error)
      return 'passthrough'
    }

    // v1 routes private chats only; a group never reaches a privileged Bot.
    if (message.scope === 'group') return 'passthrough'
    if (message.content === '') return 'passthrough'
    if (dedupe.isDuplicate(message.messageId)) return 'handled' // already owned

    const gate = access.check(message)
    if (!gate.allowed) {
      // A refused peer gets no explanation: answering would confirm that a
      // private bridge is listening on this AppID. It stays silent and the
      // message does NOT reach any Bot.
      logger.warn('refused QQ message from %s (%s)', shortId(message.openId), gate.reason)
      // Recorded so first-time setup can read the exact OpenID back. This does
      // NOT grant anything: the peer stays refused.
      rejectedLog?.record(message.openId, shortId(message.openId), gate.reason)
      return 'handled'
    }
    dedupe.remember(message.messageId)

    const command = commands.parse(message.content)
    switch (command.kind) {
      case 'unknown':
        // An unrecognised slash command is never executed and never forwarded
        // to a Bot. It goes back to the transport, which lets the stock plugin
        // answer /bot-ping, /bot-status, /new, ... and keeps a command-looking
        // message out of a Bot's context.
        return 'passthrough'
      case 'bare-switch':
        pending.run(() => send(message.replyTarget, commands.help))
        return 'handled'
      case 'help':
        pending.run(() => send(message.replyTarget, command.text ?? commands.help))
        return 'handled'
      case 'team':
        pending.run(async () => {
          await registry.refresh()
          await send(
            message.replyTarget,
            renderTeam({
              bots: registry.bots,
              current: router.current(message.openId),
              mainBot: registry.mainBot()?.name,
            }),
          )
        })
        return 'handled'
      case 'current':
        pending.run(() =>
          send(message.replyTarget, renderCurrent({ current: router.current(message.openId), bots: registry.bots })),
        )
        return 'handled'
      case 'switch':
        pending.run(async () => {
          await registry.refresh()
          if (registry.find(command.bot) === undefined) {
            await send(message.replyTarget, `团队里没有「${command.bot}」。发送 /团队 查看当前名单。`)
            return
          }
          await router.select(message.openId, command.bot)
          await send(message.replyTarget, renderSwitch(command.bot))
          // `/程序员 帮我看看这段代码` switches for the future AND runs now.
          if (command.close === true && command.text !== undefined) {
            deliverTalk({ openId: message.openId, scope: message.scope, replyTarget: message.replyTarget, text: command.text })
          }
        })
        return 'handled'
      case 'not-found':
        // A CJK slash word is someone addressing a team member that does not
        // exist. Answer in QQ instead of forwarding a name the Bot cannot use.
        pending.run(() => send(message.replyTarget, `团队里没有「${command.bot}」。发送 /团队 查看当前名单。`))
        return 'handled'
      case 'talk':
        deliverTalk({
          openId: message.openId,
          scope: message.scope,
          replyTarget: message.replyTarget,
          text: message.content,
        })
        return 'handled'
      default:
        return 'passthrough'
    }
  }

  /**
   * Async entry point used by tests and by the adapter's fire-and-forget path.
   * Resolves to the same verdict as `handleMessage` once the send side settles.
   */
  const onMessage = async raw => {
    const verdict = handleMessage(raw)
    await drain()
    return verdict
  }

  /**
   * DSH session events. This fires for every session in the host, so the first
   * job is always to prove the session belongs to this bridge.
   */
  const onSessionEvent = (session, event) => {
    const sessionId = session?.header?.id ?? session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    const type = event?.type
    if (type === 'user/message') {
      const source = event.data?.source
      const state = turns.get(sessionId)
      if (state !== undefined) {
        // Only a bridge-tagged message arms the relay. Another Bot's relay or a
        // Web prompt must NOT make this turn's answer reach QQ.
        if (source?.kind === BRIDGE_KIND) state.bridge = true
        return
      }
      if (source?.kind !== BRIDGE_KIND) return
      turns.set(sessionId, { texts: [], bridge: true })
      return
    }
    if (type === 'assistant/message') {
      const state = turns.get(sessionId)
      if (state === undefined) return
      const text = contentText(event.data?.message?.content)
      if (text !== '') state.texts.push(text)
      return
    }
    if (type !== 'turn/end') return
    const state = turns.get(sessionId)
    turns.delete(sessionId)
    // A turn that did not answer a bridge message is never relayed.
    if (state === undefined || state.bridge !== true) {
      logger.debug('turn/end on %s ignored (bridge=%s)', sessionId, String(state?.bridge))
      return
    }
    const entry = tracker.claim(sessionId)
    if (entry === undefined) {
      logger.warn('turn/end on %s had no waiting peer; the reply cannot be relayed', sessionId)
      return
    }
    pending.run(() => finishTurn(entry, state.texts, event.data?.reason))
  }

  /**
   * Await everything the bridge started off the critical path.
   *
   * A plain `await queue.drain(); await pending.drain()` is NOT enough: a
   * command handler is one pending task that, on success, pushes into the
   * queue. Draining the queue first and the pending set second leaves a window
   * where the queue was already empty and the pending task finishes only after
   * the drain returned. So this waits for BOTH counters to reach zero, and only
   * then settles.
   */
  const drain = async () => {
    for (let guard = 0; guard < 500; guard += 1) {
      await pending.drain()
      await queue.drain()
      if (pending.size === 0 && queue.size === 0) return
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    logger.warn('drain did not settle (pending=%d, queued=%d)', pending.size, queue.size)
  }

  let sweeper
  let unsubscribe

  return {
    /** Attach to the QQ adapter and to DSH session events. */
    start(ctx) {
      // The listener's return value IS the ownership answer the transport
      // needs: exactly `true` stops the stock QQ chain, anything else lets it
      // through. The comparison must be strict -- `Boolean(verdict)` would turn
      // the bridge's own 'passthrough' string into "owned" and swallow every
      // message, including the stock plugin's own /bot-ping and /new.
      unsubscribe = adapter.onMessage(raw => handleMessage(raw) === 'handled')
      if (typeof ctx?.on === 'function') {
        ctx.on('session/event', onSessionEvent)
        logger.debug('subscribed to session/event')
      } else {
        logger.warn('no ctx.on: DSH session events will NOT be observed, so no reply can be relayed')
      }
      const period = Math.min(60_000, Math.max(5_000, Math.floor(replyTimeoutMs / 4)))
      sweeper = setInterval(() => tracker.sweep(), period)
      if (typeof sweeper.unref === 'function') sweeper.unref()
      logger.info('bridge ready: %s', access.describe())
      return this
    },
    stop() {
      if (sweeper !== undefined) clearInterval(sweeper)
      sweeper = undefined
      unsubscribe?.()
      unsubscribe = undefined
      turns.clear()
      tracker.clear()
    },
    // Exposed for tests and diagnostics.
    handleMessage,
    onMessage,
    onSessionEvent,
    status() {
      return {
        access: access.describe(),
        defaultBot: defaultBotName() ?? null,
        queueDepth: queue.size,
        waiting: tracker.waiting,
        abandoned: tracker.abandonedCount,
        routedPeers: router.size,
        bots: registry.bots.map(bot => ({ name: bot.name, sessionId: bot.sessionId })),
        sourceKind: BRIDGE_KIND,
      }
    },
    drain,
    internals: {
      tracker,
      queue,
      commands,
      access,
      dedupe,
      rejectedLog,
      pending: {
        get size() {
          return pending.size
        },
        drain: () => pending.drain(),
      },
    },
  }
}

/** Text of a `content` array from a live session event. */
function contentText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}
