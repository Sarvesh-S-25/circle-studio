import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../backend/lib/store.mjs';
import { Templates, Workflows, readImportFile, SEED_ID, IMPORT_MAX_BYTES } from '../../backend/lib/templates.mjs';
import { normalizeWorkflow, planToWorkflow, stageOrder, agentsOf } from '../../backend/lib/workflow.mjs';
import { seedWorkflow, SEED_FILE } from '../helpers/engine.mjs';
import { tempDir, rmDir, makeMiniProject } from '../helpers/project.mjs';

const makeTempDir = () => tempDir('circle-folder-');

function setup() {
  const dir = tempDir('circle-tpl-');
  const store = new Store(path.join(dir, 'data'));
  const templates = new Templates({ store, seedFile: SEED_FILE });
  return { dir, store, templates, workflows: new Workflows({ store, templates }), done: () => rmDir(dir) };
}
const oldPlan = () => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'workflow', 'old-plan.json'), 'utf8'));
const tiny = (name = 'Tiny') => ({ name, nodes: [{ id: 'you', kind: 'human' }, { id: 's', kind: 'stage', title: 'S' }, { id: 'a', kind: 'agent', parent: 's', title: 'A' }], edges: [{ from: 'you', to: 's' }] });
const rejects = (fn, code, re) => assert.throws(fn, (e) => e.code === code && re.test(e.message), `${code} ${re}`);

test('the bundled template is seeded once; deleting it keeps it deleted', () => {
  const { store, templates, done } = setup();
  try {
    const [seed] = templates.list();
    assert.equal(seed.id, SEED_ID);
    assert.equal(seed.builtin, true);
    assert.equal(seed.head, '1.0.0');
    assert.equal(seed.stages, 8);
    assert.equal(seed.agents, 19);
    assert.deepEqual(seed.engines, ['claude']);
    assert.ok(fs.existsSync(store.abs('templates/.seeded')), 'a marker file records that it was seeded');
    templates.remove(SEED_ID);
    assert.deepEqual(templates.list(), []);
    assert.deepEqual(new Templates({ store, seedFile: SEED_FILE }).list(), [], 'a new start does not bring it back');
    rejects(() => templates.get(SEED_ID), 'not_found', /No such template/);
    rejects(() => templates.remove(SEED_ID), 'not_found', /No such template/);
  } finally { done(); }
});

test('a missing seed file is not marked as seeded, so it is tried again', () => {
  const dir = tempDir('circle-tpl-');
  const store = new Store(path.join(dir, 'data'));
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(new Templates({ store, seedFile: path.join(dir, 'nope.json') }).list(), []);
    assert.equal(fs.existsSync(store.abs('templates/.seeded')), false);
    assert.equal(new Templates({ store, seedFile: SEED_FILE }).list().length, 1);
  } finally { console.error = quiet; rmDir(dir); }
});

test('create: blank, from a workflow, with a name and description', () => {
  const { templates, done } = setup();
  try {
    const blank = templates.create({});
    assert.match(blank.template.id, /^t_[0-9a-f]{8}$/);
    assert.deepEqual(blank.workflow.nodes.map((n) => n.id), ['you']);
    assert.equal(blank.head, '1.0.0');
    assert.equal(blank.template.builtin, false);
    const named = templates.create({ workflow: tiny(), name: 'Mine', description: 'For me' });
    assert.equal(named.template.name, 'Mine');
    assert.equal(named.workflow.name, 'Mine');
    assert.equal(named.workflow.description, 'For me');
    assert.equal(named.versions.length, 1);
    assert.equal(named.versions[0].note, 'Created');
    assert.deepEqual(templates.list().map((t) => t.name), [seedWorkflow().name, 'Untitled workflow', 'Mine']);
    rejects(() => templates.create({ workflow: { nodes: 'x' } }), 'bad_request', /nodes list/);
  } finally { done(); }
});

test('save appends a semantic version, identical content is not saved again, remove deletes', () => {
  const { templates, done } = setup();
  try {
    const { template } = templates.create({ workflow: tiny() });
    const wf = templates.get(template.id).workflow;
    const same = templates.save(template.id, { workflow: wf });
    assert.equal(same.unchanged, true);
    assert.equal(same.head, '1.0.0');
    const next = structuredClone(wf);
    next.nodes.find((n) => n.id === 'a').model = 'haiku';
    const patch = templates.save(template.id, { workflow: next, note: 'cheaper' });
    assert.deepEqual([patch.unchanged, patch.level, patch.head], [false, 'patch', '1.0.1']);
    next.nodes.push({ id: 'b', kind: 'agent', parent: 's' });
    next.name = 'Renamed';
    const minor = templates.save(template.id, { workflow: next });
    assert.equal(minor.head, '1.1.0');
    assert.equal(minor.template.name, 'Renamed');
    assert.equal(minor.versions.length, 3);
    assert.equal(minor.versions[0].vsHead.summary.added, 1, 'version 1.0.0 lacks the one agent the head has');
    assert.equal('record' in minor, false);
    assert.equal(templates.save(template.id, { workflow: next, bump: 'major', note: 'same' }).unchanged, true);
    templates.remove(template.id);
    rejects(() => templates.get(template.id), 'not_found', /No such template/);
    rejects(() => templates.get('../etc'), 'not_found', /No such template/);
  } finally { done(); }
});

test('import from pasted JSON (text or object), naming it or not', () => {
  const { templates, done } = setup();
  try {
    const a = templates.import({ json: JSON.stringify(tiny('Pasted')) });
    assert.equal(a.template.name, 'Pasted');
    const b = templates.import({ json: tiny('Object'), name: '  Chosen  ' });
    assert.equal(b.template.name, 'Chosen');
    rejects(() => templates.import({ json: '{nope' }), 'bad_request', /not valid JSON/);
    rejects(() => templates.import({}), 'bad_request', /path of a workflow.json/);
    rejects(() => templates.import({ json: '{}', path: 'C:\\x.json' }), 'bad_request', /not both/);
    rejects(() => templates.import({ json: { ...tiny(), schema: 'other/9' } }), 'bad_request', /not a circle-workflow/);
    rejects(() => templates.import({ json: { ...tiny(), nodes: [{ id: 'you', kind: 'human', does: 'use sk-ant-abcdefghijklmnopqrstuvwxyz0123' }] } }), 'bad_request', /looks like a secret/);
    assert.equal(templates.list().length, 3, 'a refused import leaves nothing behind');
  } finally { done(); }
});

test('import from a path: one .json file, or a folder that holds workflow.json, and nothing else', () => {
  const { dir, templates, done } = setup();
  try {
    const file = path.join(dir, 'flow.json');
    fs.writeFileSync(file, JSON.stringify(tiny('FromFile')));
    assert.equal(templates.import({ path: file }).template.name, 'FromFile');
    assert.equal(templates.import({ path: `"${file}"` }).template.name, 'FromFile', 'quotes from a copied path are removed');

    const folder = path.join(dir, 'proj');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'workflow.json'), JSON.stringify(tiny('FromFolder')));
    fs.writeFileSync(path.join(folder, 'other.json'), '{"secret": "not read"}');
    assert.equal(templates.import({ path: folder }).template.name, 'FromFolder');

    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty);
    fs.writeFileSync(path.join(empty, 'other.json'), JSON.stringify(tiny()));
    rejects(() => templates.import({ path: empty }), 'not_found', /no workflow.json/);
    rejects(() => templates.import({ path: path.join(dir, 'missing.json') }), 'not_found', /does not exist/);

    fs.writeFileSync(path.join(dir, 'flow.txt'), JSON.stringify(tiny()));
    rejects(() => templates.import({ path: path.join(dir, 'flow.txt') }), 'bad_request', /Only a .json file/);
    fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(tiny()));
    rejects(() => templates.import({ path: path.join(dir, 'credentials.json') }), 'forbidden', /may hold secrets/);
    const dot = path.join(dir, 'node_modules');
    fs.mkdirSync(dot);
    fs.writeFileSync(path.join(dot, 'workflow.json'), JSON.stringify(tiny()));
    rejects(() => templates.import({ path: dot }), 'forbidden', /may hold secrets/);
  } finally { done(); }
});

test('import from a path refuses relative and network paths, big files, links and a bad body', () => {
  const { dir, templates, done } = setup();
  try {
    for (const p of ['flow.json', '.\\flow.json', '..\\flow.json', '\\\\server\\share\\flow.json', '//server/share/flow.json', '\\\\?\\C:\\flow.json', '\\flow.json', '', '   ']) {
      rejects(() => readImportFile(p), 'bad_request', /absolute|Give the full path/);
    }
    rejects(() => readImportFile('C:\\x\0.json'), 'bad_request', /Give the full path/);
    rejects(() => readImportFile(42), 'bad_request', /Give the full path/);
    const big = path.join(dir, 'big.json');
    fs.writeFileSync(big, ' '.repeat(IMPORT_MAX_BYTES + 1));
    rejects(() => templates.import({ path: big }), 'too_large', /larger than 1 MB/);
    const garbage = path.join(dir, 'garbage.json');
    fs.writeFileSync(garbage, 'password = hunter2hunter2 {{{');
    assert.throws(() => templates.import({ path: garbage }), (e) => e.code === 'bad_request' && !e.message.includes('hunter2'), 'a parse error never repeats the file');
    const real = path.join(dir, 'real.json');
    fs.writeFileSync(real, JSON.stringify(tiny()));
    const link = path.join(dir, 'link.json');
    let fileLinks = true;
    try { fs.symlinkSync(real, link); } catch { fileLinks = false; }
    if (fileLinks) rejects(() => templates.import({ path: link }), 'bad_request', /Links are not followed/);
    const folderLink = path.join(dir, 'folder-link');
    fs.mkdirSync(path.join(dir, 'real-folder'));
    fs.writeFileSync(path.join(dir, 'real-folder', 'workflow.json'), JSON.stringify(tiny()));
    fs.symlinkSync(path.join(dir, 'real-folder'), folderLink, 'junction');
    rejects(() => templates.import({ path: folderLink }), 'bad_request', /Links are not followed/);
    const linkedFile = path.join(dir, 'has-link');
    fs.mkdirSync(linkedFile);
    try { fs.symlinkSync(real, path.join(linkedFile, 'workflow.json')); rejects(() => templates.import({ path: linkedFile }), 'bad_request', /Links are not followed/); } catch (e) { if (e.code !== 'EPERM') throw e; }
  } finally { done(); }
});

test('a project never gets a template it did not choose: its own workflow.json, else its agents, else blank', () => {
  const { store, workflows, done } = setup();
  const empty = makeTempDir();
  const withAgents = makeMiniProject();
  const withFile = makeTempDir();
  try {
    const blank = workflows.get({ id: 'p_blank', name: 'Blank', path: empty });
    assert.equal(blank.templateId, null);
    assert.equal(blank.origin, 'blank');
    assert.deepEqual(blank.workflow.nodes.map((n) => n.id), ['you']);
    assert.match(blank.versions[0].note, /^Blank/);
    assert.ok(fs.existsSync(store.abs('workflows/p_blank.json')), 'stored once, so it stays put');

    const team = workflows.get({ id: 'p_team', name: 'Team', path: withAgents });
    assert.equal(team.origin, 'agents');
    assert.deepEqual(team.workflow.nodes.filter((n) => n.kind === 'agent').map((n) => [n.id, n.model]), [['planner', 'sonnet'], ['researcher', 'haiku']], 'exactly the agents in the folder, with their models');
    assert.equal(team.workflow.nodes.filter((n) => n.kind === 'stage').length, 1);

    const own = normalizeWorkflow({ name: 'Mine', nodes: [{ id: 'you', kind: 'human' }, { id: 'go', kind: 'stage', title: 'Go' }], edges: [{ from: 'you', to: 'go' }] });
    fs.writeFileSync(path.join(withFile, 'workflow.json'), JSON.stringify(own));
    const file = workflows.get({ id: 'p_file', name: 'File', path: withFile });
    assert.equal(file.origin, 'file');
    assert.deepEqual(file.workflow.nodes.map((n) => n.id), ['you', 'go']);
  } finally { done(); rmDir(empty); rmDir(withAgents); rmDir(withFile); }
});

test('a project that an older version filled with a template copy says so and offers what the folder has', () => {
  const { store, templates, workflows, done } = setup();
  const root = makeMiniProject();
  try {
    const project = { id: 'p_old', name: 'Old', path: root };
    fs.mkdirSync(store.abs('workflows'), { recursive: true });
    const wf = templates.head(SEED_ID);
    store.writeJson('workflows/p_old.json', { id: 'p_old', name: wf.name, description: '', createdAt: 'x', updatedAt: 'x', builtin: false, templateId: SEED_ID, head: '1.0.0', versions: [{ version: '1.0.0', at: 'x', note: 'Started from the template "Staged build team"', parent: null, summary: { added: 0, removed: 0, changed: 0 }, workflow: wf }] });
    const view = workflows.get(project);
    assert.equal(view.autoTemplate.templateName, 'Staged build team');
    assert.equal(view.autoTemplate.folder.origin, 'agents');
    const replaced = workflows.save(project, { workflow: view.autoTemplate.folder.workflow, note: 'Replaced the template copy with the agents in this folder' });
    assert.equal(replaced.autoTemplate, undefined, 'once edited, it is the project\'s own');
  } finally { done(); rmDir(root); }
});

test('a project whose plan file still has phases is migrated from them, once', () => {
  const { store, workflows, done } = setup();
  try {
    const plan = oldPlan();
    plan.phases.find((p) => p.id === 'deploy').enabled = false;
    store.writeJson('plans/sample_test.json', plan);
    const view = workflows.get({ id: 'sample_test', name: 'sample-test' });
    assert.equal(view.templateId, null);
    assert.equal(view.versions[0].note, 'Migrated from the phases of the old plan');
    assert.deepEqual(stageOrder(view.workflow), ['research', 'plan', 'stack', 'security-review', 'split', 'design', 'build']);
    assert.deepEqual(view.workflow.flags, { localOnly: true, humanDoesGit: true });
    assert.deepEqual(view.workflow, planToWorkflow(plan, seedWorkflow()));
    store.writeJson('plans/sample_test.json', { ...plan, phases: undefined });
    assert.equal(workflows.get({ id: 'sample_test', name: 'sample-test' }).versions.length, 1, 'later opens read the stored workflow');
  } finally { done(); }
});

test('project workflow: save, restore, lanes and flags follow the brief', () => {
  const { templates, workflows, done } = setup();
  try {
    const project = { id: 'p_one', name: 'One' };
    workflows.create(project, { workflow: templates.head(SEED_ID), templateId: SEED_ID });
    const wf = workflows.get(project).workflow;
    const fewer = structuredClone(wf);
    fewer.nodes = fewer.nodes.filter((n) => n.id !== 'scaler');
    const major = workflows.save(project, { workflow: fewer, note: 'no scaler' });
    assert.deepEqual([major.level, major.head], ['major', '2.0.0']);
    assert.equal(agentsOf(major.workflow).some((a) => a.id === 'scaler'), false);
    const back = workflows.restore(project, '1.0.0');
    assert.equal(back.head, '2.1.0');
    assert.equal(back.versions.at(-1).restoredFrom, '1.0.0');
    assert.equal(workflows.restore(project, '2.1.0').unchanged, true);
    assert.throws(() => workflows.restore(project, '7.7.7'), (e) => e.code === 'not_found');
    const flags = workflows.syncFlags(project, { lanes: { frontend: false, backend: true, contract: true, migrations: true }, localOnly: false, humanDoesGit: true });
    assert.equal(flags.level, 'patch');
    assert.deepEqual(flags.workflow.lanes, { frontend: false, backend: true, contract: true, migrations: true });
    assert.deepEqual(flags.workflow.flags, { localOnly: false, humanDoesGit: true });
    assert.equal(workflows.syncFlags(project, { lanes: flags.workflow.lanes, localOnly: false, humanDoesGit: true }).unchanged, true);
    assert.deepEqual(normalizeWorkflow(flags.workflow), flags.workflow);
  } finally { done(); }
});

test('a damaged workflow file is set aside and rebuilt instead of crashing', () => {
  const { store, workflows, done } = setup();
  try {
    fs.mkdirSync(store.abs('workflows'), { recursive: true });
    fs.writeFileSync(store.abs('workflows/p_one.json'), '{"id": "p_one", "versions": []}');
    assert.equal(workflows.get({ id: 'p_one', name: 'One' }).head, '1.0.0');
  } finally { done(); }
});
