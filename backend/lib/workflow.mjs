// The workflow graph (circle-workflow/1): what a project's plan is made of. Normalising anything that comes
// from a browser, a file or a template, lint warnings, migrating an old phase list, and comparing two graphs.
// The shapes and limits are in docs/spec.md.
import { badRequest } from './errors.mjs';
import { ID_RE, NAME_RE } from './paths.mjs';

export const SCHEMA = 'circle-workflow/1';
export const LIMITS = { nodes: 80, edges: 200 };
export const ENGINE_IDS = ['claude', 'codex', 'gemini', 'copilot'];
export const KINDS = ['human', 'stage', 'agent'];

const VERSION_RE = /^\d{1,4}\.\d{1,5}\.\d{1,5}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const oneLine = (v, max) => text(v, max * 2).replace(/\s+/g, ' ').trim().slice(0, max);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const names = (v, max) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && NAME_RE.test(x)))].slice(0, max) : []);
const engines = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => ENGINE_IDS.includes(x)))] : []);

function httpsLinks(v, where) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const raw of v.slice(0, 20)) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    let ok = raw.length <= 500 && raw.startsWith('https://');
    if (ok) { try { ok = new URL(raw).protocol === 'https:'; } catch { ok = false; } }
    if (!ok) throw badRequest(`${where}: links must be https:// addresses of at most 500 characters.`);
    out.push(raw);
  }
  return out;
}

function position(v) {
  if (!isObj(v) || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return undefined;
  const clamp = (n) => Math.max(-50000, Math.min(50000, Math.round(n)));
  return { x: clamp(v.x), y: clamp(v.y) };
}

/**
 * The checkpoint after a stage. `on:false` = no stop. `by`: 'you' (the human approves, the work waits), 'engine' (another
 * engine reviews the result, then the work goes on), 'both' (an engine reviews first, then the human approves).
 * An old gate ({ on, label }) is a 'you' gate.
 */
export const GATE_BY = ['you', 'engine', 'both'];
export function normalizeGate(raw) {
  const g = isObj(raw) ? raw : {};
  const by = GATE_BY.includes(g.by) ? g.by : 'you';
  const gate = { on: g.on === true, by, label: oneLine(g.label, 200) };
  if (by !== 'you') gate.engine = ENGINE_IDS.includes(g.engine) ? g.engine : 'claude';
  return gate;
}

/** Who checks a stage's result, in plain words: "You", "Codex", "Codex, then you", or null for no stop. */
export function gateWho(gate) {
  if (!gate?.on) return null;
  const e = ENGINE_LABEL[gate.engine] || gate.engine;
  return gate.by === 'engine' ? e : gate.by === 'both' ? `${e}, then you` : 'You';
}
export const ENGINE_LABEL = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot' };

function normalizeNode(raw, at) {
  if (!isObj(raw)) throw badRequest(`Node ${at + 1} must be an object.`);
  if (typeof raw.id !== 'string' || raw.id.length > 64 || !NAME_RE.test(raw.id)) {
    throw badRequest(`Node ${at + 1} needs an id of lowercase letters, digits and single hyphens (at most 64).`);
  }
  if (!KINDS.includes(raw.kind)) throw badRequest(`Node "${raw.id}": kind must be ${KINDS.join(', ')}.`);
  const where = `Node "${raw.id}"`;
  const node = { id: raw.id, kind: raw.kind, title: oneLine(raw.title, 100) || raw.id };
  if (raw.parent !== undefined && raw.kind === 'agent') {
    if (typeof raw.parent !== 'string' || !NAME_RE.test(raw.parent)) throw badRequest(`${where}: parent must be a stage id.`);
    node.parent = raw.parent;
  }
  const does = text(raw.does, 2000);
  if (does) node.does = does;
  if (raw.kind === 'human') return withPosition(node, raw);
  if (raw.kind === 'agent') {
    if (raw.engine !== undefined && !ENGINE_IDS.includes(raw.engine)) throw badRequest(`${where}: engine must be ${ENGINE_IDS.join(', ')}.`);
    node.engine = raw.engine || 'claude';
    const model = oneLine(raw.model, 100);
    if (model) node.model = model;
    node.consult = engines(raw.consult);
    node.optional = bool(raw.optional, false);
    node.defaultOn = bool(raw.defaultOn, true);
    if (raw.reader === true) node.reader = true; // long reads go through a Haiku reader first (render.readerText)
    // automatic: above this share of its context (30..95 %), long tool output is condensed by Haiku (a hook)
    if (Number.isFinite(raw.condense)) node.condense = Math.max(30, Math.min(95, Math.round(raw.condense)));
    const prompt = text(raw.prompt, 8000);
    if (prompt) node.prompt = prompt;
  } else {
    node.gate = normalizeGate(raw.gate);
    const skipWhen = oneLine(raw.skipWhen, 300);
    if (skipWhen) node.skipWhen = skipWhen;
  }
  node.needs = names(raw.needs, 40);
  node.skills = names(raw.skills, 40);
  node.links = httpsLinks(raw.links, where);
  node.notes = text(raw.notes, 4000);
  return withPosition(node, raw);
}

function withPosition(node, raw) {
  const p = position(raw.position);
  if (p) node.position = p;
  return node;
}

function normalizeEdges(list, nodeIds) {
  if (list !== undefined && !Array.isArray(list)) throw badRequest('edges must be a list.');
  if ((list || []).length > LIMITS.edges) throw badRequest(`A workflow has at most ${LIMITS.edges} edges.`);
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    if (!isObj(raw) || !nodeIds.has(raw.from) || !nodeIds.has(raw.to) || raw.from === raw.to) continue;
    const key = `${raw.from}>${raw.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const edge = { from: raw.from, to: raw.to };
    if (typeof raw.id === 'string' && ID_RE.test(raw.id)) edge.id = raw.id;
    const label = oneLine(raw.label, 60);
    if (label) edge.label = label;
    out.push(edge);
  }
  return out;
}

/** Validate and coerce a workflow. Throws bad_request on structural problems; unknown fields are dropped. */
export function normalizeWorkflow(input) {
  if (!isObj(input)) throw badRequest('The workflow must be an object.');
  if (input.schema !== undefined && input.schema !== SCHEMA) throw badRequest(`This is not a ${SCHEMA} workflow.`);
  if (!Array.isArray(input.nodes)) throw badRequest('The workflow needs a nodes list.');
  if (input.nodes.length > LIMITS.nodes) throw badRequest(`A workflow has at most ${LIMITS.nodes} nodes.`);
  const nodes = input.nodes.map(normalizeNode);
  const ids = new Set();
  for (const n of nodes) {
    if (ids.has(n.id)) throw badRequest(`Two nodes share the id "${n.id}".`);
    ids.add(n.id);
  }
  const lanes = isObj(input.lanes) ? input.lanes : {};
  const flags = isObj(input.flags) ? input.flags : {};
  return {
    schema: SCHEMA,
    name: oneLine(input.name, 100) || 'Untitled workflow',
    description: text(input.description, 2000),
    version: typeof input.version === 'string' && VERSION_RE.test(input.version) ? input.version : '1.0.0',
    lanes: { frontend: lanes.frontend !== false, backend: lanes.backend !== false, contract: lanes.contract !== false, migrations: lanes.migrations === true },
    flags: { localOnly: flags.localOnly !== false, humanDoesGit: flags.humanDoesGit === true },
    links: httpsLinks(input.links, 'The workflow'),
    nodes,
    edges: normalizeEdges(input.edges, ids),
  };
}

/** A new workflow with only the human at the start. */
export function blankWorkflow(name = 'Untitled workflow', description = '') {
  return normalizeWorkflow({ name, description, nodes: [{ id: 'you', kind: 'human', title: 'You', does: 'Decides at every checkpoint that waits for you.' }], edges: [] });
}

export const stagesOf = (wf) => wf.nodes.filter((n) => n.kind === 'stage');
export const agentsOf = (wf, stageId) => wf.nodes.filter((n) => n.kind === 'agent' && (stageId === undefined || n.parent === stageId));

/** Stage ids in the order the work runs: dependencies first, otherwise the order they were drawn. */
export function stageOrder(wf) {
  const ids = stagesOf(wf).map((n) => n.id);
  const set = new Set(ids);
  const before = new Map(ids.map((id) => [id, new Set()]));
  for (const e of wf.edges) if (set.has(e.from) && set.has(e.to)) before.get(e.to).add(e.from);
  for (const n of stagesOf(wf)) for (const need of n.needs) if (set.has(need) && need !== n.id) before.get(n.id).add(need);
  const out = [];
  const left = [...ids];
  while (left.length) {
    const ready = left.findIndex((id) => [...before.get(id)].every((p) => out.includes(p)));
    out.push(...left.splice(ready < 0 ? 0 : ready, 1));
  }
  return out;
}

function hasCycle(wf) {
  const next = new Map(wf.nodes.map((n) => [n.id, new Set()]));
  for (const e of wf.edges) next.get(e.from)?.add(e.to);
  for (const n of wf.nodes) for (const need of n.needs || []) next.get(need)?.add(n.id);
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const to of next.get(id) || []) if (visit(to)) return true;
    state.set(id, 2);
    return false;
  };
  return wf.nodes.some((n) => visit(n.id));
}

/**
 * Lint warnings: [{ id, severity: 'danger'|'warn'|'info', message, nodeId? }].
 * `usable` is the set of engine ids that can run now; leave it out when that is not known.
 */
export function lintWorkflow(wf, { usable } = {}) {
  const out = [];
  const warn = (id, severity, message, nodeId) => out.push({ id, severity, message, ...(nodeId ? { nodeId } : {}) });
  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  for (const n of wf.nodes) {
    if (n.kind === 'agent' && !n.parent) warn('agent-no-parent', 'warn', `"${n.title}" is not inside a stage.`, n.id);
    if (n.parent && !byId.has(n.parent)) warn('unknown-parent', 'danger', `"${n.title}" sits under "${n.parent}", which does not exist.`, n.id);
    else if (n.parent && byId.get(n.parent).kind !== 'stage') warn('parent-not-stage', 'danger', `"${n.title}" sits under "${byId.get(n.parent).title}", which is not a stage.`, n.id);
    for (const need of n.needs || []) if (!byId.has(need)) warn('unknown-need', 'danger', `"${n.title}" needs "${need}", which does not exist.`, n.id);
    if (n.kind === 'agent' && usable && !usable.has(n.engine)) warn('engine-not-usable', 'warn', `"${n.title}" runs on ${n.engine}, which is not usable on this PC right now.`, n.id);
  }
  for (const e of wf.edges) {
    if (byId.get(e.to)?.kind === 'human') warn('link-into-you', 'warn', `"${byId.get(e.from)?.title || e.from}" links into "${byId.get(e.to).title}". Links go out of you, not into you: click the line and remove it.`, e.from);
  }
  if (hasCycle(wf)) warn('cycle', 'danger', 'The flow loops back on itself, so nothing can finish.');
  const order = stageOrder(wf);
  const build = order.indexOf('build');
  if (build > 0) {
    for (const id of order.slice(0, build)) {
      const stage = byId.get(id);
      if (agentsOf(wf, id).length && !stage.gate.on) warn('no-gate-before-build', 'warn', `"${stage.title}" has agents but no checkpoint, and it runs before Build. Nobody checks its result.`, id);
    }
  }
  return out;
}

/* ---- from the old plan (a list of phases) to a graph --------------------------------------------------- */

const uniqueId = (taken, want) => {
  let id = want;
  for (let n = 2; taken.has(id); n++) id = `${want.slice(0, 58)}-${n}`;
  return id;
};

/** Every stage but the human, chained in `order`, each depending on the ones before it that it already needed. */
function chain(wf, order) {
  const human = wf.nodes.find((n) => n.kind === 'human');
  const flow = [];
  order.forEach((id, i) => {
    const from = i === 0 ? human?.id : order[i - 1];
    if (from) flow.push({ from, to: id });
  });
  return flow;
}

/** The old phase that is called something else in the seed, because an agent already has its id. */
const LEGACY_STAGE = { security: 'security-review' };

/**
 * Turn an old plan ({ phases:[{id, enabled, gate, agents, skills, notes}], lanes, localOnly, humanDoesGit, brief })
 * into a workflow, using `base` (the seed workflow) for the stages and agents a phase id stands for.
 * Phases the plan switched off leave the graph; their agents go with them.
 */
export function planToWorkflow(plan, base) {
  const wf = structuredClone(normalizeWorkflow(base));
  const baseStages = new Set(stagesOf(wf).map((n) => n.id));
  const phases = (Array.isArray(plan?.phases) ? plan.phases : [])
    .filter((p) => p && baseStages.has(LEGACY_STAGE[p.id] ?? p.id))
    .map((p) => ({ ...p, id: LEGACY_STAGE[p.id] ?? p.id }));
  const on = phases.filter((p) => p.enabled !== false);
  const kept = new Set(on.map((p) => p.id));
  wf.nodes = wf.nodes.filter((n) => n.kind === 'human' || (n.kind === 'stage' ? kept.has(n.id) : kept.has(n.parent)));
  const taken = new Set(wf.nodes.map((n) => n.id));
  for (const p of on) {
    const stage = wf.nodes.find((n) => n.id === p.id);
    if (isObj(p.gate)) stage.gate = { on: p.gate.enabled !== false, label: oneLine(p.gate.label, 200) };
    stage.skills = names(p.skills, 40);
    if (typeof p.notes === 'string') stage.notes = text(p.notes, 4000);
    for (const role of names(p.agents, 20)) {
      if (wf.nodes.some((n) => n.kind === 'agent' && n.parent === p.id && n.id === role)) continue;
      const id = uniqueId(taken, role);
      taken.add(id);
      wf.nodes.push({ id, kind: 'agent', title: role, parent: p.id, engine: 'claude', consult: [], optional: false, defaultOn: true, needs: [], skills: [], links: [], notes: '' });
    }
  }
  const order = on.map((p) => p.id);
  for (const n of wf.nodes) if (n.kind === 'stage') n.needs = n.needs.filter((id) => order.indexOf(id) >= 0 && order.indexOf(id) < order.indexOf(n.id));
  wf.edges = chain(wf, order);
  if (isObj(plan.lanes)) wf.lanes = { frontend: plan.lanes.frontend !== false, backend: plan.lanes.backend !== false, contract: plan.lanes.contract !== false, migrations: plan.lanes.migrations === true };
  wf.flags = { localOnly: plan.localOnly !== false, humanDoesGit: plan.humanDoesGit === true };
  const name = oneLine(plan.brief?.name, 100);
  if (name) wf.name = name;
  wf.version = '1.0.0';
  return normalizeWorkflow(wf);
}

/* ---- comparing two graphs ------------------------------------------------------------------------------- */

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const edgeKey = (e) => `${e.from}>${e.to}`;
const FIELD_LABEL = { title: 'title', does: 'role text', engine: 'engine', model: 'model', consult: 'engines it may ask', reader: 'Haiku reader', condense: 'automatic condensing', optional: 'optional', defaultOn: 'default on', prompt: 'prompt', gate: 'checkpoint', needs: 'needs', skills: 'skills', links: 'links', notes: 'notes', skipWhen: 'skip rule', position: 'position', parent: 'stage', kind: 'kind' };

function changedFields(a, b) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'id' && !same(a[k], b[k]));
}

/**
 * What differs between two normalised workflows. `changes` is a readable list; the rest is what the
 * version bump and the summary counts are made from. The `version` field never counts.
 */
export function diffWorkflows(before, after) {
  const a = new Map(before.nodes.map((n) => [n.id, n]));
  const b = new Map(after.nodes.map((n) => [n.id, n]));
  const title = (id) => (b.get(id) || a.get(id)).title;
  const nodes = {
    added: after.nodes.filter((n) => !a.has(n.id)).map((n) => n.id),
    removed: before.nodes.filter((n) => !b.has(n.id)).map((n) => n.id),
    changed: after.nodes.filter((n) => a.has(n.id)).map((n) => ({ id: n.id, fields: changedFields(a.get(n.id), n) })).filter((c) => c.fields.length),
  };
  const ea = new Map(before.edges.map((e) => [edgeKey(e), e]));
  const eb = new Map(after.edges.map((e) => [edgeKey(e), e]));
  const edges = {
    added: after.edges.filter((e) => !ea.has(edgeKey(e))).map(edgeKey),
    removed: before.edges.filter((e) => !eb.has(edgeKey(e))).map(edgeKey),
    changed: after.edges.filter((e) => ea.has(edgeKey(e)) && !same(ea.get(edgeKey(e)).label, e.label)).map(edgeKey),
  };
  const needsChanged = nodes.changed.filter((c) => c.fields.includes('needs')).map((c) => c.id);
  const commonStages = stageOrder(before).filter((id) => b.get(id)?.kind === 'stage');
  const stageOrderChanged = !same(commonStages, stageOrder(after).filter((id) => a.get(id)?.kind === 'stage'));
  const meta = ['name', 'description', 'lanes', 'flags', 'links'].filter((k) => !same(before[k], after[k]));

  const changes = [
    ...nodes.added.map((id) => ({ kind: 'node-added', id, text: `Added ${b.get(id).kind} "${title(id)}"` })),
    ...nodes.removed.map((id) => ({ kind: 'node-removed', id, text: `Removed ${a.get(id).kind} "${title(id)}"` })),
    ...nodes.changed.map((c) => ({ kind: 'node-changed', id: c.id, text: `Changed ${c.fields.map((f) => FIELD_LABEL[f] || f).join(', ')} of "${title(c.id)}"` })),
    ...edges.added.map((k) => ({ kind: 'edge-added', id: k, text: `Connected ${k.replace('>', ' to ')}` })),
    ...edges.removed.map((k) => ({ kind: 'edge-removed', id: k, text: `Disconnected ${k.replace('>', ' from ')}` })),
    ...edges.changed.map((k) => ({ kind: 'edge-changed', id: k, text: `Changed the label of ${k.replace('>', ' to ')}` })),
    ...(stageOrderChanged ? [{ kind: 'stage-order', text: 'Changed the order of the stages' }] : []),
    ...meta.map((k) => ({ kind: 'meta', id: k, text: `Changed the workflow ${k}` })),
  ];
  return { nodes, edges, needsChanged, stageOrderChanged, meta, changes, empty: changes.length === 0 };
}
