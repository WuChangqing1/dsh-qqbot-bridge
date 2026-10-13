// End-to-end behaviour of the bridge, with the QQ gateway and the LLM faked.
//
// This file is the acceptance test for the claims that matter:
//   * a QQ message lands in the EXISTING Bot session, tagged as coming from QQ;
//   * the Bot's real answer goes back to that QQ peer;
//   * a message the user types in the Web UI is NEVER relayed to QQ;
//   * another Bot's internal relay is NEVER relayed to QQ;
//   * an unauthorised OpenID is refused and reaches no Bot at all.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { harness, sampleState } from './harness.mjs'
import { BRIDGE_KIND } from '../lib/source-tag.js'

test('a QQ message enters the existing 管家 session, tagged as bridge traffic', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  const verdict = await h.adapter.deliver(h.qq({ content: '记住本轮测试标识 CODE-TEST-001' }))
  assert.equal(verdict, true, 'the bridge must tell the transport it owns the message')
  await h.bridge.drain()

  const delivered = h.sessionController.delivered('session-manager')
  assert.equal(delivered.length, 1, 'exactly one message reached the Bot session')
  assert.equal(delivered[0].content[0].text, '记住本轮测试标识 CODE-TEST-001')
  assert.equal(delivered[0].source.kind, BRIDGE_KIND, 'the message is attributed to the bridge, not to a Web prompt')
  assert.equal(delivered[0].source.peerId, 'openid-allowed')
  assert.equal(delivered[0].role, 'user')
  // The session is the Bot's own real session id -- no replacement agent is created.
  assert.equal(h.sessionController.agents.size, 1)
})

test('the Bot answer is relayed back to the QQ peer', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '你好' }))
  await h.bridge.drain()
  await h.turn('session-manager', { text: '你好，我是管家。' })

  assert.match(h.adapter.textTo('openid-allowed'), /你好，我是管家。/)
})

test('a Web message is never relayed to QQ (no cross-user leak)', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  // A QQ message is in flight.
  await h.adapter.deliver(h.qq({ content: '你好' }))
  await h.bridge.drain()

  // The user then types in the Web UI. That prompt mints `{ kind: 'user' }`.
  await h.turn('session-manager', {
    text: '这是 Web 上的私人回复，不应该出现在 QQ 里。',
    source: { kind: 'user', rpcId: 'rpc-from-browser' },
  })

  assert.equal(h.adapter.sent.length, 0, 'nothing may be pushed to QQ for a Web prompt')
})

test("another Bot's internal relay is never relayed to QQ", async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '请程序员看看' }))
  await h.bridge.drain()

  // 管家 talks to 程序员 through DS Bot's own delivery path (`kind: 'bot'`),
  // and 程序员 answers -- none of that belongs on QQ.
  await h.turn('session-manager', {
    text: '[Message from 程序员] 我这边看完了。',
    source: { kind: 'bot', form: 'relay', role: 'reply', senderName: '程序员' },
  })

  assert.equal(h.adapter.sent.length, 0)
})

test('a QQ-first turn followed by a Web turn still relays only the first answer', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '第一个问题' }))
  await h.bridge.drain()
  await h.turn('session-manager', { text: '第一个回答' })
  await h.turn('session-manager', { text: 'Web 专属回答', source: { kind: 'user' } })

  const text = h.adapter.textTo('openid-allowed')
  assert.match(text, /第一个回答/)
  assert.doesNotMatch(text, /Web 专属回答/)
})

test('/团队 lists the existing four Bots', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '/团队' }))
  await h.bridge.drain()

  const text = h.adapter.textTo('openid-allowed')
  assert.match(text, /团队共 4 个 Bot/)
  for (const name of ['管家', '设计师', '程序员', '聊天搭子']) assert.match(text, new RegExp(name))
})

test('/当前 reports the routed Bot', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '/当前' }))
  await h.bridge.drain()
  assert.match(h.adapter.textTo('openid-allowed'), /当前目标 Bot：管家/)

  await h.adapter.deliver(h.qq({ content: '/程序员' }))
  await h.bridge.drain()
  await h.adapter.deliver(h.qq({ content: '/当前' }))
  await h.bridge.drain()
  assert.match(h.adapter.textTo('openid-allowed'), /当前目标 Bot：程序员/)
})

test('/程序员 switches and confirms with the spec wording', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '/程序员' }))
  await h.bridge.drain()
  assert.match(h.adapter.textTo('openid-allowed'), /已切换至程序员。接下来可以直接发送代码或问题。/)
  assert.equal(h.router.current('openid-allowed'), '程序员')
})

test('after a switch the next message goes to that Bot session', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '/程序员' }))
  await h.bridge.drain()
  await h.adapter.deliver(h.qq({ content: '请记住本轮测试标识为 CODE-TEST-001。' }))
  await h.bridge.drain()

  const delivered = h.sessionController.delivered('session-coder-part2')
  assert.equal(delivered.length, 1)
  assert.match(delivered[0].content[0].text, /CODE-TEST-001/)
  assert.equal(h.sessionController.delivered('session-manager').length, 0, '管家 must not receive it')
})

test('/聊天 addresses 聊天搭子', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '/聊天 今天怎么样' }))
  await h.bridge.drain()

  assert.equal(h.router.current('openid-allowed'), '聊天搭子')
  assert.equal(h.sessionController.delivered('session-companion').length, 1)
})

test('a switch with trailing text switches AND runs that text', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '/设计师 给这个界面出个方案' }))
  await h.bridge.drain()

  const delivered = h.sessionController.delivered('session-designer')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].content[0].text, '给这个界面出个方案')
})

test('an unknown Bot name is refused without switching', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '/法务 帮我看看' }))
  await h.bridge.drain()

  assert.equal(h.router.current('openid-allowed'), '管家')
  assert.match(h.adapter.textTo('openid-allowed'), /团队里没有「法务」/)
})

test('a duplicate message id costs no second turn', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  const message = h.qq({ content: '只应该处理一次' })
  assert.equal(await h.adapter.deliver(message), true)
  assert.equal(await h.adapter.deliver(message), true)
  await h.bridge.drain()

  assert.equal(h.sessionController.delivered('session-manager').length, 1)
})

test('an unauthorised OpenID is consumed silently and reaches no Bot', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  const verdict = await h.adapter.deliver(h.qq({ openId: 'openid-stranger', content: '你好' }))
  assert.equal(verdict, true, 'the message must not fall through to the stock agent')
  await h.bridge.drain()

  assert.equal(h.sessionController.delivered('session-manager').length, 0)
  assert.equal(h.adapter.sent.length, 0, 'a refused peer gets no reply')
  assert.ok(h.logs.some(([level, line]) => level === 'warn' && line.includes('refused')))
})

test('an empty allowlist refuses everyone', async t => {
  const h = await harness({ config: { allowOpenIds: [] } })
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '你好' }))
  await h.bridge.drain()
  assert.equal(h.sessionController.agents.size, 0)
})

test('an unknown slash command falls through to the stock plugin untouched', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  assert.equal(await h.adapter.deliver(h.qq({ content: '/bot-ping' })), false)
  assert.equal(await h.adapter.deliver(h.qq({ content: '/rm -rf /' })), false, 'a shell-looking word must not be executed or claimed')
  await h.bridge.drain()

  assert.equal(h.sessionController.agents.size, 0, 'a slash word is never sent to a Bot')
})

test('group messages are never routed to a privileged Bot', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  const verdict = await h.adapter.deliver(h.qq({ scope: 'group', groupOpenId: 'group-1', content: '群里说话' }))
  assert.equal(verdict, false, 'group traffic must fall through to the stock plugin')
  await h.bridge.drain()
  assert.equal(h.sessionController.agents.size, 0)
})

test('a failed turn is reported honestly, not as success', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '会失败的一轮' }))
  await h.bridge.drain()
  await h.turn('session-manager', { reason: { kind: 'error', error: { code: 'AUTH', message: 'denied' } } })

  const text = h.adapter.textTo('openid-allowed')
  assert.match(text, /失败了/)
  assert.match(text, /AUTH/)
  assert.match(text, /DSH Web/)
})

test('an interrupted turn is reported as interrupted', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '会被中断' }))
  await h.bridge.drain()
  await h.turn('session-manager', { reason: { kind: 'aborted' } })

  assert.match(h.adapter.textTo('openid-allowed'), /被中断/)
})

test('a long answer is split into QQ-sized chunks', async t => {
  const h = await harness({ config: { textChunkLimit: 100 } })
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '长回答' }))
  await h.bridge.drain()
  await h.turn('session-manager', { text: 'A'.repeat(250) })

  assert.equal(h.adapter.sent.length, 3)
  for (const entry of h.adapter.sent) assert.ok(entry.text.length <= 100)
})

test('a delivery failure is reported and leaves nothing waiting', async t => {
  const h = await harness({ failWith: 'session/not-found' })
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '你好' }))
  await h.bridge.drain()

  assert.match(h.adapter.textTo('openid-allowed'), /没有送达/)
  assert.equal(h.bridge.internals.tracker.waiting, 0)
})

test('the session is re-read so a part switch keeps working', async t => {
  const h = await harness()
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '第一轮' }))
  await h.bridge.drain()
  await h.turn('session-manager', { text: '第一轮回答' })

  // ds-bot moves 管家 on to a fresh part, as parts.js:moveOn() does.
  const next = sampleState()
  next.bots['session-manager'].segments = [{ sessionId: 'session-manager', endedAt: 1 }]
  next.bots['session-manager'].sessionId = 'session-manager-part2'
  await h.team.write(next)

  await h.adapter.deliver(h.qq({ content: '第二轮' }))
  await h.bridge.drain()

  assert.equal(h.sessionController.delivered('session-manager-part2').length, 1)
  assert.equal(h.sessionController.delivered('session-manager').length, 1, 'the old part is not written to again')
})

test('two peers get their own answers, never each other', async t => {
  const h = await harness({ config: { allowOpenIds: ['openid-allowed', 'openid-second'] } })
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ openId: 'openid-allowed', content: '我是 A' }))
  await h.bridge.drain()
  await h.turn('session-manager', { text: '回答给 A' })

  await h.adapter.deliver(h.qq({ openId: 'openid-second', content: '我是 B' }))
  await h.bridge.drain()
  await h.turn('session-manager', { text: '回答给 B' })

  assert.match(h.adapter.textTo('openid-allowed'), /回答给 A/)
  assert.doesNotMatch(h.adapter.textTo('openid-allowed'), /回答给 B/)
  assert.match(h.adapter.textTo('openid-second'), /回答给 B/)
})

test('a waiting peer is told to look in DSH Web when the turn never answers', async t => {
  const h = await harness({ config: { replyTimeoutMs: 30 } })
  t.after(() => h.cleanup())

  await h.adapter.deliver(h.qq({ content: '很久都不回' }))
  await h.bridge.drain()
  // Nothing answers within the (test-shortened) window; the sweeper must give
  // up out loud rather than stay silent forever.
  await new Promise(resolve => setTimeout(resolve, 50))
  h.bridge.internals.tracker.sweep()
  await h.bridge.drain()

  assert.match(h.adapter.textTo('openid-allowed'), /DSH Web/)
})

test('the bridge status reports the real team and the fail-closed default', async t => {
  const h = await harness({ config: { allowOpenIds: [] } })
  t.after(() => h.cleanup())

  const status = h.bridge.status()
  assert.equal(status.bots.length, 4)
  assert.equal(status.sourceKind, BRIDGE_KIND)
  assert.match(status.access, /denied/)
  assert.equal(status.defaultBot, '管家')
})
