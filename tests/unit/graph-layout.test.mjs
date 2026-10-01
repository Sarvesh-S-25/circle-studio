import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NODE_W, tidy, placed, boxOf, bounds, layers, flowNodes, edgeGeometry, neighbour, suggestBump, fmtTokens, uniqueId } from '../../frontend/js/components/graph/layout.js';

const seed = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'backend', 'seed', 'staged-build-team.json'), 'utf8'));
const clone = () => structuredClone(seed);
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('tidy: every node has a place, nothing overlaps, stages flow in order', () => {
  const auto = tidy(seed);
  const pos = placed(seed, auto);
  assert.equal(Object.keys(pos).length, seed.nodes.length);
  const boxes = seed.nodes.map((n) => ({ id: n.id, box: boxOf(n, pos[n.id]) }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i].box, boxes[j].box), `${boxes[i].id} overlaps ${boxes[j].id}`);
  const L = layers(seed);
  assert.equal(L.get('you'), 0);
  assert.deepEqual(['research', 'plan', 'stack', 'security-review', 'split', 'design', 'build', 'deploy'].map((id) => L.get(id)), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(!flowNodes(seed).some((n) => n.kind === 'agent'), 'agents ride in their stage column');
});

test('tidy: agents sit under their stage in sub-columns of four, and a long flow wraps into rows', () => {
  const auto = tidy(seed);
  const build = auto.build;
  const kids = seed.nodes.filter((n) => n.parent === 'build');
  assert.ok(kids.length > 4);
  for (const n of kids) { assert.ok(auto[n.id].y > build.y); assert.ok(auto[n.id].x >= build.x && auto[n.id].x < build.x + 3 * NODE_W); }
  assert.ok(kids.some((n) => auto[n.id].x > build.x), 'more than four agents use a second sub-column');
  const rows = new Set(Object.values(auto).filter((_, i) => true).map((p) => p.y));
  assert.ok(auto.deploy.y > auto.you.y || auto.split.y > auto.you.y, 'the flow wraps into a second row');
  const wide = tidy(seed, { maxRowWidth: 1e6 });
  assert.equal(wide.deploy.y, wide.you.y, 'one row when there is room');
  assert.ok(wide.deploy.x > wide.you.x + 8 * NODE_W);
});

test('a saved position wins over the automatic one; bounds hold everything', () => {
  const wf = clone();
  wf.nodes.find((n) => n.id === 'plan').position = { x: 900, y: 500 };
  const pos = placed(wf, tidy(wf));
  assert.deepEqual(pos.plan, { x: 900, y: 500 });
  const b = bounds(wf, pos);
  for (const n of wf.nodes) { const box = boxOf(n, pos[n.id]); assert.ok(box.x >= b.x && box.y >= b.y && box.x + box.w <= b.x + b.w && box.y + box.h <= b.y + b.h); }
});

test('cycles and dangling edges do not hang or crash the layout', () => {
  const wf = { nodes: [{ id: 'a', kind: 'stage' }, { id: 'b', kind: 'stage' }, { id: 'c', kind: 'agent', parent: 'ghost' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'a', to: 'zzz' }] };
  const auto = tidy(wf);
  assert.equal(Object.keys(auto).length, 3);
  assert.deepEqual(tidy({ nodes: [], edges: [] }), {});
});

test('edgeGeometry picks the side: forward is right to left, below is bottom to top, backwards loops around', () => {
  const a = { x: 0, y: 0, w: 100, h: 50 };
  assert.deepEqual([edgeGeometry(a, { x: 300, y: 0, w: 100, h: 50 }).start, edgeGeometry(a, { x: 300, y: 0, w: 100, h: 50 }).end], [{ x: 100, y: 25 }, { x: 300, y: 25 }]);
  const down = edgeGeometry(a, { x: 0, y: 200, w: 100, h: 50 });
  assert.deepEqual([down.start, down.end], [{ x: 50, y: 50 }, { x: 50, y: 200 }]);
  const back = edgeGeometry({ x: 500, y: 0, w: 100, h: 50 }, { x: 0, y: 0, w: 100, h: 50 });
  assert.match(back.d, /^M500 25 C/);
  assert.match(back.d, /100 25$/);
});

test('neighbour finds the closest node in an arrow direction', () => {
  const at = (id, x, y) => ({ id, box: { x, y, w: 100, h: 50 } });
  const others = [at('right', 300, 0), at('far', 800, 0), at('below', 0, 200), at('left', -300, 10)];
  const from = { x: 0, y: 0, w: 100, h: 50 };
  assert.deepEqual(['right', 'left', 'down', 'up'].map((d) => neighbour(d, from, others)), ['right', 'left', 'below', null]);
});

test('suggestBump follows the server rules', () => {
  const wf = clone();
  assert.equal(suggestBump(wf, clone()), null);
  const props = clone(); props.nodes[2].engine = 'codex'; props.nodes[2].notes = 'x';
  assert.equal(suggestBump(wf, props), 'patch');
  const added = clone(); added.nodes.push({ id: 'extra', kind: 'agent', parent: 'build', skills: [], links: [] });
  assert.equal(suggestBump(wf, added), 'minor');
  const removed = clone(); removed.nodes = removed.nodes.filter((n) => n.id !== 'scaler');
  assert.equal(suggestBump(wf, removed), 'major');
  const needs = clone(); needs.nodes.find((n) => n.id === 'build').needs = ['plan'];
  assert.equal(suggestBump(wf, needs), 'major');
  const order = clone(); const [p, s] = [order.nodes.findIndex((n) => n.id === 'plan'), order.nodes.findIndex((n) => n.id === 'stack')];
  [order.nodes[p], order.nodes[s]] = [order.nodes[s], order.nodes[p]];
  assert.equal(suggestBump(wf, order), 'major');
});

test('fmtTokens and uniqueId', () => {
  assert.deepEqual([0, 12, 950, 1500, 25000, 6_800_000, NaN].map(fmtTokens), ['0', '12', '950', '1.5k', '25k', '6.8M', '0']);
  const wf = { nodes: [{ id: 'new-stage' }, { id: 'new-stage-2' }] };
  assert.deepEqual([uniqueId(wf, 'New Stage'), uniqueId(wf, 'Fresh one!'), uniqueId(wf, '***')], ['new-stage-3', 'fresh-one', 'node']);
});
