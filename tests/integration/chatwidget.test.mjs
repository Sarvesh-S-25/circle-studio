// The Chat widget and switching tiles: a project's main chat (its newest Claude Code conversation), its agents' chats
// (a run inside that conversation, or the agent's chat in Circle Studio), one shown at a time; switching a tile's
// project or chat saves only that tile; the desktop feed carries the same, with keys that survive a switch; and desktop
// widgets started from older code are restarted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, tempDir, rmDir } from '../helpers/project.mjs';
import { writeConversation } from '../helpers/fake-history.mjs';
import { desktopWidgets, hostVersion } from '../../backend/lib/deskhost.mjs';

const ALL = { write: true, run: true, claude: true };
const SID = '0b5da320-50f4-46c7-82d1-9f24bcb77565';

test('chat widget: main chat, agents\' chats, one at a time; switching saves just that tile; the feed matches', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  try {
    writeConversation(s.claudeHome, root, {
      id: SID, title: 'Build the shop',
      turns: [['Start with the cart', 'Done: the cart works.'], ['My key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ok?', 'Never paste keys here.']],
      agents: [{ run: 'agent-abc123', agentType: 'planner', description: 'Plan phase 2', prompt: 'Plan it', answer: 'Here is the plan.' }, { run: 'agent-def456', agentType: 'Explore', description: 'Look around', prompt: 'Find the tests', answer: 'They are in tests/.' }],
    });
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    const wf = { nodes: [{ id: 'you', kind: 'human', title: 'You' }, { id: 'build', kind: 'stage', title: 'Build' }, { id: 'planner', kind: 'agent', title: 'Planner', parent: 'build', engine: 'claude' }, { id: 'reviewer', kind: 'agent', title: 'Reviewer', parent: 'build', engine: 'claude' }, { id: 'quiet', kind: 'agent', title: 'Quiet one', parent: 'build', engine: 'claude' }], edges: [{ from: 'you', to: 'build' }] };
    assert.equal((await s.call('PUT', `/api/projects/${id}/workflow`, { workflow: wf, note: 'test' })).status, 200);
    await s.app.chats.append(s.app.sessions.chatKey(id, 'reviewer', 'claude'), [{ role: 'user', text: 'Review the cart', at: '2026-10-02T10:00:00Z' }, { role: 'assistant', text: 'Two issues found.', at: '2026-10-02T10:01:00Z' }], null);

    const main = (await s.call('GET', `/api/widgets/chat?projectId=${id}&size=m`)).json;
    assert.deepEqual(main.threads.map((t) => t.id), ['main', 'node:planner', 'node:reviewer', 'run:Explore'], 'only agents that have a chat, and other agents the conversation used');
    assert.equal(main.selected, 'main');
    assert.deepEqual(main.messages.map((m) => [m.who, m.mine]), [['Claude', false], ['You', true], ['Claude', false]], 'the last three for a medium tile');
    assert.ok(!JSON.stringify(main).includes('sk-ant-api03-AAAA'), 'keys are masked');
    const planner = (await s.call('GET', `/api/widgets/chat?projectId=${id}&nodeId=node:planner&size=l`)).json;
    assert.deepEqual(planner.messages.map((m) => [m.who, m.text]), [['Main chat', 'Plan it'], ['Planner', 'Here is the plan.']], 'a run is asked by the main chat');
    const reviewer = (await s.call('GET', `/api/widgets/chat?projectId=${id}&nodeId=node:reviewer`)).json;
    assert.deepEqual(reviewer.messages.map((m) => m.text), ['Review the cart', 'Two issues found.']);
    assert.equal((await s.call('GET', `/api/widgets/chat?projectId=${id}&nodeId=node:gone`)).json.selected, 'main', 'an unknown chat falls back to the main one');

    // tiles: a chat tile comes in medium or large; switching saves only that tile
    assert.equal((await s.call('PUT', '/api/settings', { widgets: [{ kind: 'chat', size: 's' }] })).status, 400);
    await s.call('PUT', '/api/settings', { widgets: [{ kind: 'spend', size: 'm' }, { kind: 'chat', size: 'm', projectId: id }] });
    assert.equal((await s.call('POST', '/api/widgets/pick', { index: 1, nodeId: 'node:reviewer' })).json.widget.nodeId, 'node:reviewer');
    assert.equal((await s.call('POST', '/api/widgets/pick', { index: 0, nodeId: 'main' })).status, 400, 'only the chat tile switches chats');
    assert.equal((await s.call('POST', '/api/widgets/pick', { index: 0, projectId: id })).status, 400, 'spending shows no project');
    assert.equal((await s.call('POST', '/api/widgets/pick', { index: 1, projectId: 'nope' })).status, 400);
    assert.equal((await s.call('POST', '/api/widgets/pick', { index: 9, nodeId: 'main' })).status, 400);

    // the desktop feed: the same chat, the tile's index, and a key that does not name the project
    const feed = (await s.call('GET', '/api/widgets/feed')).json;
    const tile = feed.tiles.find((t) => t.kind === 'chat');
    assert.equal(tile.key, 'chat:m:1');
    assert.equal(tile.index, 1);
    assert.equal(tile.projectId, id);
    assert.equal(tile.canPick, false, 'one project: nothing to switch to');
    assert.equal(tile.chat.selected, 'node:reviewer');
    assert.deepEqual(tile.chat.threads.filter((t) => t.on).map((t) => t.id), ['node:reviewer']);
    assert.equal(tile.url, `#/projects/${id}/chat`);
    assert.deepEqual(feed.projects.map((p) => p.id), [id]);
  } finally {
    await s.close();
    rmDir(root);
  }
});

test('desktop widgets started from older code are restarted; current ones are left alone', { skip: process.platform !== 'win32' }, () => {
  const dataDir = tempDir('cs-dw-');
  try {
    const appRoot = path.resolve(import.meta.dirname, '..', '..');
    fs.writeFileSync(path.join(dataDir, 'desktop-widgets.pid'), String(process.pid)); // "running"
    fs.writeFileSync(path.join(dataDir, 'desktop-widgets.version'), 'from-an-older-copy');
    const spawned = [];
    const killed = [];
    const host = desktopWidgets({ appRoot, port: 4380, dataDir }, { spawnImpl: (f, a) => { spawned.push(a); return { on() {}, unref() {} }; }, killImpl: (pid) => killed.push(pid) });
    const r = host.start();
    assert.equal(r.restarted, true);
    assert.deepEqual(killed, [process.pid], 'the old ones were stopped');
    assert.equal(spawned.length, 1, 'and new ones started');
    assert.equal(fs.readFileSync(path.join(dataDir, 'desktop-widgets.version'), 'utf8'), hostVersion(appRoot));
    fs.writeFileSync(path.join(dataDir, 'desktop-widgets.pid'), String(process.pid));
    assert.equal(host.start().running, true);
    assert.equal(spawned.length, 1, 'already current: not started twice');
  } finally {
    rmDir(dataDir);
  }
});
