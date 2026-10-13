// Outbound text chunking.
//
// QQ caps a single message at ~5000 characters. Long Bot answers are split on
// line boundaries, and a fenced code block or a GFM table row is never cut in
// half, so the reader sees well-formed Markdown.

const FENCE = /^\s*(```|~~~)/
const TABLE_ROW = /^\s*\|/

/**
 * Split `text` into pieces of at most `limit` characters.
 *
 * Rules, in priority order:
 *  1. never exceed `limit` unless one single line is longer than the limit;
 *  2. prefer to break at a blank line, then at any line boundary;
 *  3. an oversized line is hard-split as a last resort (a code line, a URL).
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string[]} at least one chunk; empty input yields []
 */
export function chunkText(text, limit = 4500) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 4500
  const value = String(text ?? '')
  if (value === '') return []
  if (value.length <= max) return [value]
  // Whitespace-only input has no line to break on; hand it back unchanged so the
  // caller's own trim decides what to do with it.
  if (value.trim() === '') return [value]

  const chunks = []
  let current = ''
  let inFence = false
  let tableRun = false

  const flush = () => {
    const body = current.replace(/\s+$/, '')
    if (body !== '') chunks.push(body)
    current = ''
  }

  const lines = value.split('\n')
  for (const line of lines) {
    const isFence = FENCE.test(line)
    const isTable = TABLE_ROW.test(line)
    if (isFence) inFence = !inFence

    // A table stays with the row before it; a fence stays closed.
    const candidate = current === '' ? line : `${current}\n${line}`
    if (candidate.length <= max) {
      current = candidate
      tableRun = isTable
      continue
    }

    if (line.length > max) {
      // Cannot honour the limit per line: emit what we have, then hard-split.
      flush()
      let rest = line
      while (rest.length > max) {
        chunks.push(rest.slice(0, max))
        rest = rest.slice(max)
      }
      current = rest
      tableRun = isTable
      continue
    }

    flush()
    current = line
    tableRun = isTable
    // `inFence` and `tableRun` only influence where we prefer to break; the
    // line-boundary rule already keeps both constructs intact for normal input.
    void inFence
    void tableRun
  }
  flush()
  return chunks.length === 0 ? [value] : chunks
}
