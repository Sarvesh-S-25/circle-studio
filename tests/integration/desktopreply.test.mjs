// Answering from the desktop: an answer that comes back while no window is open becomes a card (what you asked, what
// it said, masked), a reply typed on the card goes to that chat, and the editor opens at the file the agent worked on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, tempDir, rmDir } from '../helpers/project.mjs';
import { workingFile } from '../../backend/lib/ide.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a reply from the desktop goes to the chat; its answer comes back as a card; Open in editor answers', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true, run: true, claude: true } })).json.project.id;
    assert.deepEqual((await s.call('GET', '/api/desktop/replies')).json.replies, []);
    assert.equal((await s.call('POST', '/api/overlay/say', { projectId: id, text: '' })).status, 400);
    const sent = (await s.call('POST', '/api/overlay/say', { projectId: id, text: 'what is in this folder?' })).json;
    assert.equal(sent.sent, true);
    let reps = [];
    for (let i = 0; i < 100 && !reps.length; i++) { await sleep(50); reps = (await s.call('GET', '/api/desktop/replies')).json.replies; }
    assert.equal(reps.length, 1, 'the answer is waiting as a card');
    assert.equal(reps[0].projectId, id);
    assert.equal(reps[0].asked, 'what is in this folder?');
    assert.ok(reps[0].text.length > 0);
    assert.ok(!reps[0].text.includes('**'), 'plain words, no Markdown marks');
    // closed: gone
    assert.equal((await s.call('POST', '/api/desktop/replies/dismiss', { id: reps[0].id })).json.dismissed, true);
    assert.deepEqual((await s.call('GET', '/api/desktop/replies')).json.replies, []);
    // an agent that is not in the workflow is refused
    assert.equal((await s.call('POST', '/api/overlay/say', { projectId: id, nodeId: 'nobody', text: 'hi' })).status, 400);
    // the editor: opened (no window in tests) or a plain reason when none is installed
    const ed = (await s.call('POST', '/api/desktop/editor', { projectId: id })).json;
    assert.ok(ed.opened === true || typeof ed.why === 'string');
    // the overlay's chat box carries the conversation
    const talk = (await s.call('GET', `/api/overlay?projectId=${id}`)).json.talk;
    assert.ok(talk.messages.some((m) => m.mine && m.text === 'what is in this folder?'));
  } finally {
    await s.close();
    rmDir(root);
  }
});

test('the file an agent works on: written before read, inside the folder, and still there', () => {
  const root = tempDir('circle-ide-');
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.js'), '');
    fs.writeFileSync(path.join(root, 'b.md'), '');
    assert.equal(workingFile(root, ['Read b.md', 'Edit src/a.js', 'Read b.md']), path.join(root, 'src', 'a.js'));
    assert.equal(workingFile(root, ['Read b.md', 'Edit gone.js']), path.join(root, 'b.md'), 'a file that is gone is skipped');
    assert.equal(workingFile(root, ['Read ../outside.txt', `Read ${path.join(root, '..', 'x.txt')}`]), null, 'never outside the folder');
    assert.equal(workingFile(root, ['Run npm test', 'Grep "x"']), null);
  } finally {
    rmDir(root);
  }
});
