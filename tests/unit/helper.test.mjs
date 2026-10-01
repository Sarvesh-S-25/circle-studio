import test from 'node:test';
import assert from 'node:assert/strict';
import { helperPrompt, mergeProposal, helperResult, compactWorkflow, HELPER_MARK } from '../../backend/lib/helper.mjs';
import { normalizeWorkflow } from '../../backend/lib/workflow.mjs';

const wf = () => normalizeWorkflow({ name: 'W', nodes: [
  { id: 'you', kind: 'human' },
  { id: 'plan', kind: 'stage', title: 'Plan', gate: { on: true, label: 'Look' }, notes: 'my note', links: ['https://example.test/x'], position: { x: 10, y: 20 } },
  { id: 'planner', kind: 'agent', parent: 'plan', title: 'Planner', engine: 'claude', prompt: 'long private prompt', skills: ['keep-me'] },
], edges: [{ from: 'you', to: 'plan' }] });

test('the prompt carries the structure, the engines that work, the skills, and no secret', () => {
  const p = helperPrompt({ workflow: wf(), plan: { idea: 'A CLI', brief: { what: 'key sk-ant-abcdefghijklmnopqrstuvwxyz0123' } }, lanes: { backend: true }, engines: [{ id: 'claude', usable: true }, { id: 'codex', usable: false }], skills: ['keep-me'], history: [{ role: 'you', text: 'hi' }], message: 'make it lean' });
  assert.ok(p.startsWith(HELPER_MARK));
  assert.match(p, /Engines usable now: claude\./);
  assert.match(p, /Skills in the library: keep-me\./);
  assert.match(p, /Human: hi/);
  assert.match(p, /The human now says: make it lean/);
  assert.ok(!p.includes('abcdefghijklmnopqrstuvwxyz0123'));
  const compact = JSON.parse(/<workflow>\n(.*)\n<\/workflow>/.exec(p)[1]);
  assert.deepEqual(compact, compactWorkflow(wf()));
  assert.ok(!('position' in compact.nodes[1]) && !('notes' in compact.nodes[1]) && !('prompt' in compact.nodes[2]), 'positions, notes and prompts stay out');
});

test('merging keeps what the helper does not see for the nodes it kept, and drops unknown skills', () => {
  const cur = wf();
  const proposed = compactWorkflow(cur);
  proposed.nodes.find((n) => n.id === 'plan').gate = { on: true, by: 'engine', engine: 'codex', label: 'gaps' };
  proposed.nodes.find((n) => n.id === 'planner').skills = ['keep-me', 'invented-skill'];
  proposed.nodes.push({ id: 'build', kind: 'stage', title: 'Build', gate: { on: false, by: 'you', label: '' } });
  proposed.edges.push({ from: 'plan', to: 'build' });
  const m = mergeProposal(cur, proposed, { skills: ['keep-me'] });
  const plan = m.nodes.find((n) => n.id === 'plan');
  assert.deepEqual(plan.position, { x: 10, y: 20 });
  assert.equal(plan.notes, 'my note');
  assert.deepEqual(plan.links, ['https://example.test/x']);
  assert.deepEqual(plan.gate, { on: true, by: 'engine', label: 'gaps', engine: 'codex' });
  assert.equal(m.nodes.find((n) => n.id === 'planner').prompt, 'long private prompt');
  assert.deepEqual(m.nodes.find((n) => n.id === 'planner').skills, ['keep-me']);
  assert.equal(m.edges.length, 2);
});

test('a proposal without the human node gets it back; a proposal that changes nothing is no proposal', () => {
  const cur = wf();
  const p = compactWorkflow(cur);
  p.nodes = p.nodes.filter((n) => n.kind !== 'human');
  assert.ok(mergeProposal(cur, p).nodes.some((n) => n.id === 'you'));
  const same = helperResult(cur, { reply: 'Looks fine.', changed: true, workflow: compactWorkflow(cur) }, { skills: ['keep-me'] });
  assert.equal(same.proposal, null);
  assert.equal(same.reply, 'Looks fine.');
  const none = helperResult(cur, { reply: 'Answer only', changed: false }, { skills: [] });
  assert.deepEqual([none.proposal, none.changes], [null, []]);
});

test('an invalid proposal is refused, not applied', () => {
  assert.throws(() => mergeProposal(wf(), { nodes: [{ id: 'Bad Id', kind: 'stage', title: 'x' }], edges: [] }), /id/);
});

test('agents left under a removed stage are parked in one visible stage, never lost or orphaned', () => {
  const cur = wf();
  const p = compactWorkflow(cur);
  p.nodes = p.nodes.filter((n) => n.id !== 'plan');
  p.nodes.push({ id: 'build', kind: 'stage', title: 'Build', gate: { on: false, by: 'you', label: '' } });
  p.edges = [{ from: 'you', to: 'build' }];
  const r = helperResult(cur, { reply: 'ok', changed: true, workflow: p }, { skills: [] });
  const planner = r.proposal.nodes.find((n) => n.id === 'planner');
  assert.equal(r.proposal.nodes.find((n) => n.id === planner.parent).title, 'Not placed yet');
  assert.match(r.warnings[0], /^1 agent was not put in any stage/);
  assert.ok(!r.warnings.some((w) => /does not exist/.test(w)));
});
