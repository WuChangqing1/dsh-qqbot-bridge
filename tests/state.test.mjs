import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDedupe } from '../lib/dedupe.js'
import { createQueue } from '../lib/queue.js'
import { createReplyTracker } from '../lib/reply-tracker.js'

test('dedupe: the second sighting of an id is a duplicate', () => {
  const dedupe = createDedupe({ windowMs: 1000 })
  assert.equal(dedupe.isDuplicate('a'), false)
  dedupe.remember('a')
  assert.equal(dedupe.isDuplicate('a'), true)
  assert.equal(dedupe.isDuplicate('b'), false)
})

test('dedupe: a missing id is never a duplicate', () => {
  const dedupe = createDedupe()
  assert.equal(dedupe.isDuplicate(''), false)
  dedupe.remember('')
  assert.equal(dedupe.isDuplicate(''), false)
})

test('dedupe: entries expire out of the window', () => {
  let now = 0
  const dedupe = createDedupe({ windowMs: 100, now: () => now })
  dedupe.remember('a')
  now = 50
  assert.equal(dedupe.isDuplicate('a'), true)
  now = 500
  assert.equal(dedupe.isDuplicate('a'), false)
})

test('dedupe: the cache is bounded', () => {
  const dedupe = createDedupe({ windowMs: 1_000_000, max: 10 })
  for (let index = 0; index < 100; index += 1) dedupe.remember(`id-${index}`)
  assert.ok(dedupe.size <= 10)
  assert.equal(dedupe.isDuplicate('id-99'), true)
  assert.equal(dedupe.isDuplicate('id-0'), false)
})

test('queue: one lane per key, items run in order', async () => {
  const seen = []
  const queue = createQueue({
    run: async item => {
      await new Promise(resolve => setTimeout(resolve, item.delay ?? 0))
      seen.push(item.id)
    },
  })
  queue.push('peer-a', { id: 1, delay: 5 })
  queue.push('peer-a', { id: 2 })
  queue.push('peer-a', { id: 3 })
  await queue.drain()
  assert.deepEqual(seen, [1, 2, 3])
})

test('queue: different keys run concurrently', async () => {
  const order = []
  const queue = createQueue({
    run: async item => {
      order.push(`start:${item.key}`)
      await new Promise(resolve => setTimeout(resolve, 5))
      order.push(`end:${item.key}`)
    },
  })
  queue.push('a', { key: 'a' })
  queue.push('b', { key: 'b' })
  await queue.drain()
  assert.deepEqual(order.slice(0, 2), ['start:a', 'start:b'])
})

test('queue: a full lane rejects instead of growing without bound', () => {
  const dropped = []
  const queue = createQueue({
    run: () => new Promise(() => {}), // never settles
    max: 2,
    onOverflow: (key, count) => dropped.push([key, count]),
  })
  assert.equal(queue.push('peer', { id: 1 }), 'accepted') // starts running
  assert.equal(queue.push('peer', { id: 2 }), 'accepted')
  assert.equal(queue.push('peer', { id: 3 }), 'accepted')
  assert.equal(queue.push('peer', { id: 4 }), 'rejected')
  assert.deepEqual(dropped, [['peer', 1]])
})

test('reply tracker: claim takes the oldest entry for a session', () => {
  const tracker = createReplyTracker({ timeoutMs: 1000 })
  tracker.add({ requestId: 'r1', sessionId: 's1', target: '管家' })
  tracker.add({ requestId: 'r2', sessionId: 's1', target: '管家' })
  assert.equal(tracker.claim('s1').requestId, 'r1')
  assert.equal(tracker.claim('s1').requestId, 'r2')
  assert.equal(tracker.claim('s1'), undefined)
})

test('reply tracker: sessions do not steal each other entries', () => {
  const tracker = createReplyTracker({ timeoutMs: 1000 })
  tracker.add({ requestId: 'r1', sessionId: 's1', target: '管家' })
  tracker.add({ requestId: 'r2', sessionId: 's2', target: '程序员' })
  assert.equal(tracker.claim('s2').requestId, 'r2')
  assert.equal(tracker.claim('s1').requestId, 'r1')
})

test('reply tracker: an expired entry is dropped and reported', () => {
  let now = 0
  const gaveUp = []
  const tracker = createReplyTracker({ timeoutMs: 100, now: () => now })
  tracker.add({ requestId: 'r1', sessionId: 's1', target: '管家', onGiveUp: (entry, reason) => gaveUp.push([entry.requestId, reason]) })
  now = 1000
  assert.equal(tracker.claim('s1'), undefined)
  assert.deepEqual(gaveUp, [['r1', 'timeout']])
  assert.equal(tracker.abandonedCount, 1)
})

test('reply tracker: sweep reports stale entries without a claim', () => {
  let now = 0
  const gaveUp = []
  const tracker = createReplyTracker({ timeoutMs: 10, now: () => now })
  tracker.add({ requestId: 'r1', sessionId: 's1', onGiveUp: (entry, reason) => gaveUp.push(reason) })
  now = 100
  tracker.sweep()
  assert.deepEqual(gaveUp, ['timeout'])
  assert.equal(tracker.waiting, 0)
})

test('reply tracker: abandon removes the entry', () => {
  const tracker = createReplyTracker({ timeoutMs: 1000 })
  tracker.add({ requestId: 'r1', sessionId: 's1' })
  assert.equal(tracker.abandon('r1'), true)
  assert.equal(tracker.waiting, 0)
  assert.equal(tracker.abandon('r1'), false)
})

test('reply tracker: waiting counts every session', () => {
  const tracker = createReplyTracker({ timeoutMs: 1000 })
  tracker.add({ requestId: 'r1', sessionId: 's1' })
  tracker.add({ requestId: 'r2', sessionId: 's2' })
  assert.equal(tracker.waiting, 2)
  assert.equal(tracker.pending('s1').length, 1)
})
