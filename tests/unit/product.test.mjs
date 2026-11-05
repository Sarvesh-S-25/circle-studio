import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store } from '../../backend/lib/store.mjs';
import { Progress } from '../../backend/lib/progress.mjs';
import { Inbox } from '../../backend/lib/inbox.mjs';
import { Storage } from '../../backend/lib/storage.mjs';
import { validateShape } from '../../backend/lib/advice.mjs';
import { notificationAllowed } from '../../backend/lib/notices.mjs';
import { normalizePermissions } from '../../backend/lib/projects.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

test('completed requests move to a paged archive while active requests remain answerable', () => {
  const dir = tempDir();
  try {
    const store = new Store(dir);
    store.writeJson('inbox/dummy.json', { requests: Array.from({ length: 1000 }, (_, i) => ({ id: `old-${i}`, projectId: 'dummy', status: 'answered', title: `History ${i}`, at: '2026-01-01' })) });
    const inbox = new Inbox({ store });
    inbox.add({ id: 'pending', projectId: 'dummy', status: 'pending', title: 'Still waiting' });
    inbox.add({ id: 'new-1', projectId: 'dummy', status: 'answered', title: 'New answer' });
    inbox.add({ id: 'new-2', projectId: 'dummy', status: 'answered', title: 'New answer' });
    assert.equal(inbox.pendingCount('dummy'), 1);
    const first = inbox.archivePage('dummy', '', 1);
    assert.equal(first.requests.length, 1); assert.ok(first.nextCursor);
    const second = inbox.archivePage('dummy', first.nextCursor, 1);
    assert.equal(second.requests.length, 1); assert.notEqual(first.requests[0].id, second.requests[0].id);
    assert.equal(inbox.list().filter((r) => r.status !== 'pending').length, 1000);
    assert.equal(first.requests[0].id, 'old-998'); assert.equal(second.requests[0].id, 'old-999');
  } finally { rmDir(dir); }
});

test('neutral engine permissions preserve legacy access and explicit revocation takes precedence', () => {
  assert.equal(normalizePermissions({ claude: true }).engine, true);
  assert.equal(normalizePermissions({ engine: true }).claude, true);
  assert.equal(normalizePermissions({ engine: false, claude: true }).claude, false);
  assert.equal(normalizePermissions({}).engine, false);
});

test('quiet hours cross midnight and never suppress urgent approvals and questions', () => {
  const settings = { desktopNotifications: { quietHours: true, start: '22:00', end: '07:00' } };
  assert.equal(notificationAllowed(settings, 'done', new Date(2026, 9, 22, 23)), false);
  assert.equal(notificationAllowed(settings, 'update', new Date(2026, 9, 23, 6)), false);
  assert.equal(notificationAllowed(settings, 'done', new Date(2026, 9, 23, 7)), true);
  assert.equal(notificationAllowed(settings, 'approval', new Date(2026, 9, 22, 23)), true);
  assert.equal(notificationAllowed(settings, 'question', new Date(2026, 9, 22, 23)), true);
  assert.equal(notificationAllowed({ desktopNotifications: { done: false } }, 'done'), false);
});

test('cleanup previews only old generated files and refuses changed files before removing anything', () => {
  const dir = tempDir();
  try {
    const store = new Store(dir); const storage = new Storage(store);
    const old = new Date(Date.now() - 9 * 86400000);
    for (const rel of ['cache/a.json', 'logs/old.log', 'chats/keep.json', 'inbox/keep.json']) { store.writeJson(rel, { dummy: true }); fs.utimesSync(store.abs(rel), old, old); }
    store.writeJson('cache/recent.json', { recent: true });
    const preview = storage.cleanupPreview();
    assert.deepEqual(preview.files.map((f) => f.path).sort(), ['cache/a.json', 'logs/old.log']);
    store.writeJson('logs/old.log', { changed: true });
    assert.throws(() => storage.cleanup(preview.id), /changed/);
    assert.ok(fs.existsSync(store.abs('cache/a.json')), 'validation failure deletes nothing');
    const next = storage.cleanupPreview(); assert.equal(storage.cleanup(next.id).removed, 1);
    assert.ok(fs.existsSync(store.abs('chats/keep.json')) && fs.existsSync(store.abs('inbox/keep.json')));
  } finally { rmDir(dir); }
});

test('progress requires evidence, review and dependencies; cancelled tasks earn nothing; replay is idempotent', async () => {
  const dir = tempDir();
  try {
    const progress = new Progress(new Store(dir)); const wf = { nodes: [{ id: 'build', kind: 'stage' }] };
    await assert.rejects(progress.save('p', { title: 'Incomplete', status: 'done' }, wf), /review/);
    const a = await progress.save('p', { title: 'A', stageId: 'build', engine: 'codex' }, wf);
    const b = await progress.save('p', { title: 'B', dependencies: [a.id], stageId: 'build', engine: 'codex' }, wf);
    const accepted = { status: 'done', reviewed: true, evidence: [{ kind: 'test', detail: 'Checked the dummy fixture; pass.' }] };
    await assert.rejects(progress.save('p', { id: b.id, ...accepted }, wf), /dependencies/);
    await progress.save('p', { id: a.id, ...accepted }, wf);
    await progress.save('p', { id: b.id, ...accepted }, wf);
    await progress.save('p', { id: b.id, ...accepted }, wf);
    assert.equal(progress.read('p', { achievements: true }).events.length, 2);
    assert.equal(progress.read('p', { achievements: true }).stages[0].complete, true);
    await progress.save('p', { id: a.id, status: 'cancelled' }, wf);
    assert.equal(progress.read('p').summary.cancelled, 1);
    assert.equal(progress.read('p').summary.done, 0);
    assert.equal(progress.read('p').tasks.find((t) => t.id === b.id).status, 'review');
    assert.match(progress.read('p').tasks.find((t) => t.id === b.id).dependencyNotice, /dependency/);
    assert.equal(progress.read('p').events.length, 2, 'historical acceptance evidence remains intact');
    assert.deepEqual(progress.read('p').achievements, []);
    await progress.resetAchievements('p');
    assert.deepEqual(progress.read('p', { achievements: true }).achievements, []);
    assert.equal(progress.read('p').tasks.length, 2, 'reset preserves tasks');
    await progress.save('p', { id: a.id, ...accepted }, wf);
    await progress.save('p', { id: b.id, ...accepted }, wf);
    assert.deepEqual(progress.read('p', { achievements: true }).achievements, [], 'replaying an accepted task after reset does not earn it again');
    await assert.rejects(progress.save('p', { id: a.id, status: 'planned', dependencies: [b.id] }, wf), /cycle/);
  } finally { rmDir(dir); }
});

test('backup excludes vault credentials; preview blocks traversal and corruption; restore verifies in isolation', () => {
  const dir = tempDir();
  try {
    const store = new Store(dir); const storage = new Storage(store);
    store.writeJson('settings.json', { preferredEngine: 'codex' });
    store.writeJson('vault.json', { encrypted: 'private' });
    store.writeJson('chats/p.json', { messages: [{ text: 'Hello' }] });
    const backup = storage.backup();
    assert.equal(backup.entries.length, 2);
    assert.ok(!JSON.stringify(backup).includes('private'));
    const bad = structuredClone(backup); bad.entries[0].path = '../escape'; assert.throws(() => storage.preview(bad));
    const corrupt = structuredClone(backup); corrupt.entries[0].sha256 = 'wrong'; assert.throws(() => storage.preview(corrupt), /integrity/);
    const preview = storage.preview(backup);
    store.writeJson('settings.json', { preferredEngine: 'claude' });
    const restored = storage.restore(preview.id);
    assert.equal(restored.verified, true);
    assert.equal(JSON.parse(fs.readFileSync(`${restored.dataDir}/settings.json`, 'utf8')).preferredEngine, 'codex');
    assert.equal(store.readJson('settings.json').preferredEngine, 'claude');
    assert.throws(() => storage.restore(preview.id), /expired/);
  } finally { rmDir(dir); }
});

test('structured output rejects invalid types, missing fields and unexpected properties', () => {
  const schema = { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'integer', minimum: 0 } } }, additionalProperties: false };
  assert.doesNotThrow(() => validateShape({ items: [0, 4] }, schema));
  for (const value of [{}, { items: 'bad' }, { items: [-1] }, { items: [], extra: true }]) assert.throws(() => validateShape(value, schema));
});
