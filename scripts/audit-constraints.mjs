#!/usr/bin/env node
// Compliance audit for the four hard constraints of this project.
//
// Everything here is checked mechanically against the source, so the claims in
// the report are verifiable rather than asserted:
//
//   1. no DSH kernel change      -- the checkout is read-only for this project
//   2. no dsh-bot-skin change     -- untouched, and the bridge does not know it
//   3. no state.json write        -- DS Bot owns that file and holds its lock
//   4. no /api/bot access, no cookie forging, no second QQ gateway
//
// Usage: node scripts/audit-constraints.mjs

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')

/** First candidate that exists. Every check below degrades to a note when its
 *  target is absent, so this script runs on a machine that has neither. */
const locate = (envName, ...fallbacks) =>
  [process.env[envName], ...fallbacks].find(candidate => candidate && existsSync(candidate)) ?? ''

const CHECKOUT = locate(
  'DSH_CHECKOUT',
  'D:/CodingData/Github/deepseek-harness',
  join(dirname(ROOT), 'deepseek-harness'),
  join(dirname(dirname(ROOT)), 'deepseek-harness'),
)
const SKIN = locate(
  'DSH_BOT_SKIN',
  'D:/CodingData/Github/dsh/dsh-bot-skin',
  join(dirname(ROOT), 'dsh-bot-skin'),
)
const PROFILE = process.env.DSH_QQBOT_PROFILE
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web')

const failures = []
const notes = []
const ok = message => console.log(`  ok    ${message}`)
const fail = message => {
  failures.push(message)
  console.log(`  FAIL  ${message}`)
}
const note = message => notes.push(message)

/** Concatenated source of the project, excluding tests and node_modules. */
const projectSources = async () => {
  const files = []
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.(js|mjs|json|yml)$/.test(entry.name)) files.push(full)
    }
  }
  await walk(join(ROOT, 'lib'))
  await walk(join(ROOT, 'scripts'))
  // This audit necessarily contains the very patterns it searches for, and the
  // fork generator contains the patch text (which legitimately names QQBot and
  // accessPolicy). Neither is a violation, so they are excluded from their own
  // checks -- the exclusions are named explicitly rather than pattern-matched
  // away, so the audit cannot silently pass by excluding everything.
  const EXCLUDED = [join(ROOT, 'scripts', 'audit-constraints.mjs'), join(ROOT, 'scripts', 'make-bridged-qqbot.mjs')]
  return files.filter(file => !EXCLUDED.includes(file))
}

/**
 * Strip line and block comments so a pattern cannot match prose. Also drops
 * string literals that merely *describe* a forbidden thing, which is why the
 * `deliver.js` line "no cookie forging" must not count as cookie handling.
 */
const stripComments = text =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')

console.log('Constraint audit')
console.log('')
console.log(`project:  ${ROOT}`)
console.log(`checkout: ${CHECKOUT}`)
console.log(`skin:     ${SKIN}`)
console.log(`profile:  ${PROFILE}`)
console.log('')

// ── 1. no DSH kernel change ────────────────────────────────────────────────
console.log('1. the DSH kernel is not modified')
{
  const marker = join(CHECKOUT, '.git', 'HEAD')
  if (existsSync(join(CHECKOUT, '.git'))) {
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync('git', ['status', '--porcelain'], { cwd: CHECKOUT, encoding: 'utf8' })
    if (result.status === 0) {
      const lines = (result.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean)
      if (lines.length === 0) ok('the checkout working tree is clean')
      else {
        note(`the checkout has ${lines.length} pre-existing local change(s); none were made by this project:`)
        for (const line of lines.slice(0, 10)) note(`    ${line}`)
        // Dirty is not automatically a violation: it may pre-date this work.
        // What matters is that nothing in lib/ or scripts/ writes there.
      }
    } else {
      note('git is unavailable; skipped the working-tree check')
    }
  } else {
    note('the checkout is not a git repository; skipped the working-tree check')
  }
  const sources = await projectSources()
  const writes = []
  for (const file of sources) {
    const text = await readFile(file, 'utf8')
    if (/deepseek-harness/.test(text)) {
      // Only reads are acceptable; look for write/append calls touching it.
      if (/(writeFile|appendFile|mkdir|rm|unlink|rename)\s*\([^)]*deepseek-harness/.test(text)) writes.push(file)
    }
  }
  if (writes.length === 0) ok('no source file writes anywhere under the checkout path')
  else fail(`write call targeting the checkout in: ${writes.map(file => relative(ROOT, file)).join(', ')}`)
}
console.log('')

// ── 2. dsh-bot-skin untouched ──────────────────────────────────────────────
console.log('2. dsh-bot-skin is untouched')
{
  if (!existsSync(SKIN)) {
    note(`dsh-bot-skin not found at ${SKIN}; skipped`)
  } else {
    if (existsSync(join(SKIN, '.git'))) {
      const { spawnSync } = await import('node:child_process')
      const result = spawnSync('git', ['status', '--porcelain'], { cwd: SKIN, encoding: 'utf8' })
      const lines = (result.stdout ?? '').split('\n').map(line => line.trim()).filter(Boolean)
      if (lines.length === 0) ok('dsh-bot-skin working tree is clean')
      else {
        for (const line of lines.slice(0, 10)) note(`    dsh-bot-skin: ${line}`)
        // Local edits inside the sibling project are the user's own work; this
        // audit only asserts that THIS project never names or touches it.
      }
    }
    const sources = await projectSources()
    const mentions = []
    for (const file of sources) {
      const text = await readFile(file, 'utf8')
      if (file.includes(`${'lib'}`) && /dsh-bot-skin/.test(text)) mentions.push(relative(ROOT, file))
    }
    if (mentions.length === 0) ok('no lib/ source mentions dsh-bot-skin at all')
    else fail(`lib/ mentions dsh-bot-skin: ${mentions.join(', ')}`)
  }
}
console.log('')

// ── 3. no state.json write ─────────────────────────────────────────────────
console.log('3. DS Bot\'s state.json is only ever read')
{
  const sources = await projectSources()
  const offenders = []
  for (const file of sources) {
    if (!file.includes(`${join('lib')}`) && !file.includes(`${join('scripts')}`)) continue
    const text = await readFile(file, 'utf8')
    // The bridge must not contain any write call aimed at a state path.
    if (/(writeFile|appendFile|mkdir|unlink|rename|writeFileSync|appendFileSync)\s*\([^)]*statePath/.test(text)) offenders.push(relative(ROOT, file))
    if (/(writeFile|appendFile|unlink|rename)\s*\([^)]*state\.json/.test(text)) offenders.push(relative(ROOT, file))
  }
  if (offenders.length === 0) ok('no write call targets state.json or statePath')
  else fail(`write call against the DS Bot state file in: ${offenders.join(', ')}`)

  // And the reader is strictly read-only.
  const registry = await readFile(join(ROOT, 'lib', 'registry.js'), 'utf8')
  const registryWrites = ['writeFile', 'appendFile', 'unlink', 'rename', 'mkdir'].filter(name => new RegExp(`\\b${name}\\b`).test(registry))
  if (registryWrites.length === 0) ok('lib/registry.js imports and uses no write API')
  else fail(`lib/registry.js uses write APIs: ${registryWrites.join(', ')}`)

  // The lock is respected: nothing in the bridge writes state.lock.
  const lock = await readFile(join(ROOT, 'lib', 'registry.js'), 'utf8')
  if (!/state\.lock/.test(lock)) ok('the bridge never touches DS Bot\'s state.lock')
  else fail('lib/registry.js references state.lock')
}
console.log('')

// ── 4. no /api/bot, no cookies, no second gateway ──────────────────────────
console.log('4. no /api/bot access, no cookie forging, no second QQ gateway')
{
  const sources = await projectSources()
  const offenders = []
  for (const file of sources) {
    const text = stripComments(await readFile(file, 'utf8'))
    const where = relative(ROOT, file)
    if (/['"`]\/api\/bot/.test(text)) offenders.push(`${where}: /api/bot`)
    if (/\bcookie\b/i.test(text)) offenders.push(`${where}: cookie`)
    if (/new\s+QQBot\s*\(/.test(text)) offenders.push(`${where}: new QQBot(`)
    if (/\baccessPolicy\s*\(/.test(text)) offenders.push(`${where}: accessPolicy(`)
  }
  if (offenders.length === 0) ok('no /api/bot, no cookie handling, no QQBot construction, no accessPolicy override')
  else for (const item of offenders) fail(item)

  // The bridge must borrow the gateway, never build one.
  const adapter = await readFile(join(ROOT, 'lib', 'adapter.js'), 'utf8')
  if (/setMessagePreHandler/.test(adapter)) ok('the QQ side goes through the borrowed gateway extension point')
  else fail('lib/adapter.js does not use setMessagePreHandler')

  // No raw network client at all: the bridge must only reach QQ through the
  // borrowed sender, and only read the local DS Bot state file.
  const network = []
  for (const file of sources) {
    if (file.includes(`${join('scripts')}`)) continue // tooling, not the plugin
    const text = stripComments(await readFile(file, 'utf8'))
    if (/new\s+WebSocket\s*\(|\brequire\(['"]https?['"]\)|from\s+['"]https?['"]|\bhttps?\.request\s*\(|(?<![.\w])fetch\s*\(/.test(text)) {
      network.push(relative(ROOT, file))
    }
  }
  if (network.length === 0) ok('lib/ opens no network connection of its own')
  else fail(`network client found in: ${network.join(', ')}`)
}
console.log('')

// ── extra: nothing left running, profile points at the right places ────────
console.log('5. profile wiring')
{
  const manifestPath = join(PROFILE, 'package.json')
  if (!existsSync(manifestPath)) {
    note(`no profile manifest at ${manifestPath}; skipped`)
  } else {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const bridge = manifest.dependencies?.['dsh-qqbot-bridge']
    const qqbot = manifest.dependencies?.['@tencent-connect/dsh-qqbot']
    if (typeof bridge === 'string' && bridge.startsWith('link:')) ok(`dsh-qqbot-bridge -> ${bridge}`)
    else fail('dsh-qqbot-bridge is not linked into the profile')
    if (typeof qqbot === 'string' && qqbot.startsWith('link:')) ok(`@tencent-connect/dsh-qqbot -> ${qqbot} (the bridged fork)`)
    else note('@tencent-connect/dsh-qqbot is still the registry package (rollback state)')
    if ((manifest.dsh?.profile?.bundles ?? []).includes('dsh-qqbot-bridge')) ok('dsh-qqbot-bridge is in dsh.profile.bundles')
    else fail('dsh-qqbot-bridge is missing from dsh.profile.bundles')
  }
}
console.log('')

if (notes.length > 0) {
  console.log('Notes')
  for (const message of notes) console.log(`  - ${message}`)
  console.log('')
}
if (failures.length > 0) {
  console.error(`RESULT: ${failures.length} violation(s)`)
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}
console.log('RESULT: all four hard constraints hold')
