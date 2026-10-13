// Track promises started off the critical path.
//
// The inbound QQ path must return synchronously (the QQ middleware chain is
// synchronous), so every real piece of work -- a `/团队` reply, a Bot turn
// relay, a refusal notice -- is started with `void task()`. That is correct for
// production, but it makes the work unobservable: a test cannot know when it
// finished, and shutdown cannot know what is still in flight.
//
// This tracker makes those promises awaitable without changing the calling
// convention.

/**
 * @param {object} [options]
 * @param {(error: unknown) => void} [options.onError]
 */
export function createPending({ onError } = {}) {
  /** @type {Set<Promise<unknown>>} */
  const inFlight = new Set()

  /**
   * Track a promise. Never throws; a rejection is reported to `onError` and
   * swallowed so one failed background task cannot take down the process.
   * @returns {Promise<void>} resolves when the task settles
   */
  const track = promise => {
    const wrapped = Promise.resolve(promise)
      .catch(error => {
        try {
          onError?.(error)
        } catch {
          // reporting must not throw
        }
      })
      .finally(() => {
        inFlight.delete(wrapped)
      })
    inFlight.add(wrapped)
    return wrapped
  }

  return {
    /** Start a task off the critical path and track it. */
    run(fn) {
      let result
      try {
        result = fn()
      } catch (error) {
        onError?.(error)
        return Promise.resolve()
      }
      return track(result)
    },
    /** Await everything currently in flight, including tasks it starts. */
    async drain() {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight])
      }
    },
    get size() {
      return inFlight.size
    },
  }
}
