import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProject, skillEngineMap, skillTargets, SKILL_DIRS, GEMINI_SKILLS_NOTE } from '../../backend/lib/render.mjs';
import { normalizeWorkflow, agentsOf } from '../../backend/lib/workflow.mjs';
import { normalizePlan, defaultPlan } from '../../backend/lib/plan.mjs';
import { parseFrontMatter, fieldString } from '../../backend/lib/frontmatter.mjs';
import { seedWorkflow } from '../helpers/engine.mjs';

const ALL = ['claude', 'codex', 'gemini', 'copilot'];
const skill = (text = 'x') => [{ path: 'SKILL.md', buffer: Buffer.from(`---\nname: s\ndescription: d\n---\n${text}`) }, { path: 'refs/a.md', buffer: Buffer.from('a') }];
const library = (skills = {}, allowed = {}) => ({ files: (n) => skills[n] || [], enginesFor: (n) => allowed[n] || ALL });
const plan = (idea = 'Make a thing') => normalizePlan({ idea, brief: { name: 'demo', what: idea } }, 'p1', defaultPlan('p1', 'demo'));
const render = (workflow, lib = library(), extra = {}) => renderProject({ name: 'demo', idea: 'Make a thing', workflow, plan: plan(), library: lib, today: '2026-01-01', ...extra });
const byPath = (files) => Object.fromEntries(files.map((f) => [f.path, f.content]));

const mixed = () => normalizeWorkflow({
  name: 'Mixed',
  nodes: [
    { id: 'you', kind: 'human' },
    { id: 'build', kind: 'stage', title: 'Build', skills: ['stage-skill'] },
    { id: 'lead', kind: 'agent', parent: 'build', engine: 'claude', skills: ['shared-one'] },
    { id: 'helper', kind: 'agent', parent: 'build', engine: 'copilot', skills: ['shared-one', 'claude-only'] },
    { id: 'coder', kind: 'agent', parent: 'build', engine: 'codex', skills: ['shared-one'] },
    { id: 'chatty', kind: 'agent', parent: 'build', engine: 'gemini', skills: ['gemini-one', 'missing-skill'] },
  ],
  edges: [{ from: 'you', to: 'build' }],
});

test('the bundled workflow renders every file a Claude project needs', () => {
  const wf = seedWorkflow();
  const { files, warnings } = render(wf);
  const got = byPath(files);
  assert.deepEqual(warnings, []);
  assert.deepEqual(Object.keys(got).filter((p) => !p.startsWith('.claude/agents/')), ['workflow.json', 'AGENTS.md', 'CLAUDE.md', 'docs/brief.md']);
  assert.equal(Object.keys(got).filter((p) => p.startsWith('.claude/agents/')).length, 19);
  assert.deepEqual(JSON.parse(got['workflow.json']), wf);
  assert.equal(got['CLAUDE.md'], '@AGENTS.md\n');
  assert.match(got['docs/brief.md'], /^# Brief: demo\n/);
  assert.match(got['docs/brief.md'], /\| 4 \| Security design review \| security \(claude\) \| You approve: Read the security findings \|/);
});

test('AGENTS.md is engine-neutral: how to read workflow.json, the flags, each stage with its gate and agents', () => {
  const text = byPath(render(seedWorkflow()).files)['AGENTS.md'];
  assert.match(text, /^# demo\n\nMake a thing\n/);
  assert.match(text, /`workflow\.json`/);
  assert.match(text, /The human does git\. Never run a git command/);
  assert.match(text, /Local only: this project stays on this PC/);
  assert.match(text, /Lanes in use: frontend, backend, contract\./);
  assert.match(text, /### 5\. Split\n\nWhen done: stop and wait for the human to approve: Approve how the work is split\. Never start the next stage before that\.\nNeeds: Stack\./);
  assert.match(text, /### 4\. Security design review\n\nWhen done: stop and wait for the human to approve: Read the security findings\./);
  assert.match(text, /- \*\*planner\*\* \(claude, sonnet\): .* May ask Gemini, Copilot and Codex for a second opinion \(read-only\)\./);
  assert.match(text, /- \*\*splitter\*\* \(claude, opus\): Produces contracts\/split\.json/);
  assert.match(text, /Skip when: the project has no frontend\./);
  assert.ok(!/CLAUDE|claude-teams/.test(text.split('## Stages')[0].replace(/\(claude\)/g, '')), 'the rules section names no engine');
  assert.ok(text.indexOf('### 1. Research') < text.indexOf('### 8. Deploy'));
});

test('a Claude agent file has name, description, model and the role text', () => {
  const file = byPath(render(seedWorkflow()).files)['.claude/agents/researcher.md'];
  const fm = parseFrontMatter(file);
  assert.ok(fm.ok);
  assert.equal(fieldString(fm, 'name'), 'researcher');
  assert.equal(fieldString(fm, 'model'), 'haiku');
  assert.match(fieldString(fm, 'description'), /^Scrapes the web for prior art/);
  assert.match(fm.body, /Produces options with evidence/);
  assert.match(fm.body, /You work in the "Research" stage\. When done: stop and wait for the human to approve: Pick one of the options\./);
});

test('CLAUDE.md and agent files only when a node uses Claude', () => {
  const codexOnly = normalizeWorkflow({ nodes: [{ id: 's', kind: 'stage' }, { id: 'a', kind: 'agent', parent: 's', engine: 'codex' }] });
  const paths = render(codexOnly).files.map((f) => f.path);
  assert.deepEqual(paths, ['workflow.json', 'AGENTS.md', 'docs/brief.md']);
  const leaveOut = render(seedWorkflow(), library(), { claudeMd: false, brief: false }).files.map((f) => f.path);
  assert.ok(!leaveOut.includes('CLAUDE.md') && !leaveOut.includes('docs/brief.md'));
  assert.ok(leaveOut.includes('AGENTS.md'));
});

test('a model that is not a plain name is left out of the agent file, and skills are listed', () => {
  const wf = normalizeWorkflow({ nodes: [{ id: 's', kind: 'stage' }, { id: 'a', kind: 'agent', parent: 's', model: 'not a model!', skills: ['one', 'two'], does: 'Line one: has a colon.', prompt: 'Be careful.', notes: 'Extra' }] });
  const fm = parseFrontMatter(byPath(render(wf, library({ one: skill(), two: skill() })).files)['.claude/agents/a.md']);
  assert.equal(fieldString(fm, 'model'), '');
  assert.equal(fieldString(fm, 'description'), 'Line one: has a colon.');
  assert.deepEqual(fm.fields.get('skills').value, ['one', 'two']);
  assert.match(fm.body, /Line one: has a colon\.\n\nBe careful\.\n\nExtra/);
});

test('skills are installed per engine folder and partition, once per folder', () => {
  const lib = library(
    { 'shared-one': skill('one'), 'claude-only': skill('c'), 'gemini-one': skill('g'), 'stage-skill': skill('st') },
    { 'claude-only': ['claude'] },
  );
  const { files, warnings } = render(mixed(), lib);
  const skillPaths = files.map((f) => f.path).filter((p) => /skills\//.test(p));
  assert.deepEqual(skillPaths, [
    '.claude/skills/shared-one/SKILL.md', '.claude/skills/shared-one/refs/a.md',
    '.agents/skills/shared-one/SKILL.md', '.agents/skills/shared-one/refs/a.md',
    '.gemini/skills/gemini-one/SKILL.md', '.gemini/skills/gemini-one/refs/a.md',
    '.claude/skills/stage-skill/SKILL.md', '.claude/skills/stage-skill/refs/a.md',
    '.agents/skills/stage-skill/SKILL.md', '.agents/skills/stage-skill/refs/a.md',
    '.gemini/skills/stage-skill/SKILL.md', '.gemini/skills/stage-skill/refs/a.md',
  ]);
  assert.equal(new Set(skillPaths).size, skillPaths.length, 'codex and copilot share one .agents folder');
  assert.ok(!skillPaths.some((p) => p.includes('claude-only')), 'only the copilot node uses it, and its partition is claude');
  assert.deepEqual(warnings.sort(), [
    GEMINI_SKILLS_NOTE,
    'Skill "claude-only" is not for copilot, so it was not installed for it.',
    'Skill "missing-skill" is not in the library, so it was not installed.',
  ].sort());
  assert.equal(byPath(files)['.agents/skills/shared-one/refs/a.md'].toString(), 'a');
});

test('skillEngineMap: a stage\'s skills go to its agents, or to every engine in the graph', () => {
  const map = skillEngineMap(mixed());
  assert.deepEqual([...map.get('stage-skill')].sort(), ALL.slice().sort());
  assert.deepEqual([...map.get('shared-one')].sort(), ['claude', 'codex', 'copilot']);
  assert.deepEqual([...map.get('gemini-one')], ['gemini']);
  const lonely = normalizeWorkflow({ nodes: [{ id: 's', kind: 'stage', skills: ['x'] }] });
  assert.deepEqual([...skillEngineMap(lonely).get('x')], ['claude'], 'a graph with no agents falls back to claude');
  const stageOnly = normalizeWorkflow({ nodes: [{ id: 's', kind: 'stage', skills: ['x'] }, { id: 'a', kind: 'agent', parent: 's', engine: 'gemini' }, { id: 't', kind: 'stage' }, { id: 'b', kind: 'agent', parent: 't', engine: 'codex' }] });
  assert.deepEqual([...skillEngineMap(stageOnly).get('x')], ['gemini']);
});

test('skillTargets keeps only what the partition allows and dedupes folders', () => {
  assert.deepEqual(skillTargets(['codex', 'copilot'], ALL), { dirs: ['.agents/skills'], engines: ['codex', 'copilot'], skipped: [] });
  assert.deepEqual(skillTargets(['claude', 'gemini'], ['claude']), { dirs: ['.claude/skills'], engines: ['claude'], skipped: ['gemini'] });
  assert.deepEqual(skillTargets(['gemini'], ['claude']).dirs, []);
  assert.deepEqual(SKILL_DIRS, { claude: '.claude/skills', codex: '.agents/skills', copilot: '.agents/skills', gemini: '.gemini/skills' });
});

test('text that looks like a secret is refused, naming the file and the kind but never the value', () => {
  const wf = seedWorkflow();
  agentsOf(wf).find((a) => a.id === 'planner').does = 'Use the key sk-ant-abcdefghijklmnopqrstuvwxyz0123 to plan.';
  assert.throws(() => render(wf), (e) => e.code === 'bad_request' && /workflow\.json/.test(e.message) && /anthropic-key/.test(e.message) && !e.message.includes('abcdefghijkl'));
});
