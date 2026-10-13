// Inbound de-duplication.
//
// QQ can redeliver the same event (network retry, gateway reconnect). A repeat
// must not cost a second LLM turn, so message ids are remembered in a bounded
// LRU with a time window.

/**
 * @param {object} options
 * @param {number} [options.windowMs] how long an id counts as seen
 * @param {number} [options.max]      hard cap on remembered ids
 * @param {() => number} [options.now] injectable clock (tests)
 */
export function createDedupe({ windowMs = 300_000, max = 2000, now = Date.now } = {}) {
  /** @type {Map<string, number>} id -> first-seen timestamp (insertion ordered) */
  const seen = new Map()

  const prune = time => {
    for (const [id, at] of seen) {
      if (time - at <= windowMs) break // insertion order == time order
      seen.delete(id)
    }
    while (seen.size > max) {
      const oldest = seen.keys().next()
      if (oldest.done === true) break
      seen.delete(oldest.value)
    }
  }

  return {
    /** True when this id was already handled inside the window. */
    isDuplicate(id) {
      const key = String(id ?? '')
      if (key === '') return false
      const time = now()
      prune(time)
      return seen.has(key)
    },
    /** Record an id as handled. Call only after the decision to accept it. */
    remember(id) {
      const key = String(id ?? '')
      if (key === '') return
      const time = now()
      seen.delete(key)
      seen.set(key, time)
      prune(time)
    },
    get size() {
      return seen.size
    },
  }
}
