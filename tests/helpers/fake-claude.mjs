// A stand-in for the `claude` CLI. Run as: node fake-claude.mjs <the same arguments the app passes to claude>
// Chat speaks the real bidirectional protocol (docs/research/engines.md): one user JSON line on stdin, events on stdout,
// control_request lines for permissions and questions, control_response lines back. The default turn replays the real
// recording in tests/fixtures/claude/chat-read.jsonl. FAKE_CLAUDE selects a scenario:
//   slow         init and one text delta, then waits (to test stop / kill)
//   badsession   answers --resume with an error_during_execution result
//   secret       puts a key-shaped string in the text
//   echo-input   puts the prompt it received in the text (and, for the advisor, in the summary)
//   bash         asks to run FAKE_CLAUDE_COMMAND (default "echo circle-live"), then reports what happened
//   question     asks a question with AskUserQuestion, then reports the answer
//   crash        emits init then exits with code 1
//   loggedout    `claude auth status` says not signed in
// The arguments and the prompt are appended to FAKE_CLAUDE_LOG (one JSON line per run) when it is set.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const fixtures = path.resolve(import.meta.dirname, '..', 'fixtures', 'claude');
const mode = process.env.FAKE_CLAUDE || '';
const log = (extra = {}) => {
  if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, env: { key: process.env.ANTHROPIC_API_KEY ?? null, token: process.env.ANTHROPIC_AUTH_TOKEN ?? null, cc: process.env.CLAUDECODE ?? null, vault: process.env.TEST_VAULT_KEY ?? null }, cwd: process.cwd(), ...extra })}\n`);
};

if (args[0] === 'auth') {
  log();
  console.log(JSON.stringify({ loggedIn: mode !== 'loggedout', authMethod: 'claude.ai', subscriptionType: 'pro', email: 'someone@example.test', orgId: 'org-secret' }));
  process.exit(mode === 'loggedout' ? 1 : 0);
}
if (args[0] === '--version') { console.log('9.9.9 (Fake Claude)'); process.exit(0); }

process.stdin.setEncoding('utf8');

if (args.includes('--json-schema')) {
  // the advisor: the whole prompt on stdin, one JSON answer on stdout
  log();
  let input = '';
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    log({ prompt: input });
    if (input.startsWith('You fix a broken MCP server')) {
      // the connection fixer: points the config at the working mode of the fake server
      const out = { summary: 'The server is missing its Python package.', steps: ['Install the package', 'Test again'], commands: ['pip install fastapi'], config: { command: 'node', args: ['fake-mcp.mjs', 'ok'] }, codebase: [{ file: 'pyproject.toml', advice: 'List fastapi under dependencies.' }] };
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: out, result: JSON.stringify(out), modelUsage: { 'fake-model': {} }, total_cost_usd: 0.001, duration_ms: 5 }));
      return;
    }
    if (input.startsWith('You keep a catalog')) {
      // the catalog describer: one short line per id
      const items = [...input.matchAll(/- id: (.+)\n {2}type: (.+)\n {2}name: (.+)/g)].map((m) => ({ id: m[1], summary: `Use ${m[3]} for its ${m[2]} work.`, tags: [m[2]] }));
      const out = { items };
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: out, result: JSON.stringify(out), modelUsage: { 'fake-model': {} }, total_cost_usd: 0.0005, duration_ms: 5 }));
      return;
    }
    if (input.startsWith('CIRCLE-SKILL-NEEDS')) {
      // finding skills, step 1: one need for the first agent, searched as "react testing"
      const first = /^- ([a-z0-9-]+): /m.exec(input)?.[1];
      const out = { needs: [{ need: 'Testing React components', search: 'react testing', agents: first ? [first, 'not-an-agent'] : [] }] };
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: out, result: JSON.stringify(out), modelUsage: { 'fake-haiku': {} }, total_cost_usd: 0.0002, duration_ms: 5 }));
      return;
    }
    if (input.startsWith('CIRCLE-SKILL-PICK')) {
      // step 2: picks every candidate whose name mentions "test", plus one id that does not exist
      const first = /^- ([a-z0-9-]+): /m.exec(input)?.[1];
      const ids = [...input.matchAll(/^(c\d+) \| [^|]+ \| ([^:]+):/gm)].filter((m) => /test/.test(m[2])).map((m) => m[1]);
      const out = { note: 'Found a testing skill.', picks: [...ids.map((id) => ({ id, plain: 'Helps an agent write tests.', why: 'The team writes React code.', agents: first ? [first] : [] })), { id: 'c999', plain: 'x', why: 'y' }] };
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: out, result: JSON.stringify(out), modelUsage: { 'fake-haiku': {} }, total_cost_usd: 0.0003, duration_ms: 5 }));
      return;
    }
    if (input.startsWith('CIRCLE-WORKFLOW-HELPER')) {
      // the workflow helper: "lighter" drops optional agents, "review" puts a Codex check after the first stage
      const wf = JSON.parse(/<workflow>\n(.*)\n<\/workflow>/.exec(input)[1]);
      const said = /The human now says: (.*)/.exec(input)[1];
      let out = { reply: `You asked: ${said}`, changed: false };
      if (/lighter/i.test(said)) {
        wf.nodes = wf.nodes.filter((n) => !(n.kind === 'agent' && n.optional));
        out = { reply: 'Dropped the optional agents.', changed: true, workflow: wf };
      } else if (/review/i.test(said)) {
        const first = wf.nodes.find((n) => n.kind === 'stage');
        first.gate = { on: true, by: 'engine', engine: 'codex', label: 'the result has no gaps' };
        wf.nodes.push({ id: 'ghost', kind: 'agent', title: 'Ghost', parent: first.id, engine: 'claude', skills: ['not-in-library'] });
        out = { reply: 'Codex now checks the first stage.', changed: true, workflow: wf };
      }
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: out, result: JSON.stringify(out), modelUsage: { 'fake-model': {} }, total_cost_usd: 0.001, duration_ms: 5 }));
      return;
    }
    const j = JSON.parse(fs.readFileSync(path.join(fixtures, 'advisor.json'), 'utf8'));
    if (mode === 'echo-input') j.structured_output.summary = `INPUT:${input}`;
    process.stdout.write(JSON.stringify(j));
  });
} else {
  chat();
}

function chat() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (o) => console.log(JSON.stringify(o));
  const SESSION = 'fake-session-1';
  const init = { type: 'system', subtype: 'init', session_id: SESSION, model: 'fake-model', cwd: process.cwd() };
  const say = (text) => send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, session_id: SESSION });
  const result = (extra = {}) => send({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION, total_cost_usd: 0.001, duration_ms: 5, num_turns: 1, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 }, modelUsage: { 'fake-model': { inputTokens: 10, outputTokens: 5, contextWindow: 200000 } }, permission_denials: [], result: 'ok', ...extra });

  const waiting = new Map();
  const early = new Map();
  let started = false;
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'user' && !started) { started = true; turn(o); }
      else if (o.type === 'control_response') {
        const id = o.response?.request_id;
        if (waiting.has(id)) { waiting.get(id)(o.response.response); waiting.delete(id); } else early.set(id, o.response.response);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
  setTimeout(() => process.exit(0), 120_000).unref();
  log();

  const ask = (request_id, request) => new Promise((resolve) => {
    send({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', ...request } });
    if (early.has(request_id)) resolve(early.get(request_id)); else waiting.set(request_id, resolve);
  });

  async function turn(user) {
    const prompt = typeof user.message?.content === 'string' ? user.message.content : JSON.stringify(user.message?.content);
    log({ prompt });
    if (mode === 'badsession' && args.includes('--resume')) {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'x', errors: ['No conversation found'] });
      process.exit(1);
    }
    if (mode === 'crash') { send(init); process.exit(1); }
    if (mode === 'bash') {
      const command = process.env.FAKE_CLAUDE_COMMAND || 'echo circle-live';
      send(init);
      send({ type: 'assistant', message: { model: 'fake-model', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command } }] }, session_id: SESSION });
      const r = await ask('req-bash', { tool_name: 'Bash', input: { command }, tool_use_id: 'toolu_1', ...(process.env.FAKE_CLAUDE_BLOCKED ? { blocked_path: process.env.FAKE_CLAUDE_BLOCKED } : {}) });
      if (r.behavior === 'allow') { send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'circle-live', is_error: false }] } }); say('It ran and printed circle-live.'); }
      else { send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: r.message, is_error: true }] } }); say(`It was refused: ${r.message}`); }
      result();
      return;
    }
    if (mode === 'question') {
      const questions = [{ question: 'Tabs or spaces?', header: 'Indent', options: [{ label: 'Tabs', description: 'one tab' }, { label: 'Spaces', description: 'two spaces' }], multiSelect: false }];
      send(init);
      send({ type: 'assistant', message: { model: 'fake-model', content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions } }] }, session_id: SESSION });
      const r = await ask('req-question', { tool_name: 'AskUserQuestion', input: { questions }, tool_use_id: 'toolu_q', requires_user_interaction: true });
      say(r.behavior === 'allow' ? `You chose ${JSON.stringify(r.updatedInput?.answers)}.` : 'No answer.');
      result();
      return;
    }
    const lines = fs.readFileSync(path.join(fixtures, 'chat-read.jsonl'), 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      const o = JSON.parse(line);
      if (o.type === 'system' && o.subtype?.startsWith('hook')) continue;
      if (mode === 'slow' && o.type === 'stream_event' && o.event?.delta?.type === 'text_delta') { console.log(line); await sleep(60_000); return; }
      if (mode === 'secret' && o.type === 'stream_event' && o.event?.delta?.type === 'text_delta') { o.event.delta.text = 'The key is sk-ant-abcdefghijklmnopqrstuvwxyz0123 ok '; console.log(JSON.stringify(o)); continue; }
      console.log(mode === 'echo-input' && o.type === 'result' ? JSON.stringify({ ...o, result: `INPUT:${prompt}` }) : line);
    }
  }
}
