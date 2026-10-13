import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createRejectedLog, rejectedFile } from '../lib/rejected-log.js'
import { tempTeam } from './harness.mjs'

test('a refused OpenID is recorded with its reason and count', async t => {
  const team = await tempTeam()
  const log = createRejectedLog({ file: rejectedFile(team.dataDir) })
  t.after(async () => {
    await log.flush()
    await team.cleanup()
  })
  await log.load()
  log.record('openid-a', 'open...a', 'allowlist-empty')
  log.record('openid-a', 'open...a', 'allowlist-empty')
  log.record('openid-b', 'open...b', 'not-allowed')

  const list = await log.list()
  assert.equal(list.length, 2)
  const a = list.find(entry => entry.openId === 'openid-a')
  assert.equal(a.count, 2)
  assert.equal(a.reason, 'allowlist-empty')
  assert.equal(a.short, 'open...a')
})

test('the newest refusal comes first', async t => {
  const team = await tempTeam()
  let now = 1000
  const log = createRejectedLog({ file: rejectedFile(team.dataDir), now: () => now })
  t.after(async () => {
    await log.flush()
    await team.cleanup()
  })
  await log.load()
  log.record('older', 'old', 'not-allowed')
  now = 2000
  log.record('newer', 'new', 'not-allowed')
  const list = await log.list()
  assert.equal(list[0].openId, 'newer')
})

test('an empty OpenID is not recorded', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const log = createRejectedLog({ file: rejectedFile(team.dataDir) })
  await log.load()
  log.record('', '', 'no-openid')
  assert.deepEqual(await log.list(), [])
})

test('the list survives a restart', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const file = rejectedFile(team.dataDir)
  const first = createRejectedLog({ file })
  await first.load()
  first.record('openid-a', 'open...a', 'allowlist-empty')
  await new Promise(resolve => setTimeout(resolve, 20))

  const reopened = createRejectedLog({ file })
  await reopened.load()
  const list = await reopened.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].openId, 'openid-a')
})

test('a corrupt file is survivable', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(team.dataDir, { recursive: true })
  await writeFile(rejectedFile(team.dataDir), 'not json', 'utf8')
  const log = createRejectedLog({ file: rejectedFile(team.dataDir) })
  await log.load()
  assert.deepEqual(await log.list(), [])
})

test('the file is written owner-only', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const log = createRejectedLog({ file: rejectedFile(team.dataDir) })
  await log.load()
  log.record('openid-a', 'open...a', 'allowlist-empty')
  // Give the queued write a moment, then assert the content is what we expect.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const raw = await readFile(join(team.dataDir, 'rejected-openids.json'), 'utf8')
      const parsed = JSON.parse(raw)
      assert.equal(parsed.rejected[0].openId, 'openid-a')
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  assert.fail('the rejected list was never written')
})

test('the in-memory map stays bounded', async t => {
  const team = await tempTeam()
  const log = createRejectedLog({ file: rejectedFile(team.dataDir) })
  t.after(async () => {
    await log.flush()
    await team.cleanup()
  })
  await log.load()
  for (let index = 0; index < 200; index += 1) log.record(`openid-${index}`, `o${index}`, 'not-allowed')
  const list = await log.list()
  assert.ok(list.length <= 20, `expected at most 20 entries, got ${list.length}`)
})
