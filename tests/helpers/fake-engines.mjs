// Stand-ins for the Copilot (ACP), Codex (app-server) and agy CLIs. Run as: node fake-engines.mjs <acp|codex|agy> [args]
// The shapes come from the real recordings and schemas in docs/research/engines.md.
// FAKE_ENGINE_COMMAND is the shell command the fake asks permission for; FAKE_ENGINE_DENIED makes agy report a denied action.
import readline from 'node:readline';

const kind = process.argv[2];
const rest = process.argv.slice(3);
const command = process.env.FAKE_ENGINE_COMMAND || 'echo hello';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (rest[0] === '--version') { console.log(`${kind}-fake 1.0.0`); process.exit(0); }
if (kind === 'codex' && rest[0] === 'login') { console.log(process.env.FAKE_ENGINE_LOGGEDOUT ? 'Not logged in' : 'Logged in using ChatGPT'); process.exit(process.env.FAKE_ENGINE_LOGGEDOUT ? 1 : 0); }
if (kind === 'agy' && rest[0] === 'models') { console.log('gemini-fake'); process.exit(0); }

const rl = readline.createInterface({ input: process.stdin });
const waiting = new Map();
let nextId = 1000;
const ask = (method, params, jsonrpc) => new Promise((resolve) => {
  const id = nextId++;
  waiting.set(id, resolve);
  out({ ...(jsonrpc ? { jsonrpc: '2.0' } : {}), id, method, params });
});

rl.on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method === undefined) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); return; }
  if (kind === 'acp') await acp(m);
  else if (kind === 'codex') await codex(m);
  else if (kind === 'agy') agy(m);
});

async function acp(m) {
  const reply = (result) => out({ jsonrpc: '2.0', id: m.id, result });
  if (m.method === 'initialize') return reply({ protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } });
  if (m.method === 'session/new') return reply({ sessionId: 'acp-1' });
  if (m.method === 'session/load') return m.params.sessionId === 'acp-1' ? reply({}) : out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown session' } });
  if (m.method === 'session/prompt') {
    const sid = m.params.sessionId;
    const update = (u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: u } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me run that. ' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Run requested command', kind: 'execute', status: 'pending', rawInput: { command } });
    const res = await ask('session/request_permission', { sessionId: sid, toolCall: { toolCallId: 'call_1', title: 'Run requested command', kind: 'execute', status: 'pending', rawInput: { command } }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' }, { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }] }, true);
    const allowed = res?.outcome?.outcome === 'selected' && res.outcome.optionId === 'allow_once';
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: allowed ? 'completed' : 'failed' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'It ran.' : 'It was refused.' } });
    update({ sessionUpdate: 'usage_update', used: 12000, size: 200000 });
    return reply({ stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 7, totalTokens: 107 } });
  }
  if (m.id !== undefined) reply({});
}

async function codex(m) {
  const reply = (result) => out({ id: m.id, result });
  if (m.method === 'initialize') return reply({ userAgent: 'codex-fake' });
  if (m.method === 'initialized') return;
  if (m.method === 'thread/start' || m.method === 'thread/resume') return reply({ thread: { id: m.params.threadId || 'thr-1' } });
  if (m.method === 'turn/start') {
    reply({ turn: { id: 'turn-1' } });
    out({ method: 'item/agentMessage/delta', params: { delta: 'Running it. ' } });
    out({ method: 'item/started', params: { item: { id: 'item-1', type: 'commandExecution', command } } });
    const res = await ask('item/commandExecution/requestApproval', { threadId: m.params.threadId, itemId: 'item-1', command, cwd: process.cwd() }, false);
    const ok = res?.decision === 'accept';
    out({ method: 'item/completed', params: { item: { id: 'item-1', type: 'commandExecution', status: ok ? 'completed' : 'failed' } } });
    out({ method: 'item/agentMessage/delta', params: { delta: ok ? 'Done.' : 'Declined.' } });
    out({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 50, outputTokens: 5 }, last: { totalTokens: 55 }, modelContextWindow: 1000 } } });
    out({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    return;
  }
  if (m.id !== undefined) reply({});
}

function agy(m) {
  if (m.event !== 'user') return;
  out({ event: 'init', conversation_id: 'conv-1', init: { model: 'gemini-fake', cwd: process.cwd(), tools: [] } });
  out({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'pong' } });
  out({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 12, output_tokens: 3 } } });
  out({ event: 'result', conversation_id: 'conv-1', denied_actions: process.env.FAKE_ENGINE_DENIED ? [{ permission: 'command' }] : [] });
  process.exit(0);
}
