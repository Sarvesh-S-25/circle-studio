import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGate, gateWho, normalizeWorkflow, lintWorkflow } from '../../backend/lib/workflow.mjs';
import { checkpointText, consultText } from '../../backend/lib/render.mjs';

test('an old gate ({ on, label }) reads as "you decide"; bad values fall back safely', () => {
  assert.deepEqual(normalizeGate({ on: true, label: 'Look' }), { on: true, by: 'you', label: 'Look' });
  assert.deepEqual(normalizeGate(undefined), { on: false, by: 'you', label: '' });
  assert.deepEqual(normalizeGate({ on: true, by: 'engine', engine: 'codex' }), { on: true, by: 'engine', label: '', engine: 'codex' });
  assert.deepEqual(normalizeGate({ on: true, by: 'both', engine: 'nope' }), { on: true, by: 'both', label: '', engine: 'claude' });
  assert.equal(normalizeGate({ on: true, by: 'robot' }).by, 'you');
  assert.equal('engine' in normalizeGate({ on: true, by: 'you', engine: 'codex' }), false, 'no engine kept on a gate you decide');
});

test('who checks, in plain words', () => {
  assert.equal(gateWho({ on: false, by: 'you' }), null);
  assert.equal(gateWho({ on: true, by: 'you' }), 'You');
  assert.equal(gateWho({ on: true, by: 'engine', engine: 'codex' }), 'Codex');
  assert.equal(gateWho({ on: true, by: 'both', engine: 'gemini' }), 'Gemini, then you');
});

test('the instruction the team gets for each kind of checkpoint', () => {
  assert.match(checkpointText({ on: false }), /go straight on/);
  assert.match(checkpointText({ on: true, by: 'you', label: 'Pick one' }), /stop and wait for the human to approve: Pick one\. Never start/);
  const eng = checkpointText({ on: true, by: 'engine', engine: 'codex', label: 'the plan' });
  assert.match(eng, /ask Codex to review the result in a separate, read-only session \(the plan\)/);
  assert.match(eng, /Do not wait for the human\./);
  assert.match(checkpointText({ on: true, by: 'both', engine: 'claude' }), /ask Claude to review .* then stop and wait for the human/);
});

test('engine access is per agent and never lists its own engine', () => {
  assert.equal(consultText({ engine: 'claude', consult: [] }), '');
  assert.equal(consultText({ engine: 'claude', consult: ['claude'] }), '');
  assert.equal(consultText({ engine: 'claude', consult: ['codex'] }), 'May ask Codex for a second opinion (read-only).');
  assert.equal(consultText({ engine: 'codex', consult: ['gemini', 'copilot'] }), 'May ask Gemini and Copilot for a second opinion (read-only).');
});

test('an engine checkpoint counts as a check for the "nobody checks it" warning', () => {
  const wf = (gate) => normalizeWorkflow({ nodes: [
    { id: 'you', kind: 'human' }, { id: 'plan', kind: 'stage', gate }, { id: 'planner', kind: 'agent', parent: 'plan' }, { id: 'build', kind: 'stage' },
  ], edges: [{ from: 'you', to: 'plan' }, { from: 'plan', to: 'build' }] });
  assert.deepEqual(lintWorkflow(wf({ on: false })).map((w) => w.id), ['no-gate-before-build']);
  assert.deepEqual(lintWorkflow(wf({ on: true, by: 'engine', engine: 'codex' })), []);
});

test('a link into "You" is flagged so it can be removed', () => {
  const wf = normalizeWorkflow({ nodes: [{ id: 'you', kind: 'human', title: 'You' }, { id: 'temporal', kind: 'stage', title: 'temporal' }], edges: [{ from: 'temporal', to: 'you' }] });
  const w = lintWorkflow(wf);
  assert.ok(w.some((x) => x.id === 'link-into-you' && x.nodeId === 'temporal'));
});
