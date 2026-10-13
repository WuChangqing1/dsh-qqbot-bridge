#!/usr/bin/env node
// Run every test file, one child process each.
//
// WHY NOT `node --test`: the Node test runner spawns a child per file with
// piped stdio, and on this machine the DSH sandbox denies a piped child
// (`spawn EPERM`). Spawning with `stdio: 'inherit'` needs no pipe, so this
// runner works both under the sandbox and in a normal shell.
//
// Fallback if even `spawn` is denied: run the files directly from the shell,
//   Get-ChildItem tests -Filter *.test.mjs | ForEach-Object { node $_.FullName }

import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const testsDir = resolve(here, '..', 'tests')

const files = (await readdir(testsDir))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()

if (files.length === 0) {
  console.error('no test files found in', testsDir)
  process.exit(1)
}

let failed = 0

for (const file of files) {
  const result = spawnSync(process.execPath, [join(testsDir, file)], { stdio: 'inherit' })
  if (result.error !== undefined) {
    console.error(`FAIL  ${file}: ${result.error.code ?? result.error.message}`)
    console.error('      a piped child is denied in this sandbox; run the file directly instead')
    failed += 1
    continue
  }
  if (result.status !== 0) failed += 1
}

console.log('')
console.log(`files: ${files.length}, failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
