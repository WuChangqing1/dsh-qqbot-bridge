// Logging that cannot leak credentials.
//
// QQ AppSecret, tokens and OpenIDs are the three things that must never reach a
// log file in the clear. Every message this module emits goes through `scrub`
// first, and OpenIDs are rendered shortened unless debug is on.

const SECRET_KEYS = /(secret|token|appsecret|apikey|api_key|password|passwd|credential|authorization|signature)/i
/** Something that looks like a bearer token or a long high-entropy blob. */
const SECRET_SHAPE = /\b[A-Za-z0-9_-]{24,}\b/g

const mask = value => {
  const text = String(value ?? '')
  if (text === '') return ''
  if (text.length <= 6) return '*'.repeat(text.length)
  return `${text.slice(0, 3)}...(${text.length})`
}

/** Shorten an OpenID so a log line stays useful without being an identity dump. */
export function shortId(value) {
  const text = String(value ?? '')
  if (text === '') return '(none)'
  if (text.length <= 8) return `${text.slice(0, 2)}...`
  return `${text.slice(0, 4)}...${text.slice(-2)}`
}

/**
 * Replace credential-looking substrings in a log line.
 * Applied to the composed message, so it also catches secrets that were interpolated.
 */
export function scrub(text) {
  return String(text ?? '').replace(SECRET_SHAPE, match => (match.length >= 24 ? mask(match) : match))
}

/** Longest string value we will ever print from a nested object. */
const MAX_VALUE = 200

/**
 * Render one log argument. Plain strings pass through (then get scrubbed);
 * objects are summarised by key, with credential-looking keys masked.
 */
export function render(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (Array.isArray(value)) return `[${value.length} items]`
  if (typeof value === 'object') {
    const parts = []
    for (const [key, inner] of Object.entries(value)) {
      if (SECRET_KEYS.test(key)) {
        const empty = inner === undefined || inner === null || inner === ''
        parts.push(`${key}=${empty ? '(empty)' : mask(inner)}`)
      } else if (inner !== null && typeof inner === 'object') {
        parts.push(`${key}=<${Array.isArray(inner) ? 'array' : 'object'}>`)
      } else {
        parts.push(`${key}=${String(inner).slice(0, MAX_VALUE)}`)
      }
    }
    return `{${parts.join(', ')}}`
  }
  return String(value)
}

/** printf-lite: replaces `%s` placeholders in order, appends leftover args. */
export function format(args) {
  const [first, ...rest] = args
  if (typeof first !== 'string' || !first.includes('%s')) return args.map(render).join(' ')
  let index = 0
  const body = first.replace(/%s/g, () => {
    if (index >= rest.length) return '%s'
    const value = rest[index]
    index += 1
    return render(value)
  })
  const tail = rest.slice(index).map(render).join(' ')
  return tail === '' ? body : `${body} ${tail}`
}

/**
 * Build the logger the bridge uses.
 * @param {object|Function} base ctx.logger (callable) or a console-like object
 * @param {string} name logger scope
 * @param {boolean} debug whether debug lines are emitted
 */
export function createLogger(base, name, debug = false) {
  let target = base
  if (typeof base === 'function') {
    try {
      target = base(name)
    } catch {
      target = globalThis.console
    }
  }
  target ??= globalThis.console
  const emit = (level, args) => {
    const line = scrub(format(args))
    const fn = target[level]
    if (typeof fn === 'function') {
      try {
        fn.call(target, line)
        return
      } catch {
        // fall through to console
      }
    }
    const fallback = level === 'debug' ? 'log' : level
    const con = globalThis.console
    if (typeof con[fallback] === 'function') con[fallback](line)
  }
  return {
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    debug: (...args) => {
      if (debug) emit('debug', args)
    },
  }
}
