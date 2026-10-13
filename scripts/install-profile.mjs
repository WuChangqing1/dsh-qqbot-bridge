#!/usr/bin/env node
// Switch the web profile to the bridged QQ plugin and mount dsh-qqbot-bridge.
//
// Idempotent and reversible. It rewrites ONLY these three things in the profile
// manifest:
//   * dependencies["@tencent-connect/dsh-qqbot"]      -> link:<fork dir>
//   * dependencies["dsh-qqbot-bridge"]                -> link:<project dir>
//   * dsh.profile.bundles                             -> + "dsh-qqbot-bridge"
//
// It does not run pnpm, does not restart anything, and does not touch
// cordis.patch.yml (where the credentials and the allowlist live). Use
// --dry-run to see the diff first, and rollback-profile.mjs to undo it.
//
// Usage:
//   node scripts/install-profile.mjs --fork <dir> --project <dir> [--profile <dir>] [--dry-run]

import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')

const args = process.argv.slice(2)
const valueOf = flag => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}
const has = flag => args.includes(flag)

const FORK = resolve(valueOf('--fork') ?? join(dirname(ROOT), 'dsh-bridged-qqbot'))
const PROJECT = resolve(valueOf('--project') ?? ROOT)
/** The DSH home, resolved the same way the harness does: DSH_HOME wins, else ~/.dsh. */
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = resolve(
  valueOf('--profile') ?? process.env.DSH_QQBOT_PROFILE ?? join(dshHome, 'profiles', 'web'),
)
const DRY = has('--dry-run')

/** DSH writes `link:` specs with forward slashes, even on Windows. */
const linkSpec = dir => `link:${dir.replace(/\\/g, '/')}`

const manifestPath = join(PROFILE, 'package.json')

const main = async () => {
  if (!existsSync(manifestPath)) throw new Error(`no profile manifest at ${manifestPath}`)
  if (!existsSync(join(PROJECT, 'package.json'))) throw new Error(`no project package.json at ${PROJECT}`)
  if (!existsSync(join(FORK, 'PATCH-0001-APPLIED.md'))) {
    throw new Error(
      `${FORK} is not a bridged fork (no PATCH-0001-APPLIED.md). Run scripts/make-bridged-qqbot.mjs first.`,
    )
  }

  const before = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(before)
  manifest.dependencies ??= {}
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []

  const changes = []
  const setDep = (name, value) => {
    if (manifest.dependencies[name] === value) return
    changes.push(`${name}: ${manifest.dependencies[name] ?? '(absent)'} -> ${value}`)
    manifest.dependencies[name] = value
  }
  setDep('@tencent-connect/dsh-qqbot', linkSpec(FORK))
  setDep('dsh-qqbot-bridge', linkSpec(PROJECT))
  if (!manifest.dsh.profile.bundles.includes('dsh-qqbot-bridge')) {
    // Appended last so its patch layer applies after the QQ plugin's own layer.
    manifest.dsh.profile.bundles.push('dsh-qqbot-bridge')
    changes.push(`dsh.profile.bundles: + dsh-qqbot-bridge`)
  }

  console.log(`profile: ${PROFILE}`)
  console.log(`fork:    ${FORK}`)
  console.log(`project: ${PROJECT}`)
  console.log('')
  if (changes.length === 0) {
    console.log('already installed; nothing to change')
    return
  }
  for (const change of changes) console.log(`  ${change}`)
  console.log('')

  if (DRY) {
    console.log('--dry-run: nothing written')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${manifestPath}.bak-${stamp}`
  await copyFile(manifestPath, backup)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`wrote ${manifestPath}`)
  console.log(`backup ${backup}`)
  console.log('')
  console.log('Next (with the dsh host STOPPED):')
  console.log(`  cd ${PROFILE}`)
  console.log('  pnpm install')
  console.log('')
  console.log('Then check the fork still resolves its own dependencies:')
  console.log(`  cd ${FORK} && pnpm install --prefer-offline`)
}

main().catch(error => {
  console.error(`[install-profile] ${error?.message ?? error}`)
  process.exit(1)
})
