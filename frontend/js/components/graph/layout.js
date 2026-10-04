// Pure geometry for the workflow graph: no DOM, so tests import it directly.
// A workflow is { nodes:[{id,kind,parent?,position?}], edges:[{from,to}] } (docs/spec.md).

export const NODE_W = 236;
export const SIZES = { human: 96, stage: 136, agent: 136 };
const GAP_X = 176; // room on the arrow between two columns for a checkpoint marker and its label
const GAP_Y = 20;
const PAD = 32;
const ROW_GAP = 72;

export const nodeHeight = (n) => SIZES[n.kind] || SIZES.agent;
export const childrenOf = (wf, id) => wf.nodes.filter((n) => n.parent === id);
const hasParent = (wf, n) => n.kind === 'agent' && n.parent && wf.nodes.some((p) => p.id === n.parent && p.id !== n.id);

/** Nodes that take part in the flow. An agent under a stage rides in its stage's column instead. */
export const flowNodes = (wf) => wf.nodes.filter((n) => !hasParent(wf, n));

/** Column of every flow node: the longest chain of edges leading to it. Cycles are cut where they are found. */
export function layers(wf) {
  const flow = flowNodes(wf);
  const ids = new Set(flow.map((n) => n.id));
  const preds = new Map(flow.map((n) => [n.id, []]));
  for (const e of wf.edges) if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to) preds.get(e.to).push(e.from);
  const layer = new Map();
  const open = new Set();
  const depth = (id) => {
    if (layer.has(id)) return layer.get(id);
    if (open.has(id)) return 0;
    open.add(id);
    let d = 0;
    for (const p of preds.get(id)) d = Math.max(d, depth(p) + 1);
    open.delete(id);
    layer.set(id, d);
    return d;
  };
  flow.forEach((n) => depth(n.id));
  return layer;
}

const KIDS_PER_COLUMN = 4;
const subColumns = (wf, n) => Math.max(1, Math.ceil(childrenOf(wf, n.id).length / KIDS_PER_COLUMN));
const layerWidth = (wf, col) => Math.max(...col.map((n) => subColumns(wf, n) * NODE_W + (subColumns(wf, n) - 1) * GAP_Y), NODE_W);
const blockHeight = (wf, n) => {
  const kids = childrenOf(wf, n.id).slice(0, KIDS_PER_COLUMN);
  return nodeHeight(n) + kids.reduce((s, c) => s + GAP_Y + nodeHeight(c), 0);
};

/**
 * Automatic positions { id: {x, y} } (top-left corners): one column per layer, a stage's agents in sub-columns of four
 * under it, and a new row when a row would be wider than `maxRowWidth`.
 */
export function tidy(wf, { maxRowWidth = 6 * (NODE_W + GAP_X) } = {}) {
  const layer = layers(wf);
  const columns = [];
  for (const n of flowNodes(wf)) (columns[layer.get(n.id)] ||= []).push(n);
  const pos = {};
  let rowTop = PAD;
  let rowHeight = 0;
  let x = PAD;
  for (const col of columns) {
    if (!col) continue;
    const w = layerWidth(wf, col);
    if (x > PAD && x + w > PAD + maxRowWidth) { rowTop += rowHeight + ROW_GAP; rowHeight = 0; x = PAD; }
    let y = rowTop;
    for (const n of col) {
      pos[n.id] = { x, y };
      childrenOf(wf, n.id).forEach((kid, i) => {
        pos[kid.id] = { x: x + Math.floor(i / KIDS_PER_COLUMN) * (NODE_W + GAP_Y), y: y + nodeHeight(n) + GAP_Y + (i % KIDS_PER_COLUMN) * (nodeHeight(kid) + GAP_Y) };
      });
      y += blockHeight(wf, n) + GAP_Y;
    }
    rowHeight = Math.max(rowHeight, y - rowTop);
    x += w + GAP_X;
  }
  return pos;
}

/** Where a node is: its own saved position, else the automatic one. */
export const placed = (wf, auto) => Object.fromEntries(wf.nodes.map((n) => [n.id, n.position || auto[n.id] || { x: PAD, y: PAD }]));

export const boxOf = (n, p) => ({ x: p.x, y: p.y, w: NODE_W, h: nodeHeight(n) });

/* Helpers: a small node beside an agent (its Haiku reader), joined by a dashed line. Not a step of the flow: it works
   inside that agent's turn. It sits in the gap to the right of the card, or hangs off the card's corner when another
   card is there (a stage with more than four agents). */
export const HELPER_W = 132;
export const HELPER_H = 50;
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const hasHelper = (n) => n.kind === 'agent' && (n.reader === true || Boolean(n.condense));
export function helperBox(agentBox, others = []) {
  const beside = { x: agentBox.x + agentBox.w + 24, y: agentBox.y + 28, w: HELPER_W, h: HELPER_H };
  if (!others.some((o) => overlaps(beside, o))) return { ...beside, hanging: false };
  return { x: agentBox.x + agentBox.w - HELPER_W + 10, y: agentBox.y + agentBox.h - 18, w: HELPER_W, h: HELPER_H, hanging: true };
}

export function bounds(wf, positions) {
  if (!wf.nodes.length) return { x: 0, y: 0, w: 1, h: 1 };
  let x1 = Infinity; let y1 = Infinity; let x2 = -Infinity; let y2 = -Infinity;
  for (const n of wf.nodes) {
    const b = boxOf(n, positions[n.id]);
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h);
    if (hasHelper(n)) x2 = Math.max(x2, b.x + b.w + 24 + HELPER_W); // room for its helper beside it
  }
  return { x: x1 - PAD, y: y1 - PAD, w: x2 - x1 + PAD * 2, h: y2 - y1 + PAD * 2 };
}

/** A curved connector between two boxes: `d` for an SVG path, `mid` for its label, `end`/`angle` for nothing else to compute. */
export function edgeGeometry(a, b) {
  let s; let e; let d;
  if (b.x >= a.x + a.w + 24) {
    s = { x: a.x + a.w, y: a.y + a.h / 2 };
    e = { x: b.x, y: b.y + b.h / 2 };
    const k = Math.max(40, (e.x - s.x) / 2);
    d = `M${s.x} ${s.y} C${s.x + k} ${s.y} ${e.x - k} ${e.y} ${e.x} ${e.y}`;
  } else if (b.y >= a.y + a.h) {
    s = { x: a.x + a.w / 2, y: a.y + a.h };
    e = { x: b.x + b.w / 2, y: b.y };
    const k = Math.max(32, (e.y - s.y) / 2);
    d = `M${s.x} ${s.y} C${s.x} ${s.y + k} ${e.x} ${e.y - k} ${e.x} ${e.y}`;
  } else {
    s = { x: a.x, y: a.y + a.h / 2 };
    e = { x: b.x + b.w, y: b.y + b.h / 2 };
    const k = 64;
    d = `M${s.x} ${s.y} C${s.x - k} ${s.y} ${e.x + k} ${e.y} ${e.x} ${e.y}`;
  }
  return { d, start: s, end: e, mid: { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 } };
}

/**
 * Where a stage's checkpoint marker sits: on the arrow to the next stage (the first one, when there are several),
 * or just after the stage when nothing follows it. `next` is the box of that next stage or null.
 */
export function checkpointPoint(stageBox, next) {
  if (next) return edgeGeometry(stageBox, next).mid;
  return { x: stageBox.x + stageBox.w + 88, y: stageBox.y + stageBox.h / 2 };
}

/** The node closest to `from` in an arrow direction, or null. Used for keyboard movement between nodes. */
export function neighbour(dir, from, others) {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best = null;
  let bestScore = Infinity;
  for (const o of others) {
    const dx = o.box.x + o.box.w / 2 - cx;
    const dy = o.box.y + o.box.h / 2 - cy;
    const along = { right: dx, left: -dx, down: dy, up: -dy }[dir];
    if (along <= 4) continue;
    const across = Math.abs(dir === 'left' || dir === 'right' ? dy : dx);
    const score = along + across * 2;
    if (score < bestScore) { best = o; bestScore = score; }
  }
  return best ? best.id : null;
}

/** The semantic-version level a change calls for (same rules as the server: patch, minor, major). */
export function suggestBump(before, after) {
  const ids = (w) => new Set(w.nodes.map((n) => n.id));
  const key = (e) => `${e.from}>${e.to}`;
  const a = ids(before); const b = ids(after);
  const ea = new Set(before.edges.map(key)); const eb = new Set(after.edges.map(key));
  const removed = [...a].some((id) => !b.has(id)) || [...ea].some((k) => !eb.has(k));
  const added = [...b].some((id) => !a.has(id)) || [...eb].some((k) => !ea.has(k));
  const needs = after.nodes.some((n) => a.has(n.id) && JSON.stringify(before.nodes.find((o) => o.id === n.id).needs || []) !== JSON.stringify(n.needs || []));
  const order = (w) => w.nodes.filter((n) => n.kind === 'stage' && (a.has(n.id) && b.has(n.id))).map((n) => n.id).join();
  if (removed || needs || order(before) !== order(after)) return 'major';
  if (added) return 'minor';
  return JSON.stringify(before) === JSON.stringify(after) ? null : 'patch';
}

export function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

export function uniqueId(wf, base) {
  const stem = String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'node';
  const taken = new Set(wf.nodes.map((n) => n.id));
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) if (!taken.has(`${stem}-${i}`)) return `${stem}-${i}`;
}
