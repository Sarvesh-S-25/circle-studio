import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyReference, makeMiniProject, rmDir, hasReference } from '../helpers/project.mjs';
import { makeEngine, seedWorkflow } from '../helpers/engine.mjs';

const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const cleanup = (...dirs) => dirs.forEach(rmDir);
const paths = (cs) => cs.files.map((f) => f.path).sort();

test('model op on the real scaffold: one line in models.json, predicted agent line, script runs, drift gone', { skip: !hasReference }, async () => {
  const root = copyReference();
  const { cm, dataDir } = makeEngine(root);
  try {
    const before = read(root, 'models.json');
    const cs = cm.preview('p1', [{ op: 'model', role: 'researcher', model: 'sonnet' }]);
    assert.deepEqual(paths(cs), ['.claude/agents/researcher.md', 'models.json']);
    const models = cs.files.find((f) => f.path === 'models.json');
    assert.equal(models.via, 'app');
    assert.equal(models.diff.added, 1);
    assert.equal(models.diff.removed, 1);
    const agent = cs.files.find((f) => f.path === '.claude/agents/researcher.md');
    assert.equal(agent.via, 'apply-models.mjs');
    assert.equal(agent.diff.added, 1);
    assert.equal(cs.commands.length, 1);
    assert.equal(read(root, 'models.json'), before, 'preview wrote nothing');

    const res = await cm.apply(cs.id);
    assert.deepEqual(res.applied, ['models.json']);
    assert.deepEqual(res.viaScript, ['.claude/agents/researcher.md']);
    assert.ok(res.commands[0].ok, res.commands[0].output);
    assert.match(read(root, '.claude/agents/researcher.md'), /^model: sonnet$/m);
    assert.equal(res.warnings.filter((w) => /not what the preview predicted/.test(w)).length, 0);
    assert.ok(res.backup && fs.existsSync(path.join(dataDir, res.backup, 'models.json')), 'a backup was made');
    const check = spawnSync(process.execPath, ['scripts/apply-models.mjs', '--check'], { cwd: root, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    await assert.rejects(() => cm.apply(cs.id), /expired or was already applied/);
  } finally { cleanup(root, dataDir); }
});

test('model op on a mini project without the script edits the agent line directly (CRLF-safe)', async () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    const cs = cm.preview('p1', [{ op: 'model', role: 'planner', model: 'opus', note: 'Needs the strongest tier.' }]);
    assert.equal(cs.commands.length, 0);
    assert.ok(cs.warnings.some((w) => /no scripts\/apply-models\.mjs/.test(w)));
    const res = await cm.apply(cs.id);
    assert.deepEqual(res.applied.sort(), ['.claude/agents/planner.md', 'models.json']);
    assert.match(read(root, '.claude/agents/planner.md'), /^model: opus$/m);
    assert.equal(JSON.parse(read(root, 'models.json')).roles.planner.note, 'Needs the strongest tier.');
    assert.equal(JSON.parse(read(root, 'models.json')).roles.researcher.model, 'haiku');
  } finally { cleanup(root, dataDir); }
});

test('model op validates the tier and the role', () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    assert.throws(() => cm.preview('p1', [{ op: 'model', role: 'planner', model: 'sonnet[1m]' }]), /not allowed/);
    assert.throws(() => cm.preview('p1', [{ op: 'model', role: 'nobody', model: 'opus' }]), /not in models\.json/);
    assert.throws(() => cm.preview('p1', [{ op: 'model', role: '../x', model: 'opus' }]), /Invalid role/);
    assert.throws(() => cm.preview('p1', [{ op: 'nope' }]), /Unknown operation/);
    const same = cm.preview('p1', [{ op: 'model', role: 'planner', model: 'sonnet' }]);
    assert.equal(same.id, null);
    assert.equal(same.files.length, 0);
  } finally { cleanup(root, dataDir); }
});

test('malformed models.json is refused, not guessed at', () => {
  const root = makeMiniProject();
  fs.writeFileSync(path.join(root, 'models.json'), '{ "roles": { broken');
  const { cm, dataDir } = makeEngine(root);
  try {
    assert.throws(() => cm.preview('p1', [{ op: 'model', role: 'planner', model: 'opus' }]), /not valid JSON/);
  } finally { cleanup(root, dataDir); }
});

test('engines op: validates the chain and keeps other keys', async () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    assert.throws(() => cm.preview('p1', [{ op: 'engines', role: 'planner', engine: 'gemini', failover: ['gemini'] }]), /twice/);
    assert.throws(() => cm.preview('p1', [{ op: 'engines', role: 'planner', engine: 'claude', failover: [] }]), /Unknown engine/);
    assert.throws(() => cm.preview('p1', [{ op: 'engines', role: 'planner', engine: 'codex', failover: ['self', 'gemini'] }]), /last/);
    const cs = cm.preview('p1', [{ op: 'engines', role: 'researcher', engine: 'codex', failover: ['gemini', 'self'] }]);
    await cm.apply(cs.id);
    const cfg = JSON.parse(read(root, '.claude/consult.config.json'));
    assert.deepEqual(cfg.roles.researcher, { engine: 'codex', web: true, failover: ['gemini', 'self'] });
    assert.equal(read(root, '.claude/consult.config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
    const skill = cm.preview('p1', [{ op: 'engines', role: 'my-skill', engine: 'copilot', failover: ['self'] }]);
    assert.ok(skill.warnings.some((w) => /consult\.mjs --role my-skill/.test(w)));
  } finally { cleanup(root, dataDir); }
});

test('engines-default puts the chosen engine first everywhere and self last', async () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    await cm.apply(cm.preview('p1', [{ op: 'engines-default', engine: 'codex' }]).id);
    const cfg = JSON.parse(read(root, '.claude/consult.config.json'));
    assert.equal(cfg.default, 'codex');
    assert.deepEqual(cfg.failover, ['codex', 'gemini', 'copilot', 'self']);
    assert.deepEqual(cfg.roles.researcher, { engine: 'codex', web: true, failover: ['gemini', 'copilot', 'self'] });
  } finally { cleanup(root, dataDir); }
});

test('roster op keeps CRLF and the missing final newline', async () => {
  const root = makeMiniProject({ crlfRoster: true });
  const { cm, dataDir } = makeEngine(root);
  try {
    const before = read(root, '.claude/state/roster.json');
    assert.ok(before.includes('\r\n'));
    const cs = cm.preview('p1', [{ op: 'roster', key: 'deployer', value: true }]);
    assert.equal(cs.files[0].eol, 'crlf');
    await cm.apply(cs.id);
    const after = read(root, '.claude/state/roster.json');
    assert.equal(after, before.replace('"deployer": false', '"deployer": true'));
    assert.throws(() => cm.preview('p1', [{ op: 'roster', key: 'ghost', value: true }]), /not an optional agent/);
  } finally { cleanup(root, dataDir); }
});

test('board-post: urgent row goes on top with six cells; pipes are escaped', async () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    const cs = cm.preview('p1', [{ op: 'board-post', text: 'Stop the login work | use the new API\nnow', to: 'fe-builder', urgent: true, supersedes: [1] }]);
    await cm.apply(cs.id);
    const rows = read(root, 'docs/tasks/BOARD.md').split('\n');
    const at = rows.findIndex((l) => l.startsWith('|---'));
    assert.match(rows[at + 1], /^\| TX-002 \| fe-builder \| open \| human \(Circle Studio\) \| URGENT - Stop the login work \\\| use the new API now; supersedes TX-001 \| \d{4}-\d\d-\d\d \|$/);
    assert.equal(rows[at + 1].replace(/\\\|/g, '').split('|').length - 2, 6);
    assert.throws(() => cm.preview('p1', [{ op: 'board-post', text: '' }]), /between 1 and 400/);
    assert.throws(() => cm.preview('p1', [{ op: 'board-post', text: 'use sk-ant-abcdefghijklmnopqrstuvwxyz1234' }]), /secret/);
  } finally { cleanup(root, dataDir); }
});

test('adr-status changes one line and keeps each file\'s EOL; only the header block counts', async () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    const cs1 = cm.preview('p1', [{ op: 'adr-status', file: '001-stack.md', status: 'accepted' }, { op: 'adr-status', file: '002-db.md', status: 'proposed' }]);
    await cm.apply(cs1.id);
    assert.equal(read(root, 'docs/adr/001-stack.md'), '# ADR 001 - Stack\n\n- **Status:** accepted\n- **Date:** 2026-01-01\n\n## Context\n\nStatus of things.\n');
    assert.equal(read(root, 'docs/adr/002-db.md'), '# ADR 002 - DB\r\n\r\n- **Status:** proposed\r\n- **Date:** 2026-01-02\r\n\r\n## Context\r\n');
    assert.throws(() => cm.preview('p1', [{ op: 'adr-status', file: '../../x.md', status: 'accepted' }]), /look like/);
  } finally { cleanup(root, dataDir); }
});

test('freeze-set writes lane names only and warns that paths are ignored', async () => {
  const root = makeMiniProject();
  fs.writeFileSync(path.join(root, '.claude/state/freeze.json'), '{"frozen": [], "request_id": null, "paths": ["backend/x.ts"]}\n');
  const { cm, dataDir } = makeEngine(root);
  try {
    assert.throws(() => cm.preview('p1', [{ op: 'freeze-set', frozen: ['Backend'] }]), /lowercase/);
    const cs = cm.preview('p1', [{ op: 'freeze-set', frozen: ['backend'], requestId: 'CH-9' }]);
    assert.ok(cs.warnings.some((w) => /paths/.test(w)));
    await cm.apply(cs.id);
    assert.equal(read(root, '.claude/state/freeze.json'), '{"frozen": ["backend"], "request_id": "CH-9", "paths": ["backend/x.ts"]}\n');
  } finally { cleanup(root, dataDir); }
});

test('secrets-fix: preview is redacted, write uses the real text, defaults become ${VAR}', async () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    const cs = cm.preview('p1', [{ op: 'secrets-fix' }]);
    const json = JSON.stringify(cs);
    assert.ok(!json.includes('abcdefghijklmnop1234'), 'no secret in the preview');
    assert.equal(cs.files[0].redacted, true);
    assert.ok(cs.warnings.some((w) => /Rotate/.test(w)));
    await cm.apply(cs.id);
    const after = read(root, '.mcp.json');
    assert.ok(after.includes('Bearer ${DEMO_TOKEN}'));
    assert.ok(!after.includes('sk-ant'));
  } finally { cleanup(root, dataDir); }
});

test('human-git: roster key, anchored .gitignore block that keeps contracts, push.md; never git', async () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    const cs = cm.preview('p1', [{ op: 'human-git', value: true }]);
    assert.deepEqual(paths(cs), ['.claude/state/roster.json', '.gitignore', 'push.md']);
    await cm.apply(cs.id);
    assert.equal(JSON.parse(read(root, '.claude/state/roster.json')).human_does_git, true);
    const gi = read(root, '.gitignore');
    assert.ok(gi.startsWith('node_modules/\n.env\n'));
    assert.ok(gi.includes('\n/scripts/\n') && !gi.includes('\nscripts/\n'));
    assert.ok(!gi.includes('contracts'));
    assert.match(read(root, 'push.md'), /^# Pushing /);
    // turning it off removes the block
    await cm.apply(cm.preview('p1', [{ op: 'human-git', value: false }]).id);
    assert.equal(read(root, '.gitignore'), 'node_modules/\n.env\n');
    assert.equal(JSON.parse(read(root, '.claude/state/roster.json')).human_does_git, false);
  } finally { cleanup(root, dataDir); }
});

test('apply refuses when a file changed after the preview, and writes nothing', async () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    const cs = cm.preview('p1', [{ op: 'model', role: 'planner', model: 'opus' }]);
    fs.appendFileSync(path.join(root, 'models.json'), '\n');
    const snapshot = read(root, '.claude/agents/planner.md');
    await assert.rejects(() => cm.apply(cs.id), /changed on disk since the preview/);
    assert.equal(read(root, '.claude/agents/planner.md'), snapshot);
  } finally { cleanup(root, dataDir); }
});

test('the control plane is never written', () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    assert.throws(() => cm.preview('p1', [{ op: 'agent-field', role: 'planner', field: 'model', value: 'opus' }]), /"model" operation/);
  } finally { cleanup(root, dataDir); }
});

test('agent-field edits one front matter line', async () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    await cm.apply(cm.preview('p1', [{ op: 'agent-field', role: 'planner', field: 'description', value: 'Plans: carefully.' }]).id);
    assert.equal(read(root, '.claude/agents/planner.md'), '---\nname: planner\ndescription: "Plans: carefully."\nmodel: sonnet\ntools: Read, Grep\n---\n\nBody.\n');
  } finally { cleanup(root, dataDir); }
});

test('skill-install copies a library skill, refuses to clobber, edits its model', async () => {
  const root = makeMiniProject();
  const { cm, library, dataDir, effects } = makeEngine(root);
  try {
    library.put('demo-skill', [
      { path: 'SKILL.md', buffer: Buffer.from('---\nname: demo-skill\ndescription: Demo.\n---\n\nHello\n') },
      { path: 'refs/notes.md', buffer: Buffer.from('notes') },
      { path: 'assets/dot.bin', buffer: Buffer.from([0, 1, 2, 3]) },
    ], { type: 'local' });
    const cs = cm.preview('p1', [{ op: 'skill-install', name: 'demo-skill' }]);
    assert.equal(cs.files.length, 3);
    assert.ok(cs.files.find((f) => f.binary));
    await cm.apply(cs.id);
    assert.deepEqual(fs.readFileSync(path.join(root, '.claude/skills/demo-skill/assets/dot.bin')), Buffer.from([0, 1, 2, 3]));
    assert.equal(effects.length, 1);
    assert.equal(library.get('demo-skill').uses, 1);
    assert.equal(cm.preview('p1', [{ op: 'skill-install', name: 'demo-skill' }]).files.length, 0, 'installing twice changes nothing');
    fs.writeFileSync(path.join(root, '.claude/skills/demo-skill/SKILL.md'), '---\nname: demo-skill\ndescription: Edited by hand.\n---\n');
    assert.throws(() => cm.preview('p1', [{ op: 'skill-install', name: 'demo-skill' }]), /already installed/);
    assert.ok(cm.preview('p1', [{ op: 'skill-install', name: 'demo-skill', overwrite: true }]).files.length >= 1);
    await cm.apply(cm.preview('p1', [{ op: 'skill-model', name: 'demo-skill', model: 'haiku' }]).id);
    assert.match(read(root, '.claude/skills/demo-skill/SKILL.md'), /^model: haiku$/m);
  } finally { cleanup(root, dataDir); }
});

test('agent-install brings the agent, models.json, consult entry and REFERENCE-LINKS section from another project', async () => {
  const root = makeMiniProject();
  const source = makeMiniProject();
  fs.writeFileSync(path.join(source, '.claude/agents/qa.md'), '---\nname: qa\ndescription: Tests things.\nmodel: opus\ntools: Read, Grep\n---\n\nBody.\n');
  const models = JSON.parse(read(source, 'models.json'));
  models.roles.qa = { model: 'opus', note: 'Tests.' };
  fs.writeFileSync(path.join(source, 'models.json'), JSON.stringify(models, null, 2));
  const { cm, dataDir } = makeEngine(root, { others: { p2: source } });
  try {
    assert.throws(() => cm.preview('p1', [{ op: 'agent-install', role: 'qa' }]), /which project/);
    const cs = cm.preview('p1', [{ op: 'agent-install', from: 'p2', role: 'qa' }]);
    assert.ok(paths(cs).includes('.claude/agents/qa.md'));
    assert.ok(paths(cs).includes('models.json'));
    assert.ok(paths(cs).includes('REFERENCE-LINKS.md'));
    await cm.apply(cs.id);
    assert.ok(read(root, 'REFERENCE-LINKS.md').includes('## qa'));
    assert.equal(JSON.parse(read(root, 'models.json')).roles.qa.model, 'opus');
    assert.match(read(root, '.claude/agents/qa.md'), /^model: opus$/m);
    assert.throws(() => cm.preview('p1', [{ op: 'agent-install', from: 'p2', role: 'qa' }]), /already exists/);
    assert.throws(() => cm.preview('p1', [{ op: 'agent-install', from: 'p1', role: 'qa' }]), /same/);
  } finally { cleanup(root, source, dataDir); }
});

test('plan-write creates the brief and later only replaces its own block', async () => {
  const root = makeMiniProject();
  const { cm, dataDir } = makeEngine(root);
  try {
    const cs = cm.preview('p1', [{ op: 'plan-write' }]);
    assert.ok(paths(cs).includes('docs/brief.md'));
    await cm.apply(cs.id);
    let brief = read(root, 'docs/brief.md');
    assert.match(brief, /^# Brief: demo/);
    assert.ok(brief.includes('<!-- circle:plan:start -->') && brief.includes('<!-- circle:plan:end -->'));
    brief = brief.replace('(not written yet)', 'MY OWN WORDS');
    fs.writeFileSync(path.join(root, 'docs/brief.md'), brief);
    assert.equal(cm.preview('p1', [{ op: 'plan-write' }]).id, null, 'an unchanged plan changes nothing');
    const changed = seedWorkflow();
    changed.nodes.find((n) => n.id === 'deployer').defaultOn = false;
    changed.nodes.find((n) => n.id === 'deploy').gate = { on: false, label: '' };
    const second = makeEngine(root, { workflow: changed });
    const cs2 = second.cm.preview('p1', [{ op: 'plan-write' }]);
    assert.deepEqual(paths(cs2), ['.claude/state/roster.json', 'docs/brief.md']);
    await second.cm.apply(cs2.id);
    assert.ok(read(root, 'docs/brief.md').includes('MY OWN WORDS'));
    assert.match(read(root, 'docs/brief.md'), /\| 8 \| Deploy \| deployer \(claude\) \| go on \|/);
    assert.equal(JSON.parse(read(root, '.claude/state/roster.json')).optional.deployer, false);
    rmDir(second.dataDir);
  } finally { cleanup(root, dataDir); }
});
