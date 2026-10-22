// New chat and carrying on an earlier conversation, without a terminal: the chat window's main chat shows your newest
// Claude Code conversation in the folder and a reply carries that one on; New chat starts a new page (the earlier ones
// stay in the folder); Earlier chats takes any of them up again. The overlay does the same with new, chats, continue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { writeConversation } from '../helpers/fake-history.mjs';
import { folderKey } from '../../backend/lib/cchistory.mjs';

const ALL = { write: true, run: true, claude: true };
const OLD = '1b5da320-50f4-46c7-82d1-9f24bcb77561';
const NEW = '2b5da320-50f4-46c7-82d1-9f24bcb77562';

test('main chat: carry on what is shown, start a new chat, take up an earlier one (window and overlay)', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  try {
    writeConversation(s.claudeHome, root, { id: OLD, title: 'Fix the login', turns: [['Fix the login', 'Fixed.']], at: '2026-09-01T10:00:00.000Z' });
    writeConversation(s.claudeHome, root, { id: NEW, title: 'Build the shop', turns: [['Start with the cart', 'The cart works.']], at: '2026-09-20T10:00:00.000Z' });
    // their age is the file's, as Claude Code writes them
    const dir = path.join(s.claudeHome, 'projects', folderKey(root));
    fs.utimesSync(path.join(dir, `${OLD}.jsonl`), new Date('2026-09-01T10:00:00Z'), new Date('2026-09-01T10:00:00Z'));
    fs.utimesSync(path.join(dir, `${NEW}.jsonl`), new Date('2026-09-20T10:00:00Z'), new Date('2026-09-20T10:00:00Z'));
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    const chat = async () => (await s.call('GET', `/api/widgets/chat?projectId=${id}&size=l`)).json;
    const cmd = async (text) => (await s.call('POST', '/api/overlay/command', { text, projectId: id })).json;

    // the newest conversation from the terminal shows, and a reply would carry it on
    let c = await chat();
    assert.equal(c.title, 'Build the shop');
    assert.equal(c.continueId, NEW);
    assert.equal(c.fresh, false);

    // New chat: an empty page that shows instead, nothing to carry on
    assert.equal((await s.call('DELETE', `/api/projects/${id}/chat`)).status, 200);
    c = await chat();
    assert.deepEqual([c.fresh, c.continueId, c.messages.length], [true, null, 0]);
    assert.match(c.empty, /new chat/i);

    // Earlier chats: the older one, taken up again, shows with what was said, and is not "to carry on" any more
    const list = (await s.call('GET', `/api/projects/${id}/history`)).json.conversations;
    assert.deepEqual(list.map((x) => x.id), [NEW, OLD]);
    assert.equal((await s.call('POST', `/api/projects/${id}/chat/link`, { sessionId: OLD })).status, 200);
    c = await chat();
    assert.equal(c.title, 'Fix the login');
    assert.equal(c.continueId, null);
    assert.deepEqual(c.messages.map((m) => m.text), ['Fix the login', 'Fixed.']);

    // the overlay: chats lists them numbered, continue 1 takes up the newest, new starts again
    const ch = await cmd('chats');
    assert.match(ch.say.lines[0], /^1\. Build the shop/);
    assert.match(ch.say.lines[1], /^2\. Fix the login/);
    assert.match((await cmd('continue 1')).say.title, /Build the shop/);
    assert.equal((await chat()).title, 'Build the shop');
    assert.equal((await cmd('continue nothing like it')).say.tone, 'warn');
    assert.match((await cmd('new')).say.title, /^New chat/);
    assert.equal((await chat()).fresh, true);
    assert.equal((await cmd('folder')).open, '#/open-folder');

    // a sentence in the overlay, while a newer terminal conversation shows: it carries that one on, and is answered
    const LATEST = '3b5da320-50f4-46c7-82d1-9f24bcb77563';
    writeConversation(s.claudeHome, root, { id: LATEST, title: 'Write the docs', turns: [['Write the docs', 'Started.']] });
    assert.equal((await chat()).continueId, LATEST);
    const sent = await cmd('please go on with the docs');
    assert.match(sent.say.lines.join(' '), /carries on "Write the docs"/);
    let live = null;
    for (let i = 0; i < 100 && !live?.done; i++) { await new Promise((r) => setTimeout(r, 50)); live = (await s.call('GET', `/api/overlay?projectId=${id}`)).json.live; }
    assert.equal(live.done, true);
    assert.equal(live.error, null);
    const after = await chat();
    assert.equal(after.continueId, null, 'now in that conversation: nothing more to carry on');
    assert.deepEqual(after.messages.slice(0, 3).map((m) => m.text), ['Write the docs', 'Started.', 'please go on with the docs'], 'what was said before it came here, then here');
  } finally {
    await s.close();
    rmDir(root);
  }
});
