// "Terminal": the window a conversation runs in is brought forward when one is open; otherwise a new terminal in the
// folder carries the newest conversation on (claude --resume <id>), never while Circle Studio is answering in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';
import { writeConversation } from '../helpers/fake-history.mjs';
import { resumeScript } from '../../backend/lib/terminal.mjs';
import { createCodexAdapter } from '../../backend/lib/engines/codex.mjs';
import path from 'node:path';

const ID = '11111111-2222-3333-4444-555555555555';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Terminal resumes the displayed saved Codex conversation and forks a pending copy without moving another selection', async () => {
  const s = await startServer({ adapters: () => [createCodexAdapter({ bin: process.execPath, prefixArgs: [path.resolve('tests/helpers/fake-engines.mjs'), 'codex'] })] });
  const root = makeMiniProject(); const launched = [];
  s.app.overrides.findWindow = async () => ({ found: false });
  s.app.overrides.spawnTerminal = (bin, args) => { launched.push(Buffer.from(args[1], 'base64').toString('utf16le')); return {}; };
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { engine: true } })).json.project.id;
    const key = s.app.sessions.chatKey(id, null, 'codex');
    const original = await s.app.chats.append(key, [{ role: 'user', engine: 'codex', text: 'First thread' }], 'first-provider-thread');
    const copy = await s.app.chats.link(key, { id: 'first-provider-thread', title: 'Reviewed copy', engine: 'codex' });
    await s.app.chats.reset(key);
    const selected = await s.app.chats.append(key, [{ role: 'user', engine: 'codex', text: 'Other thread' }], 'other-provider-thread');
    const first = await s.call('POST', '/api/desktop/terminal', { projectId: id, engine: 'codex', conversationId: original.conversationId, model: 'dummy-codex-balanced', reasoning: 'medium' });
    assert.equal(first.json.opened, true);
    assert.match(launched[0], /codex resume 'first-provider-thread'/);
    assert.match(launched[0], /model_reasoning_effort="medium"/);
    assert.equal(s.app.chats.get(key).conversationId, selected.conversationId);
    const forked = await s.call('POST', '/api/desktop/terminal', { projectId: id, engine: 'codex', conversationId: copy.conversationId });
    assert.equal(forked.json.opened, true, JSON.stringify(forked.json));
    assert.match(launched[1], /codex resume 'fake-codex-copy-1'/);
    assert.equal(s.app.chats.read(key, original.conversationId).sessionId, 'first-provider-thread');
    assert.equal(s.app.chats.read(key, copy.conversationId).fork, false);
    assert.equal(s.app.chats.get(key).conversationId, selected.conversationId, 'forking a viewed copy leaves the active selection intact');
    const invalid = await s.call('POST', '/api/desktop/terminal', { projectId: id, engine: 'codex', conversationId: '00000000-0000-0000-0000-000000000000' });
    assert.equal(invalid.status, 404);
    assert.equal(launched.length, 2, 'missing saved conversations cannot open a different thread');
  } finally { await s.close(); rmDir(root); }
});

test('what a new terminal runs: into the folder (quotes kept safe), then Claude on that conversation', () => {
  const s = resumeScript({ folder: "C:\\Users\\o'neil\\my app", sessionId: ID, title: 'Fix it' });
  assert.match(s, /Set-Location -LiteralPath 'C:\\Users\\o''neil\\my app'/);
  assert.match(s, new RegExp(`claude --resume ${ID}$`));
  assert.match(resumeScript({ folder: 'C:\\x' }), /; claude$/);
  assert.throws(() => resumeScript({ folder: 'C:\\x', sessionId: 'x; Remove-Item C:\\' }), /not valid/);
  const codex = resumeScript({ folder: 'C:\\x', engine: 'codex', sessionId: ID, model: 'dummy-codex', reasoning: 'high' });
  assert.ok(codex.endsWith(`codex resume '${ID}' --model 'dummy-codex' -c 'model_reasoning_effort="high"'`));
  assert.throws(() => resumeScript({ folder: 'C:\\x', engine: 'codex', reasoning: 'high; bad' }), /not valid/);
});

test('the terminal: shown when open, a new one that carries it on when not, never while it answers', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  const spawned = [];
  let window = null;
  const asked = [];
  s.app.overrides.findWindow = async ({ folder, titles, only }) => (asked.push(only), window ? { found: true, kind: window.kind, app: window.kind, title: window.title, how: 'session', folder, titles } : { found: false });
  s.app.overrides.spawnTerminal = (bin, args) => { spawned.push(args); return {}; };
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true, run: true, claude: true } })).json.project.id;
    writeConversation(s.claudeHome, root, { id: ID, title: 'Build the shop', turns: [['Start with the cart', 'The cart works.']], at: new Date().toISOString() });

    // a terminal titled with the conversation is open: it comes forward, nothing new opens
    window = { kind: 'terminal', title: 'claude' };
    let r = (await s.call('POST', '/api/desktop/terminal', { projectId: id })).json;
    assert.deepEqual([r.shown, r.opened, r.app], [true, false, 'terminal']);
    assert.match(r.say.title, /^Showing the terminal/);
    assert.match(r.say.lines[0], /Claude Code is working there/);
    assert.equal(spawned.length, 0);

    // none open: show says so; auto opens one that carries "Build the shop" on
    window = null;
    r = (await s.call('POST', '/api/desktop/terminal', { projectId: id, mode: 'show' })).json;
    assert.deepEqual([r.shown, r.opened], [false, false]);
    assert.match(r.say.lines[0], /\/terminal new/);
    r = (await s.call('POST', '/api/desktop/terminal', { projectId: id })).json;
    assert.deepEqual([r.opened, r.resumed], [true, 'Build the shop']);
    const script = Buffer.from(spawned[0][1], 'base64').toString('utf16le');
    assert.match(script, new RegExp(`claude --resume ${ID}`));
    assert.ok(script.includes(root.replace(/'/g, "''")));

    // from the bar too
    assert.match((await s.call('POST', '/api/overlay/command', { projectId: id, text: '/terminal', from: 'bar' })).json.say.title, /^Opened a terminal with this chat: "Build the shop"/);
    assert.ok(asked.every((o) => o === 'terminal'), 'only terminals are looked for: an editor is not a terminal');

    // while Circle Studio answers in that chat: refused (two Claudes would talk over each other)
    process.env.FAKE_CLAUDE = 'bash';
    await s.call('POST', '/api/overlay/command', { projectId: id, text: 'go', from: 'bar' });
    for (let i = 0; i < 100 && !(await s.call('GET', '/api/requests?status=pending')).json.requests.length; i++) await sleep(50);
    const before = spawned.length;
    r = (await s.call('POST', '/api/desktop/terminal', { projectId: id, mode: 'new' })).json;
    assert.equal(r.opened, false);
    assert.match(r.say.title, /answering/);
    assert.equal(spawned.length, before);
    await s.call('POST', '/api/overlay/command', { projectId: id, text: '/stop', from: 'bar' });
    // the folder button on the cards
    assert.deepEqual((await s.call('POST', '/api/desktop/folder', { projectId: id })).json.folder, root);
  } finally {
    delete process.env.FAKE_CLAUDE;
    await s.close();
    rmDir(root);
  }
});
