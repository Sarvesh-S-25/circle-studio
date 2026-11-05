// Notifications (lib/notices.mjs) and the widgets added with them: the Notifications and Running now tiles, and small
// sizes for every kind. Notices are kept whether or not Windows was told, and reach open windows on the event stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../backend/lib/store.mjs';
import { Notices } from '../../backend/lib/notices.mjs';
import { buildFeed } from '../../backend/lib/feed.mjs';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, tempDir, rmDir } from '../helpers/project.mjs';

const ALL = { write: true, run: true, claude: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('notices: kept newest first, the same one within a minute is one, at most 60, secrets never kept', () => {
  const dir = tempDir('cs-notices-');
  try {
    let t = Date.parse('2026-10-05T10:00:00Z');
    const n = new Notices(new Store(dir), { now: () => t });
    const a = n.add({ kind: 'done', title: 'x: the chat finished' });
    assert.equal(n.add({ kind: 'done', title: 'x: the chat finished' }).id, a.id, 'a repeat within a minute is the same notice');
    t += 61_000;
    n.add({ kind: 'done', title: 'x: the chat finished' });
    const key = `sk-ant-api03-${'a'.repeat(90)}`;
    const s = n.add({ kind: 'error', title: 'oops', body: `failed with ${key}`, url: 'javascript:alert(1)' });
    assert.ok(!s.body.includes(key), 'a key in the text is redacted');
    assert.equal(s.url, '#/', 'only app links are kept');
    assert.throws(() => n.add({ kind: 'nope', title: 'x' }));
    assert.deepEqual([n.list().unread, n.list().notices[0].kind], [3, 'error']);
    for (let i = 0; i < 70; i++) { t += 61_000; n.add({ kind: 'team', title: `q${i}` }); }
    assert.equal(n.list().notices.length, 60);
    assert.equal(new Notices(new Store(dir)).list().notices.length, 60, 'kept on disk');
    assert.equal(n.markRead([n.list().notices[0].id]), 1);
    assert.equal(n.markRead(), 59);
    assert.equal(n.list().unread, 0);
  } finally { rmDir(dir); }
});

test('feed: Notifications and Running now tiles, and the small size of every kind, draw without errors', () => {
  const now = Date.parse('2026-10-05T10:10:00Z');
  const project = { id: 'p1', name: 'Demo' };
  const pulse = { project, agents: [{ title: 'qa', state: 'waiting' }, { title: 'dev', state: 'working' }], workflow: { stages: [{ title: 'Plan', state: 'done' }, { title: 'Build', state: 'waiting' }], agents: 2, version: '1.0.0' }, repo: { isRepo: true, branch: 'main', changed: 2 }, stats: { attention: [] } };
  const stats = { totals: { projects: 1 }, projects: [{ id: 'p1', name: 'Demo', exists: true }], running: [{ source: 'team', projectId: 'p1', name: 'Demo', agent: 'qa', what: 'Bash', startedAt: '2026-10-05T10:00:00Z' }] };
  const notices = { unread: 1, notices: [{ id: 'a1', at: '2026-10-05T10:05:00Z', kind: 'question', title: 'Demo: qa has a question', body: 'Which colour?', url: '#/inbox', read: false }] };
  const kinds = ['pulse', 'status', 'spend', 'workflow', 'inbox', 'project', 'overview', 'chat', 'notices', 'running', 'mods'];
  const mods = [{ name: 'waiting-game', isMod: true, group: 'project', onIn: [{ id: 'p1', name: 'Demo' }] }, { name: 'tools', isMod: false, group: 'off' }];
  const tiles = kinds.flatMap((kind) => ['s', 'm', 'l'].map((size) => ({ kind, size, projectId: 'p1' })));
  const chats = new Map(tiles.map((t, i) => [i, { project, selected: 'main', threads: [{ id: 'main', label: 'Main' }], messages: [{ who: 'You', text: 'hi', mine: true }, { who: 'Claude', text: 'Hello there' }] }]));
  const feed = buildFeed({ tiles, pulseOf: () => pulse, usage: null, stats, pending: [], alerts: [], nameOf: () => 'Demo', palette: {}, defaultProject: 'p1', chats, notices, mods, now });
  for (const t of feed.tiles) assert.ok(!/Could not draw/.test(t.empty || ''), `${t.kind} ${t.size}: ${t.empty}`);
  const at = (kind, size) => feed.tiles.find((t) => t.kind === kind && t.size === size);
  assert.deepEqual([at('notices', 's').big, at('notices', 's').bigState], ['1', 'waiting']);
  assert.equal(at('notices', 'm').items[0].sub, '5 min · Which colour?');
  assert.equal(at('running', 'l').items[0].title, 'Demo: qa');
  // where and since when: the clock time (in this PC's own format), for how long, what it does
  assert.match(at('running', 'l').items[0].sub, /^since .+ · 10 min · Bash$/);
  assert.deepEqual([at('workflow', 's').progress.done, at('workflow', 's').progress.total], [1, 2], 'a count of stages done, not a guess');
  assert.equal(at('workflow', 'm').now.title, 'Build');
  assert.equal(at('workflow', 'm').now.state, 'waiting');
  assert.equal(at('workflow', 'l').stages.length, 2);
  // the activity ring: one per project, turning while it works; one ring needs no line under it
  assert.deepEqual(at('pulse', 's').activity.map((r) => [r.name, r.state]), [['Demo', 'working']]);
  assert.match(at('pulse', 's').activity[0].word, /^Working · 10 min$/);
  assert.equal(at('pulse', 's').sub, '');
  // mods: how many are on, and where
  assert.equal(at('mods', 's').big, '1');
  assert.equal(at('mods', 'm').items[0].sub, 'Mod · in Demo');
  assert.equal(at('project', 's').sub, 'waiting for you');
  assert.equal(at('overview', 's').big, '1');
  assert.equal(at('chat', 's').sub, 'Claude: Hello there');
});

test('notices in the app: an agent that asks is kept even with a window open; read and mark read; small tiles save', async () => {
  const toasts = [];
  const s = await startServer({ toast: (t) => { toasts.push(t); return true; } });
  const root = makeMiniProject();
  const ctl = new AbortController();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    // a window is open: no Windows toast, but the notice is kept and sent to the window
    let streamed = '';
    fetch(`${s.base}/api/events`, { signal: ctl.signal }).then(async (r) => { const rd = r.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; streamed += Buffer.from(value).toString('utf8'); } }).catch(() => {});
    for (let i = 0; i < 40 && s.app.viewers.count === 0; i++) await sleep(25);
    process.env.FAKE_CLAUDE = 'bash';
    const run = s.sse('/api/chat', { projectId: id, message: 'run it' });
    let list;
    for (let i = 0; i < 100; i++) { list = (await s.call('GET', '/api/notices')).json; if (list.notices.length) break; await sleep(50); }
    assert.equal(list.unread, 1);
    assert.equal(list.notices[0].kind, 'approval');
    assert.equal(list.notices[0].url, '#/inbox');
    assert.equal(toasts.length, 0, 'the open window shows it, Windows does not');
    for (let i = 0; i < 40 && !streamed.includes('event: notice'); i++) await sleep(25);
    assert.ok(streamed.includes('event: notice'), 'open windows hear about it at once');
    const pending = (await s.call('GET', `/api/requests?status=pending&projectId=${id}`)).json.requests[0];
    await s.call('POST', `/api/requests/${pending.id}/respond`, { decision: 'deny' });
    await run;
    delete process.env.FAKE_CLAUDE;
    assert.equal((await s.call('POST', '/api/notices/read', { ids: ['not-an-id'] })).status, 400);
    const read = (await s.call('POST', '/api/notices/read', {})).json;
    assert.deepEqual([read.changed, read.unread], [2, 0], 'approval and short-run completion both remain in the audit');
    // every kind saves in every size, including the new ones
    const widgets = ['workflow', 'project', 'overview', 'chat', 'notices', 'running'].map((kind) => ({ kind, size: 's' }));
    assert.equal((await s.call('PUT', '/api/settings', { widgets })).status, 200);
    const feed = (await s.call('GET', '/api/widgets/feed')).json;
    assert.deepEqual(feed.tiles.map((t) => t.kind), ['workflow', 'project', 'overview', 'chat', 'notices', 'running']);
    assert.equal(feed.tiles.find((t) => t.kind === 'notices').big, '0');
  } finally {
    ctl.abort();
    delete process.env.FAKE_CLAUDE;
    await s.close();
    rmDir(root);
  }
});
