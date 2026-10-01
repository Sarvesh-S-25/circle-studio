// The Claude Code conversations a human had in a folder outside the app: listed, read (redacted), and continued in a
// chat as a fork so the original transcript is never changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';
import { writeConversation } from '../helpers/fake-history.mjs';
import { TRACE, runsOf, has, after } from '../helpers/trace.mjs';

const ALL = { write: true, run: true, claude: true };
const SID = '0b5da320-50f4-46c7-82d1-9f24bcb77565';
const OLD = '19da6996-a16d-430d-bd11-84424f9dec96';

test('history: lists, reads, redacts and continues Claude Code conversations as a fork', async () => {
  const log = TRACE();
  process.env.FAKE_CLAUDE_LOG = log;
  const s = await startServer();
  const root = makeMiniProject();
  try {
    const file = writeConversation(s.claudeHome, root, {
      id: SID, title: 'Plan the build',
      turns: [['How do we start?', 'Read the brief first.', 'docs/brief.md'], ['My key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ok?', 'Never paste keys here.']],
      agents: [{ run: 'agent-abc123', agentType: 'planner', description: 'Plan phase 2', prompt: 'Plan it', answer: 'Here is the plan.' }],
    });
    const old = writeConversation(s.claudeHome, root, { id: OLD, turns: [['<command-name>/mcp</command-name>', 'No servers.']] });
    fs.utimesSync(old, new Date('2026-09-01'), new Date('2026-09-01'));
    const before = fs.readFileSync(file, 'utf8');
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;

    const list = (await s.call('GET', `/api/projects/${id}/history`)).json;
    assert.equal(list.conversations.length, 2);
    assert.equal(list.conversations[0].id, SID, 'newest first');
    assert.equal(list.conversations[0].title, 'Plan the build');
    assert.equal(list.conversations[1].title, '/mcp', 'a slash command reads as itself');
    assert.equal(list.conversations[0].agents[0].agentType, 'planner');
    assert.match(list.folder, /^~\/\.claude\/projects\//);

    const one = (await s.call('GET', `/api/projects/${id}/history/${SID}`)).json;
    assert.deepEqual(one.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant'], 'tool results and synthetic replies are left out');
    assert.equal(one.messages[1].tools[0].summary, 'Read docs/brief.md');
    assert.ok(!JSON.stringify(one).includes('sk-ant-api03-AAAA'), 'secrets are redacted');

    const run = (await s.call('GET', `/api/projects/${id}/history/${SID}?run=agent-abc123`)).json;
    assert.deepEqual(run.messages.map((m) => m.text), ['Plan it', 'Here is the plan.']);
    assert.equal((await s.call('GET', `/api/projects/${id}/history/not-a-session`)).status, 400);
    assert.equal((await s.call('GET', `/api/projects/${id}/history/${SID}?run=..%2F..%2Fx`)).status, 400);

    // continue it in the main chat: the first turn resumes it with --fork-session, the next one resumes the fork
    const linked = await s.call('POST', `/api/projects/${id}/chat/link`, { sessionId: SID });
    assert.equal(linked.status, 200);
    assert.equal((await s.call('GET', `/api/projects/${id}/chat`)).json.linked.id, SID);
    assert.equal((await s.call('POST', `/api/projects/${id}/chat/link`, { sessionId: '11111111-1111-1111-1111-111111111111' })).status, 404);
    const first = await s.sse('/api/chat', { projectId: id, message: 'carry on' });
    const forked = first.events.at(-1).data.sessionId;
    assert.ok(forked && forked !== SID);
    await s.sse('/api/chat', { projectId: id, message: 'and then?' });
    const turns = runsOf(log).filter((x) => has(x.args, '-p') && x.prompt !== undefined);
    assert.equal(after(turns[0].args, '--resume'), SID);
    assert.ok(has(turns[0].args, '--fork-session'), 'the first turn forks');
    assert.equal(after(turns[1].args, '--resume'), forked);
    assert.ok(!has(turns[1].args, '--fork-session'), 'later turns continue the fork');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the original transcript is untouched');

    // a node of kind agent sees the runs of its agent type
    const wf = (await s.call('GET', `/api/projects/${id}/workflow`)).json;
    const agent = wf.workflow?.nodes?.find((n) => n.kind === 'agent');
    if (agent) {
      const mine = (await s.call('GET', `/api/projects/${id}/history?nodeId=${agent.id}`)).json;
      assert.equal(mine.agentRuns.length, agent.id === 'planner' || agent.title === 'planner' ? 1 : 0);
    }
  } finally {
    delete process.env.FAKE_CLAUDE_LOG;
    await s.close();
    rmDir(root);
  }
});
