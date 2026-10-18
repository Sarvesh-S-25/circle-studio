// After each turn, one line above the prompt: how full the context is, how long the turn took, how many files changed
// and whether a test ran after the last change. A turn that changed files and ran no test says so, so you can ask for
// one before you move on. Shipped by Circle Studio as a starter mod: change it freely.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TurnCheck } from '../types'

const last = atom({ plugin: 'turn-check', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'turn-check', key: 'isHidden' } as const, false)

const TEST_RE = /\b(test|tests|jest|vitest|pytest|mocha|playwright|cypress|go test|cargo test|dotnet test|node --test|npm (run )?test|pnpm test|yarn test)\b/i
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const WARN_AT = 70

/** True when a shell command runs tests. */
export const isTest = (command: string): boolean => TEST_RE.test(command)

/** The words of the line, from what the turn did. */
export const describe = (t: TurnCheck): string => {
  const parts = [
    t.percent === null ? '' : `Context ${t.percent}%`,
    `${t.seconds}s, ${t.tools} tool${t.tools === 1 ? '' : 's'}`,
    t.changed ? `${t.changed} file${t.changed === 1 ? '' : 's'} changed, ${t.tested ? 'tests ran after' : 'no tests ran after'}` : 'no files changed',
  ]
  return parts.filter(Boolean).join('  ·  ')
}

let startedAt = 0
let tools = 0
let changed = new Set<string>()
let tested = false
let warned = false

async function finish($: EngineInterface) {
  const now = await $.clock.now()
  const usage = await $.session.usage()
  const percent = typeof usage.context.percent === 'number' ? Math.round(usage.context.percent) : null
  const t: TurnCheck = { seconds: Math.max(0, Math.round((now - startedAt) / 1000)), tools, changed: changed.size, tested, percent }
  await update($, last, () => t)
  await update($, isHidden, () => false)
  if (percent !== null && percent >= WARN_AT && !warned) {
    warned = true
    $.ui.toast(`Context is ${percent}% full. A new session or /compact keeps answers sharp.`)
  }
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    startedAt = await $.clock.now()
    tools = 0
    changed = new Set()
    tested = false
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    tools += 1
    const ran = await next(e)
    const name = String(e.tool)
    const input = (e as { input?: Record<string, unknown> }).input || {}
    if (WRITE_TOOLS.has(name) && typeof input.file_path === 'string') { changed.add(input.file_path); tested = false }
    if (name === 'Bash' && typeof input.command === 'string' && isTest(input.command)) tested = true
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    await finish($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t = await read($, last)
    if (e.props.hasSurvey || t === null || (await read($, isHidden))) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const warn = t.changed > 0 && !t.tested
    return (
      <Box>
        <Text dimColor={!warn} color={warn ? 'warning' : undefined}>{describe(t)} </Text>
        <Button key="hide" label="Hide" dimColor onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
