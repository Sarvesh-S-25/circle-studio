import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Store } from '../../backend/lib/store.mjs';
import { Library, normalizePlacement, PARTITIONS } from '../../backend/lib/skills.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

const md = (name = 's') => `---\nname: ${name}\ndescription: Demo.\n---\n\nBody\n`;
const ALL = ['claude', 'codex', 'gemini', 'copilot'];

function setup() {
  const dir = tempDir('circle-lib-');
  const store = new Store(dir);
  return { dir, store, library: new Library({ store }), done: () => rmDir(dir) };
}

test('normalizePlacement: defaults, order, and what it refuses', () => {
  assert.deepEqual(normalizePlacement(), { partition: 'shared', engines: ALL });
  assert.deepEqual(normalizePlacement({ partition: 'gemini', engines: ['gemini', 'claude'] }), { partition: 'gemini', engines: ['claude', 'gemini'] });
  assert.deepEqual(PARTITIONS, ['shared', 'claude', 'copilot', 'gemini']);
  for (const bad of [{ partition: 'codex' }, { partition: 'x' }, { engines: ['gpt'] }, { engines: 'claude' }]) {
    assert.throws(() => normalizePlacement(bad), (e) => e.code === 'bad_request', JSON.stringify(bad));
  }
});

test('a library from before partitions is migrated once: every skill is shared with every engine', () => {
  const { store, library, done } = setup();
  try {
    library.save('old-one', md('old-one'));
    store.writeJson('library.json', { version: 1, skills: { 'old-one': { uses: 3, source: { type: 'created' } } } });
    const [skill] = library.list();
    assert.equal(skill.partition, 'shared');
    assert.deepEqual(skill.engines, ALL);
    assert.equal(skill.uses, 3, 'nothing else about the entry changes');
    const stored = store.readJson('library.json');
    assert.equal(stored.version, 2);
    assert.deepEqual(stored.skills['old-one'], { uses: 3, source: { type: 'created' }, partition: 'shared', engines: ALL });
    assert.deepEqual(library.enginesFor('old-one'), ALL);
    assert.deepEqual(library.enginesFor('not-there'), ALL, 'a skill with no record is shared too');
  } finally { done(); }
});

test('save keeps or changes the placement; a new skill starts shared', () => {
  const { library, done } = setup();
  try {
    assert.equal(library.save('one', md('one')).skill.partition, 'shared');
    const gemini = library.save('one', md('one'), { partition: 'gemini', engines: ['gemini'] });
    assert.deepEqual([gemini.skill.partition, gemini.skill.engines], ['gemini', ['gemini']]);
    const edited = library.save('one', md('one').replace('Body', 'New body'));
    assert.deepEqual([edited.skill.partition, edited.skill.engines], ['gemini', ['gemini']], 'editing the text keeps the placement');
    const only = library.save('one', undefined, { engines: ['claude', 'copilot'] });
    assert.equal(only.created, false);
    assert.deepEqual([only.skill.partition, only.skill.engines], ['gemini', ['claude', 'copilot']]);
    assert.match(fs.readFileSync(`${library.dir}/one/SKILL.md`, 'utf8'), /New body/, 'a placement-only save leaves the file alone');
    assert.throws(() => library.save('one', undefined, {}), (e) => /Send skillMd/.test(e.message));
    assert.throws(() => library.save('brand-new', undefined, { partition: 'claude' }), (e) => /skillMd must be text/.test(e.message));
    assert.throws(() => library.save('one', md('one'), { partition: 'codex' }), (e) => e.code === 'bad_request');
    assert.equal(library.get('one').partition, 'gemini');
  } finally { done(); }
});

test('enginesFor: shared skills go to every listed engine, a partitioned skill only to its own', () => {
  const { library, done } = setup();
  try {
    library.save('shared-some', md('shared-some'), { engines: ['claude', 'codex'] });
    library.save('claude-own', md('claude-own'), { partition: 'claude' });
    library.save('gemini-own', md('gemini-own'), { partition: 'gemini', engines: ['claude'] });
    assert.deepEqual(library.enginesFor('shared-some'), ['claude', 'codex']);
    assert.deepEqual(library.enginesFor('claude-own'), ['claude']);
    assert.deepEqual(library.enginesFor('gemini-own'), [], 'its partition names an engine the skill does not list');
  } finally { done(); }
});

test('put and importDropped take a placement; a re-import keeps the one a skill has', () => {
  const { library, done } = setup();
  try {
    const files = [{ path: 'SKILL.md', buffer: Buffer.from(md('imp')) }];
    library.put('imp', files, { type: 'local' }, { partition: 'copilot', engines: ['copilot', 'codex'] });
    assert.deepEqual([library.get('imp').partition, library.get('imp').engines], ['copilot', ['codex', 'copilot']]);
    library.put('imp', files, { type: 'local' }, { overwrite: true });
    assert.equal(library.get('imp').partition, 'copilot', 'overwriting without a placement keeps it');
    const dropped = library.importDropped([{ path: 'dropped/SKILL.md', buffer: Buffer.from(md('dropped')) }], { partition: 'claude' });
    assert.deepEqual(dropped.imported, ['dropped']);
    assert.equal(library.get('dropped').partition, 'claude');
    assert.throws(() => library.importDropped([], { partition: 'nope' }), (e) => e.code === 'bad_request');
  } finally { done(); }
});
