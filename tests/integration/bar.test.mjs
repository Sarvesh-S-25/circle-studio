// The overlay's bar (Ctrl+Alt+C): what you type goes to the project's chat, even one word; a line starting with / is a
// command, answered under the box; a message typed while it answers is sent when it finishes; the feed says who
// answers, where it works and what it is doing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, tries = 100) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(50); } return null; };

test('the bar: words are messages, / is for commands, a message waits its turn', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  const bar = async (text, projectId) => (await s.call('POST', '/api/overlay/command', { text, projectId, from: 'bar' })).json;
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true, run: true, claude: true } })).json.project.id;
    const chat = async () => (await s.call('GET', `/api/projects/${id}/chat`)).json.messages;
    const quiet = () => until(async () => (await s.call('GET', `/api/projects/${id}/chat/live`)).json.turn === null);

    // one word is a message, not "not a command"
    const hi = await bar('hi', id);
    assert.equal(hi.command, 'ask');
    assert.ok(await quiet());
    assert.equal((await chat()).find((m) => m.role === 'user').text, 'hi');

    // the feed: who answers, where
    const feed = (await s.call('GET', `/api/overlay?projectId=${id}`)).json;
    assert.equal(feed.bar.engineLabel, 'Claude');
    assert.equal(feed.bar.where, root);

    // commands, answered under the box
    assert.match((await bar('/help', id)).say.lines.join('\n'), /\/usage/);
    assert.match((await bar('/status', id)).say.lines[0], /^Folder: /);
    assert.equal((await bar('/usage', id)).command, 'bar');
    assert.equal((await bar('/model sonnet', id)).say.title, 'Model: sonnet.');
    assert.equal((await bar('/model gpt', id)).say.tone, 'warn');
    assert.match((await bar('/engine next', id)).say.title, /^Now talking to Claude/, 'only Claude is ready in the tests');
    assert.equal((await bar('/waiting', id)).say.title, 'Nothing waits for you.');
    assert.equal((await bar('/allow', id)).say.title, 'Nothing waits for you.');
    // Claude Code's own /words, and //word, go to Claude as typed
    assert.equal((await bar('/compact', id)).command, 'ask');
    assert.ok(await quiet());
    assert.equal((await chat()).filter((m) => m.role === 'user').at(-1).text, '/compact');

    // typed while it answers: sent when it finishes
    process.env.FAKE_CLAUDE = 'bash';
    assert.equal((await bar('check the build', id)).command, 'ask');
    const req = await until(async () => (await s.call('GET', '/api/requests?status=pending')).json.requests[0]);
    const lined = await bar('then say what changed', id);
    assert.equal(lined.say.title, 'Sends when it finishes.');
    assert.equal((await s.call('GET', `/api/overlay?projectId=${id}`)).json.bar.lined, 1);
    assert.equal((await s.call('GET', `/api/overlay?projectId=${id}`)).json.bar.waiting, 1, 'the bar says it waits for you');
    await s.call('POST', `/api/requests/${req.id}/respond`, { decision: 'allow' });
    // the next one goes by itself, and asks in its turn
    const req2 = await until(async () => (await s.call('GET', '/api/requests?status=pending')).json.requests.find((r) => r.id !== req.id));
    assert.ok(req2, 'the lined-up message was sent');
    await s.call('POST', `/api/requests/${req2.id}/respond`, { decision: 'deny' });
    assert.ok(await quiet());
    assert.deepEqual((await chat()).filter((m) => m.role === 'user').slice(-2).map((m) => m.text), ['check the build', 'then say what changed']);
  } finally {
    delete process.env.FAKE_CLAUDE;
    await s.close();
    rmDir(root);
  }
});
