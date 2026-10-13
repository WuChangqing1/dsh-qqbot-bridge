// Message marker shared by the delivery and reply paths.
//
// WHY THIS EXISTS
// The stock DS Bot endpoint (POST /api/bot -> sessionController.prompt) does not
// let a caller choose the message `source`: prompt always mints
// `{ kind: 'user', rpcId }`, which is byte-for-byte what the browser mints for a
// human typing in the Web UI. A bridge on that path therefore cannot tell
// "the user typed this in QQ" from "the user typed this in the Web chat", and
// would happily forward a private Web answer to a QQ peer.
//
// DSH officially supports extending the source union by declaration merging
// (`declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { ... } }`
// -- see packages/api/session-controller/src/types.ts 'user-rpc' and DS Bot's
// own 'bot' source). This module uses the same mechanism with a plain-JS
// `structuredClone`-safe object, and the delivery path attaches it through
// `agent.followup(createUserMessage({ source }))`, which is the exact call DS
// Bot's own delivery module uses.

/** The `source.kind` stamped on every message this bridge injects. */
export const BRIDGE_KIND = 'qqbot-bridge'

/**
 * Build the `source` for one bridge-injected message.
 * Every field is a string or a number so it survives `structuredClone` and JSON.
 *
 * @param {object} input
 * @param {string} input.requestId  bridge-side correlation id
 * @param {string} input.peerId     QQ OpenID (never logged in the clear)
 * @param {'c2c'|'group'} input.scope
 * @param {string} [input.groupOpenId]
 * @param {number} [input.at]
 */
export function bridgeSource({ requestId, peerId, scope = 'c2c', groupOpenId, at = Date.now() }) {
  return {
    kind: BRIDGE_KIND,
    role: 'user',
    form: 'qq',
    requestId,
    peerId,
    scope,
    ...(groupOpenId === undefined ? {} : { groupOpenId }),
    at,
  }
}

/** True when a persisted message was injected by this bridge. */
export function isBridgeSource(source) {
  return source !== null && typeof source === 'object' && source.kind === BRIDGE_KIND
}

/**
 * The bridge request id carried by a message source, or undefined.
 * Used to match a finished turn to the QQ peer that is waiting for it.
 */
export function requestIdOf(source) {
  if (!isBridgeSource(source)) return undefined
  return typeof source.requestId === 'string' && source.requestId !== '' ? source.requestId : undefined
}
