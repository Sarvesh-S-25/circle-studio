import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlan, normalizePlan, lintPlan, rosterFromWorkflow, buildBrief, BLOCK_START, BLOCK_END } from '../../backend/lib/plan.mjs';
import { loadConfig } from '../../backend/config.mjs';
import { seedWorkflow } from '../helpers/engine.mjs';

test('the plan is the brief, lanes, flags and pins: phases are gone', () => {
  const plan = defaultPlan('p1', 'demo');
  assert.deepEqual(Object.keys(plan), ['version', 'projectId', 'updatedAt', 'idea', 'brief', 'lanes', 'localOnly', 'humanDoesGit', 'pins']);
  assert.equal(plan.version, 2);
  const old = { ...plan, phases: [{ id: 'build', enabled: true }], lanes: { frontend: false, migrations: true }, humanDoesGit: true, idea: 'x' };
  const back = normalizePlan(old, 'p1', plan);
  assert.equal('phases' in back, false, 'an old plan file loses its phases when it is read');
  assert.deepEqual(back.lanes, { frontend: false, backend: true, migrations: true, contract: true });
  assert.equal(back.humanDoesGit, true);
  assert.equal(back.idea, 'x');
});

test('pins keep a stage id when it looks like one, and are cleaned otherwise', () => {
  const plan = normalizePlan({ pins: [
    { title: 'a', phaseId: 'build' },
    { title: 'b', phaseId: 'security-review', kind: 'keep', done: true },
    { title: 'c', phaseId: 'Not A Stage' },
    { title: '' },
    { id: 'same', title: 'd' },
    { id: 'same', title: 'e', kind: 'weird' },
  ] }, 'p1');
  assert.deepEqual(plan.pins.map((p) => [p.title, p.phaseId, p.kind, p.done]), [
    ['a', 'build', 'issue', false], ['b', 'security-review', 'keep', true], ['c', null, 'issue', false], ['d', null, 'issue', false], ['e', null, 'issue', false],
  ]);
  assert.equal(new Set(plan.pins.map((p) => p.id)).size, 5);
  assert.throws(() => normalizePlan('nope', 'p1'), (e) => e.code === 'bad_request');
});

test('lintPlan only reports open pinned issues', () => {
  const plan = normalizePlan({ pins: [{ title: 'a' }, { title: 'b', done: true }, { title: 'c', kind: 'keep' }] }, 'p1');
  assert.deepEqual(lintPlan(plan), [{ id: 'pins-open-high', severity: 'info', message: '1 pinned issue not yet resolved.' }]);
  assert.deepEqual(lintPlan(defaultPlan('p1')), []);
});

test('rosterFromWorkflow: optional agents only, off when switched off or their lane is off', () => {
  const wf = seedWorkflow();
  wf.nodes.find((n) => n.id === 'scaler').defaultOn = false;
  assert.deepEqual(rosterFromWorkflow(wf), { researcher: true, 'business-auditor': false, scaler: false, security: true, migrator: false, connector: true, qa: true, deployer: true });
  wf.lanes.contract = false;
  wf.lanes.migrations = true;
  const next = rosterFromWorkflow(wf);
  assert.deepEqual([next.connector, next.migrator], [false, true]);
});

test('buildBrief draws the stage table from the workflow and replaces only its own block', () => {
  const wf = seedWorkflow();
  const plan = normalizePlan({ idea: 'An idea', brief: { name: 'demo' }, pins: [{ title: 'Watch out', phaseId: 'build' }] }, 'p1');
  const text = buildBrief(plan, wf, null, { today: '2026-01-01' });
  assert.match(text, /^# Brief: demo\n\n## What it is\n\nAn idea\n/);
  assert.match(text, /\| # \| Stage \| Who runs it \| When done \| Skills \|/);
  assert.match(text, /\| 1 \| Research \| researcher \(claude\), business-auditor \(claude\), scaler \(claude\) \| You approve: Pick one of the options \| - \|/);
  assert.match(text, /\| 6 \| Design \| designer \(claude\), design-tooling \(claude\) \| You approve: Pick a design direction \| - \|/);
  assert.match(text, /- \[issue\] Watch out \(build\)/);
  assert.ok(text.includes(BLOCK_START) && text.includes(BLOCK_END));
  const edited = text.replace('An idea', 'MY WORDS');
  wf.nodes.find((n) => n.id === 'deploy').gate.on = false;
  const again = buildBrief(plan, wf, edited, { today: '2026-02-02' });
  assert.ok(again.includes('MY WORDS'));
  assert.match(again, /Written 2026-02-02/);
  assert.match(again, /\| 8 \| Deploy \| deployer \(claude\) \| go on \| - \|/);
  assert.equal(again.split(BLOCK_START).length, 2);
  assert.match(buildBrief(plan, wf, 'Mine\r\n', { eol: '\r\n', today: '2026-01-01' }), /^Mine\r\n\r\n<!-- circle:plan:start -->\r\n/);
});

test('the config knows no template folder', () => {
  const config = loadConfig({ CIRCLE_DATA: 'C:\\data', CIRCLE_TEMPLATE: 'C:\\somewhere', CIRCLE_PROJECTS_ROOT: 'C:\\projects' });
  assert.equal('template' in config, false);
  assert.equal(config.projectsRoot, 'C:\\projects');
  assert.ok(loadConfig({}).projectsRoot.endsWith('Desktop'));
});
