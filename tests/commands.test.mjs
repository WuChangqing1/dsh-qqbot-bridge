import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCommands, renderCurrent, renderSwitch, renderTeam } from '../lib/commands.js'

const bots = [
  { name: '管家', role: '总管家' },
  { name: '设计师', role: '设计师' },
  { name: '程序员', role: '程序员' },
  { name: '聊天搭子', role: '聊天搭子' },
]
const commands = createCommands({ bots })

test('a plain message is talk', () => {
  assert.deepEqual(commands.parse('帮我看下这段代码'), { kind: 'talk', text: '帮我看下这段代码' })
})

test('the four spec commands resolve to the real Bots', () => {
  assert.equal(commands.parse('/管家').kind, 'switch')
  assert.equal(commands.parse('/管家').bot, '管家')
  assert.equal(commands.parse('/设计师').bot, '设计师')
  assert.equal(commands.parse('/程序员').bot, '程序员')
  assert.equal(commands.parse('/聊天').bot, '聊天搭子')
})

test('/当前 and /团队 are their own commands', () => {
  assert.equal(commands.parse('/当前').kind, 'current')
  assert.equal(commands.parse('/团队').kind, 'team')
})

test('a command with trailing text switches AND carries the message', () => {
  const parsed = commands.parse('/程序员 帮我看看这段代码')
  assert.equal(parsed.kind, 'switch')
  assert.equal(parsed.bot, '程序员')
  assert.equal(parsed.close, true)
  assert.equal(parsed.text, '帮我看看这段代码')
})

test('a bare slash reports bare-switch, never a shell command', () => {
  assert.equal(commands.parse('/').kind, 'bare-switch')
  assert.equal(commands.parse('/   ').kind, 'bare-switch')
})

test('commands the stock plugin owns are reported as unknown, not forwarded', () => {
  for (const text of ['/bot-ping', '/bot-status', '/new', '/model gpt', '/help', '/team', '/current']) {
    assert.equal(commands.parse(text).kind, 'unknown', `${text} must fall through`)
  }
})

test('a CJK name that is not on the team gets a not-found, not a silent switch', () => {
  assert.equal(commands.parse('/法务').kind, 'not-found')
  assert.equal(commands.parse('/法务 帮我看看').kind, 'not-found')
  assert.equal(commands.parse('/法务').bot, '法务')
})

test('matching ignores stray whitespace around the command word', () => {
  assert.equal(commands.parse('  /程序员  ').bot, '程序员')
  assert.equal(commands.parse('/当前').kind, 'current')
  assert.equal(commands.parse('/聊天').bot, '聊天搭子')
})

test('the switch confirmation matches the spec wording', () => {
  assert.equal(renderSwitch('程序员'), '已切换至程序员。接下来可以直接发送代码或问题。')
})

test('/团队 lists the existing Bots, never new agents', () => {
  const text = renderTeam({ bots, current: '程序员', mainBot: '管家' })
  assert.match(text, /团队共 4 个 Bot/)
  for (const bot of bots) assert.match(text, new RegExp(bot.name))
  assert.match(text, /程序员（当前）/)
  assert.match(text, /管家（主 Bot）/)
})

test('/当前 names the selected Bot', () => {
  assert.match(renderCurrent({ current: '设计师', bots }), /当前目标 Bot：设计师/)
})

test('setBots re-registers after a rename', () => {
  const mutable = createCommands({ bots })
  assert.equal(mutable.parse('/法务').kind, 'not-found')
  mutable.setBots([...bots, { name: '法务', role: '法务' }])
  assert.equal(mutable.parse('/法务').bot, '法务')
  assert.equal(mutable.parse('/法务').kind, 'switch')
})
