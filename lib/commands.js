// QQ-side command parsing.
//
// Contract with the stock plugin is narrow ON PURPOSE. The bridge claims only:
//   * the exact Bot names in the live roster (管家 / 设计师 / 程序员 / 聊天搭子);
//   * a small, explicit alias table (聊天 -> 聊天搭子, coder, designer, ...);
//   * four command words: /团队 /当前 /帮助 plus those names.
// Everything else -- including unknown `/something` and the stock plugin's own
// /bot-ping, /bot-status, /new, /model, /preset, /compact, /stop -- is reported
// as `unknown` and handed back to the transport, so the stock behaviour is
// untouched and an unrecognised slash word is never executed and never becomes
// a Bot prompt.
//
// Deliberately NOT claimed: the bare English words `team` / `current` / `help`.
// They are plausible stock commands, and claiming them would risk a collision
// for no benefit.

const COMMAND_PREFIX = '/'

/**
 * Bridge-owned aliases, as an explicit table rather than fuzzy matching, so a
 * typo can never silently address the wrong Bot. Only unambiguous short forms.
 * @type {Readonly<Record<string, string>>}
 */
export const ALIASES = {
  聊天: '聊天搭子',
  chat: '聊天搭子',
  companion: '聊天搭子',
  coder: '程序员',
  code: '程序员',
  designer: '设计师',
  design: '设计师',
  butler: '管家',
  manager: '管家',
}

/** Command words the bridge owns (never Bot names). */
const OWNED_WORDS = new Set(['当前', '团队', '帮助'])

/**
 * Every stock command in @tencent-connect/dsh-qqbot v0.5.0 is ASCII
 * (new/reset/clear/compact/model/preset/stop/bot-ping/bot-version/bot-status/
 * bot-help). A slash word made only of CJK characters is therefore someone
 * trying to address a team member, not a stock command -- so `/法务` gets a
 * "no such Bot" reply instead of being forwarded.
 */
const CJK_ONLY = /^[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/u

const HELP =
  'QQ 指令：/团队 查看团队列表，/当前 查看当前 Bot，/管家 /设计师 /程序员 /聊天 切换目标 Bot。'

/** Normalise a command word: strip the prefix, lowercase. */
const word = token => token.replace(/^\/+/, '').toLowerCase()

/**
 * @param {object} options
 * @param {{name: string, aliases?: string[]}[]} options.bots the live Bot roster
 * @param {Record<string,string>} [options.aliases] extra alias -> Bot-name table
 */
export function createCommands({ bots = [], aliases = ALIASES } = {}) {
  /** alias (lowercased) -> Bot name */
  const lookup = new Map()
  const register = (alias, botName) => {
    const key = String(alias ?? '').trim().toLowerCase()
    // A Bot's own name always wins over a generic alias.
    if (key !== '' && !lookup.has(key)) lookup.set(key, botName)
  }
  const setBots = next => {
    lookup.clear()
    for (const entry of next ?? []) {
      const name = String(entry?.name ?? '').trim()
      if (name === '') continue
      register(name, name)
      for (const alias of entry?.aliases ?? []) register(alias, name)
    }
    // Generic aliases only fill gaps: a Bot literally named `chat` keeps its name.
    for (const [alias, botName] of Object.entries(aliases ?? {})) register(alias, botName)
  }
  setBots(bots)

  /**
   * Parse one QQ message.
   * @param {string} rawText
   * @returns {{kind:'talk', text:string} | {kind:'switch', bot:string, close:boolean, text?:string}
   *          | {kind:'current'} | {kind:'team'} | {kind:'help', text:string}
   *          | {kind:'bare-switch'} | {kind:'not-found', bot:string}
   *          | {kind:'unknown', command:string}}
   */
  const parse = rawText => {
    const text = String(rawText ?? '').trim()
    if (text === '' || !text.startsWith(COMMAND_PREFIX)) return { kind: 'talk', text }

    // A slash word is only the first whitespace-delimited token, so
    // `/程序员 你好` addresses the Bot and carries a message.
    const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text)
    const token = match?.[1] ?? text
    const rest = (match?.[2] ?? '').trim()
    const name = word(token)
    if (name === '') return { kind: 'bare-switch' }
    if (OWNED_WORDS.has(name)) {
      if (name === '当前') return { kind: 'current' }
      if (name === '团队') return { kind: 'team' }
      return { kind: 'help', text: HELP }
    }
    const target = lookup.get(name)
    if (target !== undefined) {
      if (rest === '') return { kind: 'switch', bot: target, close: false }
      // `/程序员 帮我看看这段代码` switches for the future AND runs this message.
      return { kind: 'switch', bot: target, close: true, text: rest }
    }
    if (CJK_ONLY.test(name)) return { kind: 'not-found', bot: name }
    return { kind: 'unknown', command: token }
  }

  return {
    parse,
    /** Re-register the roster after a Bot is created, renamed or deleted. */
    setBots,
    /** The command words this parser owns; the rest belongs to the stock plugin. */
    get commands() {
      return [...new Set([...lookup.keys(), ...OWNED_WORDS])].sort()
    },
    help: HELP,
  }
}

/** Render the live team for `/团队`. */
export function renderTeam({ bots = [], current, mainBot } = {}) {
  if (bots.length === 0) return '团队里还没有 Bot。'
  const lines = bots.map(entry => {
    const marks = []
    if (entry.name === current) marks.push('当前')
    if (entry.name === mainBot) marks.push('主 Bot')
    const suffix = marks.length > 0 ? `（${marks.join('、')}）` : ''
    return `· ${entry.name} — ${entry.role ?? '未设置角色'}${suffix}`
  })
  return [`团队共 ${bots.length} 个 Bot：`, ...lines].join('\n')
}

/** Render `/当前`. */
export function renderCurrent({ current, bots = [] } = {}) {
  const entry = bots.find(bot => bot.name === current)
  if (entry === undefined) return `当前目标 Bot：${current ?? '(未设置)'}`
  return `当前目标 Bot：${entry.name}（${entry.role ?? '未设置角色'}）`
}

/** The confirmation the spec asks for after a switch. */
export function renderSwitch(name) {
  return `已切换至${name}。接下来可以直接发送代码或问题。`
}
