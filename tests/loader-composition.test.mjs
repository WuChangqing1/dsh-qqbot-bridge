// The layer that decides whether the bridge is loaded AT ALL.
//
// Every other test in this project mounts the plugin by hand on a Context it
// built itself. That is a real Cordis Context and it does catch the
// `ctx.set`-vs-`ctx.provide` class of bug -- but it still cannot answer the
// question that actually blocked this project:
//
//     "does the HOST's Loader compose a row for this bundle?"
//
// A row that never enters the composed tree is never imported, so `apply()`
// never runs and no amount of plugin-side code can say a word about it. These
// tests use DSH's OWN composition functions -- `loadProfile` and
// `composeEntries` from `@deepseek-ai/dsh-app-boot`, the same pair the CLI's
// `--dump-config` and the real boot use -- over the profile that is actually
// installed on this machine, so "bundle list -> bundle patch -> user patch ->
// effective row" is covered end to end.
//
// They skip (rather than fail) when the DSH checkout or the profile is absent,
// so the suite still runs on a machine that only has this project.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import {
  BRIDGE_ROOT, CHECKOUT, CLI_INSTALL_ANCHOR, DSH_HOME_DIR, WEB_PROFILE_DIR, loadAppBoot, profileSkip,
} from './cordis-harness.mjs'

const skip = profileSkip

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/** Compose the real installed profile once; every test below reads this. */
let composed
const composition = async () => {
  composed ??= (async () => {
    const { loadProfile, composeEntries } = await loadAppBoot()
    const profile = loadProfile('dsh', 'web', CLI_INSTALL_ANCHOR, DSH_HOME_DIR)
    const entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
    return { profile, entries, composeEntries }
  })()
  return composed
}

/** Compose an arbitrary layer stack with DSH's own composition function. */
const composeWith = async layers => (await composition()).composeEntries(layers)

test('the installed web profile lists dsh-qqbot-bridge as the last bundle', { skip }, () => {
  const manifest = readJson(join(WEB_PROFILE_DIR, 'package.json'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  assert.ok(bundles.length > 0, 'the profile must declare bundles')
  assert.equal(bundles.at(-1), 'dsh-qqbot-bridge', 'the bridge bundle must be part of the composed stack')
  // A bundle only counts when it is also installed: the profile's dependency map
  // is what the Loader resolves the bare package name through.
  assert.ok(
    manifest.dependencies?.['dsh-qqbot-bridge'] !== undefined,
    'the profile must depend on dsh-qqbot-bridge (see scripts/install-profile.mjs)',
  )
})

test('the bridge bundle declares a patch layer that exists on disk', { skip }, async () => {
  const { profile } = await composition()
  const layer = profile.layers.find(entry => entry.packageName === 'dsh-qqbot-bridge')
  assert.ok(layer !== undefined, 'the bundle must have loaded as a layer (check skippedBundles)')
  assert.deepEqual(profile.skippedBundles, [], `no bundle may be skipped: ${JSON.stringify(profile.skippedBundles)}`)

  const manifest = readJson(join(layer.packageDir, 'package.json'))
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  for (const patchPath of layer.patchPaths) {
    assert.ok(existsSync(patchPath), `declared patch must exist: ${patchPath}`)
  }
  // ...and the layer resolves back to THIS working tree, not a stale copy. The
  // profile installs the bundle with a `link:` dependency, so the directory the
  // resolver reports is the symlink under the profile; what matters is where it
  // points.
  const canonical = path => {
    try {
      return realpathSync.native(path).replace(/\\/g, '/').toLowerCase()
    } catch {
      return path.replace(/\\/g, '/').toLowerCase()
    }
  }
  assert.equal(
    canonical(layer.packageDir),
    canonical(BRIDGE_ROOT),
    'the profile must link to this project, so a rebuild is visible immediately',
  )
})

test('the composed tree contains the qqbot-bridge row with the bridge module', { skip }, async () => {
  const { entries } = await composition()
  const rows = entries.filter(entry => entry.id === 'qqbot-bridge')
  assert.equal(rows.length, 1, 'exactly one qqbot-bridge row may exist after composition')
  const [row] = rows
  // The BASE layer names the module; the profile patch is allowed to override
  // `config` only. A row that lost its `name` would import as `undefined`.
  assert.equal(row.name, 'dsh-qqbot-bridge')
  assert.notEqual(row.disabled, true, 'the row must not be disabled')
})

test('the profile patch overrides the row config without touching its identity', { skip }, async () => {
  const { profile, entries } = await composition()
  const [row] = entries.filter(entry => entry.id === 'qqbot-bridge')

  // What this operator's cordis.patch.yml actually says for this row.
  const userRow = profile.patches
    .flatMap(patch => (Array.isArray(patch) ? patch : [patch]))
    .find(entry => entry?.id === 'qqbot-bridge')
  assert.ok(userRow !== undefined, 'the profile patch must address the row by id')

  // A patch REPLACES a row's whole config rather than merging into it, so the
  // effective config is the profile's -- provided the bundle layer declared the
  // id. The identity still comes from the bundle.
  assert.deepEqual(row.config, userRow.config)
  assert.equal(row.name, 'dsh-qqbot-bridge', 'the profile patch must not be able to drop the module name')

  // The VALUES are this operator's private setup (their own OpenID lives here),
  // so they are deliberately not asserted. Only the shape that the fail-closed
  // contract depends on is: an allowlist is always an ARRAY, so an empty one can
  // mean "nobody" instead of becoming a wildcard or a string.
  assert.ok(Array.isArray(row.config.allowOpenIds), 'allowOpenIds must stay an array')
  assert.equal(typeof row.config.defaultBot, 'string')
})

test('a synthetic user layer really does replace the whole config (hermetic)', { skip }, async () => {
  const { profile } = await composition()
  const synthetic = [{
    id: 'qqbot-bridge',
    config: { allowOpenIds: ['synthetic-openid'], defaultBot: 'Synthetic', watchdogIntervalMs: 250 },
  }]
  const entries = await composeWith([...profile.layers.map(layer => layer.patches), profile.patches, synthetic])
  const [row] = entries.filter(entry => entry.id === 'qqbot-bridge')

  assert.deepEqual(row.config.allowOpenIds, ['synthetic-openid'])
  assert.equal(row.config.defaultBot, 'Synthetic')
  assert.equal(row.config.watchdogIntervalMs, 250)
  assert.equal(row.name, 'dsh-qqbot-bridge', 'a config override must not rename the row')
})

test('the composed row config actually validates against the plugin schema', { skip }, async () => {
  const { entries } = await composition()
  const [row] = entries.filter(entry => entry.id === 'qqbot-bridge')

  // The end of the chain the host walks: bundle patch -> user patch -> row
  // config -> the plugin's own `Config`. A schema the operator's patch cannot
  // satisfy would make the entry fail to activate, and no plugin-side code would
  // run to explain it.
  const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
  const resolved = plugin.Config(row.config)
  assert.ok(Array.isArray(resolved.allowOpenIds))
  assert.equal(typeof resolved.defaultBot, 'string')
  assert.ok(resolved.watchdogIntervalMs > 0)

  // The security default is asserted on an EMPTY config instead, so the check is
  // hermetic and does not depend on this machine's private setup.
  const defaults = plugin.Config({})
  assert.deepEqual(defaults.allowOpenIds, [], 'an omitted allowlist must stay empty, never become a wildcard')
  assert.equal(defaults.allowGroups, false)
  assert.equal(defaults.watchdogIntervalMs, 10_000, 'an omitted watchdog interval must take the default')
})

test('the composed tree mounts no Cordis console logger exporter (why the bridge logs itself)', { skip }, async () => {
  const { entries } = await composition()
  const console_ = entries.filter(entry => String(entry.name ?? '').includes('logger-console'))
  // This is the finding that made a healthy bridge look like a plugin that had
  // never loaded: `ctx.logger` buffers every message and prints nothing, because
  // the only exporter any DSH bundle mounts is the in-memory ring buffer.
  //
  // If this assertion ever fails, DSH started shipping a console exporter --
  // good news. Then relax it and revisit the console mirroring in lib/host-log.js
  // (it is harmless either way, just no longer load-bearing).
  assert.deepEqual(
    console_,
    [],
    'a console logger exporter appeared in the composed tree; lib/host-log.js can be simplified',
  )
  assert.ok(existsSync(join(CHECKOUT, 'vendor', 'logger-console')), 'the exporter package still exists in the checkout')
})
