import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRegistry } from '../lib/registry.js'
import { sampleState, tempTeam } from './harness.mjs'

test('registry reads the four Bots from state.json', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const registry = createRegistry({ statePath: team.statePath })
  await registry.refresh(true)
  assert.deepEqual(
    registry.bots.map(bot => bot.name),
    ['管家', '设计师', '程序员', '聊天搭子'],
  )
  assert.equal(registry.bots.length, 4, 'must reuse the existing Bots, never create new ones')
})

test('a Bot with no explicit part speaks in its own id', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const registry = createRegistry({ statePath: team.statePath })
  await registry.refresh(true)
  assert.equal(registry.find('管家').sessionId, 'session-manager')
})

test('the current part is re-read after a long chat moves on', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const registry = createRegistry({ statePath: team.statePath })
  await registry.refresh(true)
  assert.equal(registry.find('程序员').sessionId, 'session-coder-part2')

  // ds-bot's parts.js:moveOn() archives the old part and swaps in a fresh id.
  const next = sampleState()
  next.bots['session-coder'].segments = [{ sessionId: 'session-coder-part1', endedAt: 1 }]
  next.bots['session-coder'].sessionId = 'session-coder-part3'
  next.revision = 8
  await team.write(next)

  await registry.refresh()
  assert.equal(registry.find('程序员').sessionId, 'session-coder-part3')
  assert.deepEqual(registry.find('程序员').segments, ['session-coder-part1'])
})

test('a renamed Bot is found by its new name', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const registry = createRegistry({ statePath: team.statePath })
  await registry.refresh(true)

  const next = sampleState()
  next.bots['session-manager'].name = '总管'
  next.revision = 9
  await team.write(next)

  // `force` mirrors production, where the polling re-read eventually picks this
  // up; the point here is that a rename is resolved by the new name.
  await registry.refresh(true)
  assert.equal(registry.find('总管').name, '总管')
  assert.equal(registry.find('管家'), undefined)
})

test('the main Bot is the first Main Bot id', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const registry = createRegistry({ statePath: team.statePath })
  await registry.refresh(true)
  assert.equal(registry.mainBot().name, '管家')

  const next = sampleState({ mainBotIds: ['session-coder'] })
  delete next.bots['session-coder'].sessionId
  await team.write(next)
  await registry.refresh()
  assert.equal(registry.mainBot().name, '程序员')
})

test('a missing state.json is survivable and non-fatal', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const registry = createRegistry({ statePath: `${team.dir}/does-not-exist.json` })
  const view = await registry.refresh(true)
  assert.deepEqual(view.bots, [])
  assert.equal(registry.mainBot(), undefined)
})

test('a corrupt state.json keeps the previous snapshot', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const registry = createRegistry({ statePath: team.statePath })
  await registry.refresh(true)
  const before = registry.bots.length

  const { writeFile } = await import('node:fs/promises')
  await writeFile(team.statePath, '{ not json', 'utf8')
  await registry.refresh(true)
  assert.equal(registry.bots.length, before, 'a mid-write file must not wipe the roster')
})

test('roster changes notify listeners exactly once per change', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const registry = createRegistry({ statePath: team.statePath })
  await registry.refresh(true)

  let notifications = 0
  registry.onRosterChange(() => {
    notifications += 1
  })

  await registry.refresh()
  assert.equal(notifications, 0, 'no change, no notification')

  const next = sampleState()
  next.bots['session-coder'].sessionId = 'session-coder-part9'
  await team.write(next)
  await registry.refresh()
  assert.equal(notifications, 1)

  await registry.refresh()
  assert.equal(notifications, 1, 'an unchanged re-read must not notify again')
})

test('ownerOf resolves both current and archived parts back to a Bot', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const registry = createRegistry({ statePath: team.statePath })
  await registry.refresh(true)
  assert.equal((await registry.ownerOf('session-coder-part2')).name, '程序员')
  assert.equal((await registry.ownerOf('session-manager')).name, '管家')
  assert.equal(await registry.ownerOf('session-nobody'), undefined)
})
