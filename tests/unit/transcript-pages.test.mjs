import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../backend/lib/store.mjs';
import { Chats } from '../../backend/lib/records.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

test('byte-indexed transcript pages preserve Unicode, nested tools and escaped JSON and invalidate on writes', async () => {
  const root = tempDir();
  try {
    const chats = new Chats(new Store(root));
    const messages = Array.from({ length: 420 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `Message ${i} 😀 తెలుగు \\"messages\\": [ }]`, tools: [{ name: 'Read', input: { nested: ['braces }[', { ok: true }] } }] }));
    const saved = await chats.append('dummy', messages, 'fixture');
    for (const offset of [0, 100, 150, 399, 419, 420]) assert.deepEqual(chats.read('dummy', saved.conversationId, { offset }).messages, messages.slice(offset, offset + 150));
    const copy = chats.read('dummy', saved.conversationId); copy.messages[0].text = 'Changed only by caller';
    assert.equal(chats.read('dummy', saved.conversationId).messages[0].text, messages[0].text);
    await chats.append('dummy', [{ role: 'assistant', text: 'New message' }]);
    assert.equal(chats.read('dummy', saved.conversationId, { offset: 420 }).messages[0].text, 'New message');
    assert.equal(chats.read('dummy', saved.conversationId).totalMessages, 421);
    assert.ok(chats.cacheStats().pages.bytes <= chats.cacheStats().pages.budget);
  } finally { rmDir(root); }
});
