#!/usr/bin/env node
// `node --check` every source file in the project.
//
// Spawned with `stdio: 'inherit'`, like run-tests.mjs: a piped child is denied by
// some sandboxes (`spawn EPERM`), and this check must work in exactly the
// environments the tests run in.
//
// Usage: node scripts/check-syntax.mjs

import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')

const files = []
const walk = async dir => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full)
    else if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) files.push(full)
  }
}

for (const directory of ['lib', 'scripts', 'tests']) await walk(join(ROOT, directory))
files.sort()

let failed = 0
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.error !== undefined || result.status !== 0) {
    console.error(`FAIL  ${relative(ROOT, file)}`)
    failed += 1
  }
}

console.log('')
console.log(`checked: ${String(files.length)} files, failed: ${String(failed)}`)
process.exit(failed === 0 ? 0 : 1)
