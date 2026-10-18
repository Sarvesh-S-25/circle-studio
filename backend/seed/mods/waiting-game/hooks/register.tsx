// A tiny game for while Claude works. A dot sweeps along a track; press c (or Catch) while it is inside the ring.
// Each catch speeds it up a little; a miss starts the streak again. The best score is kept between sessions.
// Shipped by Circle Studio as a starter mod: change it freely, or ask Claude to make another one.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Game } from '../types'

const PANE = 'waiting-game'
const WIDTH = 24
const RING = 4

const fresh = (best = 0): Game => ({ pos: 0, dir: 1, ring: 12, score: 0, best, said: '', isWorking: false, startedAt: 0, now: 0 })
const game = atom({ plugin: 'waiting-game', key: 'game' } as const, fresh())

/** A new ring somewhere the dot is not. */
const newRing = (pos: number): number => {
  for (let i = 0; i < 8; i++) {
    const r = Math.floor(Math.random() * (WIDTH - RING))
    if (pos < r || pos >= r + RING) return r
  }
  return pos > WIDTH / 2 ? 1 : WIDTH - RING - 1
}

/** One step of the dot: back and forth along the track. */
export const step = (g: Game): Game => {
  let pos = g.pos + g.dir
  let dir = g.dir
  if (pos >= WIDTH - 1) { pos = WIDTH - 1; dir = -1 }
  if (pos <= 0) { pos = 0; dir = 1 }
  return { ...g, pos, dir }
}

/** A press: inside the ring scores and moves the ring, outside starts the streak again. */
export const press = (g: Game): Game => {
  if (g.pos >= g.ring && g.pos < g.ring + RING) {
    const score = g.score + 1
    return { ...g, score, best: Math.max(g.best, score), ring: newRing(g.pos), said: score % 5 === 0 ? `${score} in a row!` : 'Caught it' }
  }
  return { ...g, score: 0, said: 'Missed. Again!' }
}

const speed = (score: number) => Math.max(45, 130 - score * 8)

let tick: { cancel: () => void } | null = null
let shownSpeed = 0

/** Moves the dot at the speed the score asks for (faster as you catch more). */
async function run($: EngineInterface) {
  const g = await read($, game)
  const ms = speed(g.score)
  if (tick && shownSpeed === ms) return
  tick?.cancel()
  shownSpeed = ms
  tick = $.clock.every(ms, () => { void update($, game, step) })
}

function stop() { tick?.cancel(); tick = null; shownSpeed = 0 }

async function openGame($: EngineInterface) {
  const best = Number((await $.store.get('best')) ?? 0)
  const now = await $.clock.now()
  await update($, game, g => ({ ...g, best: Math.max(best, g.best), now }))
  await $.ui.open({ id: PANE, title: 'Waiting game', rows: 7 })
  await run($)
}

async function catchIt($: EngineInterface) {
  const after = await update($, game, press)
  if (after.score === after.best) await $.store.set('best', after.best)
  await run($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'waiting-game', description: 'Play a tiny game while Claude works' })
    return next(e)
  })

  on('command.run', { command: 'waiting-game' }, async $ => {
    await openGame($)
    return { text: 'Waiting game opened: press c when the dot is inside the ring.' }
  })

  // opens by itself when you send a prompt, and says when Claude is done
  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, game, g => ({ ...g, isWorking: true, startedAt: now, now }))
    await openGame($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const g = await update($, game, x => ({ ...x, isWorking: false, now }))
    await $.store.set('best', g.best)
    stop()
    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    stop()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const g = await read($, game)
    const track = Array.from({ length: WIDTH }, (_, i) => (i === g.pos ? 'o' : i >= g.ring && i < g.ring + RING ? '=' : '·')).join('')
    const secs = g.startedAt ? Math.max(0, Math.round((g.now - g.startedAt) / 1000)) : 0

    return (
      <Box flexDirection="column">
        <Text dimColor>{g.isWorking ? `Claude is working${secs ? ` (${secs}s)` : ''}. Catch the dot inside the ring.` : 'Claude is done. Play on, or close this pane.'}</Text>
        <Text>[{track}]</Text>
        <Box>
          <Button key="catch" hotkey="c" variant="primary" autoFocus onPress={() => catchIt($)}>Catch</Button>
          <Text> Score {g.score}  Best {g.best}  {g.said}</Text>
        </Box>
      </Box>
    )
  })
}
