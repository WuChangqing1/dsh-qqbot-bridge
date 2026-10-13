import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createAccess } from '../lib/access.js'

test('an empty allowlist denies everyone (fail closed)', () => {
  const access = createAccess({ allowOpenIds: [] })
  const verdict = access.check({ scope: 'c2c', openId: 'openid-x' })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reason, 'allowlist-empty')
  assert.match(access.describe(), /denied/)
})

test('a listed OpenID is allowed, an unlisted one is not', () => {
  const access = createAccess({ allowOpenIds: ['openid-a', '  ', 'openid-b'] })
  assert.equal(access.check({ scope: 'c2c', openId: 'openid-a' }).allowed, true)
  assert.equal(access.check({ scope: 'c2c', openId: 'openid-b' }).allowed, true)
  assert.equal(access.check({ scope: 'c2c', openId: 'openid-c' }).allowed, false)
  assert.equal(access.check({ scope: 'c2c', openId: 'openid-c' }).reason, 'not-allowed')
})

test('a missing OpenID is never allowed', () => {
  const access = createAccess({ allowOpenIds: ['*'] })
  assert.equal(access.check({ scope: 'c2c', openId: '' }).allowed, false)
  assert.equal(access.check({ scope: 'c2c' }).reason, 'no-openid')
})

test('the wildcard is explicit, never an implicit default', () => {
  const closed = createAccess({ allowOpenIds: [] })
  assert.equal(closed.check({ scope: 'c2c', openId: 'anyone' }).allowed, false)

  const open = createAccess({ allowOpenIds: ['*'] })
  assert.equal(open.check({ scope: 'c2c', openId: 'anyone' }).allowed, true)
  assert.match(open.describe(), /WILDCARD/)
})

test('groups are disabled by default and never route', () => {
  const access = createAccess({ allowOpenIds: ['openid-a'] })
  const verdict = access.check({ scope: 'group', openId: 'openid-a', groupOpenId: 'group-1' })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reason, 'groups-disabled')
})

test('an allowed group still requires an allowed sender', () => {
  const access = createAccess({ allowOpenIds: ['openid-a'], allowGroups: true, allowGroupIds: ['group-1'] })
  assert.equal(access.check({ scope: 'group', openId: 'openid-a', groupOpenId: 'group-1' }).allowed, true)
  assert.equal(access.check({ scope: 'group', openId: 'openid-stranger', groupOpenId: 'group-1' }).reason, 'sender-not-allowed')
  assert.equal(access.check({ scope: 'group', openId: 'openid-a', groupOpenId: 'group-2' }).reason, 'group-not-allowed')
})

test('a nickname is never used as identity (only the OpenID is compared)', () => {
  const access = createAccess({ allowOpenIds: ['openid-a'] })
  // Someone renaming themselves to the allowed peer's nickname changes nothing.
  assert.equal(access.check({ scope: 'c2c', openId: 'openid-a', nickname: 'someone' }).allowed, true)
  assert.equal(access.check({ scope: 'c2c', openId: 'openid-b', nickname: 'openid-a' }).allowed, false)
})
