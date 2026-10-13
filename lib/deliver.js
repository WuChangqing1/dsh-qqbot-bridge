// Message delivery into a DS Bot session.
//
// Two supported Host APIs can admit a message:
//   A) `sessionController.prompt({ requestId, sessionId, mode: 'queue', content })`
//      -- what DS Bot's POST /api/bot `send` endpoint uses. Fast, but it always
//      stamps `source = { kind: 'user', rpcId }`, indistinguishable from a Web
//      prompt.
//   B) `sessionController.resolveAgent(sessionId)` then
//      `agent.followup(createUserMessage({ content, source }))` then
//      `ctx.sessions.flush(agent.session)`
//      -- what DS Bot's own delivery module and its `answer-question` endpoint
//      use. Same effect on the model, but the caller owns `source`.
//
// The bridge needs (B): its own `source.kind` is what lets the reply path prove
// that a finished turn answers a QQ message rather than a Web one. See
// ./source-tag.js for the full reasoning.
//
// Neither path touches state.json, forges a cookie, or reaches into /api/bot.

import { randomUUID } from 'node:crypto'
import { BRIDGE_KIND, bridgeSource } from './source-tag.js'

/** Extract readable text from a `content` array, the way DS Bot does. */
export function textOfContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}

/**
 * @param {object} options
 * @param {object} options.sessionController   ctx.sessionController
 * @param {object} options.sessions            ctx.sessions (for flush)
 * @param {(input: {content: any[], source: any}) => any} options.createUserMessage
 *        `createUserMessage` from @deepseek-ai/dsh-llm
 * @param {object} [options.logger]
 */
export function createDelivery({ sessionController, sessions, createUserMessage, logger }) {
  if (!sessionController) throw new Error('bridge/delivery: ctx.sessionController is required')
  if (typeof createUserMessage !== 'function') throw new Error('bridge/delivery: createUserMessage is required')

  /** Resolve a live agent, resuming a cold session if needed. */
  const resolveAgent = async sessionId => {
    const resolved = await sessionController.resolveAgent(sessionId)
    if (resolved !== null && typeof resolved === 'object' && 'error' in resolved && resolved.error) {
      throw new Error(resolved.error?.message ?? `session unavailable: ${sessionId}`)
    }
    const agent = resolved?.agent ?? resolved
    if (!agent || typeof agent.followup !== 'function') {
      throw new Error(`bridge/delivery: no live agent for ${sessionId}`)
    }
    return agent
  }

  /**
   * Admit one QQ message into a DS Bot session.
   * Resolves as soon as the message is queued -- NOT when the Bot answers. The
   * answer is correlated later through the `session/event` subscription.
   *
   * @param {{sessionId: string, text: string, peerId: string, scope?: 'c2c'|'group',
   *          groupOpenId?: string, requestId?: string}} input
   * @returns {Promise<{requestId: string, queued: true}>}
   */
  const submit = async ({ sessionId, text, peerId, scope = 'c2c', groupOpenId, requestId = randomUUID() }) => {
    const body = String(text ?? '').trim()
    if (body === '') throw new Error('bridge/delivery: empty text')
    if (typeof sessionId !== 'string' || sessionId === '') throw new Error('bridge/delivery: missing sessionId')

    const agent = await resolveAgent(sessionId)
    const message = createUserMessage({
      content: [{ type: 'text', text: body }],
      source: bridgeSource({ requestId, peerId, scope, groupOpenId }),
    })
    agent.followup(message)
    // Flush so the message is durable before the bridge reports success; DS Bot
    // does the same in delivery.js.
    if (sessions && typeof sessions.flush === 'function' && agent.session !== undefined) {
      await sessions.flush(agent.session)
    }
    logger?.debug?.('admitted %s into %s', requestId, sessionId)
    return { requestId, queued: true }
  }

  return { submit, resolveAgent, sourceKind: BRIDGE_KIND }
}
