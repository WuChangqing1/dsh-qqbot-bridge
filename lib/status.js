// The bridge's on-disk activation record: `<dataDir>/bridge-status.json`.
//
// This is the second half of "activation must never be silent". The console
// channel (./host-log.js) shows a human what happened in the terminal; this
// file shows a tool -- or an operator after the fact -- the same facts as
// structured JSON, and it exists from the first moment `apply()` runs rather
// than only after the first QQ message.
//
// It is also what creates the data directory eagerly. Before this file, the
// bridge only called `mkdir` from `router.save()` / `rejectedLog.save()`, so a
// running bridge left no trace at all on disk until somebody sent a message,
// which made "the directory is missing" look like "the plugin never loaded".
//
// ── Nothing here may be a credential ───────────────────────────────────────
// `appSecret`, tokens and raw OpenIDs never appear. OpenIDs are reduced to a
// count; the refused-OpenID discovery list stays in `rejected-openids.json`,
// which only stores what a peer already sent to us.

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Schema version of the status document, so a reader can branch safely. */
export const STATUS_SCHEMA_VERSION = 1

/** The file name inside the bridge's data directory. */
export const STATUS_FILE_NAME = 'bridge-status.json'

/** Where the status document lives for a given data directory. */
export const statusFile = dataDir => join(dataDir, STATUS_FILE_NAME)

/**
 * @param {object} options
 * @param {string} options.dataDir      the bridge's data directory (created here)
 * @param {string} [options.file]       override for the status path (tests)
 * @param {string} [options.statePath]  the DS Bot state.json this bridge reads
 * @param {string} [options.version]    the bridge package version
 * @param {string[]} [options.allowOpenIds] the configured allowlist (counted only)
 * @param {object} [options.config]     the plugin config, for non-secret summary fields
 * @param {() => number} [options.now]  clock, injectable for tests
 */
export function createStatusWriter({
  dataDir,
  file = statusFile(dataDir),
  statePath = '',
  version = '0.0.0',
  allowOpenIds = [],
  config = {},
  now = Date.now,
} = {}) {
  const startedAt = now()
  let phase = 'loading'
  let detail = {}
  let lastError
  let writing = Promise.resolve()
  let lastBody

  const count = new Set(allowOpenIds.filter(id => typeof id === 'string' && id !== '')).size

  /** The document as it will be written. */
  const snapshot = () => ({
    schemaVersion: STATUS_SCHEMA_VERSION,
    plugin: 'dsh-qqbot-bridge',
    version,
    pid: process.pid,
    phase,
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(now()).toISOString(),
    dataDir,
    statePath,
    // Access summary. Counts only -- an OpenID is an identity, not a metric.
    allowOpenIdsCount: count,
    failClosed: count === 0,
    allowGroups: config.allowGroups === true,
    defaultBot: typeof config.defaultBot === 'string' ? config.defaultBot : '',
    ...detail,
  })

  /**
   * Record a phase and rewrite the status file.
   * Never rejects: a status file that cannot be written must not stop the
   * bridge, and the caller still sees the failure through `lastError`.
   *
   * @param {string} next            the new phase
   * @param {object} [extra]         extra fields merged into the document
   * @returns {Promise<object>} the snapshot that was (or would have been) written
   */
  const publish = (next, extra = {}) => {
    phase = next
    detail = { ...detail, ...extra }
    const body = snapshot()
    lastBody = body
    writing = writing
      .then(async () => {
        await mkdir(dataDir, { recursive: true })
        const temp = `${file}.${process.pid}.tmp`
        await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
        await rename(temp, file)
      })
      .catch(error => {
        lastError = error
      })
    return writing.then(() => body)
  }

  return {
    /** The status file path. */
    file,
    /** The data directory, created by the first publish. */
    dataDir,
    /** Current phase, for logging. */
    get phase() {
      return phase
    },
    /** The last error raised while writing the file, if any. */
    get lastError() {
      return lastError
    },
    /** The most recent document (also available before the write settles). */
    get body() {
      return lastBody
    },
    publish,
    /** Block until every queued write has settled. */
    flush() {
      return writing
    },
  }
}
