// "Allow from now on": only the choices that fit a request are offered (this run; every edit in this project; reading
// outside it), one answer also lets the same kind waiting beside it go ahead, the project keeps the choice (and shows
// it in Permissions), secrets and commands are never allowed for good, and a request a desktop card shows is marked
// so the window does not notify a second time.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';
import { rememberOptions } from '../../backend/lib/sessions.mjs';
import { evaluate } from '../../backend/lib/policy.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, tries = 100) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(50); } return null; };
const outside = (name) => path.join(os.tmpdir(), `circle-outside-${name}`);

test('the choices offered fit the request', () => {
  const root = path.join(os.tmpdir(), 'circle-proj');
  const ctx = { root, permissions: { write: true, shell: true } };
  const opts = (tool, input) => rememberOptions(tool, input, evaluate({ tool, input }, ctx));
  assert.deepEqual(opts('Edit', { file_path: path.join(root, 'a.md'), old_string: 'a', new_string: 'b' }), ['run', 'edits']);
  assert.deepEqual(opts('Bash', { command: 'npm test' }), ['run']);
  assert.deepEqual(opts('Read', { file_path: outside('shot.png') }), ['reads-outside']);
  assert.deepEqual(opts('Edit', { file_path: outside('x.md'), old_string: 'a', new_string: 'b' }), [], 'an edit outside is never allowed for good');
  assert.deepEqual(opts('Read', { file_path: path.join(root, 'a.md') }), [], 'reading inside never asks');
});

async function turnWith(s, id, tools) {
  process.env.FAKE_CLAUDE = 'tools';
  process.env.FAKE_CLAUDE_TOOLS = JSON.stringify(tools);
  assert.equal((await s.call('POST', '/api/overlay/say', { projectId: id, text: 'go' })).json.sent, true);
}
const pendingOf = async (s, n) => until(async () => { const r = (await s.call('GET', '/api/requests?status=pending')).json.requests; return r.length >= n ? r : null; });
const quiet = async (s, id) => until(async () => (await s.call('GET', `/api/projects/${id}/chat/live`)).json.turn === null);

test('always allow edits here: the one beside it goes too, later edits never ask, commands still do', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true, run: true, claude: true } })).json.project.id;
    const edit = (f) => ({ name: 'Edit', input: { file_path: path.join(root, f), old_string: 'a', new_string: 'b' } });
    await turnWith(s, id, [edit('one.md'), edit('two.md')]);
    const two = await pendingOf(s, 2);
    assert.ok(two, 'both edits wait');
    assert.deepEqual(two[0].remember, ['run', 'edits']);
    // a choice that does not fit is refused
    assert.equal((await s.call('POST', `/api/requests/${two[0].id}/respond`, { decision: 'allow', remember: 'reads-outside' })).status, 400);
    assert.equal((await s.call('POST', `/api/requests/${two[0].id}/respond`, { decision: 'allow', remember: 'edits' })).status, 200);
    assert.ok(await quiet(s, id), 'the second edit went ahead with the first');
    const answers = (await s.call('GET', `/api/projects/${id}/chat`)).json.messages.at(-1).text;
    assert.match(answers, /allow, allow/);
    assert.equal((await s.call('GET', `/api/projects/${id}`)).json.project.permissions.autoEdits, true, 'kept with the project');

    // the next edit does not ask, and the Inbox says why it went ahead
    await turnWith(s, id, [edit('three.md')]);
    assert.ok(await quiet(s, id));
    const all = (await s.call('GET', '/api/requests?status=all')).json.requests;
    assert.ok(all.some((r) => r.title.includes('three.md') && r.status === 'allowed' && /always allow edits/.test(r.note)));
    // a command still asks, and cannot be allowed for good
    await turnWith(s, id, [{ name: 'Bash', input: { command: 'npm test' } }]);
    const cmd = await pendingOf(s, 1);
    assert.deepEqual(cmd[0].remember, ['run']);
    assert.equal((await s.call('POST', `/api/requests/${cmd[0].id}/respond`, { decision: 'allow', remember: 'edits' })).status, 400);
    assert.equal((await s.call('POST', `/api/requests/${cmd[0].id}/respond`, { decision: 'deny' })).status, 200);
    assert.ok(await quiet(s, id));

    // turned off in Permissions: edits ask again
    const perms = (await s.call('GET', `/api/projects/${id}`)).json.project.permissions;
    await s.call('PUT', `/api/projects/${id}/permissions`, { permissions: { ...perms, autoEdits: false } });
    await turnWith(s, id, [edit('four.md')]);
    const again = await pendingOf(s, 1);
    assert.ok(again, 'it asks again');
    await s.call('POST', `/api/requests/${again[0].id}/respond`, { decision: 'deny' });
    assert.ok(await quiet(s, id));
  } finally {
    delete process.env.FAKE_CLAUDE;
    delete process.env.FAKE_CLAUDE_TOOLS;
    await s.close();
    rmDir(root);
  }
});

test('always allow reading outside: never a secret; a desktop card marks the request so the window stays quiet', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  const ac = new AbortController();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true, run: true, claude: true } })).json.project.id;
    // what an open window hears: a request the desktop card shows carries carded
    s.app.overrides.asksOnDesktop = () => true;
    const heard = [];
    fetch(`${s.base}/api/events`, { signal: ac.signal }).then(async (res) => {
      const dec = new TextDecoder();
      for await (const chunk of res.body) heard.push(dec.decode(chunk));
    }).catch(() => {});
    await sleep(100);
    await turnWith(s, id, [{ name: 'Read', input: { file_path: outside('a.png') } }, { name: 'Read', input: { file_path: outside('b.png') } }]);
    const two = await pendingOf(s, 2);
    assert.deepEqual(two[0].remember, ['reads-outside']);
    assert.ok(await until(() => heard.join('').includes('"carded":true')), 'the window is told a card shows it');
    assert.equal((await s.call('POST', `/api/requests/${two[0].id}/respond`, { decision: 'allow', remember: 'reads-outside' })).status, 200);
    assert.ok(await quiet(s, id));
    assert.equal((await s.call('GET', `/api/projects/${id}`)).json.project.permissions.autoReadsOutside, true);
    // a secret outside is still refused, whatever the switch says
    await turnWith(s, id, [{ name: 'Read', input: { file_path: path.join(os.tmpdir(), 'circle-outside', '.env') } }]);
    assert.ok(await quiet(s, id));
    const secret = (await s.call('GET', '/api/requests?status=all')).json.requests.find((r) => r.title.includes('.env'));
    assert.equal(secret.status, 'auto-denied');
  } finally {
    ac.abort();
    delete process.env.FAKE_CLAUDE;
    delete process.env.FAKE_CLAUDE_TOOLS;
    await s.close();
    rmDir(root);
  }
});
