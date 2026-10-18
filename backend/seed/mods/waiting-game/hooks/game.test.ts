import { test, expect } from 'claude-code/testing'

import { press, step } from './register.tsx'

const g = { pos: 0, dir: 1 as const, ring: 10, score: 0, best: 0, said: '', isWorking: true, startedAt: 0, now: 0 }

test('the dot walks to the end of the track and turns back', async () => {
  let x = { ...g }
  for (let i = 0; i < 30; i++) x = step(x)
  expect(x.dir).toBe(-1)
  expect(x.pos).toBeLessThan(24)
})

test('a press inside the ring scores and moves the ring', async () => {
  const after = press({ ...g, pos: 11 })
  expect(after.score).toBe(1)
  expect(after.best).toBe(1)
  expect(after.pos >= after.ring && after.pos < after.ring + 4).toBe(false)
})

test('a press outside the ring starts the streak again', async () => {
  const after = press({ ...g, pos: 2, score: 3, best: 3 })
  expect(after.score).toBe(0)
  expect(after.best).toBe(3)
})
