// OpenID discovery for first-time setup -- WITHOUT weakening the allowlist.
//
// A refused OpenID is still refused: this module only records the attempt so
// the operator can read back the exact id and paste it into `allowOpenIds`.
// Nothing here can grant access, and the bridge never adds itself to the
// allowlist. The file holds a bounded, most-recent-first list of rejected
// OpenIDs with timestamps, and it is written with owner-only permissions.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const MAX_ENTRIES = 20
/** A queue of writes so two rejections cannot interleave. */
let writing = Promise.resolve()

/**
 * @param {object} options
 * @param {string} options.file       where the candidate list lives
 * @param {() => number} [options.now]
 */
export function createRejectedLog({ file, now = Date.now }) {
  /** @type {Map<string, {openId: string, at: number, count: number, short: string, reason?: string}>} */
  const entries = new Map()
  let loaded = null

  const load = () => {
    loaded ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        for (const entry of parsed?.rejected ?? []) {
          if (typeof entry?.openId === 'string' && entry.openId !== '') {
            entries.set(entry.openId, {
              openId: entry.openId,
              at: Number(entry.at ?? 0),
              count: Number(entry.count ?? 1),
              short: String(entry.short ?? ''),
              reason: entry.reason === undefined ? undefined : String(entry.reason),
            })
          }
        }
      } catch {
        // Missing or corrupt: start empty. Never fatal.
      }
    })()
    return loaded
  }

  const save = () => {
    const list = [...entries.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES)
    const snapshot = JSON.stringify({ version: 1, rejected: list }, null, 2)
    writing = writing
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.${process.pid}.tmp`
        // mode 0o600: this is an identity list, not a public artefact.
        await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
        await rename(temp, file)
      })
      .catch(() => {})
    return writing
  }

  return {
    load,
    /**
     * Record one refused attempt.
     * @param {string} openId full OpenID
     * @param {string} shortId shortened form, for the log line
     * @param {string} reason why it was refused
     */
    record(openId, shortId, reason) {
      const key = String(openId ?? '')
      if (key === '') return
      const at = now()
      const existing = entries.get(key)
      if (existing === undefined) {
        entries.set(key, { openId: key, at, count: 1, short: String(shortId), reason: String(reason ?? '') })
      } else {
        existing.at = at
        existing.count += 1
        existing.reason = String(reason ?? '')
      }
      // Bound the in-memory map too, not just the file.
      if (entries.size > MAX_ENTRIES * 4) {
        const sorted = [...entries.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES * 2)
        entries.clear()
        for (const entry of sorted) entries.set(entry.openId, entry)
      }
      void save()
    },
    /** Everything seen so far, newest first. */
    async list() {
      await load()
      return [...entries.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ENTRIES)
    },
    get path() {
      return file
    },
    /** Settle pending writes (tests). */
    flush() {
      return writing
    },
  }
}

/** Default location of the candidate list. */
export const rejectedFile = dataDir => join(dataDir, 'rejected-openids.json')
