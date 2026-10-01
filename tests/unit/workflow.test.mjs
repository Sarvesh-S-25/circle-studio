import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWorkflow, blankWorkflow, lintWorkflow, planToWorkflow, diffWorkflows, stageOrder, agentsOf, stagesOf, LIMITS } from '../../backend/lib/workflow.mjs';
import { seedWorkflow } from '../helpers/engine.mjs';

const oldPlan = () => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'workflow', 'old-plan.json'), 'utf8'));
const small = (extra = {}) => ({ nodes: [{ id: 'you', kind: 'human' }, { id: 's', kind: 'stage' }, { id: 'a', kind: 'agent', parent: 's' }], edges: [{ from: 'you', to: 's' }], ...extra });
const bad = (input, re) => assert.throws(() => normalizeWorkflow(input), (e) => e.code === 'bad_request' && re.test(e.message), re.source);

test('the bundled template is a valid, lint-clean workflow with the eight stages in order', () => {
  const wf = seedWorkflow();
  assert.equal(wf.nodes.length, 28);
  assert.deepEqual(stageOrder(wf), ['research', 'plan', 'stack', 'security-review', 'split', 'design', 'build', 'deploy']);
  assert.equal(agentsOf(wf, 'build').length, 9);
  assert.deepEqual(lintWorkflow(wf), []);
  assert.deepEqual(normalizeWorkflow(wf), wf, 'normalising twice changes nothing');
});

test('normalize: limits, ids, kinds, engines, duplicates', () => {
  const many = Array.from({ length: LIMITS.nodes + 1 }, (_, i) => ({ id: `n${i}`, kind: 'stage' }));
  bad({ nodes: many }, /at most 80 nodes/);
  assert.equal(normalizeWorkflow({ nodes: many.slice(0, LIMITS.nodes) }).nodes.length, 80);
  bad({ nodes: many.slice(0, 3), edges: Array.from({ length: LIMITS.edges + 1 }, () => ({ from: 'n0', to: 'n1' })) }, /at most 200 edges/);
  bad({ nodes: [{ id: 'Bad Id', kind: 'stage' }] }, /needs an id/);
  bad({ nodes: [{ id: 'x'.repeat(65), kind: 'stage' }] }, /needs an id/);
  bad({ nodes: [{ id: 'a', kind: 'robot' }] }, /kind must be/);
  bad({ nodes: [{ id: 'a', kind: 'agent', engine: 'gpt' }] }, /engine must be/);
  bad({ nodes: [{ id: 'a', kind: 'stage' }, { id: 'a', kind: 'agent' }] }, /share the id/);
  bad({ nodes: [{ id: 'a', kind: 'agent', parent: 'Not A Name' }] }, /parent must be/);
  bad({ schema: 'circle-workflow/2', nodes: [] }, /not a circle-workflow\/1/);
  bad({}, /nodes list/);
  bad('nope', /must be an object/);
  bad({ nodes: 'x' }, /nodes list/);
  bad({ nodes: [null] }, /must be an object/);
});

test('normalize: unknown fields dropped, strings capped, defaults filled', () => {
  const wf = normalizeWorkflow({
    name: 'n'.repeat(500), description: 'd'.repeat(5000), version: 'not-a-version', evil: 1, lanes: { migrations: true, frontend: false }, flags: { humanDoesGit: true },
    nodes: [
      { id: 'you', kind: 'human', title: 'T\nwo\tlines', engine: 'codex', gate: { on: true } },
      { id: 's', kind: 'stage', title: 'S', gate: { on: true, label: 'l'.repeat(999) }, needs: ['you', 'Bad Name', 'you'], skills: ['ok-skill', 'Bad'], notes: 'x'.repeat(9000), engine: 'codex', position: { x: 12.6, y: 'no' } },
      { id: 'a', kind: 'agent', parent: 's', prompt: 'p'.repeat(20000), model: 'm'.repeat(300), consult: ['gemini', 'gpt', 'gemini'], position: { x: 1e9, y: -3.4 }, junk: true },
    ],
  });
  assert.equal(wf.name.length, 100);
  assert.equal(wf.description.length, 2000);
  assert.equal(wf.version, '1.0.0');
  assert.equal('evil' in wf, false);
  assert.deepEqual(wf.lanes, { frontend: false, backend: true, contract: true, migrations: true });
  assert.deepEqual(wf.flags, { localOnly: true, humanDoesGit: true });
  const [you, s, a] = wf.nodes;
  assert.deepEqual(you, { id: 'you', kind: 'human', title: 'T wo lines' });
  assert.equal(s.gate.label.length, 200);
  assert.deepEqual(s.needs, ['you']);
  assert.deepEqual(s.skills, ['ok-skill']);
  assert.equal(s.notes.length, 4000);
  assert.equal('engine' in s, false);
  assert.equal('position' in s, false, 'half a position is no position');
  assert.equal(a.prompt.length, 8000);
  assert.equal(a.model.length, 100);
  assert.deepEqual(a.consult, ['gemini']);
  assert.deepEqual(a.position, { x: 50000, y: -3 });
  assert.equal(a.engine, 'claude');
  assert.equal(a.optional, false);
  assert.equal(a.defaultOn, true);
  assert.equal('junk' in a, false);
});

test('normalize: links must be https', () => {
  assert.deepEqual(normalizeWorkflow({ ...small(), links: ['https://example.com/a'] }).links, ['https://example.com/a']);
  bad({ ...small(), links: ['http://example.com'] }, /https/);
  bad({ ...small(), links: ['javascript:alert(1)'] }, /https/);
  bad({ ...small(), links: ['https://' + 'a'.repeat(600)] }, /https/);
  bad({ nodes: [{ id: 's', kind: 'stage', links: ['ftp://x'] }] }, /Node "s": links/);
  assert.deepEqual(normalizeWorkflow({ ...small(), links: ['', 5] }).links, [], 'blanks are skipped');
});

test('normalize: edges to nothing, to themselves or repeated are dropped', () => {
  const wf = normalizeWorkflow(small({ edges: [{ from: 'you', to: 's', label: 'go', id: 'e_1' }, { from: 'you', to: 's' }, { from: 's', to: 's' }, { from: 's', to: 'ghost' }, { from: 'a', to: 's', label: 'x'.repeat(200) }] }));
  assert.deepEqual(wf.edges.map((e) => `${e.from}>${e.to}`), ['you>s', 'a>s']);
  assert.equal(wf.edges[0].id, 'e_1');
  assert.equal(wf.edges[1].label.length, 60);
});

test('a blank workflow is only the human', () => {
  const wf = blankWorkflow('Mine');
  assert.deepEqual(wf.nodes.map((n) => n.id), ['you']);
  assert.equal(wf.name, 'Mine');
  assert.deepEqual(lintWorkflow(wf), []);
});

test('lint: unknown parent, parent that is not a stage, unknown need, no parent', () => {
  const wf = normalizeWorkflow({ nodes: [{ id: 's', kind: 'stage', needs: ['ghost'] }, { id: 'a', kind: 'agent', parent: 'nowhere' }, { id: 'b', kind: 'agent', parent: 'a' }, { id: 'c', kind: 'agent' }] });
  const ids = lintWorkflow(wf).map((w) => `${w.id}:${w.nodeId}`).sort();
  assert.deepEqual(ids, ['agent-no-parent:c', 'parent-not-stage:b', 'unknown-need:s', 'unknown-parent:a']);
});

test('lint: a cycle in the flow or in the needs', () => {
  const loop = normalizeWorkflow({ nodes: [{ id: 'a', kind: 'stage' }, { id: 'b', kind: 'stage' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
  assert.deepEqual(lintWorkflow(loop).map((w) => w.id), ['cycle']);
  const needs = normalizeWorkflow({ nodes: [{ id: 'a', kind: 'stage', needs: ['b'] }, { id: 'b', kind: 'stage', needs: ['a'] }] });
  assert.deepEqual(lintWorkflow(needs).map((w) => w.id), ['cycle']);
  assert.deepEqual(lintWorkflow(normalizeWorkflow(small())), []);
});

test('lint: a stage with agents and no gate before build', () => {
  const wf = (gate) => normalizeWorkflow({
    nodes: [{ id: 'you', kind: 'human' }, { id: 'plan', kind: 'stage', gate: { on: gate } }, { id: 'planner', kind: 'agent', parent: 'plan' }, { id: 'empty', kind: 'stage' }, { id: 'build', kind: 'stage' }, { id: 'builder', kind: 'agent', parent: 'build' }],
    edges: [{ from: 'you', to: 'plan' }, { from: 'plan', to: 'empty' }, { from: 'empty', to: 'build' }],
  });
  const warned = lintWorkflow(wf(false));
  assert.deepEqual(warned.map((w) => [w.id, w.nodeId]), [['no-gate-before-build', 'plan']], 'no agents in "empty", and build itself may be ungated');
  assert.deepEqual(lintWorkflow(wf(true)), []);
});

test('lint: an engine that is not usable, only when the engines are known', () => {
  const wf = normalizeWorkflow({ nodes: [{ id: 's', kind: 'stage' }, { id: 'a', kind: 'agent', parent: 's', engine: 'codex' }, { id: 'b', kind: 'agent', parent: 's', engine: 'claude' }] });
  assert.deepEqual(lintWorkflow(wf), []);
  const out = lintWorkflow(wf, { usable: new Set(['claude']) });
  assert.deepEqual(out.map((w) => [w.id, w.nodeId, w.severity]), [['engine-not-usable', 'a', 'warn']]);
});

test('planToWorkflow migrates the sample-test plan: same stages, gates, lanes and flags', () => {
  const wf = planToWorkflow(oldPlan(), seedWorkflow());
  assert.equal(wf.name, 'sample-test');
  assert.deepEqual(stageOrder(wf), ['research', 'plan', 'stack', 'security-review', 'split', 'design', 'build', 'deploy']);
  const gates = Object.fromEntries(stagesOf(wf).map((s) => [s.id, s.gate.on]));
  assert.equal(gates['security-review'], false, 'the old plan had no gate on security');
  assert.equal(gates.split, true);
  assert.equal(stagesOf(wf).find((s) => s.id === 'stack').gate.label, 'G3: accept or amend the stack ADR');
  assert.deepEqual(wf.flags, { localOnly: true, humanDoesGit: true });
  assert.deepEqual(wf.lanes, { frontend: true, backend: true, contract: true, migrations: false });
  assert.equal(agentsOf(wf).length, 19);
  assert.equal(wf.edges.length, 8);
  assert.deepEqual(wf.edges[0], { from: 'you', to: 'research' });
  assert.equal(wf.version, '1.0.0');
});

test('planToWorkflow: switched-off phases leave with their agents, order and extras carry over', () => {
  const plan = oldPlan();
  plan.phases.find((p) => p.id === 'deploy').enabled = false;
  plan.phases.find((p) => p.id === 'research').enabled = false;
  const [split] = plan.phases.splice(plan.phases.findIndex((p) => p.id === 'split'), 1);
  plan.phases.splice(plan.phases.findIndex((p) => p.id === 'stack'), 0, split);
  const design = plan.phases.find((p) => p.id === 'design');
  Object.assign(design, { agents: ['ux-writer', 'designer', 'security'], skills: ['frontend-design'], notes: 'Keep it calm.' });
  const wf = planToWorkflow(plan, seedWorkflow());
  assert.deepEqual(stageOrder(wf), ['plan', 'split', 'stack', 'security-review', 'design', 'build']);
  assert.equal(wf.nodes.some((n) => n.id === 'researcher' || n.id === 'deployer' || n.id === 'deploy'), false);
  assert.deepEqual(wf.edges.map((e) => `${e.from}>${e.to}`), ['you>plan', 'plan>split', 'split>stack', 'stack>security-review', 'security-review>design', 'design>build']);
  assert.deepEqual(agentsOf(wf, 'design').map((a) => a.id), ['designer', 'design-tooling', 'ux-writer', 'security-2'], 'a clashing name gets a free id');
  assert.deepEqual(stagesOf(wf).find((s) => s.id === 'design').skills, ['frontend-design']);
  assert.equal(stagesOf(wf).find((s) => s.id === 'design').notes, 'Keep it calm.');
  assert.deepEqual(stagesOf(wf).find((s) => s.id === 'build').needs, ['split', 'stack']);
  assert.deepEqual(stagesOf(wf).find((s) => s.id === 'stack').needs, ['plan']);
  assert.deepEqual(lintWorkflow(wf).map((w) => w.id), ['no-gate-before-build'], 'the old plan had no gate on security, and the new lint says so');
});

test('planToWorkflow ignores phases it does not know', () => {
  const plan = { phases: [{ id: 'mystery', enabled: true }, { id: 'plan', enabled: true, gate: { enabled: false, label: '' } }] };
  const wf = planToWorkflow(plan, seedWorkflow());
  assert.deepEqual(stageOrder(wf), ['plan']);
  assert.equal(stagesOf(wf)[0].gate.on, false);
});

test('diffWorkflows lists what differs and ignores the version field', () => {
  const a = seedWorkflow();
  const b = structuredClone(a);
  b.version = '9.9.9';
  assert.equal(diffWorkflows(a, b).empty, true);
  b.nodes.find((n) => n.id === 'planner').engine = 'codex';
  b.nodes = b.nodes.filter((n) => n.id !== 'scaler');
  b.nodes.push({ id: 'extra', kind: 'agent', title: 'Extra', parent: 'plan', engine: 'claude', consult: [], optional: false, defaultOn: true, needs: [], skills: [], links: [], notes: '' });
  const d = diffWorkflows(a, normalizeWorkflow(b));
  assert.deepEqual(d.nodes.added, ['extra']);
  assert.deepEqual(d.nodes.removed, ['scaler']);
  assert.deepEqual(d.nodes.changed, [{ id: 'planner', fields: ['engine'] }]);
  assert.deepEqual(d.changes.map((c) => c.kind), ['node-added', 'node-removed', 'node-changed']);
});
