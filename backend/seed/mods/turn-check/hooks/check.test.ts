import { test, expect } from 'claude-code/testing'

import { describe, isTest } from './register.tsx'

test('test commands are recognised', async () => {
  expect(isTest('npm test')).toBe(true)
  expect(isTest('node --test tests/unit')).toBe(true)
  expect(isTest('pytest -q')).toBe(true)
  expect(isTest('git status')).toBe(false)
})

test('a turn that changed files without tests says so', async () => {
  const line = describe({ seconds: 12, tools: 5, changed: 2, tested: false, percent: 41 })
  expect(line).toContain('Context 41%')
  expect(line).toContain('2 files changed, no tests ran after')
})

test('a quiet turn is short', async () => {
  expect(describe({ seconds: 3, tools: 1, changed: 0, tested: false, percent: null })).toBe('3s, 1 tool  ·  no files changed')
})
