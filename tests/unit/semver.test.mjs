import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkflow, diffWorkflows } from '../../backend/lib/workflow.mjs';
import { bumpLevel, summarize, nextVersion, startHistory, appendVersion, restoreVersion, describeVersions, MAX_VERSIONS } from '../../backend/lib/semver.mjs';

const base = () => normalizeWorkflow({
  name: 'Flow',
  nodes: [
    { id: 'you', kind: 'human' },
    { id: 'a', kind: 'stage', title: 'A' },
    { id: 'b', kind: 'stage', title: 'B', needs: ['a'] },
    { id: 'x', kind: 'agent', parent: 'a', engine: 'claude' },
  ],
  edges: [{ from: 'you', to: 'a' }, { from: 'a', to: 'b' }],
});
const edit = (fn) => { const wf = base(); fn(wf); return normalizeWorkflow(wf); };
const level = (after) => bumpLevel(diffWorkflows(base(), after));
const node = (wf, id) => wf.nodes.find((n) => n.id === id);

test('patch: only property edits', () => {
  assert.equal(level(edit((w) => { node(w, 'x').engine = 'codex'; })), 'patch');
  assert.equal(level(edit((w) => { node(w, 'x').model = 'haiku'; })), 'patch');
  assert.equal(level(edit((w) => { node(w, 'x').skills = ['s-one']; })), 'patch');
  assert.equal(level(edit((w) => { node(w, 'a').gate = { on: true, label: 'Look' }; })), 'patch');
  assert.equal(level(edit((w) => { node(w, 'a').notes = 'n'; })), 'patch');
  assert.equal(level(edit((w) => { node(w, 'a').position = { x: 10, y: 20 }; })), 'patch');
  assert.equal(level(edit((w) => { node(w, 'x').parent = 'b'; })), 'patch', 'moving an agent to another stage is a property edit');
  assert.equal(level(edit((w) => { w.name = 'Renamed'; })), 'patch');
  assert.equal(level(edit((w) => { w.edges[1].label = 'then'; })), 'patch');
});

test('minor: nodes or edges added', () => {
  assert.equal(level(edit((w) => { w.nodes.push({ id: 'y', kind: 'agent', parent: 'a' }); })), 'minor');
  assert.equal(level(edit((w) => { w.edges.push({ from: 'x', to: 'b' }); })), 'minor');
  assert.equal(level(edit((w) => { w.nodes.push({ id: 'c', kind: 'stage' }); node(w, 'x').notes = 'also a property edit'; })), 'minor');
});

test('major: nodes or edges removed, needs changed, stage order changed', () => {
  assert.equal(level(edit((w) => { w.nodes = w.nodes.filter((n) => n.id !== 'x'); })), 'major');
  assert.equal(level(edit((w) => { w.edges = w.edges.slice(0, 1); node(w, 'b').needs = ['a']; })), 'major', 'an edge removed');
  assert.equal(level(edit((w) => { node(w, 'b').needs = []; })), 'major');
  const noFlow = (fn) => { const w = base(); w.edges = []; for (const n of w.nodes) if (n.needs) n.needs = []; fn(w); return normalizeWorkflow(w); };
  const plain = noFlow(() => {});
  const swapped = noFlow((w) => { w.nodes = [w.nodes[0], w.nodes[2], w.nodes[1], w.nodes[3]]; });
  assert.equal(bumpLevel(diffWorkflows(plain, swapped)), 'major', 'the same nodes and edges in another stage order');
  const added = noFlow((w) => { w.nodes.unshift({ id: 'z', kind: 'stage' }); });
  assert.equal(bumpLevel(diffWorkflows(plain, added)), 'minor', 'a new stage does not reorder the ones already there');
  assert.equal(level(edit(() => {})), null, 'nothing changed');
});

test('the summary counts added, removed and changed', () => {
  const after = edit((w) => {
    w.nodes.push({ id: 'y', kind: 'agent', parent: 'a' });
    w.edges.push({ from: 'y', to: 'a' });
    w.nodes = w.nodes.filter((n) => n.id !== 'b');
    node(w, 'x').engine = 'gemini';
    w.name = 'Other';
  });
  assert.deepEqual(summarize(diffWorkflows(base(), after)), { added: 2, removed: 2, changed: 2 });
  assert.match(diffWorkflows(base(), after).changes.map((c) => c.text).join('\n'), /Removed stage "B"[\s\S]*Changed engine of "x"/);
});

test('nextVersion resets the lower parts', () => {
  assert.equal(nextVersion('1.4.7', 'patch'), '1.4.8');
  assert.equal(nextVersion('1.4.7', 'minor'), '1.5.0');
  assert.equal(nextVersion('1.4.7', 'major'), '2.0.0');
});

test('history: first version 1.0.0, each save appends, identical content is not saved again', () => {
  const at = '2026-01-01T00:00:00.000Z';
  let record = startHistory(base(), { note: 'first', at });
  assert.equal(record.head, '1.0.0');
  assert.deepEqual(record.versions[0].summary, { added: 6, removed: 0, changed: 0 });
  assert.equal(record.versions[0].parent, null);

  const same = appendVersion(record, base(), { at });
  assert.equal(same.unchanged, true);
  assert.equal(same.record, record);

  const p = appendVersion(record, edit((w) => { node(w, 'x').model = 'haiku'; }), { note: 'tune', at });
  assert.equal(p.version, '1.0.1');
  assert.equal(p.record.versions[1].parent, '1.0.0');
  assert.equal(p.record.versions[1].workflow.version, '1.0.1');
  const m = appendVersion(p.record, edit((w) => { node(w, 'x').model = 'haiku'; w.nodes.push({ id: 'y', kind: 'agent', parent: 'a' }); }), { at });
  assert.equal(m.version, '1.1.0');
  const forced = appendVersion(record, edit((w) => { node(w, 'x').model = 'opus'; }), { bump: 'major', at });
  assert.equal(forced.version, '2.0.0', 'the request may force the level');
  assert.throws(() => appendVersion(record, edit((w) => { node(w, 'x').model = 'opus'; }), { bump: 'huge', at }), /bump must be/);
});

test('restore appends a new version that remembers where it came from', () => {
  const at = '2026-01-01T00:00:00.000Z';
  let record = startHistory(base(), { at });
  record = appendVersion(record, edit((w) => { w.nodes = w.nodes.filter((n) => n.id !== 'x'); }), { at }).record;
  assert.equal(record.head, '2.0.0');
  const back = restoreVersion(record, '1.0.0', { at });
  assert.equal(back.version, '2.1.0', 'the way back adds a node, so it is a minor step');
  assert.equal(back.record.versions.at(-1).restoredFrom, '1.0.0');
  assert.equal(back.record.versions.at(-1).parent, '2.0.0');
  assert.equal(back.record.versions.at(-1).note, 'Restored 1.0.0');
  assert.deepEqual(back.record.versions.at(-1).workflow.nodes.map((n) => n.id), ['you', 'a', 'b', 'x']);
  assert.equal(restoreVersion(back.record, '2.1.0', { at }).unchanged, true, 'restoring the head changes nothing');
  assert.throws(() => restoreVersion(record, '9.9.9', { at }), /no version/);
  const view = describeVersions(back.record);
  assert.equal(view.length, 3);
  assert.deepEqual(view[0].vsHead.changes, [], 'the first version equals the restored head');
  assert.match(view[1].vsHead.changes[0].text, /Added agent "x"/);
});

test('at most 200 versions are kept, oldest first to go', () => {
  const at = '2026-01-01T00:00:00.000Z';
  let record = startHistory(base(), { at });
  for (let i = 0; i < MAX_VERSIONS + 5; i++) record = appendVersion(record, edit((w) => { node(w, 'x').notes = `note ${i}`; }), { at }).record;
  assert.equal(record.versions.length, MAX_VERSIONS);
  assert.equal(record.versions[0].parent, null);
  assert.equal(record.versions.at(-1).version, record.head);
});
