import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChain } from '../../frontend/js/chain.js';

test('main and backup, with Claude last when the file had it last', () => {
  assert.deepEqual(buildChain({ main: 'gemini', backup: 'copilot', extras: ['codex'], selfEnd: true }), ['gemini', 'copilot', 'codex', 'self']);
  assert.deepEqual(buildChain({ main: 'codex', backup: 'gemini', extras: ['copilot'], selfEnd: true }), ['codex', 'gemini', 'copilot', 'self']);
});

test('no backup keeps the other engines the file listed; none means only the main', () => {
  assert.deepEqual(buildChain({ main: 'copilot', backup: '', extras: ['gemini'], selfEnd: true }), ['copilot', 'gemini', 'self']);
  assert.deepEqual(buildChain({ main: 'copilot' }), ['copilot']);
});

test('Claude itself as backup ends the chain; as main it is the whole chain', () => {
  assert.deepEqual(buildChain({ main: 'gemini', backup: 'self', extras: ['codex'], selfEnd: false }), ['gemini', 'self']);
  assert.deepEqual(buildChain({ main: 'self', backup: 'gemini', extras: ['codex'], selfEnd: true }), ['self']);
});

test('never duplicates an engine and never puts self in the middle', () => {
  const c = buildChain({ main: 'gemini', backup: 'gemini', extras: ['gemini', 'self', 'codex'], selfEnd: true });
  assert.deepEqual(c, ['gemini', 'codex', 'self']);
  assert.equal(new Set(c).size, c.length);
  assert.equal(c.indexOf('self'), c.length - 1);
});
