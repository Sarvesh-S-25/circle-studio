// The Copilot (ACP), Codex (app-server) and agy adapters against fake CLIs, and the full popup flow through the broker.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createCopilotAdapter, acpTool } from '../../backend/lib/engines/copilot.mjs';
import { createCodexAdapter } from '../../backend/lib/engines/codex.mjs';
import { createAgyAdapter } from '../../backend/lib/engines/agy.mjs';
import { createClaudeAdapter } from '../../backend/lib/engines/claude.mjs';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';

const FAKE = path.resolve(import.meta.dirname, '..', 'helpers', 'fake-engines.mjs');
const copilot = () => createCopilotAdapter({ loader: FAKE, nodeBin: process.execPath, prefixArgs: ['acp'] });
const codex = () => createCodexAdapter({ bin: process.execPath, prefixArgs: [FAKE, 'codex'] });
const agy = () => createAgyAdapter({ bin: process.execPath, prefixArgs: [FAKE, 'agy'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function turn(adapter, decide, extra = {}) {
  const events = [];
  const asked = [];
  const outcome = await adapter.runTurn({
    cwd: process.cwd(), prompt: 'go', systemPrompt: 'be brief', runId: 'run_1', emit: (n, d) => events.push([n, d]),
    onRequest: async (req) => { asked.push(req); return decide(req); }, ...extra,
  });
  return { events, asked, outcome, names: events.map((e) => e[0]), text: events.filter((e) => e[0] === 'text').map((e) => e[1].delta).join('') };
}

test('acpTool turns Copilot tool calls into the tools the policy knows', () => {
  assert.deepEqual(acpTool({ kind: 'execute', rawInput: { command: 'ls' } }), { tool: 'Bash', input: { command: 'ls' } });
  assert.equal(acpTool({ kind: 'execute', rawInput: { commands: ['a', 'b'] } }).input.command, 'a && b');
  assert.equal(acpTool({ kind: 'edit', locations: [{ path: 'x.js' }] }).input.file_path, 'x.js');
  assert.equal(acpTool({ kind: 'edit' }).input.unknownPath, true, 'an edit with no path is flagged, not guessed');
  assert.equal(acpTool({ kind: 'fetch', title: 'get' }).tool, 'Copilot:fetch');
});

test('copilot over ACP: a permission request reaches the app and the answer goes back', async () => {
  const yes = await turn(copilot(), () => ({ decision: 'allow' }));
  assert.equal(yes.outcome.status, 'done');
  assert.deepEqual([yes.asked[0].tool, yes.asked[0].input.command], ['Bash', 'echo hello']);
  assert.equal(yes.text, 'Let me run that. It ran.');
  assert.deepEqual(yes.names.filter((n) => ['session', 'tool', 'usage', 'done'].includes(n)), ['session', 'tool', 'tool', 'usage', 'usage', 'done']);
  assert.equal(yes.events.find((e) => e[0] === 'usage' && e[1].contextWindow)[1].contextWindow, 200000);
  const no = await turn(copilot(), () => ({ decision: 'deny' }));
  assert.equal(no.text, 'Let me run that. It was refused.');
  assert.equal(no.events.filter((e) => e[0] === 'tool' && e[1].status === 'end')[0][1].ok, false);
});

test('copilot resume: a known session is loaded, an unknown one starts fresh with a notice', async () => {
  const known = await turn(copilot(), () => ({ decision: 'allow' }), { sessionId: 'acp-1' });
  assert.equal(known.outcome.sessionId, 'acp-1');
  assert.ok(!known.names.includes('notice'));
  const unknown = await turn(copilot(), () => ({ decision: 'allow' }), { sessionId: 'gone' });
  assert.ok(unknown.events.some((e) => e[0] === 'notice' && /could not be resumed/.test(e[1].message)));
  assert.equal(unknown.outcome.status, 'done');
});

test('codex over app-server: approvals are answered accept or decline, usage carries the context window', async () => {
  const yes = await turn(codex(), () => ({ decision: 'allow' }));
  assert.equal(yes.outcome.status, 'done');
  assert.deepEqual([yes.asked[0].tool, yes.asked[0].input.command], ['Bash', 'echo hello']);
  assert.equal(yes.text, 'Running it. Done.');
  assert.equal(yes.events.find((e) => e[0] === 'usage')[1].contextWindow, 1000);
  assert.equal(yes.outcome.sessionId, 'thr-1');
  const no = await turn(codex(), () => ({ decision: 'deny' }));
  assert.equal(no.text, 'Running it. Declined.');
  assert.equal((await turn(codex(), () => ({ decision: 'allow' }), { sessionId: 'thr-9' })).outcome.sessionId, 'thr-9');
});

test('codex detection: signed in, signed out, missing', async () => {
  assert.deepEqual(await codex().detect().then((d) => [d.installed, d.loggedIn]), [true, true]);
  process.env.FAKE_ENGINE_LOGGEDOUT = '1';
  try { assert.equal((await codex().detect()).loggedIn, false); } finally { delete process.env.FAKE_ENGINE_LOGGEDOUT; }
  assert.equal((await createCodexAdapter({ bin: 'circle-no-such-cli' }).detect()).installed, false);
  assert.equal(codex().capabilities.liveVerified, false, 'Codex is labelled as not live-tested');
});

test('agy answers but cannot ask: a refused action is reported plainly', async () => {
  const ok = await turn(agy(), () => ({ decision: 'allow' }));
  assert.equal(ok.text, 'pong');
  assert.deepEqual(ok.asked, []);
  assert.equal(ok.outcome.sessionId, 'conv-1');
  assert.ok(!ok.names.includes('notice'));
  process.env.FAKE_ENGINE_DENIED = '1';
  try {
    const denied = await turn(agy(), () => ({ decision: 'allow' }));
    assert.match(denied.events.find((e) => e[0] === 'notice')[1].message, /cannot ask you for permission/);
  } finally { delete process.env.FAKE_ENGINE_DENIED; }
  assert.deepEqual([agy().capabilities.shell, agy().capabilities.approvals], ['none', 'none']);
});

test('stopping a run kills the engine process', async () => {
  const ctl = new AbortController();
  const a = copilot();
  const run = a.runTurn({ cwd: process.cwd(), prompt: 'go', systemPrompt: '', signal: ctl.signal, emit: () => {}, onRequest: () => new Promise(() => {}) });
  await sleep(600);
  ctl.abort();
  assert.equal((await run).status, 'stopped');
});

test('through the broker: a Copilot command shows up as a popup, and Codex without a login is refused', async () => {
  const s = await startServer({ adapters: (claude) => [createClaudeAdapter({ service: claude, bin: claude.bin, prefixArgs: claude.prefix }), copilot(), codex()] });
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true, run: true, claude: true } })).json.project.id;
    const run = s.sse('/api/chat', { projectId: id, message: 'run it', engine: 'copilot' });
    let req;
    for (let i = 0; i < 100 && !req; i++) { req = (await s.call('GET', `/api/requests?status=pending&projectId=${id}`)).json.requests[0]; await sleep(50); }
    assert.deepEqual([req.engine, req.tool, req.detail], ['copilot', 'Bash', 'echo hello']);
    await s.call('POST', `/api/requests/${req.id}/respond`, { decision: 'allow' });
    const r = await run;
    assert.equal(r.events.filter((e) => e.event === 'text').map((e) => e.data.delta).join(''), 'Let me run that. It ran.');
    const stored = (await s.call('GET', `/api/projects/${id}/chat?engine=copilot`)).json;
    assert.equal(stored.messages.length, 2, 'each engine keeps its own transcript');
    assert.equal((await s.call('GET', `/api/projects/${id}/chat`)).json.messages.length, 0);

    process.env.FAKE_ENGINE_LOGGEDOUT = '1';
    await s.call('POST', '/api/engines/check', {});
    const list = (await s.call('GET', '/api/engines')).json.engines;
    assert.deepEqual(list.map((e) => [e.id, e.usable]), [['claude', true], ['copilot', true], ['codex', false]]);
    assert.ok(list.every((e) => !JSON.stringify(e).includes('someone@example.test')), 'no e-mail in the engine list');
    const c = await s.call('POST', '/api/chat', { projectId: id, message: 'x', engine: 'codex' });
    assert.equal(c.status, 503);
    assert.match(c.json.error.message, /not signed in/);
  } finally { delete process.env.FAKE_ENGINE_LOGGEDOUT; await s.close(); rmDir(root); }
});
