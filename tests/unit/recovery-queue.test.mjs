import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../backend/lib/store.mjs';
import { Chats } from '../../backend/lib/records.mjs';
import { ChatQueue } from '../../backend/lib/queue.mjs';
import { Sessions } from '../../backend/lib/sessions.mjs';
import { measureOwnedProcesses } from '../../backend/lib/diagnostics.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

test('owned-process diagnostics degrades gracefully when Windows process spawning is blocked', async () => {
  const result = await measureOwnedProcesses([process.pid], { execImpl() { throw new Error('spawn EPERM'); } });
  assert.equal(result.available, false);
  assert.match(result.note, /unavailable|Windows/);
});

test('failed transcript persistence releases the run and preserves its recovery checkpoint', async () => {
  const events = []; let cleared = false; let settled = false;
  const sessions = new Sessions({
    projects: { resolve: () => ({ root: process.cwd(), name: 'Dummy', permissions: {} }) },
    chats: { get: () => ({}), selectTarget() {}, checkpoint() {}, append: async () => { throw new Error('Dummy disk full'); }, clearCheckpoint() { cleared = true; } },
    inbox: {}, config: {},
    engines: { info: async () => ({ installed: true, loggedIn: true }), adapter: () => ({ runTurn: async () => ({ status: 'done' }) }) },
  });
  sessions.subscribe((name, data) => events.push({ name, ...data }));
  sessions.onSettled = () => { settled = true; };
  await assert.rejects(sessions.runTurn({ projectId: 'dummy', engineId: 'codex', message: 'Fixture', emit() {} }), /Dummy disk full/);
  assert.equal(sessions.isBusy('dummy'), false);
  assert.equal(cleared, false);
  assert.equal(settled, false, 'a persistence failure must not automatically start the next queued turn');
  assert.equal(events.at(-1).status, 'error');
});

test('interrupted checkpoints recover once, with partial text, without replaying a turn', async () => {
  const dir = tempDir();
  try {
    const store = new Store(dir); let chats = new Chats(store);
    await chats.reset('p__codex');
    const messages = [{ role: 'user', text: 'Dummy prompt', runId: 'r1' }, { role: 'assistant', text: 'Partial answer', runId: 'r1', engine: 'codex' }];
    chats.checkpoint('p__codex', 'r1', messages, 'thread-1');
    chats = new Chats(store);
    assert.equal(chats.get('p__codex').messages.length, 2);
    assert.equal(chats.get('p__codex').messages[1].stopped, true);
    assert.match(chats.get('p__codex').messages[1].error, /recovered/);
    chats.checkpoint('p__codex', 'r1', messages, 'thread-1');
    chats = new Chats(store);
    assert.equal(chats.get('p__codex').messages.length, 2, 'a crash between append and checkpoint cleanup cannot duplicate the answer');
    await chats.reset('p__codex');
    await chats.append('p__codex', [{ role: 'assistant', text: 'Second conversation', costUsd: 0.25 }]);
    assert.equal(chats.summary('p').messages, 3);
    assert.equal(chats.summary('p').costUsd, 0.25);
  } finally { rmDir(dir); }
});

test('durable queue captures targets, deduplicates, pauses changed selections and never replays after restart', async () => {
  const dir = tempDir();
  try {
    const store = new Store(dir); const chats = new Chats(store); const calls = [];
    await chats.reset('p__codex');
    let busy = true;
    const sessions = { chats, engines: { adapter: () => ({}) }, chatKey: (p, n, e) => `${p}${n ? `__${n}` : ''}__${e}`, isBusy: () => busy, runTurn: async (input) => { calls.push(input); return { status: 'done' }; } };
    const projects = { resolve: () => ({}) };
    let queue = new ChatQueue({ store, sessions, projects });
    const input = { projectId: 'p', engineId: 'codex', model: 'dummy-model', message: 'Dummy queued prompt', clientId: 'dummy-message-1' };
    const entry = await queue.enqueue(input);
    assert.equal((await queue.enqueue(input)).id, entry.id);
    await assert.rejects(queue.enqueue({ ...input, model: 'other-model' }), /another message or target/);
    await chats.reset('p__codex'); busy = false;
    await queue.drain('p');
    assert.equal(entry.status, 'paused'); assert.equal(calls.length, 0);
    await chats.select('p__codex', entry.conversationId);
    queue.change(entry.id, 'resume');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1); assert.equal(calls[0].model, 'dummy-model');
    assert.equal(entry.status, 'done');
    busy = true;
    await queue.enqueue({ ...input, clientId: 'dummy-message-2' });
    queue.stop(); queue = new ChatQueue({ store, sessions, projects });
    assert.equal(queue.list('p').at(-1).status, 'paused');
    assert.equal(calls.length, 1, 'restart requires an explicit resume');
  } finally { rmDir(dir); }
});
