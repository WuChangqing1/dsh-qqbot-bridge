#!/usr/bin/env node
// Undo install-profile.mjs: put the web profile back on the stock QQ plugin and
// unmount the bridge.
//
// This is the documented rollback. It rewrites ONLY the profile manifest:
//   * dependencies["@tencent-connect/dsh-qqbot"] -> the registry range
//   * dependencies["dsh-qqbot-bridge"]           -> removed
//   * dsh.profile.bundles                        -> "dsh-qqbot-bridge" removed
//
// DS Bot's four Bots, the team memory, the chat history, the skin configuration
// and the bridge's own data directory are NOT touched. QQ returns to the stock
// plugin's plain-agent behaviour as soon as the host restarts.
//
// Usage:
//   node scripts/rollback-profile.mjs [--profile <dir>] [--range ^0.5.0] [--dry-run]

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

const PROFILE = resolve(
  valueOf('--profile')
  ?? process.env.DSH_QQBOT_PROFILE
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web'),
)
const RANGE = valueOf('--range') ?? '^0.5.0'
const DRY = has('--dry-run')

const manifestPath = join(PROFILE, 'package.json')

const main = async () => {
  if (!existsSync(manifestPath)) throw new Error(`no profile manifest at ${manifestPath}`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies ??= {}
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  manifest.dsh.profile.bundles ??= []

  const changes = []
  const current = manifest.dependencies['@tencent-connect/dsh-qqbot']
  if (typeof current === 'string' && current.startsWith('link:')) {
    changes.push(`@tencent-connect/dsh-qqbot: ${current} -> ${RANGE}`)
    manifest.dependencies['@tencent-connect/dsh-qqbot'] = RANGE
  } else if (current === undefined) {
    changes.push(`@tencent-connect/dsh-qqbot: (absent) -> ${RANGE}`)
    manifest.dependencies['@tencent-connect/dsh-qqbot'] = RANGE
  } else {
    console.log(`@tencent-connect/dsh-qqbot already on ${current}; leaving it`)
  }

  if (manifest.dependencies['dsh-qqbot-bridge'] !== undefined) {
    changes.push(`dsh-qqbot-bridge: ${manifest.dependencies['dsh-qqbot-bridge']} -> removed`)
    delete manifest.dependencies['dsh-qqbot-bridge']
  }
  const bundleIndex = manifest.dsh.profile.bundles.indexOf('dsh-qqbot-bridge')
  if (bundleIndex !== -1) {
    changes.push('dsh.profile.bundles: - dsh-qqbot-bridge')
    manifest.dsh.profile.bundles.splice(bundleIndex, 1)
  }

  console.log(`profile: ${PROFILE}`)
  console.log('')
  if (changes.length === 0) {
    console.log('already rolled back; nothing to change')
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
  console.log('Then restart dsh. QQ is back on the stock plugin.')
  console.log(`The bridged fork (${join(dirname(ROOT), 'dsh-bridged-qqbot')}) and this project`)
  console.log('can be deleted; nothing else references them.')
}

main().catch(error => {
  console.error(`[rollback-profile] ${error?.message ?? error}`)
  process.exit(1)
})
