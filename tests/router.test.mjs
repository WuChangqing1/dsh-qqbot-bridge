import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRouter, routingFile } from '../lib/router.js'
import { tempTeam } from './harness.mjs'

const make = async (t, fallback = () => '管家') => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const router = createRouter({ file: routingFile(team.dataDir), fallback })
  await router.load()
  return { team, router }
}

test('an unknown peer falls back to the default Bot', async t => {
  const { router } = await make(t)
  assert.equal(router.current('openid-new'), '管家')
})

test('a switch is remembered and reads back', async t => {
  const { router } = await make(t)
  await router.select('openid-a', '程序员')
  assert.equal(router.current('openid-a'), '程序员')
  assert.equal(router.current('openid-b'), '管家', 'other peers keep the default')
})

test('choices survive a restart', async t => {
  const { team, router } = await make(t)
  await router.select('openid-a', '设计师')
  await router.flush()

  const reopened = createRouter({ file: routingFile(team.dataDir), fallback: () => '管家' })
  await reopened.load()
  assert.equal(reopened.current('openid-a'), '设计师')
})

test('a bot that disappears is dropped from every peer', async t => {
  const { router } = await make(t)
  await router.select('openid-a', '程序员')
  await router.select('openid-b', '程序员')
  await router.select('openid-c', '设计师')
  await router.drop('程序员')
  assert.equal(router.current('openid-a'), '管家')
  assert.equal(router.current('openid-c'), '设计师')
  assert.deepEqual(router.snapshot(), { 设计师: 1 })
})

test('a corrupt routing file does not break startup', async t => {
  const team = await tempTeam()
  t.after(() => team.cleanup())
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(team.dataDir, { recursive: true })
  await writeFile(routingFile(team.dataDir), 'not json at all', 'utf8')
  const router = createRouter({ file: routingFile(team.dataDir), fallback: () => '管家' })
  await router.load()
  assert.equal(router.current('openid-a'), '管家')
})
