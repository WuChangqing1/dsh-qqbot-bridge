// Bot registry: the read-only view of the DS Bot team.
//
// Two facts make this module necessary:
//   * a Bot's `id` is the session id of its FIRST part and never changes;
//   * the session a Bot speaks in right now is `bots[id].sessionId`, which is
//     replaced every time a long chat moves on to a fresh part.
// So the send path must re-read the current part at send time, never cache it
// for the lifetime of the process.

import { readFile, stat } from 'node:fs/promises'

/**
 * @typedef {object} BotEntry
 * @property {string} id          stable Bot id (== first part session id)
 * @property {string} name
 * @property {string} [role]
 * @property {string} [model]
 * @property {string} sessionId   the part to send into right now
 * @property {string[]} segments  archived part session ids
 */

/**
 * @param {object} options
 * @param {string} options.statePath  DS Bot `state.json`
 * @param {() => number} [options.now]
 */
export function createRegistry({ statePath, now = Date.now }) {
  /** @type {{revision:number, mainBotIds:string[], bots:BotEntry[], byName:Map<string,BotEntry>, byId:Map<string,BotEntry>}} */
  let snapshot = { revision: -1, mainBotIds: [], bots: [], byName: new Map(), byId: new Map() }
  let stamp = ''
  let reading = null
  /** Called after a successful re-read that changed the roster. */
  const listeners = new Set()

  const parse = parsed => {
    const raw = parsed?.bots ?? {}
    const bots = []
    for (const entry of Object.values(raw)) {
      if (entry === null || typeof entry !== 'object') continue
      const id = String(entry.id ?? '').trim()
      const name = String(entry.name ?? '').trim()
      if (id === '' || name === '') continue
      const segments = Array.isArray(entry.segments)
        ? entry.segments.map(segment => String(segment?.sessionId ?? '')).filter(Boolean)
        : []
      bots.push({
        id,
        name,
        role: entry.role === undefined ? undefined : String(entry.role),
        model: entry.model === undefined ? undefined : String(entry.model),
        // A Bot with no explicit part yet speaks in its own id.
        sessionId: String(entry.sessionId ?? id),
        segments,
      })
    }
    const byName = new Map()
    const byId = new Map()
    for (const bot of bots) {
      byId.set(bot.id, bot)
      if (!byName.has(bot.name)) byName.set(bot.name, bot)
    }
    const mainBotIds = Array.isArray(parsed?.mainBotIds) ? parsed.mainBotIds.map(String) : []
    return { revision: Number(parsed?.revision ?? 0), mainBotIds, bots, byName, byId }
  }

  const changed = (a, b) =>
    a.revision !== b.revision ||
    a.bots.length !== b.bots.length ||
    a.bots.some((bot, index) => {
      const other = b.bots[index]
      return other === undefined || bot.id !== other.id || bot.name !== other.name || bot.sessionId !== other.sessionId
    })

  /**
   * Re-read the team when the file changed.
   * @param {boolean} force ignore the mtime/size stamp
   */
  const refresh = async (force = false) => {
    if (reading !== null) return reading
    reading = (async () => {
      try {
        const info = await stat(statePath)
        const next = `${info.mtimeMs}:${info.size}`
        if (!force && next === stamp) return snapshot
        const parsed = JSON.parse(await readFile(statePath, 'utf8'))
        stamp = next
        const candidate = parse(parsed)
        const dirty = changed(candidate, snapshot)
        snapshot = candidate
        if (dirty) for (const listener of listeners) listener(snapshot)
        return snapshot
      } catch {
        // A missing or mid-write state.json must not break the bridge: the
        // previous snapshot stays valid, and the next call retries.
        return snapshot
      } finally {
        reading = null
      }
    })()
    return reading
  }

  return {
    refresh,
    /** Current snapshot without touching the disk. */
    get view() {
      return snapshot
    },
    /** All Bots, in state.json order. */
    get bots() {
      return snapshot.bots
    },
    /** The Bot shown as the team's default (first Main Bot, else first Bot). */
    mainBot() {
      const first = snapshot.mainBotIds[0]
      if (first !== undefined) {
        const found = snapshot.byId.get(first)
        if (found !== undefined) return found
      }
      return snapshot.bots[0]
    },
    /** Resolve by exact name, then by case-insensitive name, then by id. */
    find(ref) {
      const key = String(ref ?? '').trim()
      if (key === '') return undefined
      return (
        snapshot.byName.get(key) ??
        snapshot.byId.get(key) ??
        snapshot.bots.find(bot => bot.name.toLowerCase() === key.toLowerCase())
      )
    },
    /** The session id to send into *now*. Re-read before every send. */
    async sessionIdOf(ref) {
      await refresh()
      return this.find(ref)?.sessionId
    },
    /** Re-read and report which Bot now owns `sessionId` (current or archived part). */
    async ownerOf(sessionId) {
      await refresh()
      const key = String(sessionId ?? '')
      const direct = snapshot.bots.find(bot => bot.sessionId === key || bot.id === key)
      if (direct !== undefined) return direct
      return snapshot.bots.find(bot => bot.segments.includes(key))
    },
    /** Roster shape the command parser wants. */
    commandEntries() {
      return snapshot.bots.map(bot => ({ name: bot.name, aliases: [], bot: bot.id }))
    },
    onRosterChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get statePath() {
      return statePath
    },
    get lastReadAt() {
      return stamp === '' ? undefined : now()
    },
  }
}
