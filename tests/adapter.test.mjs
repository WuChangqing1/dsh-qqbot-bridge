import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createPlatformAdapter, createUnavailableAdapter, normaliseTarget, resolveAdapter, textOfMessage } from '../lib/adapter.js'
import { createLogger, format, render, scrub, shortId } from '../lib/log.js'

/** A stand-in for the `qqbot` service the fork publishes. */
function fakeService({ withPreHandler = true } = {}) {
  const sent = []
  const service = {
    sender: {
      async sendMarkdown(target, content) {
        sent.push({ target, content })
      },
    },
  }
  let handler
  if (withPreHandler) {
    service.setMessagePreHandler = next => {
      handler = next
    }
  }
  service.__sent = sent
  service.__ctx = message => ({
    message,
    replyTarget: { scope: message.kind === 'group' ? 'group' : 'c2c', targetId: message.senderId, msgId: message.messageId },
  })
  service.__pre = mCtx => handler(mCtx)
  service.__hasHandler = () => handler !== undefined
  return service
}

const message = (overrides = {}) => ({
  messageId: 'msg-1',
  kind: 'c2c',
  senderId: 'openid-a',
  content: '你好',
  ...overrides,
})

test('normaliseTarget accepts both a string and a target object', () => {
  assert.deepEqual(normaliseTarget('openid-x'), { scope: 'c2c', openId: 'openid-x' })
  assert.deepEqual(normaliseTarget({ scope: 'c2c', openId: 'openid-x' }), { scope: 'c2c', openId: 'openid-x' })
  assert.deepEqual(normaliseTarget({ scope: 'group', targetId: 'group-1', openId: 'openid-x' }), {
    scope: 'group',
    openId: 'openid-x',
    groupOpenId: 'group-1',
  })
  assert.deepEqual(normaliseTarget(undefined), { scope: 'c2c', openId: '' })
})

test('textOfMessage reads the QQ content field', () => {
  assert.equal(textOfMessage({ content: 'hi' }), 'hi')
  assert.equal(textOfMessage({ text: 'hi' }), 'hi')
  assert.equal(textOfMessage({}), '')
})

test('the platform adapter installs its pre-handler exactly once', () => {
  const service = fakeService()
  const adapter = createPlatformAdapter(service)
  assert.equal(adapter.available(), true)
  assert.equal(service.__hasHandler(), false)
  const off = adapter.onMessage(() => true)
  assert.equal(service.__hasHandler(), true)
  const second = adapter.onMessage(() => true)
  assert.equal(adapter.diagnostics.listeners, 2)
  off()
  second()
  assert.equal(adapter.diagnostics.listeners, 0)
})

test('a listener that returns true consumes the message, false passes it through', () => {
  const service = fakeService()
  const adapter = createPlatformAdapter(service)
  adapter.onMessage(msg => msg.content === 'own')
  assert.equal(service.__pre(service.__ctx(message({ content: 'own' }))), true)
  assert.equal(service.__pre(service.__ctx(message({ content: 'other' }))), false)
  assert.equal(adapter.diagnostics.consumed, 1)
  assert.equal(adapter.diagnostics.passthrough, 1)
})

test('a listener that throws does not break the QQ chain', () => {
  const service = fakeService()
  const adapter = createPlatformAdapter(service, { debug: false, logger: { warn() {}, error() {}, info() {} } })
  adapter.onMessage(() => {
    throw new Error('listener exploded')
  })
  assert.equal(service.__pre(service.__ctx(message())), false)
})

test('the adapter normalises what it hands a listener', () => {
  const service = fakeService()
  const adapter = createPlatformAdapter(service)
  const seen = []
  adapter.onMessage(msg => {
    seen.push(msg)
    return true
  })
  service.__pre(service.__ctx(message({ messageId: 'm-9', content: '正文' })))
  assert.equal(seen[0].messageId, 'm-9')
  assert.equal(seen[0].scope, 'c2c')
  assert.equal(seen[0].openId, 'openid-a')
  assert.equal(seen[0].content, '正文')
  assert.deepEqual(seen[0].replyTarget, { scope: 'c2c', targetId: 'openid-a', msgId: 'm-9' })
})

test('a group message carries its group OpenID', () => {
  const service = fakeService()
  const adapter = createPlatformAdapter(service)
  const seen = []
  adapter.onMessage(msg => {
    seen.push(msg)
    return true
  })
  service.__pre(service.__ctx(message({ kind: 'group', groupOpenid: 'group-7' })))
  assert.equal(seen[0].scope, 'group')
  assert.equal(seen[0].groupOpenId, 'group-7')
})

test('the adapter sends through the stock sender, keeping its reply fallbacks', async () => {
  const service = fakeService()
  const adapter = createPlatformAdapter(service)
  adapter.onMessage(() => true)
  await adapter.send({ target: { scope: 'c2c', openId: 'openid-a' }, text: '回答' })
  assert.equal(service.__sent.length, 1)
  assert.equal(service.__sent[0].content, '回答')
  assert.equal(service.__sent[0].target.targetId, 'openid-a')
  assert.equal(adapter.diagnostics.sent, 1)
})

test('sending with no target fails loudly rather than silently dropping', async () => {
  const service = fakeService()
  const adapter = createPlatformAdapter(service)
  await assert.rejects(() => adapter.send({ target: { scope: 'c2c', openId: '' }, text: 'x' }), /no send target/)
})

test('a stock plugin without the extension point is detected, not used', () => {
  const service = fakeService({ withPreHandler: false })
  const adapter = createPlatformAdapter(service)
  assert.equal(adapter.available(), false)
  assert.throws(() => adapter.onMessage(() => true), /setMessagePreHandler/)
})

test('the unavailable adapter never pretends to work', async () => {
  const adapter = createUnavailableAdapter({ reason: 'no qqbot service', logger: { warn() {}, error() {}, info() {} } })
  assert.equal(adapter.available(), false)
  await assert.rejects(() => adapter.send({ target: { scope: 'c2c', openId: 'x' }, text: 'y' }), /unavailable/)
})

test('resolveAdapter prefers the live service and explains what is missing', () => {
  const good = resolveAdapter({ ctx: { get: () => fakeService() }, info() {}, warn() {} })
  assert.equal(good.available(), true)

  const warnings = []
  const noPre = resolveAdapter({
    ctx: { get: () => fakeService({ withPreHandler: false }) },
    warn: text => warnings.push(text),
  })
  assert.equal(noPre.available(), false)
  assert.match(warnings[0], /make-bridged-qqbot/)

  const missing = []
  const none = resolveAdapter({ ctx: { get: () => undefined }, warn: text => missing.push(text) })
  assert.equal(none.available(), false)
  assert.match(missing[0], /no qqbot service/i)
})

test('resolveAdapter survives a ctx.get that throws', () => {
  const none = resolveAdapter({
    ctx: {
      get() {
        throw new Error('service not available')
      },
    },
    warn() {},
  })
  assert.equal(none.available(), false)
})

test('logging never prints an OpenID or a token in the clear', () => {
  const openId = 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6'
  assert.equal(shortId(openId), 'A1B2...D6')
  assert.doesNotMatch(String(shortId(openId)), new RegExp(openId))

  // Synthetic fixture values. NEVER paste a real AppSecret into a test file:
  // this repository is public, and the credential would be published with it.
  const secret = 'FIXTURE-not-a-real-secret-0123456789'
  const appId = '1234567890'
  const line = scrub(`appSecret=${secret}`)
  assert.doesNotMatch(line, new RegExp(secret))

  const rendered = render({ appSecret: secret, appId, nested: { a: 1 } })
  assert.doesNotMatch(rendered, new RegExp(secret))
  assert.match(rendered, new RegExp(`appId=${appId}`))
  assert.match(rendered, /nested=<object>/)

  assert.match(format(['connect to %s as %s', 'openid', 'peer']), /connect to openid as peer/)
  assert.doesNotMatch(String(createLogger({ info() {}, warn() {}, error() {}, debug() {} }, 'x').info), /undefined/)
})
