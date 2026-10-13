#!/usr/bin/env node
// Verify that the runtime resolver the DSH host installs can actually serve the
// bare imports this bridge relies on.
//
// WHY THIS EXISTS
// The bridge imports `@deepseek-ai/schemastery` for its Config schema, and that
// package is NOT in the web profile's node_modules. The host makes it work by
// installing an in-memory resolver that routes bare specifiers to the dsh
// INSTALLATION's package table (see packages/boot/app-boot/src/profile.ts
// `collectInstallationScopePackages` and profile-resolution/resolver.ts).
//
// Restarting the host is the only true end-to-end test, and restarting is the
// user's decision. This script replicates the host's own selection rule so the
// load risk can be checked before a restart:
//
//   1. BFS the installation's dependency + peerDependency closure, following
//      each edge with Node's own resolver from the declaring package, exactly
//      like the host does;
//   2. assert every bare specifier the bridge/fork import at runtime is in that
//      closure, i.e. will be intercepted and routed to the installation copy;
//   3. assert the profile-level packages (the bridge, the fork) resolve from
//      the profile directory the way the loader needs them to.
//
// Usage: node scripts/verify-host-resolution.mjs [--install <package.json>] [--profile <dir>]

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const valueOf = flag => {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** The installed dsh CLI, i.e. the anchor every bare specifier resolves from. */
const DEFAULT_CHECKOUT = 'D:/CodingData/Github/deepseek-harness'
const INSTALL_ANCHOR = resolve(
  valueOf('--install')
  ?? process.env.DSH_INSTALL_ANCHOR
  ?? join(process.env.DSH_CHECKOUT ?? DEFAULT_CHECKOUT, 'apps', 'cli', 'package.json'),
)
const PROFILE_DIR = resolve(
  valueOf('--profile')
  ?? process.env.DSH_QQBOT_PROFILE
  ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web'),
)

const failures = []
const note = message => console.log(`  ${message}`)
const ok = message => console.log(`  ok    ${message}`)
const fail = message => {
  failures.push(message)
  console.log(`  FAIL  ${message}`)
}

/** Node's own resolution from a declaring anchor, the way the host does it. */
const packageDirFromAnchor = (anchor, name) => {
  try {
    for (const searchPath of createRequire(anchor).resolve.paths(name) ?? []) {
      const candidate = join(searchPath, name)
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    }
  } catch {
    // fall through
  }
  return undefined
}

const readManifest = path => JSON.parse(readFileSync(path, 'utf8'))

/** Replicates collectInstallationScopePackages (BFS, deps + peers). */
const installationScope = () => {
  const canonicalAnchor = join(realpathSync(dirname(INSTALL_ANCHOR)), 'package.json')
  const app = readManifest(canonicalAnchor)
  const links = new Map()
  if (typeof app.name === 'string') links.set(app.name, realpathSync(dirname(INSTALL_ANCHOR)))
  const queue = [{ anchor: canonicalAnchor, manifest: app }]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const declared = [...Object.keys(next.manifest.dependencies ?? {}), ...Object.keys(next.manifest.peerDependencies ?? {})]
    for (const dep of declared) {
      if (links.has(dep)) continue
      const dir = packageDirFromAnchor(next.anchor, dep)
      if (dir === undefined) continue
      let manifest
      try {
        manifest = readManifest(join(dir, 'package.json'))
      } catch {
        continue
      }
      links.set(dep, dir)
      queue.push({ anchor: join(dir, 'package.json'), manifest })
    }
  }
  return links
}

console.log('Host resolution check')
console.log('')
console.log(`installation anchor: ${INSTALL_ANCHOR}`)
console.log(`profile:             ${PROFILE_DIR}`)
console.log('')

// ── 1. what the bridge and the fork import at runtime ──────────────────────
const runtimeImports = [
  // lib/index.js
  '@deepseek-ai/schemastery',
  // lib/*.js standard library only -- nothing else to check
]

const forkImports = [
  '@tencent-connect/qqbot-nodejs',
  '@tencent-connect/qqbot-connector',
  'js-yaml',
]

console.log('1. installation-scope package table (what the host can route to)')
const scope = installationScope()
note(`entries: ${scope.size}`)
const scopeSources = new Map()
for (const name of runtimeImports) {
  const dir = scope.get(name)
  if (dir === undefined) {
    fail(`${name} is NOT in the installation scope; the bridge Config import would fail to load`)
    continue
  }
  scopeSources.set(name, dir)
  const owned = dir.startsWith(dirname(INSTALL_ANCHOR).toLowerCase()) || dir.toLowerCase().includes('deepseek-harness')
  ok(`${name} -> ${dir}${owned ? '  (the live tree, not a package cache)' : '  (WARNING: outside the live tree)'}`)
  if (!owned) fail(`${name} resolves outside the running installation; a restart could load a different copy`)
}
console.log('')

console.log('2. was each bridge import already resolvable from the profile itself?')
for (const name of runtimeImports) {
  // A hit here means Node's OWN walk could already serve the import, which is
  // the safe case: no interception is needed at all. A miss is also fine -- the
  // host resolver is what covers it -- but the two are worth telling apart.
  const local = packageDirFromAnchor(join(PROFILE_DIR, 'package.json'), name)
  const scoped = scopeSources.get(name)
  if (local === undefined) {
    note(`${name}: not natively resolvable from the profile; served by the host resolver from ${scoped ?? '(unknown)'}`)
  } else if (scoped !== undefined && realpathSync(local) === realpathSync(scoped)) {
    ok(`${name}: resolves natively to the same copy the host would route to (${local})`)
  } else {
    fail(`${name}: natively resolves to ${local} but the host would route to ${scoped ?? '(unknown)'}; a duplicate instance is possible`)
  }
}
console.log('')

console.log('3. the forked QQ plugin\'s own dependencies (must resolve from its own tree)')
const forkDir = existsSync(join(PROFILE_DIR, 'node_modules', '@tencent-connect', 'dsh-qqbot'))
  ? realpathSync(join(PROFILE_DIR, 'node_modules', '@tencent-connect', 'dsh-qqbot'))
  : undefined
if (forkDir === undefined) {
  fail('the forked @tencent-connect/dsh-qqbot is not linked into the profile')
} else {
  note(`link target: ${forkDir}`)
  for (const name of forkImports) {
    const dir = packageDirFromAnchor(join(forkDir, 'package.json'), name)
    if (dir !== undefined) ok(`${name} -> ${dir}`)
    else fail(`${name} does not resolve from the fork; the QQ gateway would fail to start`)
  }
}
console.log('')

console.log('4. the profile-level plugins the loader must find')
for (const name of ['dsh-qqbot-bridge', 'ds-bot', 'dsh-bot-skin', 'dsh-cost-meter', '@tencent-connect/dsh-qqbot']) {
  const dir = packageDirFromAnchor(join(PROFILE_DIR, 'package.json'), name)
  if (dir !== undefined) ok(`${name} -> ${dir}`)
  else fail(`${name} does not resolve from the profile`)
}
console.log('')

console.log('5. the bridge entry must not need anything else at load time')
const entry = fileURLToPath(new URL('../lib/index.js', import.meta.url))
const source = existsSync(entry) ? readFileSync(entry, 'utf8') : ''
const bare = [...source.matchAll(/from\s+'([^'.][^']*)'/g)].map(match => match[1])
note(`bare imports in lib/index.js: ${bare.length === 0 ? '(none)' : bare.join(', ')}`)
for (const name of bare) {
  const isBuiltin = name.startsWith('node:')
  if (isBuiltin) continue
  if (scope.has(name)) ok(`${name} is installation-scoped`)
  else fail(`${name} is neither builtin nor installation-scoped`)
}
console.log('')

if (failures.length > 0) {
  console.error(`RESULT: ${failures.length} problem(s) -- the bridge would not load cleanly`)
  for (const message of failures) console.error(`  - ${message}`)
  process.exit(1)
}
console.log('RESULT: all runtime imports are resolvable; the host resolver covers the bridge Config import')
