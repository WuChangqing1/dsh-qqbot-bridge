// Console-visible lifecycle logging for the bridge.
//
// ── Why this module exists ─────────────────────────────────────────────────
// A DSH host mounts NO console exporter for the Cordis logger. `ctx.logger`
// has exactly one built-in sink -- an in-memory ring buffer:
//
//   vendor/cordis/src/logger.ts, LoggerService constructor:
//     self.exporter({ colors: 3, export: message => { buffer.push(message) } })
//
// Anything that reaches a terminal must come from
// `@deepseek-ai/cordis-plugin-logger-console`, whose ConsoleExporter calls
// `ctx.logger.exporter(this)`. Neither `@deepseek-ai/dsh-base` nor any other
// row in the web profile mounts it, and `@deepseek-ai/dsh` does not depend on
// it -- so in `dsh web` a message sent only through `ctx.logger` goes into that
// buffer and is never printed. DSH's own end-to-end fixtures confirm the
// contract: the HMR observer has to attach an exporter AND hand-drain
// `ctx.logger.buffer` to see plugin output
// (apps/cli/tests/profiles/web/tests/web-failure-matrix.expected.e2e.ts).
//
// That is precisely how this plugin managed to activate successfully while
// looking like it had never loaded: every diagnostic it emitted was swallowed
// by an invisible buffer.
//
// So the lifecycle facts an operator must see (entered / waiting / started /
// failed / stopped) are written here, straight to the console, and the same
// text still goes to `ctx.logger` for hosts that DO mount an exporter. Both
// channels pass through the credential scrubber in ./log.js, so neither can
// print an AppSecret, a token or a raw OpenID.

import { format, scrub } from './log.js'

/** Every line this module writes starts with this, so it is greppable. */
export const PREFIX = '[qqbot-bridge]'

const sinks = {
  info: args => console.log(`${PREFIX} ${scrub(format(args))}`),
  warn: args => console.warn(`${PREFIX} ${scrub(format(args))}`),
  error: args => console.error(`${PREFIX} ${scrub(format(args))}`),
}

/**
 * The always-visible channel.
 *
 * `console.log` for info matches the convention the forked QQ plugin already
 * uses (`[im-qqbot] Bot ready!`), so both halves of the bridge read the same
 * way in one terminal.
 */
export function createHostLog() {
  return {
    info: (...args) => sinks.info(args),
    warn: (...args) => sinks.warn(args),
    error: (...args) => sinks.error(args),
  }
}

/** Render an error for a log line without ever dumping a whole object graph. */
export function describeError(error) {
  if (error === null || error === undefined) return 'unknown error'
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
