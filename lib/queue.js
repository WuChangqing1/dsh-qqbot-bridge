// Per-peer FIFO with a bounded depth.
//
// One QQ user must never have two messages in flight at once (the DS Bot turn
// would interleave), and a user who floods the bridge must not grow memory
// without bound. Different peers run concurrently.

/**
 * @param {object} options
 * @param {(item: any) => Promise<void>} options.run  performs one unit of work
 * @param {number} [options.max]      max queued items per peer
 * @param {(key: string, dropped: number) => void} [options.onOverflow]
 */
export function createQueue({ run, max = 4, onOverflow }) {
  /** @type {Map<string, {items:any[], running:boolean, dropped:number}>} */
  const lanes = new Map()

  const laneOf = key => {
    let lane = lanes.get(key)
    if (lane === undefined) lanes.set(key, (lane = { items: [], running: false, dropped: 0 }))
    return lane
  }

  const pump = async key => {
    const lane = laneOf(key)
    if (lane.running) return
    lane.running = true
    try {
      while (lane.items.length > 0) {
        const item = lane.items.shift()
        try {
          await run(item)
        } catch {
          // A failed unit must not stall the lane; the caller reports errors.
        }
      }
    } finally {
      lane.running = false
      if (lane.items.length === 0 && lane.dropped === 0) lanes.delete(key)
    }
  }

  return {
    /**
     * Enqueue one unit for `key`.
     * @returns {'accepted' | 'rejected'} rejected means the lane is full
     */
    push(key, item) {
      const lane = laneOf(String(key))
      if (lane.items.length >= max) {
        lane.dropped += 1
        onOverflow?.(String(key), lane.dropped)
        return 'rejected'
      }
      lane.items.push(item)
      void pump(String(key))
      return 'accepted'
    },
    /** Queued (not yet running) count for one peer. */
    depth(key) {
      return lanes.get(String(key))?.items.length ?? 0
    },
    get size() {
      let total = 0
      for (const lane of lanes.values()) total += lane.items.length
      return total
    },
    /** Resolve once every lane drained (tests, shutdown). */
    async drain() {
      while (true) {
        const busy = [...lanes.values()].some(lane => lane.running || lane.items.length > 0)
        if (!busy) return
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    },
  }
}
