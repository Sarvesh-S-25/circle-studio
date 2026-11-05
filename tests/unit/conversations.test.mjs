import test from 'node:test';
import assert from 'node:assert/strict';
import { Chats } from '../../backend/lib/records.mjs';
import { Store } from '../../backend/lib/store.mjs';
import { Limits } from '../../backend/lib/limits.mjs';
import { BoundedCache } from '../../backend/lib/cache.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

test('new chats, selection, archive and legacy migration preserve complete transcripts across restart', async () => {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    store.writeJson('chats/demo.json', { version: 1, sessionId: 'legacy', messages: [{ role: 'user', text: 'legacy question' }] });
    let chats = new Chats(store);
    await chats.reset('demo');
    const first = chats.list('demo').conversations.find((c) => c.sessionId === 'legacy');
    assert.ok(first);
    await chats.append('demo', Array.from({ length: 250 }, (_, i) => ({ role: 'user', text: `message ${i}` })), 'codex-thread');
    const second = chats.get('demo').conversationId;
    assert.equal(chats.list('demo').conversations.find((c) => c.id === second).title, 'message 0');
    assert.equal(chats.get('demo').messages.length, 200);
    assert.equal(chats.read('demo', second, { limit: 400 }).messages.length, 250);
    await chats.reset('demo');
    chats = new Chats(new Store(dir));
    await chats.select('demo', first.id);
    assert.equal(chats.get('demo').messages[0].text, 'legacy question');
    await chats.archive('demo', second);
    assert.equal(chats.list('demo', { archived: true }).conversations[0].id, second);
    assert.equal(chats.get('demo').sessionId, 'legacy', 'archiving another conversation preserves selection');
    store.writeJson('conversations/demo/index.json', { conversations: [] });
    assert.equal(chats.rebuildIndexes().conversations, 3);
    assert.equal(chats.get('demo').sessionId, 'legacy', 'index repair does not select another conversation');
    assert.equal(chats.read('demo', second, { limit: 400 }).messages.length, 250);
    assert.equal(chats.list('demo', { archived: true }).conversations[0].id, second);
    assert.throws(() => chats.read('../escape', second));
  } finally { rmDir(dir); }
});

test('Codex limits do not borrow Claude windows or the previous account profile', async () => {
  const dir = tempDir();
  try {
    const limits = new Limits(new Store(dir));
    limits.record({ fiveHour: { pct: 80 } }, 'chat');
    limits.record({ provider: 'codex', profileId: 'a', rateLimits: { primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 2000000000 } } }, 'account');
    assert.equal(limits.get('codex').windows[0].label, '15 minutes');
    assert.equal(limits.get().fiveHour.pct, 80);
    limits.record({ provider: 'codex', profileId: 'b', rateLimits: { secondary: { usedPercent: 4, windowDurationMins: 10080 } } }, 'account');
    assert.equal(limits.get('codex').windows.length, 1);
    assert.equal(limits.get('codex').profileId, 'b');
    await limits.refresh('codex', { readLimits: async () => { throw new Error('signed out'); } });
    assert.equal(limits.get('codex').available, false);
    assert.deepEqual(limits.get('codex').windows, []);
  } finally { rmDir(dir); }
});

test('derived caches evict least recently used values and enforce byte budgets', () => {
  const cache = new BoundedCache({ entries: 2, bytes: 100 });
  cache.set('a', 1).set('b', 2); cache.get('a'); cache.set('c', 3);
  assert.equal(cache.has('b'), false);
  cache.set('oversize', 'x'.repeat(100));
  assert.equal(cache.has('oversize'), false);
  cache.clear(); assert.equal(cache.bytes, 0);
});
