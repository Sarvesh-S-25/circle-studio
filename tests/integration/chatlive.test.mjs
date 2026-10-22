// Knowing what goes on at any moment: a turn started anywhere is readable live (what was said, tools, what waits),
// the chat page beside your code says the same and how to answer, and the Chat box takes Circle Studio's /commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';
import { chatCommand } from '../../backend/lib/overlay.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, tries = 100) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(50); } return null; };

test('in a chat box only /words that are commands are ours; the rest goes to the agent', () => {
  assert.equal(chatCommand('/waiting').id, 'waiting');
  assert.deepEqual(chatCommand('/allow 2'), { id: 'allow', rest: '2' });
  assert.equal(chatCommand('/ask what now?').id, 'ask');
  assert.equal(chatCommand('allow 1'), null, 'no slash: a sentence for the agent');
  assert.equal(chatCommand('/compact'), null, "Claude Code's own command");
  assert.equal(chatCommand('//waiting'), null, 'two slashes send the word itself');
  assert.equal(chatCommand('what is /help for?'), null);
});

test('a turn sent from outside is live everywhere, the editor page shows it with how to answer, /allow answers it', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  process.env.FAKE_CLAUDE = 'bash';
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true, run: true, claude: true } })).json.project.id;
    assert.equal((await s.call('GET', `/api/projects/${id}/chat/live`)).json.turn, null);
    // the page beside your code exists once the editor was opened
    const ed = (await s.call('POST', '/api/desktop/editor', { projectId: id })).json;
    assert.ok(ed.opened === true || typeof ed.why === 'string');
    const page = path.join(s.dataDir, 'chat-view', `${id}.md`);
    assert.ok(fs.existsSync(page));
    assert.match(fs.readFileSync(page, 'utf8'), /\*\*Quiet\.\*\*/);

    assert.equal((await s.call('POST', '/api/overlay/say', { projectId: id, text: 'please check the build' })).json.sent, true);
    const turn = await until(async () => { const t = (await s.call('GET', `/api/projects/${id}/chat/live`)).json.turn; return t?.waiting.length ? t : null; });
    assert.ok(turn, 'the live turn shows what waits');
    assert.equal(turn.you, 'please check the build');
    assert.equal(turn.status, 'waiting');
    assert.equal(turn.waiting[0].kind, 'approval');

    const waitingPage = await until(() => { const t = fs.readFileSync(page, 'utf8'); return /Waiting for you/.test(t) && t; });
    assert.ok(waitingPage, 'the page says it waits');
    assert.match(waitingPage, /`\/allow 1`/);
    assert.match(waitingPage, /echo circle-live/);
    assert.match(waitingPage, /please check the build/);

    // the Chat box: a sentence is not ours, /waiting and /allow are
    assert.equal((await s.call('POST', '/api/overlay/command', { projectId: id, text: 'allow 1', from: 'chat' })).json.command, 'none');
    assert.equal((await s.call('POST', '/api/overlay/command', { projectId: id, text: '/compact', from: 'chat' })).json.command, 'none');
    assert.deepEqual((await s.call('POST', '/api/overlay/command', { projectId: id, text: '/ask hi there', from: 'chat' })).json.passthrough, 'hi there');
    const waitingSay = (await s.call('POST', '/api/overlay/command', { projectId: id, text: '/waiting', from: 'chat' })).json.say;
    assert.match(waitingSay.lines[0], /^1\. /);
    assert.ok(waitingSay.lines.some((l) => l.startsWith('/allow 1 · /deny 1')), 'in the chat the hints carry the slash');
    assert.equal((await s.call('POST', '/api/overlay/command', { projectId: id, text: '/allow 1', from: 'chat' })).json.say.title, 'Allowed.');

    assert.ok(await until(async () => (await s.call('GET', `/api/projects/${id}/chat/live`)).json.turn === null), 'the turn ends');
    const done = await until(() => { const t = fs.readFileSync(page, 'utf8'); return /\*\*Quiet\.\*\*/.test(t) && t; });
    assert.ok(done, 'the page is quiet again');
    assert.match(done, /### You/);
    assert.doesNotMatch(done, /Waiting for you/);
    // a tool that came as a whole message (not streamed) is still named in the saved chat
    const saved = (await s.call('GET', `/api/projects/${id}/chat`)).json.messages.find((m) => m.role === 'assistant');
    assert.match(saved.tools[0].summary, /echo circle-live/);
    assert.equal(saved.tools[0].ok, true);
  } finally {
    delete process.env.FAKE_CLAUDE;
    await s.close();
    rmDir(root);
  }
});
