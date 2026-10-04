// Helpers beside agents and the pattern store: the condense hook itself (run as Claude Code runs it, with a fake Haiku),
// writing it into a project (a new one, and merged into an existing .claude/settings.json without touching anything
// else, and taken out again), what it saved on the Cost tab, the patterns related to a team, and the helper's prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, tempDir, rmDir } from '../helpers/project.mjs';
import { writeConversation } from '../helpers/fake-history.mjs';
import { reshape } from '../../backend/seed/hooks/circle-condense.mjs';
import { relate, patternsForPrompt, loadPatterns } from '../../backend/lib/patterns.mjs';
import { normalizeWorkflow } from '../../backend/lib/workflow.mjs';
import { helperBox } from '../../frontend/js/components/graph/layout.js';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'backend', 'seed', 'hooks', 'circle-condense.mjs');
const FAKE_HAIKU = path.resolve(import.meta.dirname, '..', 'helpers', 'fake-haiku.mjs');
const ALL = { write: true, run: true, claude: true };
const LOG = `${Array.from({ length: 400 }, (_, i) => `step ${i}: copying data/chunk-${i}.bin ... ok`).join('\n')}\nERROR: disk full at chunk 399`;

/** Run the hook the way Claude Code does: the event as JSON on stdin, from a project with its config next to it. */
function runHook(dir, event) {
  const r = spawnSync(process.execPath, [path.join(dir, '.claude', 'hooks', 'circle-condense.mjs')], { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, CIRCLE_CONDENSE_TEST_CLI: FAKE_HAIKU }, timeout: 30_000 });
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const usageLine = (tokens) => `${JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 } } })}\n`;

test('the condense hook: shortens long output above the limit, in the tool\'s own shape; leaves everything else alone', () => {
  const dir = tempDir('cs-hook-');
  try {
    fs.mkdirSync(path.join(dir, '.claude', 'hooks'), { recursive: true });
    fs.copyFileSync(HOOK, path.join(dir, '.claude', 'hooks', 'circle-condense.mjs'));
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'circle-condense.json'), JSON.stringify({ agents: { tester: { above: 60 }, main: { above: 60 } }, minTokens: 800 }));
    const main = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(main, usageLine(150_000)); // the main session: 75% full
    const sub = path.join(dir, 'sess', 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), usageLine(20_000)); // the tester's own: 10% full
    const scratch = path.join(dir, 'scratch');
    fs.mkdirSync(scratch);
    const ev = (extra) => ({ hook_event_name: 'PostToolUse', session_id: 's1', transcript_path: main, scratchpad_dir: scratch, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: LOG, stderr: '', interrupted: false }, ...extra });

    const out = runHook(dir, ev({}));
    const res = out.hookSpecificOutput.updatedToolOutput;
    assert.deepEqual(Object.keys(res).sort(), ['interrupted', 'stderr', 'stdout'], 'the same shape as Bash answers, or Claude Code keeps the original');
    assert.match(res.stdout, /^\[Circle Studio condensed: Bash output was \d+ tokens, now \d+ \(the context was 75% full\)/);
    assert.match(res.stdout, /ERROR: disk full at chunk 399/, 'what the agent needs is kept');
    const kept = /The full output is in (.+?);/.exec(res.stdout)[1];
    assert.equal(fs.readFileSync(kept, 'utf8'), LOG, 'and the whole output is in a file it can read');
    assert.ok(kept.startsWith(scratch));

    assert.equal(runHook(dir, ev({ agent_type: 'tester', agent_id: 'a1' })), null, 'a subagent is judged by its own transcript (10% < 60%)');
    assert.equal(runHook(dir, ev({ agent_type: 'reviewer' })), null, 'an agent that did not turn it on');
    assert.equal(runHook(dir, ev({ tool_name: 'Read', tool_response: { file: { content: LOG } } })), null, 'never a file it read');
    assert.equal(runHook(dir, ev({ tool_response: { stdout: 'short', stderr: '' } })), null, 'short output');
    fs.writeFileSync(path.join(dir, '.claude', 'hooks', 'circle-condense.json'), 'not json');
    assert.equal(runHook(dir, ev({})), null, 'a broken config changes nothing');
  } finally {
    rmDir(dir);
  }
  assert.deepEqual(reshape({ result: 'long', url: 'u' }, 'short'), { result: 'short', url: 'u' });
  assert.equal(reshape({ weird: 1 }, 'x'), null, 'an unknown shape is left alone');
});

test('writing the workflow: the hook goes in, the project\'s own settings stay, and it comes out again', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  try {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const own = { permissions: { allow: ['Bash(npm test)'] }, hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npx prettier --write' }] }] } };
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), `${JSON.stringify(own, null, 2)}\n`);
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    const wf = (on) => ({ nodes: [{ id: 'you', kind: 'human', title: 'You' }, { id: 'build', kind: 'stage', title: 'Build' }, { id: 'tester', kind: 'agent', title: 'Tester', parent: 'build', engine: 'claude', ...(on ? { condense: 70 } : {}) }], edges: [{ from: 'you', to: 'build' }] });
    const write = async (on) => {
      const r = (await s.call('PUT', `/api/projects/${id}/workflow`, { workflow: wf(on), note: 't', write: true })).json;
      assert.ok(r.preview, `shown as a diff first: ${JSON.stringify(r).slice(0, 400)}`);
      if (!r.preview.id) return; // nothing to change: no change set to apply
      const applied = await s.call('POST', '/api/changes/apply', { id: r.preview.id });
      assert.equal(applied.status, 200, JSON.stringify(applied.json).slice(0, 300));
    };
    await write(true);
    const set = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(set.permissions, own.permissions, 'its own settings are kept');
    assert.equal(set.hooks.PostToolUse.length, 2, 'its own hook is kept, ours is added');
    assert.equal(set.hooks.PostToolUse[1].hooks[0].command, 'node .claude/hooks/circle-condense.mjs');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'hooks', 'circle-condense.json'), 'utf8')).agents, { tester: { above: 70 } });
    assert.ok(fs.existsSync(path.join(root, '.claude', 'hooks', 'circle-condense.mjs')));
    await write(true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')).hooks.PostToolUse.length, 2, 'never added twice');
    await write(false);
    const off = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(off.hooks.PostToolUse, own.hooks.PostToolUse, 'switched off: only ours is taken out');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'hooks', 'circle-condense.json'), 'utf8')).agents, {});
  } finally {
    await s.close();
    rmDir(root);
  }
});

test('the one door into .claude/hooks/: only the shipped script, only names and percentages', async () => {
  const { checkCondenseWrite } = await import('../../backend/lib/condenseguard.mjs');
  const { isWritable } = await import('../../backend/lib/paths.mjs');
  assert.equal(isWritable('.claude/hooks/other.mjs'), false, 'every other hook path stays closed');
  assert.equal(isWritable('.claude/hooks/circle-condense.mjs'), true);
  assert.doesNotThrow(() => checkCondenseWrite('.claude/hooks/circle-condense.mjs', fs.readFileSync(HOOK, 'utf8')));
  assert.throws(() => checkCondenseWrite('.claude/hooks/circle-condense.mjs', 'require("child_process").exec("evil")'), /ships with Circle Studio/);
  assert.doesNotThrow(() => checkCondenseWrite('.claude/hooks/circle-condense.json', JSON.stringify({ agents: { tester: { above: 60 } }, minTokens: 4000 })));
  for (const bad of [{ agents: { tester: { above: 60, cmd: 'x' } } }, { agents: { 'a b': { above: 60 } } }, { agents: { t: { above: 5 } } }, { agents: {}, run: 'x' }]) {
    assert.throws(() => checkCondenseWrite('.claude/hooks/circle-condense.json', JSON.stringify(bad)), /only name agents/);
  }
});

test('patterns: related to the team with measured context; the helper reads them; the Cost tab counts what was condensed', async () => {
  const wf = normalizeWorkflow({ nodes: [{ id: 'you', kind: 'human', title: 'You' }, { id: 'check', kind: 'stage', title: 'Check', gate: { on: true, by: 'you', label: 'tests pass' } }, { id: 'reviewer', kind: 'agent', title: 'Reviewer', parent: 'check', engine: 'claude', model: 'opus', does: 'Reviews the changes and reads the logs' }, { id: 'builder', kind: 'agent', title: 'Builder', parent: 'check', engine: 'claude', model: 'sonnet', does: 'Implements and fixes the code' }, { id: 'runner', kind: 'agent', title: 'Test runner', parent: 'check', engine: 'claude', model: 'sonnet', does: 'Runs the tests and reports' }], edges: [{ from: 'you', to: 'check' }] });
  const fits = relate(wf, { usage: [{ name: 'reviewer', answers: 20, input: 100_000, cacheRead: 1_900_000, cacheWrite5m: 0, cacheWrite1h: 0 }] });
  const reader = fits.find((f) => f.pattern === 'reader' && f.agent === 'reviewer');
  assert.equal(reader.strength, 3, 'measured: about 100k per answer');
  assert.match(reader.why, /Measured: about 100k tokens/);
  assert.ok(!fits.some((f) => f.pattern === 'reader' && f.agent === 'builder'), 'never for an agent that edits what it reads');
  assert.ok(fits.some((f) => f.pattern === 'condense' && f.agent === 'runner'));
  assert.ok(fits.some((f) => f.pattern === 'engine-check' && f.stage === 'check'), 'a routine checkpoint that waits for you');
  assert.match(patternsForPrompt(wf), /Patterns that fit this team/);
  assert.equal(normalizeWorkflow({ nodes: [{ id: 's', kind: 'stage' }, { id: 'a', kind: 'agent', parent: 's', condense: 5 }] }).nodes[1].condense, 30, 'the limit is kept between 30 and 95');
  assert.ok(loadPatterns().every((p) => p.useWhen.length && p.avoidWhen.length && p.costs), 'every pattern says when, when not and what it costs');
  assert.equal(helperBox({ x: 0, y: 0, w: 236, h: 136 }, []).hanging, false);
  assert.equal(helperBox({ x: 0, y: 0, w: 236, h: 136 }, [{ x: 256, y: 0, w: 236, h: 136 }]).hanging, true, 'another card beside it: it hangs off the corner');

  const s = await startServer();
  const root = makeMiniProject();
  try {
    const file = writeConversation(s.claudeHome, root, { id: '0b5da320-50f4-46c7-82d1-9f24bcb77565', turns: [['run the tests', 'done']] });
    fs.appendFileSync(file, `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[Circle Studio condensed: Bash output was 3600 tokens, now 60 (the context was 72% full). The full output is in x; read it.]' }] } })}\n`);
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    const p = (await s.call('POST', `/api/projects/${id}/patterns`, { workflow: wf })).json;
    assert.ok(p.patterns.length >= 5);
    assert.ok(p.fits.length);
    assert.deepEqual([p.condensed.count, p.condensed.was, p.condensed.now], [1, 3600, 60]);
    assert.ok((await s.call('GET', '/api/catalog?type=pattern')).json.entries.some((e) => e.name.startsWith('Haiku reader')), 'patterns are in the catalog the helper searches');
    const log = (await import('../helpers/trace.mjs')).TRACE();
    process.env.FAKE_CLAUDE_LOG = log;
    await s.call('PUT', `/api/projects/${id}/workflow`, { workflow: wf, note: 't' });
    await s.call('POST', `/api/projects/${id}/workflow/suggest`, { message: 'make it cheaper' });
    const prompt = fs.readFileSync(log, 'utf8');
    assert.match(prompt, /Patterns that fit this team/, 'the helper gets the matching patterns and why');
    assert.match(prompt, /condense\\+": a percentage \(30 to 95\)/);
  } finally {
    delete process.env.FAKE_CLAUDE_LOG;
    await s.close();
    rmDir(root);
  }
});
