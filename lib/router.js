// Per-OpenID routing choice: which Bot the user is currently talking to.
//
// Keyed by QQ OpenID, persisted as JSON, and re-read on restart. The value is a
// Bot *name* rather than a session id, because a Bot's session id changes every
// time its chat moves on to a new part (`state.json: bots[id].sessionId`).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * @param {object} options
 * @param {string} options.file      JSON file to persist into
 * @param {() => string} options.fallback  name used when a peer has no choice
 */
export function createRouter({ file, fallback }) {
  /** @type {Map<string, string>} openId -> bot name */
  const choices = new Map()
  let loaded = null
  let writing = Promise.resolve()

  const load = () => {
    loaded ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(file, 'utf8'))
        for (const [openId, name] of Object.entries(parsed?.peers ?? {})) {
          if (typeof name === 'string' && name !== '') choices.set(openId, name)
        }
      } catch {
        // Missing or corrupt file: start with no choices. Never fatal.
      }
    })()
    return loaded
  }

  const save = () => {
    const snapshot = JSON.stringify(
      { version: 1, peers: Object.fromEntries([...choices.entries()].sort(([a], [b]) => a.localeCompare(b))) },
      null,
      2,
    )
    writing = writing
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        const temp = `${file}.${process.pid}.tmp`
        await writeFile(temp, snapshot, 'utf8')
        await rename(temp, file)
      })
      .catch(() => {})
    return writing
  }

  return {
    load,
    /** The Bot name this OpenID should talk to. */
    current(openId) {
      const key = String(openId ?? '')
      return choices.get(key) ?? fallback()
    },
    /** Remember a switch. Returns the name that is now current. */
    async select(openId, name) {
      const key = String(openId ?? '')
      if (key !== '') {
        choices.set(key, String(name))
        await save()
      }
      return String(name)
    },
    /** Called when a Bot is renamed or deleted. */
    async drop(name) {
      let changed = false
      for (const [openId, value] of choices) {
        if (value === name) {
          choices.delete(openId)
          changed = true
        }
      }
      if (changed) await save()
    },
    get size() {
      return choices.size
    },
    /** For diagnostics: how many peers are pinned to each Bot. */
    snapshot() {
      const counts = {}
      for (const name of choices.values()) counts[name] = (counts[name] ?? 0) + 1
      return counts
    },
    /** Block until pending writes settle (tests, shutdown). */
    flush() {
      return writing
    },
  }
}

/** Where the routing file lives by default: `<dataDir>/routing.json`. */
export const routingFile = dataDir => join(dataDir, 'routing.json')
