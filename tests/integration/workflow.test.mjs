import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, tempDir, rmDir } from '../helpers/project.mjs';
import { SEED_ID } from '../../backend/lib/templates.mjs';

const ALL = { write: true, run: true, claude: true };
const oldPlan = () => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'workflow', 'old-plan.json'), 'utf8'));
const tiny = (name = 'Tiny') => ({ name, nodes: [{ id: 'you', kind: 'human' }, { id: 's', kind: 'stage', title: 'S' }, { id: 'a', kind: 'agent', parent: 's', title: 'A' }], edges: [{ from: 'you', to: 's' }] });
const skillMd = (name) => `---\nname: ${name}\ndescription: Demo.\n---\n\nBody\n`;
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

async function withServer(fn) {
  const s = await startServer();
  try { await fn(s); } finally { await s.close(); }
}

async function withProject(s, fn, permissions = ALL) {
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions })).json.project.id;
    await fn(id, root);
  } finally { rmDir(root); }
}

test('templates over HTTP: list, create blank / from a template, get, save, remove', () => withServer(async (s) => {
  const list = await s.call('GET', '/api/templates');
  assert.deepEqual(list.json.templates.map((t) => [t.id, t.builtin, t.stages, t.agents]), [[SEED_ID, true, 8, 19]]);

  const blank = await s.call('POST', '/api/templates', { name: 'Mine', description: 'Own flow' });
  assert.equal(blank.status, 200);
  assert.deepEqual(blank.json.workflow.nodes.map((n) => n.id), ['you']);
  assert.equal(blank.json.template.description, 'Own flow');
  assert.deepEqual(blank.json.warnings, []);

  const copy = await s.call('POST', '/api/templates', { templateId: SEED_ID });
  assert.equal(copy.json.template.name, 'Staged build team copy');
  assert.equal(copy.json.workflow.nodes.length, 28);
  assert.equal((await s.call('POST', '/api/templates', { templateId: SEED_ID, workflow: tiny() })).status, 400, 'one source only');
  assert.equal((await s.call('POST', '/api/templates', { templateId: 'nope' })).status, 404);
  assert.equal((await s.call('POST', '/api/templates', { workflow: { nodes: 'x' } })).status, 400);

  const id = blank.json.template.id;
  const got = await s.call('GET', `/api/templates/${id}`);
  assert.equal(got.json.head, '1.0.0');
  assert.equal(got.json.versions[0].vsHead.changes.length, 0);
  assert.equal((await s.call('GET', '/api/templates/nope')).status, 404);
  assert.equal((await s.call('GET', '/api/templates/BAD!')).status, 400);

  const wf = got.json.workflow;
  wf.nodes.push({ id: 'design', kind: 'stage', title: 'Design', gate: { on: true, label: 'Pick' } });
  const saved = await s.call('PUT', `/api/templates/${id}`, { workflow: wf, note: 'add a stage' });
  assert.deepEqual([saved.json.unchanged, saved.json.level, saved.json.head], [false, 'minor', '1.1.0']);
  assert.equal(saved.json.versions.length, 2);
  assert.equal(saved.json.versions[1].note, 'add a stage');
  assert.equal('record' in saved.json, false);
  const again = await s.call('PUT', `/api/templates/${id}`, { workflow: saved.json.workflow });
  assert.deepEqual([again.json.unchanged, again.json.head], [true, '1.1.0']);
  const forced = structuredClone(saved.json.workflow);
  forced.nodes[1].notes = 'x';
  assert.equal((await s.call('PUT', `/api/templates/${id}`, { workflow: forced, bump: 'major' })).json.head, '2.0.0');
  assert.equal((await s.call('PUT', `/api/templates/${id}`, { workflow: forced, bump: 'huge' })).status, 400);
  assert.equal((await s.call('PUT', `/api/templates/${id}`, { workflow: 'nope' })).status, 400);

  assert.equal((await s.call('DELETE', `/api/templates/${id}`)).status, 200);
  assert.equal((await s.call('GET', `/api/templates/${id}`)).status, 404);
  assert.equal((await s.call('DELETE', `/api/templates/${id}`)).status, 404);
  assert.equal((await s.call('DELETE', `/api/templates/${SEED_ID}`)).status, 200, 'the bundled one can go too');
  assert.equal((await s.call('GET', '/api/templates')).json.templates.length, 1);
}));

test('templates.import over HTTP: pasted JSON, a path, and every refusal', () => withServer(async (s) => {
  const dir = tempDir('circle-imp-');
  try {
    const pasted = await s.call('POST', '/api/templates/import', { json: JSON.stringify(tiny('Pasted')) });
    assert.equal(pasted.json.template.name, 'Pasted');
    const file = path.join(dir, 'flow.json');
    fs.writeFileSync(file, JSON.stringify(tiny('From disk')));
    const fromFile = await s.call('POST', '/api/templates/import', { path: file, name: 'Named' });
    assert.equal(fromFile.json.template.name, 'Named');
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'workflow.json'), JSON.stringify(tiny('From folder')));
    assert.equal((await s.call('POST', '/api/templates/import', { path: proj })).json.template.name, 'From folder');

    assert.equal((await s.call('POST', '/api/templates/import', {})).status, 400);
    assert.equal((await s.call('POST', '/api/templates/import', { path: 'flow.json' })).status, 400);
    assert.equal((await s.call('POST', '/api/templates/import', { path: '\\\\host\\share\\x.json' })).status, 400);
    assert.equal((await s.call('POST', '/api/templates/import', { path: path.join(dir, 'gone.json') })).status, 404);
    assert.equal((await s.call('POST', '/api/templates/import', { json: '{bad' })).status, 400);
    const secret = await s.call('POST', '/api/templates/import', { json: JSON.stringify({ ...tiny(), description: 'key sk-ant-abcdefghijklmnopqrstuvwxyz0123' }) });
    assert.equal(secret.status, 400);
    assert.ok(!JSON.stringify(secret.json).includes('abcdefghijkl'));
    assert.equal((await s.call('GET', '/api/templates')).json.templates.length, 4);
  } finally { rmDir(dir); }
}));

test('a project has a workflow of its own: what its folder has (never an unchosen template), save, restore, lanes follow the brief', () => withServer(async (s) => withProject(s, async (id) => {
  const first = await s.call('GET', `/api/projects/${id}/workflow`);
  assert.equal(first.status, 200);
  assert.deepEqual([first.json.head, first.json.templateId, first.json.origin, first.json.versions.length], ['1.0.0', null, 'agents', 1]);
  assert.deepEqual(first.json.workflow.nodes.filter((n) => n.kind === 'agent').map((n) => n.id), ['planner', 'researcher'], 'only the agents that exist in the folder');
  assert.equal(first.json.autoTemplate, undefined);

  const wf = structuredClone(first.json.workflow);
  wf.lanes.frontend = false;
  wf.nodes = wf.nodes.filter((n) => n.id !== 'researcher');
  const saved = await s.call('PUT', `/api/projects/${id}/workflow`, { workflow: wf, note: 'no researcher' });
  assert.deepEqual([saved.json.level, saved.json.head, saved.json.versions.length], ['major', '2.0.0', 2]);
  assert.equal(saved.json.preview, undefined, 'no files unless asked');
  assert.equal((await s.call('GET', `/api/projects/${id}/plan`)).json.plan.lanes.frontend, false, 'the brief follows the workflow');

  const plan = (await s.call('GET', `/api/projects/${id}/plan`)).json.plan;
  plan.lanes.migrations = true;
  plan.humanDoesGit = true;
  assert.equal((await s.call('PUT', `/api/projects/${id}/plan`, { plan })).status, 200);
  const after = (await s.call('GET', `/api/projects/${id}/workflow`)).json;
  assert.deepEqual([after.head, after.workflow.lanes.migrations, after.workflow.flags.humanDoesGit], ['2.0.1', true, true], 'the workflow follows the brief, as a patch');

  const back = await s.call('POST', `/api/projects/${id}/workflow/restore`, { version: '1.0.0' });
  assert.equal(back.status, 200);
  assert.equal(back.json.head, '2.1.0');
  assert.equal(back.json.versions.at(-1).restoredFrom, '1.0.0');
  assert.equal((await s.call('GET', `/api/projects/${id}/plan`)).json.plan.lanes.frontend, true, 'restoring puts the lanes back in the brief');
  assert.equal((await s.call('POST', `/api/projects/${id}/workflow/restore`, { version: '9.0.0' })).status, 404);
  assert.equal((await s.call('POST', `/api/projects/${id}/workflow/restore`, {})).status, 400);
  assert.equal((await s.call('PUT', `/api/projects/${id}/workflow`, { workflow: { nodes: [{ id: 'a', kind: 'agent', engine: 'x' }] } })).status, 400);

  const cyc = structuredClone(back.json.workflow);
  cyc.edges.push({ from: 'agents', to: 'planner' }, { from: 'planner', to: 'agents' });
  const warned = await s.call('PUT', `/api/projects/${id}/workflow`, { workflow: cyc });
  assert.deepEqual(warned.json.warnings.map((w) => w.id), ['cycle']);
})));

test('workflow.save can write the files through the diff review, and only with permission', () => withServer(async (s) => {
  await withProject(s, async (id, root) => {
    const wf = (await s.call('GET', `/api/projects/${id}/workflow`)).json.workflow;
    const denied = await s.call('PUT', `/api/projects/${id}/workflow`, { workflow: { ...wf, name: 'Renamed' }, write: true });
    assert.equal(denied.status, 403);
    assert.equal((await s.call('GET', `/api/projects/${id}/workflow`)).json.head, '1.0.0', 'nothing was saved when the write was refused');
  }, { write: false });
  await withProject(s, async (id, root) => {
    const wf = (await s.call('GET', `/api/projects/${id}/workflow`)).json.workflow;
    const res = await s.call('PUT', `/api/projects/${id}/workflow`, { workflow: { ...wf, name: 'Renamed' }, write: true });
    assert.equal(res.status, 200);
    const files = res.json.preview.files.map((f) => f.path);
    assert.ok(files.includes('workflow.json') && files.includes('AGENTS.md'));
    assert.ok(files.includes('.claude/agents/researcher.md'));
    assert.ok(!files.includes('docs/brief.md') && !files.includes('CLAUDE.md'));
    assert.ok(res.json.preview.warnings.some((w) => /Add the line @AGENTS\.md to CLAUDE\.md/.test(w)));
    assert.ok(res.json.preview.warnings.some((w) => /agent files? already existed/.test(w)), 'planner.md and researcher.md were there');
    assert.ok(!fs.existsSync(path.join(root, 'workflow.json')), 'a preview writes nothing');
    const applied = await s.call('POST', '/api/changes/apply', { id: res.json.preview.id });
    assert.equal(applied.status, 200);
    assert.equal(JSON.parse(read(root, 'workflow.json')).name, 'Renamed');
    assert.match(read(root, 'AGENTS.md'), /^# Renamed|^# /);
    assert.equal(read(root, 'CLAUDE.md'), '# Project directives\n', 'CLAUDE.md is never written in an existing project');
    const again = await s.call('PUT', `/api/projects/${id}/workflow`, { workflow: { ...wf, name: 'Renamed' }, write: true });
    assert.equal(again.json.unchanged, true);
    assert.equal(again.json.preview.id, null, 'nothing more to write');
  });
}));

test('a project that still has an old plan file with phases keeps its stages and gates', () => withServer(async (s) => withProject(s, async (id) => {
  const plan = oldPlan();
  plan.projectId = id;
  plan.phases.find((p) => p.id === 'design').enabled = false;
  fs.mkdirSync(path.join(s.dataDir, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(s.dataDir, 'plans', `${id}.json`), JSON.stringify(plan));
  const wf = await s.call('GET', `/api/projects/${id}/workflow`);
  assert.equal(wf.json.templateId, null);
  assert.equal(wf.json.versions[0].note, 'Migrated from the phases of the old plan');
  assert.deepEqual(wf.json.workflow.nodes.filter((n) => n.kind === 'stage').map((n) => n.id), ['research', 'plan', 'stack', 'security', 'split', 'build', 'deploy'].map((x) => (x === 'security' ? 'security-review' : x)));
  assert.equal(wf.json.workflow.nodes.find((n) => n.id === 'security-review').gate.on, false);
  assert.equal(wf.json.workflow.flags.humanDoesGit, true);
  assert.deepEqual(wf.json.warnings.map((w) => w.id), ['no-gate-before-build']);
  const planOut = (await s.call('GET', `/api/projects/${id}/plan`)).json;
  assert.equal(planOut.plan.phases, undefined);
  assert.equal(planOut.plan.humanDoesGit, true);
  assert.equal(planOut.plan.brief.howFar, 'production');
})));

test('the old plan is migrated before the first plan save can drop its phases', () => withServer(async (s) => withProject(s, async (id) => {
  const plan = oldPlan();
  plan.phases.find((p) => p.id === 'deploy').enabled = false;
  fs.mkdirSync(path.join(s.dataDir, 'plans'), { recursive: true });
  fs.writeFileSync(path.join(s.dataDir, 'plans', `${id}.json`), JSON.stringify(plan));
  assert.equal((await s.call('PUT', `/api/projects/${id}/plan`, { plan })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'plans', `${id}.json`), 'utf8')).phases, undefined);
  const wf = (await s.call('GET', `/api/projects/${id}/workflow`)).json;
  assert.equal(wf.workflow.nodes.some((n) => n.id === 'deploy'), false, 'the switched-off phase is still off');
})));

test('there is no template project, no template folder in health or the project list', () => withServer(async (s) => {
  const health = (await s.call('GET', '/api/health')).json;
  assert.equal('template' in health, false);
  assert.ok(health.projectsRoot);
  assert.equal('template' in (await s.call('GET', '/api/projects')).json, false);
  for (const [method, url] of [['GET', '/api/projects/template'], ['GET', '/api/projects/template/plan'], ['GET', '/api/projects/template/workflow'], ['PUT', '/api/projects/template/permissions'], ['GET', '/api/projects/nope/workflow']]) {
    assert.equal((await s.call(method, url, method === 'GET' ? undefined : { permissions: ALL })).status, 404, url);
  }
}));

test('skills over HTTP: partition and engines are saved, listed, and validated', () => withServer(async (s) => {
  const put = await s.call('PUT', '/api/skills/demo', { skillMd: skillMd('demo'), partition: 'gemini', engines: ['gemini'] });
  assert.equal(put.status, 200);
  assert.deepEqual([put.json.skill.partition, put.json.skill.engines], ['gemini', ['gemini']]);
  const edited = await s.call('PUT', '/api/skills/demo', { skillMd: skillMd('demo') + 'more\n' });
  assert.equal(edited.json.skill.partition, 'gemini', 'an edit that sends no partition keeps it');
  const only = await s.call('PUT', '/api/skills/demo', { partition: 'shared' });
  assert.deepEqual([only.status, only.json.skill.partition, only.json.skill.engines], [200, 'shared', ['gemini']]);
  const listed = (await s.call('GET', '/api/skills')).json.skills;
  assert.deepEqual(listed.map((k) => [k.name, k.partition]), [['demo', 'shared']]);
  assert.equal((await s.call('GET', '/api/skills/demo')).json.skill.partition, 'shared');
  assert.equal((await s.call('PUT', '/api/skills/demo', { skillMd: skillMd('demo'), partition: 'codex' })).status, 400);
  assert.equal((await s.call('PUT', '/api/skills/demo', { skillMd: skillMd('demo'), engines: ['gpt'] })).status, 400);
  assert.equal((await s.call('PUT', '/api/skills/fresh', { partition: 'claude' })).status, 400, 'a new skill needs its text');
  const dropped = await s.call('POST', '/api/import', { files: [{ path: 'dropped/SKILL.md', data: skillMd('dropped') }], partition: 'copilot' });
  assert.deepEqual(dropped.json.imported, ['dropped']);
  assert.equal((await s.call('GET', '/api/skills/dropped')).json.skill.partition, 'copilot');
  assert.equal((await s.call('POST', '/api/import', { files: [{ path: 'x/SKILL.md', data: skillMd('x') }], partition: 'bad' })).status, 400);
}));

test('skill-install writes each engine\'s own folder, once per folder, and respects the partition', () => withServer(async (s) => withProject(s, async (id, root) => {
  await s.call('PUT', '/api/skills/shared-one', { skillMd: skillMd('shared-one') });
  await s.call('PUT', '/api/skills/claude-own', { skillMd: skillMd('claude-own'), partition: 'claude' });
  const all = await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'skill-install', name: 'shared-one', engines: ['claude', 'codex', 'copilot', 'gemini'] }] });
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.files.map((f) => f.path).sort(), ['.agents/skills/shared-one/SKILL.md', '.claude/skills/shared-one/SKILL.md', '.gemini/skills/shared-one/SKILL.md']);
  assert.ok(all.json.warnings.some((w) => /\.gemini\/skills is not verified/.test(w)));
  assert.ok(!fs.existsSync(path.join(root, '.agents')));
  assert.equal((await s.call('POST', '/api/changes/apply', { id: all.json.id })).status, 200);
  assert.match(read(root, '.agents/skills/shared-one/SKILL.md'), /name: shared-one/);
  assert.equal((await s.call('GET', '/api/skills')).json.skills.find((k) => k.name === 'shared-one').uses, 1);

  const dflt = await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'skill-install', name: 'claude-own' }] });
  assert.deepEqual(dflt.json.files.map((f) => f.path), ['.claude/skills/claude-own/SKILL.md'], 'the default is claude, as before');
  const some = await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'skill-install', name: 'claude-own', engines: ['claude', 'copilot'] }] });
  assert.deepEqual(some.json.files.map((f) => f.path), ['.claude/skills/claude-own/SKILL.md']);
  assert.ok(some.json.warnings.some((w) => /not for copilot/.test(w)));
  const none = await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'skill-install', name: 'claude-own', engines: ['copilot'] }] });
  assert.equal(none.status, 400);
  assert.equal((await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'skill-install', name: 'shared-one', engines: ['gpt'] }] })).status, 400);
  assert.equal((await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'skill-install', name: 'shared-one', engines: [] }] })).status, 400);
  fs.writeFileSync(path.join(root, '.agents/skills/shared-one/SKILL.md'), 'edited by hand');
  const clash = await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'skill-install', name: 'shared-one', engines: ['codex'] }] });
  assert.equal(clash.status, 409);
  assert.equal((await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'skill-install', name: 'shared-one', engines: ['codex'], overwrite: true }] })).status, 200);
})));

test('projects.create shows every file first and writes nothing until confirmed', () => withServer(async (s) => {
  const target = path.join(s.projectsRoot, 'fresh-one');
  const body = { name: 'fresh-one', idea: 'A tiny tool for tidying notes.', templateId: SEED_ID };
  const preview = await s.call('POST', '/api/projects/create', body);
  assert.equal(preview.status, 200);
  assert.equal(preview.json.confirmed, false);
  assert.equal(preview.json.target, target);
  const paths = preview.json.files.map((f) => f.path);
  assert.deepEqual(paths.filter((p) => !p.startsWith('.claude/agents/')), ['workflow.json', 'AGENTS.md', 'CLAUDE.md', 'docs/brief.md']);
  assert.equal(paths.length, 4 + 19);
  assert.ok(preview.json.files.every((f) => f.status === 'added' && f.diff.added > 0));
  assert.ok(!fs.existsSync(target), 'nothing is created before the confirmation');
  assert.equal((await s.call('GET', '/api/projects')).json.projects.length, 0, 'and nothing is registered');
  assert.ok(!paths.some((p) => /^(scripts|\.git|\.claude\/hooks)\b/.test(p)), 'no git, no scripts');

  const made = await s.call('POST', '/api/projects/create', { ...body, confirm: true });
  assert.equal(made.status, 200);
  assert.equal(made.json.confirmed, true);
  assert.equal(made.json.project.path, target);
  assert.deepEqual(made.json.project.permissions, ALL);
  assert.deepEqual(fs.readdirSync(target).sort(), ['.claude', 'AGENTS.md', 'CLAUDE.md', 'docs', 'workflow.json']);
  assert.equal(read(target, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.match(read(target, 'AGENTS.md'), /^# fresh-one\n\nA tiny tool for tidying notes\.\n/);
  assert.match(read(target, 'docs/brief.md'), /A tiny tool for tidying notes\./);
  assert.match(read(target, '.claude/agents/planner.md'), /^---\nname: planner\n/);

  const id = made.json.project.id;
  const wf = (await s.call('GET', `/api/projects/${id}/workflow`)).json;
  assert.deepEqual([wf.head, wf.templateId, wf.versions.length], ['1.0.0', SEED_ID, 1]);
  assert.deepEqual(JSON.parse(read(target, 'workflow.json')), wf.workflow, 'the file on disk is the stored head');
  const plan = (await s.call('GET', `/api/projects/${id}/plan`)).json.plan;
  assert.deepEqual([plan.idea, plan.brief.name, plan.brief.what], ['A tiny tool for tidying notes.', 'fresh-one', 'A tiny tool for tidying notes.']);
  assert.equal((await s.call('GET', '/api/projects')).json.projects.length, 1);
  const team = (await s.call('GET', `/api/projects/${id}`)).json.team;
  assert.ok(!team.files.modelsJson && !team.files.consultConfig, 'no models.json or consult config was written');
}));

test('projects.create refuses bad names, unknown templates and folders that are not empty', () => withServer(async (s) => {
  const call = (body) => s.call('POST', '/api/projects/create', { templateId: SEED_ID, ...body });
  assert.equal((await call({ name: '../evil' })).status, 400);
  assert.equal((await call({ name: 'A' })).status, 400);
  assert.equal((await call({})).status, 400);
  assert.equal((await s.call('POST', '/api/projects/create', { name: 'no-template' })).status, 400);
  assert.equal((await call({ name: 'ghost-one', templateId: 'missing' })).status, 404);
  assert.equal((await call({ name: 'ghost-one', workflow: { nodes: 5 } })).status, 400);

  const taken = path.join(s.projectsRoot, 'taken');
  fs.mkdirSync(taken);
  fs.writeFileSync(path.join(taken, 'f.txt'), 'x');
  for (const confirm of [false, true]) assert.equal((await call({ name: 'taken', confirm })).status, 409, `confirm ${confirm}`);
  assert.deepEqual(fs.readdirSync(taken), ['f.txt']);
  const asFile = path.join(s.projectsRoot, 'a-file');
  fs.writeFileSync(asFile, 'x');
  assert.equal((await call({ name: 'a-file' })).status, 400, 'a file is not a folder');

  for (const folder of ['relative\\dir', '\\\\server\\share\\p', 'C:\\', s.app.config.appRoot, path.join(s.app.config.appRoot, 'sub'), s.dataDir, path.join(s.dataDir, 'x'), path.join(s.projectsRoot, 'no-parent', 'child')]) {
    assert.equal((await call({ name: 'ok-name', folder })).status, 400, folder);
  }
  assert.equal(fs.readdirSync(s.projectsRoot).includes('no-parent'), false);
  const empty = path.join(s.projectsRoot, 'empty-one');
  fs.mkdirSync(empty);
  assert.equal((await call({ name: 'ok-name', folder: empty, confirm: true })).status, 200, 'an empty folder is fine');
  assert.equal((await call({ name: 'again-one', folder: empty, confirm: true })).status, 409, 'and is not empty afterwards');
  assert.equal((await s.call('GET', '/api/projects')).json.projects.length, 1);
}));

test('projects.create with a workflow of its own: engines, skills per partition, no secrets', () => withServer(async (s) => {
  await s.call('PUT', '/api/skills/shared-one', { skillMd: skillMd('shared-one') });
  await s.call('PUT', '/api/skills/claude-own', { skillMd: skillMd('claude-own'), partition: 'claude' });
  const workflow = {
    name: 'Mixed',
    nodes: [
      { id: 'you', kind: 'human' },
      { id: 'build', kind: 'stage', title: 'Build', gate: { on: true, label: 'Look' } },
      { id: 'lead', kind: 'agent', parent: 'build', engine: 'claude', model: 'sonnet', skills: ['claude-own'], does: 'Leads.' },
      { id: 'helper', kind: 'agent', parent: 'build', engine: 'copilot', skills: ['shared-one', 'claude-own', 'not-there'], does: 'Helps.' },
    ],
    edges: [{ from: 'you', to: 'build' }],
  };
  const folder = path.join(s.projectsRoot, 'mixed-project');
  const made = await s.call('POST', '/api/projects/create', { name: 'mixed-project', workflow, confirm: true });
  assert.equal(made.status, 200);
  assert.ok(made.json.warnings.includes('Skill "claude-own" is not for copilot, so it was not installed for it.'));
  assert.ok(made.json.warnings.includes('Skill "not-there" is not in the library, so it was not installed.'));
  assert.ok(fs.existsSync(path.join(folder, '.claude/skills/claude-own/SKILL.md')));
  assert.ok(fs.existsSync(path.join(folder, '.agents/skills/shared-one/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(folder, '.claude/skills/shared-one')), 'no claude node uses the shared skill');
  assert.ok(!fs.existsSync(path.join(folder, '.agents/skills/claude-own')));
  assert.deepEqual(fs.readdirSync(path.join(folder, '.claude/agents')), ['lead.md'], 'only Claude agents get an agent file');
  const wf = (await s.call('GET', `/api/projects/${made.json.project.id}/workflow`)).json;
  assert.deepEqual([wf.templateId, wf.workflow.name], [null, 'Mixed']);

  const leak = await s.call('POST', '/api/projects/create', { name: 'leaky-one', templateId: SEED_ID, idea: 'Use sk-ant-abcdefghijklmnopqrstuvwxyz0123 for it', confirm: true });
  assert.equal(leak.status, 400);
  assert.ok(!JSON.stringify(leak.json).includes('abcdefghijkl'));
  assert.ok(!fs.existsSync(path.join(s.projectsRoot, 'leaky-one')), 'nothing was written');
  const codexOnly = await s.call('POST', '/api/projects/create', { name: 'codex-only', workflow: { nodes: [{ id: 's', kind: 'stage' }, { id: 'a', kind: 'agent', parent: 's', engine: 'codex' }] }, confirm: true });
  assert.deepEqual(fs.readdirSync(path.join(s.projectsRoot, 'codex-only')).sort(), ['AGENTS.md', 'docs', 'workflow.json'], 'no CLAUDE.md without a Claude node');
  assert.equal(codexOnly.status, 200);
}));

test('the workflow helper answers, proposes a change, writes nothing, and needs the Claude permission', () => withServer(async (s) => {
  await withProject(s, async (id, root) => {
    const before = (await s.call('GET', `/api/projects/${id}/workflow`)).json;
    const answer = await s.call('POST', `/api/projects/${id}/workflow/suggest`, { message: 'what do you think?' });
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.equal(answer.json.proposal, null);
    assert.match(answer.json.reply, /You asked: what do you think\?/);

    const review = await s.call('POST', `/api/projects/${id}/workflow/suggest`, { message: 'add a review', history: [{ role: 'you', text: 'hi' }] });
    assert.equal(review.status, 200);
    const first = review.json.proposal.nodes.find((n) => n.kind === 'stage');
    assert.deepEqual(first.gate, { on: true, by: 'engine', label: 'the result has no gaps', engine: 'codex' });
    assert.deepEqual(review.json.proposal.nodes.find((n) => n.id === 'ghost').skills, [], 'a skill that is not in the library is dropped');
    assert.ok(review.json.changes.some((c) => /Added agent "Ghost"/.test(c)));
    assert.ok(review.json.changes.some((c) => /checkpoint/.test(c)));

    const unsaved = structuredClone(before.workflow);
    unsaved.nodes.find((n) => n.kind === 'stage').title = 'Renamed but not saved';
    const lighter = await s.call('POST', `/api/projects/${id}/workflow/suggest`, { message: 'make it lighter', workflow: unsaved });
    assert.equal(lighter.json.proposal.nodes.find((n) => n.kind === 'stage').title, 'Renamed but not saved', 'the helper works on the graph as it is on screen');
    assert.ok(lighter.json.proposal.nodes.every((n) => !(n.kind === 'agent' && n.optional)));

    const after = (await s.call('GET', `/api/projects/${id}/workflow`)).json;
    assert.equal(after.head, before.head, 'asking the helper saves nothing');
    assert.equal(fs.existsSync(path.join(root, 'workflow.json')), false, 'and writes nothing into the project');
    assert.equal((await s.call('POST', `/api/projects/${id}/workflow/suggest`, { message: '' })).status, 400);
  });
  await withProject(s, async (id) => {
    const r = await s.call('POST', `/api/projects/${id}/workflow/suggest`, { message: 'hi' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.detail.permission, 'claude');
  }, { write: true, run: true, claude: false });
}));
