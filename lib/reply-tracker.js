// Reply correlation: which QQ peer is waiting on which DS Bot session.
//
// A DS Bot answer is asynchronous and may involve tool calls, delegation to
// other Bots and long work, so the bridge cannot wait for it. Instead it
// registers a "pending turn" when it injects a message and matches the next
// `turn/end` on that session to that peer. FIFO per session, because a DS Bot
// session runs its turns in order.

/**
 * @param {object} options
 * @param {number} [options.timeoutMs] how long a pending turn stays claimable
 * @param {() => number} [options.now]
 */
export function createReplyTracker({ timeoutMs = 600_000, now = Date.now } = {}) {
  /** @type {Map<string, Array<object>>} sessionId -> pending turns (oldest first) */
  const bySession = new Map()
  /** @type {Map<string, object>} requestId -> pending turn (same object) */
  const byRequest = new Map()
  let abandoned = 0

  const expired = (entry, time) => time - entry.at > timeoutMs

  const forget = entry => {
    byRequest.delete(entry.requestId)
    const list = bySession.get(entry.sessionId)
    if (list === undefined) return
    const index = list.indexOf(entry)
    if (index >= 0) list.splice(index, 1)
    if (list.length === 0) bySession.delete(entry.sessionId)
  }

  return {
    /**
     * Register a pending turn.
     * @param {{requestId:string, sessionId:string, target:string, peerId?:string,
     *          scope?:string, replyTarget?:any, text?:string, at?:number, onGiveUp?:Function}} entry
     */
    add(entry) {
      const record = { ...entry, at: entry.at ?? now() }
      const list = bySession.get(record.sessionId)
      if (list === undefined) bySession.set(record.sessionId, [record])
      else list.push(record)
      byRequest.set(record.requestId, record)
      return record
    },
    /**
     * Claim the oldest live pending turn for a session (called on `turn/end`).
     * Expired entries are dropped and reported through `onGiveUp`.
     */
    claim(sessionId) {
      const key = String(sessionId ?? '')
      const list = bySession.get(key)
      if (list === undefined) return undefined
      const time = now()
      while (list.length > 0) {
        const entry = list.shift()
        byRequest.delete(entry.requestId)
        if (expired(entry, time)) {
          abandoned += 1
          try {
            entry.onGiveUp?.(entry, 'timeout')
          } catch {
            // reporting must never throw into the event loop
          }
          continue
        }
        if (list.length === 0) bySession.delete(key)
        return entry
      }
      bySession.delete(key)
      return undefined
    },
    /** Abandon one pending turn (delivery failed, or the user cancelled). */
    abandon(requestId, reason = 'abandoned') {
      const entry = byRequest.get(String(requestId ?? ''))
      if (entry === undefined) return false
      forget(entry)
      abandoned += 1
      try {
        entry.onGiveUp?.(entry, reason)
      } catch {
        // ignore
      }
      return true
    },
    /** Pending turns older than the window, handed to their `onGiveUp`. */
    sweep() {
      const time = now()
      for (const [sessionId, list] of [...bySession.entries()]) {
        for (const entry of [...list]) {
          if (!expired(entry, time)) continue
          forget(entry)
          abandoned += 1
          try {
            entry.onGiveUp?.(entry, 'timeout')
          } catch {
            // ignore
          }
        }
        if ((bySession.get(sessionId)?.length ?? 0) === 0) bySession.delete(sessionId)
      }
    },
    /** Pending turns for one session, oldest first (diagnostics/tests). */
    pending(sessionId) {
      return [...(bySession.get(String(sessionId ?? '')) ?? [])]
    },
    /** Peers currently waiting, for the status command. */
    get waiting() {
      let total = 0
      for (const list of bySession.values()) total += list.length
      return total
    },
    get abandonedCount() {
      return abandoned
    },
    clear() {
      bySession.clear()
      byRequest.clear()
    },
  }
}
