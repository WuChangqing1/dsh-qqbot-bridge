#!/usr/bin/env node
// "Is the bridge actually loaded?" -- answer it from the host's own record.
//
// The bridge writes `<dataDir>/bridge-status.json` the moment `apply()` runs, so
// this file is the ground truth for activation. Run this AFTER starting DSH:
//
//   node scripts/bridge-status.mjs
//   node scripts/bridge-status.mjs --data <bridge data dir>
//
// Exit code is 0 when the record says `phase: running`, 1 otherwise, so it can
// also be used as a health check.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const valueOf = flag => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const dataDir = resolve(valueOf('--data') ?? join(dshHome, 'qqbot-bridge'))
const statusPath = join(dataDir, 'bridge-status.json')

console.log('QQ -> DS Bot bridge status')
console.log('')
console.log(`  data dir      ${dataDir}`)
console.log(`  status file   ${statusPath}`)

if (!existsSync(statusPath)) {
  console.log('  state         MISSING')
  console.log('')
  console.log('The bridge has not written its status file, so it has not run')
  console.log('`apply()` in this DSH data directory. Check that:')
  console.log('  * `dsh-qqbot-bridge` is in the profile\'s dsh.profile.bundles list,')
  console.log('  * the id `qqbot-bridge` appears in `dsh --profile web --dump-config`,')
  console.log('  * and DSH has been restarted since the plugin was installed.')
  process.exit(1)
}

let status
try {
  status = JSON.parse(await readFile(statusPath, 'utf8'))
} catch (error) {
  console.error(`  state         UNREADABLE (${error.message})`)
  process.exit(1)
}

const values = [
  ['phase', status.phase],
  ['available', String(status.available ?? false)],
  ['transport', String(status.transport ?? '(none)')],
  ['transportOk', String(status.transportOk ?? false)],
  ['allowOpenIds', `${String(status.allowOpenIdsCount ?? 0)} configured`],
  ['failClosed', String(status.failClosed ?? false)],
  ['defaultBot', String(status.defaultBot ?? '(none)')],
  ['waiting for', (status.waitingFor ?? []).join(', ') || '(nothing)'],
  ['bots', `${String((status.bots ?? []).length)}`],
  ['started', String(status.startedAt ?? '?')],
  ['updated', String(status.updatedAt ?? '?')],
  ['plugin', `${String(status.plugin ?? '?')} v${String(status.version ?? '?')} (pid ${String(status.pid ?? '?')})`],
]
console.log('')
for (const [label, value] of values) {
  console.log(`  ${label.padEnd(13)} ${value}`)
}

if (status.lastError !== undefined) {
  console.log('')
  console.log(`  last error    ${String(status.lastError)}`)
}

if (status.failClosed === true) {
  console.log('')
  console.log('  FAIL CLOSED: allowOpenIds is empty, so every QQ peer is refused.')
  console.log('  Send a private message to the bot, then run:')
  console.log('    node scripts/show-openids.mjs')
  console.log('  and put your own OpenID into the profile patch before restarting.')
}

console.log('')
if (status.phase === 'running' && status.available === true) {
  console.log(status.transportOk === true
    ? 'RESULT: the bridge is loaded and the QQ transport is wired.'
    : 'RESULT: the bridge is loaded, but no usable QQ transport was found.')
  process.exit(status.transportOk === true ? 0 : 1)
}
console.log(`RESULT: the bridge is loaded but not running (phase=${String(status.phase)}).`)
process.exit(1)
