import { test } from 'node:test'
import assert from 'node:assert/strict'

import { chunkText } from '../lib/chunk.js'

test('short text passes through untouched', () => {
  assert.deepEqual(chunkText('hello', 100), ['hello'])
})

test('empty input yields no chunks, whitespace-only survives untouched', () => {
  assert.deepEqual(chunkText('', 100), [])
  assert.deepEqual(chunkText('   ', 2), ['   '])
})

test('nothing exceeds the limit unless a single line does', () => {
  const line = 'x'.repeat(50)
  const text = Array.from({ length: 20 }, () => line).join('\n')
  const chunks = chunkText(text, 120)
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 120, `chunk of ${chunk.length} exceeds 120`)
  assert.equal(chunks.join('\n').replace(/\n+/g, '\n'), text.replace(/\n+/g, '\n'))
})

test('an over-long single line is hard-split rather than dropped', () => {
  const text = 'y'.repeat(1000)
  const chunks = chunkText(text, 100)
  assert.equal(chunks.length, 10)
  assert.equal(chunks.join('').length, 1000)
  for (const chunk of chunks) assert.equal(chunk.length, 100)
})

test('a fenced code block is not cut mid-line', () => {
  const body = ['```js', 'const a = 1', 'const b = 2', '```'].join('\n')
  const filler = 'z'.repeat(40)
  const chunks = chunkText(`${filler}\n${body}`, 60)
  const joined = chunks.join('\n')
  assert.ok(joined.includes('```js'))
  assert.ok(joined.includes('const a = 1'))
  assert.ok(joined.includes('```'))
})

test('a table row is kept whole', () => {
  const row = '| a | b | c |'
  const text = [row, row, row, row].join('\n')
  const chunks = chunkText(text, 20)
  for (const chunk of chunks) {
    for (const line of chunk.split('\n')) {
      if (line.includes('|')) assert.ok(line === row || line === '', `split row: ${line}`)
    }
  }
})

test('a limit of zero falls back to the default instead of looping forever', () => {
  const chunks = chunkText('a'.repeat(5000), 0)
  assert.equal(chunks.length, 2)
})
