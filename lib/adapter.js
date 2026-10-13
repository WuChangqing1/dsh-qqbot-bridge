// The QQ side of the bridge, behind one small interface.
//
// Two independent facts pushed this design:
//
//  1. The stock plugin keeps its `QQBot` instance, its SessionManager and its
//     outbound sender in function-local variables and registers NO cordis
//     service. An outside plugin therefore cannot reach the gateway at all.
//  2. Starting a SECOND gateway with the same AppID is forbidden (two websocket
//     connections on the same shard fight over the event stream).
//
// So the bridge never opens a gateway. It borrows the one the QQ plugin already
// runs, through a single extension point:
//
//     ctx.get('qqbot').setMessagePreHandler(handler)
//
// `handler(mCtx)` runs BEFORE the stock middleware chain. Returning `true`
// consumes the message; returning `false` lets the stock chain handle it
// normally (which is how /bot-ping, /bot-status and everything the bridge does
// not own keep working untouched).
//
// That extension point is added by a local fork of @tencent-connect/dsh-qqbot.
// See patches/0001-qqbot-extension-point.md and COMPATIBILITY.md.

import { createLogger, shortId } from './log.js'

/**
 * @typedef {{scope: 'c2c'|'group', openId: string, groupOpenId?: string}} NormalisedTarget
 *
 * @typedef {object} BridgeAdapter
 * @property {string} name
 * @property {(listener: (message: object) => void|Promise<void>) => (() => void)} onMessage
 * @property {(input: {target: NormalisedTarget, text: string}) => Promise<void>} send
 * @property {() => boolean} available
 * @property {object} [diagnostics]
 */

/**
 * The extension point hands the pre-handler a middleware context. The bridge
 * marks a message it owns by writing `state.__qqbotBridgeHandled`, which
 * `isHandled` reads back. A shared symbol would be cleaner but each transport
 * gets its own module instance, so a plain property is the portable choice.
 */
export const HANDLED_FLAG = '__qqbotBridgeHandled'

/** Normalise whatever a transport gives us into the bridge's target shape. */
export function normaliseTarget(value) {
  if (value === null || value === undefined) return { scope: 'c2c', openId: '' }
  if (typeof value === 'string') return { scope: 'c2c', openId: value }
  const scope = value.scope === 'group' ? 'group' : 'c2c'
  const openId = String(value.openId ?? value.targetId ?? value.senderId ?? '')
  const groupOpenId = value.groupOpenId ?? value.groupOpenid ?? (scope === 'group' ? value.targetId : undefined)
  return {
    scope,
    openId,
    ...(groupOpenId === undefined ? {} : { groupOpenId: String(groupOpenId) }),
  }
}

/** Extract readable text from a QQ message payload. */
export function textOfMessage(message) {
  if (typeof message?.content === 'string') return message.content
  if (typeof message?.text === 'string') return message.text
  return ''
}

/**
 * The adapter for the forked QQ plugin.
 * @param {object} service the `qqbot` cordis service installed by the fork
 * @param {{debug?: boolean, logger?: object}} [options]
 * @returns {BridgeAdapter}
 */
export function createPlatformAdapter(service, { debug = false, logger: base } = {}) {
  const logger = createLogger(base, 'qqbot-bridge/qq', debug)
  /** @type {Set<(message: object) => void>} */
  const listeners = new Set()
  let installed = false
  let consumed = 0
  let passthrough = 0
  let sent = 0

  /**
   * Runs before the stock middleware chain.
   * @returns {boolean} true when the bridge owns this message
   */
  const preHandler = mCtx => {
    const message = mCtx?.message
    if (message === null || message === undefined) return false
    const scope = message.kind === 'group' ? 'group' : 'c2c'
    const openId = String(message.senderId ?? '')
    const groupOpenId = scope === 'group' ? String(message.groupOpenid ?? '') : undefined
    const normalised = {
      messageId: String(message.messageId ?? ''),
      scope,
      openId,
      ...(groupOpenId === undefined || groupOpenId === '' ? {} : { groupOpenId }),
      content: textOfMessage(message),
      replyTarget: mCtx?.replyTarget,
      // The real, type-safe way to send later: the SDK's own reply limiter and
      // passive-reply fallbacks stay in play.
      raw: message,
    }
    let handled = false
    for (const listener of listeners) {
      try {
        const verdict = listener(normalised)
        if (verdict === true) {
          handled = true
          continue
        }
        // The contract is synchronous and boolean. A promise here would be
        // silently falsy (the QQ middleware chain does not await a pre-handler),
        // which would let the stock agent answer the same message as well --
        // i.e. a double reply. Fail loudly instead.
        if (verdict !== false && verdict !== undefined) {
          logger.error('listener returned %s; the contract is a synchronous boolean', typeof verdict === 'object' ? 'a thenable/object' : `a ${typeof verdict}`)
        }
      } catch (error) {
        logger.error('listener failed: %s', error)
      }
    }
    if (handled) consumed += 1
    else passthrough += 1
    return handled
  }

  const install = () => {
    if (installed) return
    if (typeof service.setMessagePreHandler !== 'function') {
      throw new Error(
        'qqbot service is missing setMessagePreHandler: the installed @tencent-connect/dsh-qqbot is not the bridged fork (see COMPATIBILITY.md)',
      )
    }
    service.setMessagePreHandler(preHandler)
    installed = true
  }

  return {
    name: 'dsh-qqbot-bridge/qq',
    available: () => typeof service?.setMessagePreHandler === 'function',
    onMessage(listener) {
      install()
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Diagnostics: how a listener has been answering. */
    get lastVerdicts() {
      return { consumed, passthrough }
    },
    async send({ target, text }) {
      const normalised = normaliseTarget(target)
      if (normalised.openId === '' && normalised.groupOpenId === undefined) {
        throw new Error('bridge/qq: no send target')
      }
      const sendMarkdown = service?.sender?.sendMarkdown
      if (typeof sendMarkdown !== 'function') throw new Error('bridge/qq: sender.sendMarkdown is unavailable')
      // Reuse the SDK's passive-reply resolution (explicit msgId, cached msgId,
      // then an active push) so long answers survive the reply quota.
      const replyTarget = service.replyTargetFor?.(normalised.scope, normalised.openId) ?? {
        scope: normalised.scope,
        targetId: normalised.scope === 'group' ? (normalised.groupOpenId ?? normalised.openId) : normalised.openId,
      }
      await sendMarkdown(replyTarget, text)
      sent += 1
    },
    diagnostics: {
      get installed() {
        return installed
      },
      get listeners() {
        return listeners.size
      },
      get consumed() {
        return consumed
      },
      get passthrough() {
        return passthrough
      },
      get sent() {
        return sent
      },
      describe: () => `consumed ${consumed}, passthrough ${passthrough}, sent ${sent}`,
    },
  }
}

/**
 * A read-only adapter used when no gateway is reachable. It never pretends to
 * work: every send fails loudly, and inbound messages never arrive.
 *
 * @param {{reason: string, logger?: object, debug?: boolean}} options
 * @returns {BridgeAdapter}
 */
export function createUnavailableAdapter({ reason, logger: base, debug = false }) {
  const logger = createLogger(base, 'qqbot-bridge/qq', debug)
  return {
    name: 'dsh-qqbot-bridge/unavailable',
    available: () => false,
    onMessage() {
      logger.error('QQ transport unavailable: %s', reason)
      return () => {}
    },
    async send({ target }) {
      throw new Error(`QQ transport unavailable (${reason}); cannot send to ${shortId(target?.openId)}`)
    },
    diagnostics: {
      describe: () => `unavailable: ${reason}`,
    },
  }
}

/**
 * Pick the adapter for this host.
 *
 * The service is already guaranteed available when this runs: `apply()` waits
 * for it with `ctx.inject(['qqbot'], ...)`, so no probing with try/catch is
 * needed here. `ctx.get` is only used so the same helper works under a plain
 * test context, and it is called with `strict: false` because a service being
 * torn down must not be treated as a hard error.
 *
 * @param {object} options
 * @param {object} options.ctx
 * @param {boolean} [options.debug]
 * @param {(text: string) => void} [options.warn]
 * @param {(text: string) => void} [options.info]
 * @param {object} [options.service] an already-resolved `qqbot` service
 * @returns {BridgeAdapter}
 */
export function resolveAdapter({ ctx, service: provided, debug = false, warn, info, logger }) {
  let service = provided
  if (service === undefined && typeof ctx?.get === 'function') {
    try {
      // strict=false: an absent service returns undefined instead of throwing,
      // so the normal "not installed" case never reaches the catch.
      service = ctx.get('qqbot', false)
    } catch (error) {
      // A throwing ctx.get means the runtime itself is unhappy. Degrade and
      // report rather than killing plugin activation for a probe.
      warn?.(`could not read the qqbot service (${error?.message ?? error}); treating QQ as unavailable`)
      service = undefined
    }
  }
  if (service !== undefined && service !== null) {
    const adapter = createPlatformAdapter(service, { debug, logger })
    if (adapter.available()) {
      info?.('QQ transport: borrowing the running im-qqbot gateway (extension point present)')
      return adapter
    }
    warn?.('qqbot service found but it has no setMessagePreHandler; run scripts/make-bridged-qqbot.mjs (see COMPATIBILITY.md)')
    return createUnavailableAdapter({ reason: 'qqbot service without the bridge extension point', logger, debug })
  }
  warn?.('No qqbot service on this host; the bridge cannot receive QQ messages. Install the bridged fork and keep im-qqbot enabled (see COMPATIBILITY.md)')
  return createUnavailableAdapter({ reason: 'no qqbot service', logger, debug })
}
