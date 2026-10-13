#!/usr/bin/env node
// Show the QQ OpenIDs the bridge has refused, so you can allowlist yours.
//
// A refused peer is never granted access by this tool -- it only prints what was
// recorded. You then decide which id goes into `allowOpenIds`.
//
// Usage:
//   node scripts/show-openids.mjs
//   node scripts/show-openids.mjs --data <bridge data dir>

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
const dataDir = valueOf('--data') ?? join(dshHome, 'qqbot-bridge')
const file = resolve(dataDir, 'rejected-openids.json')

if (!existsSync(file)) {
  console.log(`No refused OpenIDs recorded yet (${file} does not exist).`)
  console.log('')
  console.log('Send any private message to the QQ bot first, then run this again.')
  process.exit(0)
}

let parsed
try {
  parsed = JSON.parse(await readFile(file, 'utf8'))
} catch (error) {
  console.error(`Cannot read ${file}: ${error.message}`)
  process.exit(1)
}

const rejected = Array.isArray(parsed?.rejected) ? parsed.rejected : []
if (rejected.length === 0) {
  console.log(`No refused OpenIDs recorded yet in ${file}.`)
  process.exit(0)
}

console.log(`Refused QQ OpenIDs (${file})`)
console.log('')
for (const entry of rejected) {
  const when = entry.at === undefined || entry.at === 0 ? 'unknown time' : new Date(entry.at).toISOString()
  console.log(`  ${entry.openId}`)
  console.log(`      last seen ${when}, attempts ${entry.count ?? 1}, reason ${entry.reason ?? 'unknown'}`)
}
console.log('')
console.log('To allow one of them, add it to the profile patch:')
console.log(`  ${join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web', 'cordis.patch.yml')}`)
console.log('')
console.log('  - id: qqbot-bridge')
console.log('    config:')
console.log(`      allowOpenIds: ["${rejected[0].openId}"]`)
console.log('')
console.log('DSH hot-reloads that file, so a restart is normally not required.')
console.log('Nothing is allowed until you do this.')
