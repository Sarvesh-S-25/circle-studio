import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../backend/lib/store.mjs';
import { Inbox, redactDeep } from '../../backend/lib/inbox.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

const rec = (id, projectId, extra = {}) => ({ id, projectId, kind: 'approval', status: 'pending', at: `2026-09-30T10:00:0${id.slice(-1)}.000Z`, detail: 'echo hi', ...extra });

test('records are stored redacted, newest first, filtered by status and project', () => {
  const dir = tempDir('circle-inbox-');
  try {
    const inbox = new Inbox({ store: new Store(dir) });
    inbox.add(rec('r_1', 'a', { detail: 'echo sk-ant-abcdefghijklmnopqrstuvwxyz0123', input: { command: 'echo sk-ant-abcdefghijklmnopqrstuvwxyz0123', nested: [{ k: 'sk-ant-abcdefghijklmnopqrstuvwxyz0123' }] } }));
    inbox.add(rec('r_2', 'a'));
    inbox.add(rec('r_3', 'b'));
    assert.ok(!JSON.stringify(inbox.list({ status: 'all' })).includes('abcdefghijklmnopqrstuvwxyz0123'));
    assert.deepEqual(inbox.list({ projectId: 'a', status: 'all' }).map((r) => r.id), ['r_2', 'r_1']);
    assert.equal(inbox.pendingCount('a'), 2);
    assert.deepEqual(inbox.update('r_1', { status: 'allowed', resolvedAt: 'x' }).status, 'allowed');
    assert.deepEqual(inbox.list({ status: 'pending' }).map((r) => r.id), ['r_3', 'r_2']);
    assert.equal(inbox.update('r_1', { status: 'denied' }), null, 'an answered request never changes again');
    assert.equal(inbox.get('r_1').status, 'allowed');
    assert.equal(inbox.update('nope', { status: 'denied' }), null);
  } finally { rmDir(dir); }
});

test('after a restart nothing is still pending, and the history is kept', () => {
  const dir = tempDir('circle-inbox-');
  try {
    const first = new Inbox({ store: new Store(dir) });
    first.add(rec('r_1', 'a'));
    first.add(rec('r_2', 'a', { status: 'allowed' }));
    const second = new Inbox({ store: new Store(dir) });
    assert.deepEqual(second.list({ status: 'all' }).map((r) => [r.id, r.status]), [['r_2', 'allowed'], ['r_1', 'expired']]);
    assert.ok(second.get('r_1').resolvedAt);
    assert.equal(second.pendingCount('a'), 0);
  } finally { rmDir(dir); }
});

test('the history is capped, and a corrupt file does not take the app down', () => {
  const dir = tempDir('circle-inbox-');
  try {
    const store = new Store(dir);
    const inbox = new Inbox({ store });
    for (let n = 0; n < 1005; n++) inbox.add({ id: `r_${n}`, projectId: 'a', kind: 'approval', status: 'allowed', at: new Date(n).toISOString() });
    assert.equal(inbox.list({ projectId: 'a', status: 'all' }).length, 1000);
    store.writeJson('inbox/b.json', { requests: 'garbage' });
    assert.equal(new Inbox({ store }).list({ projectId: 'b', status: 'all' }).length, 0);
  } finally { rmDir(dir); }
});

test('redactDeep reaches into arrays and objects and leaves other values alone', () => {
  assert.deepEqual(redactDeep({ a: 1, b: null, c: [true, 'plain'], d: { e: 'plain' } }), { a: 1, b: null, c: [true, 'plain'], d: { e: 'plain' } });
});
