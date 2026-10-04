// The workflow graph: an SVG canvas with HTML node cards. Three modes on one canvas:
//   edit      change the workflow (nodes, edges, settings)      live      who is running now, tokens, context, popups
//   versions  the semantic-version history of the workflow, compare and restore
// mountGraph(el, { workflow, mode, projectId, modes, versions, head, onChange(wf), onOpenNode(node), onRestore(version) })
//   -> { getWorkflow, setWorkflow, setMode, setLive, setVersions, select, tidy, refresh, destroy }
import { h, icon } from '../../dom.js';
import { state } from '../../state.js';
import { confirmDialog, openMenu, toast } from '../overlay.js';
import { svg } from './svg.js';
import { NODE_W, boxOf, bounds, checkpointPoint, edgeGeometry, fmtTokens, neighbour, nodeHeight, placed, tidy, uniqueId, hasHelper, helperBox } from './layout.js';
import { renderVersions } from './versions.js';

const MODES = [['edit', 'Workflow'], ['live', 'Live'], ['versions', 'Versions']];
const STATUS_WORD = { active: 'Active', waiting: 'Waiting for you', ready: 'Ready', off: 'Off' };
const KIND_ICON = { human: 'chat', stage: 'phase', agent: 'agent' };
const NUDGE = 16;

export function mountGraph(el, opts) {
  const S = {
    wf: structuredClone(opts.workflow),
    mode: opts.mode || 'edit',
    modes: opts.modes || ['edit'],
    sel: null,
    zoom: 1, panX: 24, panY: 24,
    live: null,
    versions: opts.versions || [],
    head: opts.head || null,
    legend: false,
    auto: {}, pos: {},
    connecting: null,
    edgeSel: null,
    hinted: false,
  };

  const bar = h('div', { class: 'cs-graph__bar', role: 'toolbar', 'aria-label': 'Graph tools' });
  const world = h('div', { class: 'cs-graph__world' });
  const canvas = h('div', { class: 'cs-graph__canvas', tabindex: '-1', role: 'group', 'aria-label': 'Workflow graph. Tab moves between nodes, arrow keys jump to a neighbour, Enter opens one.' }, world);
  const foot = h('div', { class: 'cs-graph__foot cs-soft cs-small', role: 'status' });
  const legend = h('div', { class: 'cs-glegend cs-card', hidden: true, role: 'dialog', 'aria-label': 'Legend' });
  const versionsHost = h('div', { class: 'cs-graph__versions', hidden: true });
  const root = h('div', { class: 'cs-graph' }, bar, h('div', { class: 'cs-graph__stage' }, canvas, legend, versionsHost), foot);
  el.append(root);

  const edgesSvg = svg('svg', { class: 'cs-graph__edges', 'aria-hidden': 'true' });
  const nodesHost = h('div', { class: 'cs-graph__nodes' });
  world.append(edgesSvg, nodesHost);

  const nodeById = (id) => S.wf.nodes.find((n) => n.id === id);
  const engineInfo = (id) => state.engines.find((e) => e.id === id);
  const editing = () => S.mode === 'edit';

  /* ---- geometry ---------------------------------------------------------------------------------- */
  function recompute() {
    S.auto = tidy(S.wf);
    S.pos = placed(S.wf, S.auto);
  }
  const box = (n) => boxOf(n, S.pos[n.id]);

  function applyView() {
    world.style.setProperty('--gx', `${S.panX}px`);
    world.style.setProperty('--gy', `${S.panY}px`);
    world.style.setProperty('--gz', String(S.zoom));
  }

  function fit() {
    if (!S.wf.nodes.length) return;
    const b = bounds(S.wf, S.pos);
    const w = canvas.clientWidth || 800;
    const ht = canvas.clientHeight || 500;
    S.zoom = Math.max(0.55, Math.min(1, w / b.w, ht / b.h)); // never smaller than readable: zoom out by hand for the whole picture
    S.panX = -b.x * S.zoom + Math.max(0, (w - b.w * S.zoom) / 2);
    S.panY = -b.y * S.zoom + Math.max(0, (ht - b.h * S.zoom) / 2);
    applyView();
  }

  function zoomAt(factor, cx, cy) {
    const next = Math.max(0.25, Math.min(2, S.zoom * factor));
    const k = next / S.zoom;
    S.panX = cx - (cx - S.panX) * k;
    S.panY = cy - (cy - S.panY) * k;
    S.zoom = next;
    applyView();
  }
  const centre = () => [canvas.clientWidth / 2, canvas.clientHeight / 2];

  /* ---- status (live mode) ------------------------------------------------------------------------ */
  function statusOf(n) {
    const run = (S.live?.runs || []).find((r) => r.nodeId === n.id);
    if (run) return { key: run.status === 'waiting' ? 'waiting' : run.status === 'active' ? 'active' : 'ready', run };
    if (n.kind === 'agent' && n.engine && engineInfo(n.engine) && !engineInfo(n.engine).usable) return { key: 'off' };
    return { key: 'ready' };
  }

  /* ---- drawing ----------------------------------------------------------------------------------- */
  function nodeEl(n) {
    const b = box(n);
    const st = S.mode === 'live' ? statusOf(n) : null;
    const kids = S.wf.nodes.filter((k) => k.parent === n.id);
    const chips = [];
    if (n.kind === 'agent') {
      if (n.engine) chips.push(h('span', { class: 'cs-gchip cs-gchip--engine', title: 'Engine' }, n.engine));
      if (n.model) chips.push(h('span', { class: 'cs-gchip', title: 'Model' }, n.model));
      if (n.optional) chips.push(h('span', { class: 'cs-gchip cs-gchip--quiet' }, 'optional'));
      const asks = (n.consult || []).filter((e) => e !== n.engine);
      if (asks.length) chips.push(h('span', { class: 'cs-gchip cs-gchip--quiet', title: `May ask ${asks.join(', ')} for a second opinion` }, `asks ${asks.join(', ')}`));
    }
    if (n.kind === 'stage') {
      chips.push(h('span', { class: 'cs-gchip cs-gchip--quiet' }, `${kids.length} agent${kids.length === 1 ? '' : 's'}`));
    }
    const skills = n.skills?.length ? h('div', { class: 'cs-gnode__skills' }, `skills: ${n.skills.slice(0, 3).join(', ')}${n.skills.length > 3 ? ` +${n.skills.length - 3}` : ''}`) : null;
    const run = st?.run;
    const live = st ? h('div', { class: 'cs-gnode__live' },
      h('span', { class: `cs-gdot cs-gdot--${st.key}`, 'aria-hidden': 'true' }), h('span', {}, STATUS_WORD[st.key]),
      run && (run.tokens?.input || run.tokens?.output) ? h('span', { class: 'cs-gnode__tok cs-mono' }, `${fmtTokens((run.tokens?.input || 0) + (run.tokens?.output || 0))} tok`) : null,
      run && run.contextPct != null ? h('span', { class: 'cs-gctx', title: `Context ${run.contextPct}%`, style: { '--ctx': `${run.contextPct}%` } }, h('span', { class: 'cs-gctx__fill' })) : null,
      run && run.contextPct != null ? h('span', { class: 'cs-soft cs-small' }, `${run.contextPct}%`) : null) : null;
    const el2 = h('div', {
      class: ['cs-gnode', `cs-gnode--${n.kind}`, st && `cs-gnode--${st.key}`, false],
      role: 'button', tabindex: '0', dataset: { id: n.id },
      style: { '--x': `${b.x}px`, '--y': `${b.y}px`, '--w': `${b.w}px`, '--h': `${b.h}px` },
      'aria-label': `${n.kind} ${n.title}${st ? `, ${STATUS_WORD[st.key]}` : ''}`,
      'aria-pressed': S.sel === n.id ? 'true' : 'false',
    },
    h('div', { class: 'cs-gnode__head' }, icon(KIND_ICON[n.kind] || 'agent', 's'), h('span', { class: 'cs-gnode__title' }, n.title || n.id)),
    n.kind !== 'human' ? h('div', { class: 'cs-gnode__chips' }, chips) : h('div', { class: 'cs-gnode__does cs-soft cs-small' }, n.does || 'Decides at every checkpoint that waits for you'),
    n.kind === 'agent' && n.does ? h('div', { class: 'cs-gnode__does cs-soft cs-small' }, n.does) : null,
    skills, live,
    editing() ? h('button', { class: 'cs-gnode__handle', type: 'button', tabindex: '-1', 'aria-label': `Link ${n.title} to another node`, title: 'Drag from here to another card to link them (or select the card and press C)', onpointerdown: (e) => startConnect(e, n) }) : null);
    return el2;
  }

  function drawEdges() {
    let edgeTools = null;
    edgesSvg.replaceChildren();
    const b = bounds(S.wf, S.pos);
    edgesSvg.setAttribute('width', String(Math.max(b.x + b.w, 1) + 400));
    edgesSvg.setAttribute('height', String(Math.max(b.y + b.h, 1) + 400));
    edgesSvg.append(svg('defs', {}, svg('marker', { id: 'cs-garrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, svg('path', { d: 'M0 0 L10 5 L0 10 z', class: 'cs-garrow' }))));
    for (const e of S.wf.edges) {
      const a = nodeById(e.from);
      const c = nodeById(e.to);
      if (!a || !c) continue;
      const g = edgeGeometry(box(a), box(c));
      const dashed = a.kind === 'agent' || c.kind === 'agent';
      const key = `${e.from}>${e.to}`;
      const picked = S.edgeSel === key;
      edgesSvg.append(svg('path', { d: g.d, class: ['cs-gedge', dashed && 'cs-gedge--dashed', picked && 'cs-gedge--picked'].filter(Boolean).join(' '), 'marker-end': 'url(#cs-garrow)', 'data-from': e.from, 'data-to': e.to }));
      if (editing()) edgesSvg.append(svg('path', { d: g.d, class: 'cs-gedge__hit', 'data-edge': key }));
      if (picked) edgeTools = { key, a, c, mid: g.mid };
      if (e.label) {
        const w = Math.max(40, e.label.length * 6.4 + 20);
        const lift = a.kind === 'stage' && a.gate?.on && nextStageOf(a)?.id === c.id ? 48 : 0; // the checkpoint sits at the middle
        edgesSvg.append(svg('g', { class: 'cs-gedge__label', transform: `translate(${g.mid.x - w / 2} ${g.mid.y - 11 - lift})` }, svg('rect', { width: w, height: 22, rx: 11 }), svg('text', { x: w / 2, y: 15, 'text-anchor': 'middle' }, e.label)));
      }
    }
    // an agent and its helper: a short dashed line, no arrow (it is called inside the agent's turn, not handed work)
    for (const n of S.wf.nodes.filter(hasHelper)) {
      const ab = box(n);
      const hb = helperOf(n);
      if (hb.hanging) continue; // it hangs off the card itself
      const s = { x: ab.x + ab.w, y: hb.y + hb.h / 2 };
      edgesSvg.append(svg('path', { d: `M${s.x} ${s.y} L${hb.x} ${s.y}`, class: 'cs-gedge cs-gedge--helper' }));
    }
    if (S.connecting) {
      const a = nodeById(S.connecting.from);
      const g = edgeGeometry(box(a), { x: S.connecting.x, y: S.connecting.y, w: 1, h: 1 });
      edgesSvg.append(svg('path', { d: g.d, class: 'cs-gedge cs-gedge--draft' }));
    }
    nodesHost.querySelector('.cs-gedgebar')?.remove();
    if (edgeTools) {
      const { key, a, c, mid } = edgeTools;
      nodesHost.append(h('div', { class: 'cs-gedgebar', role: 'group', 'aria-label': `Link from ${a.title} to ${c.title}`, style: { '--x': `${mid.x}px`, '--y': `${mid.y}px` } },
        h('span', { class: 'cs-small' }, `${a.title} → ${c.title}`),
        h('button', { class: 'cs-btn cs-btn--small cs-btn--danger', type: 'button', onclick: () => removeEdge(key) }, icon('trash', 's'), 'Remove link'),
        h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Close', onclick: () => { S.edgeSel = null; drawEdges(); } }, icon('close', 's'))));
    }
  }

  /* ---- checkpoints: what happens when a stage is done, drawn on the arrow that leaves it ------------- */
  const ENGINE_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot' };
  const nextStageOf = (n) => S.wf.edges.filter((e) => e.from === n.id).map((e) => nodeById(e.to)).find((t) => t?.kind === 'stage') || null;
  function checkpointWords(gate) {
    const eng = ENGINE_NAME[gate.engine] || gate.engine;
    if (gate.by === 'engine') return { who: `${eng} checks`, tone: 'engine', icon: 'agent', then: 'then it goes on' };
    if (gate.by === 'both') return { who: `${eng}, then you`, tone: 'both', icon: 'gate', then: 'waits for you' };
    return { who: 'You decide', tone: 'you', icon: 'gate', then: 'waits for you' };
  }
  function checkpointEl(n) {
    const next = nextStageOf(n);
    const p = checkpointPoint(box(n), next ? box(next) : null);
    const w = checkpointWords(n.gate);
    const what = n.gate.label || (n.gate.by === 'engine' ? 'reviews the result' : 'approve the result');
    return h('button', {
      class: ['cs-gcheck', `cs-gcheck--${w.tone}`], type: 'button', dataset: { stage: n.id },
      style: { '--x': `${p.x}px`, '--y': `${p.y}px` },
      title: `${n.title} checkpoint: ${w.who}, ${w.then}. ${n.gate.label || ''}`.trim(),
      'aria-label': `Checkpoint after ${n.title}: ${w.who}, ${w.then}. ${n.gate.label || ''}`.trim(),
      onclick: () => { S.sel = n.id; opts.onOpenNode?.(n, { focus: 'checkpoint' }); },
    }, h('span', { class: 'cs-gcheck__who' }, icon(w.icon, 's'), w.who), h('span', { class: 'cs-gcheck__what' }, what));
  }

  /* ---- helpers: a small node beside an agent, working inside its turn (not a step of the flow) -------- */
  function helperOf(n) {
    const others = S.wf.nodes.filter((o) => o.id !== n.id).map(box);
    return helperBox(box(n), others);
  }
  const helperWhen = (n) => (n.condense ? `auto, above ${n.condense}%` : 'when it decides');
  function helperEl(n) {
    const hb = helperOf(n);
    return h('button', {
      class: ['cs-ghelper', hb.hanging && 'cs-ghelper--hanging'], type: 'button', dataset: { helper: n.id },
      style: { '--x': `${hb.x}px`, '--y': `${hb.y}px`, '--w': `${hb.w}px`, '--h': `${hb.h}px` },
      title: n.condense ? `Haiku condenses ${n.title}'s long command output, pages and searches once its context is over ${n.condense}% full. Click to change.` : `${n.title} hands long reading to a Haiku reader when it decides to. Click to change.`,
      'aria-label': `${n.title}'s helper: Haiku reader, ${helperWhen(n)}`,
      onclick: () => { S.sel = n.id; opts.onOpenNode?.(n, { focus: 'helper' }); },
    }, h('span', { class: 'cs-ghelper__name' }, icon('sparkle', 's'), 'Haiku reader'), h('span', { class: 'cs-ghelper__when' }, helperWhen(n)));
  }

  function drawNodes() {
    const focused = document.activeElement?.closest?.('.cs-gnode')?.dataset.id;
    const checks = S.mode === 'versions' ? [] : S.wf.nodes.filter((n) => n.kind === 'stage' && n.gate?.on).map(checkpointEl);
    const helpers = S.mode === 'versions' ? [] : S.wf.nodes.filter(hasHelper).map(helperEl);
    nodesHost.replaceChildren(...S.wf.nodes.map(nodeEl), ...checks, ...helpers);
    if (focused) nodesHost.querySelector(`[data-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  function drawBar() {
    bar.replaceChildren(
      S.modes.length > 1 ? h('div', { class: 'cs-segmented', role: 'radiogroup', 'aria-label': 'Graph mode' }, MODES.filter(([m]) => S.modes.includes(m)).map(([m, label]) => h('button', { class: 'cs-segmented__btn', type: 'button', role: 'radio', 'aria-checked': String(S.mode === m), onclick: () => setMode(m) }, label))) : null,
      h('span', { class: 'cs-grow' }),
      S.mode !== 'versions' ? h('div', { class: 'cs-graph__tools' },
        editing() ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: (e) => addMenu(e.currentTarget) }, icon('plus', 's'), 'Add') : null,
        editing() ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', title: 'Arrange every node automatically (T)', onclick: tidyAll }, icon('sparkle', 's'), 'Tidy') : null,
        h('button', { class: 'cs-btn cs-btn--small', type: 'button', 'aria-expanded': String(S.legend), onclick: toggleLegend }, icon('info', 's'), 'Legend'),
        h('button', { class: 'cs-btn cs-btn--small cs-btn--icon', type: 'button', 'aria-label': 'Zoom out', onclick: () => zoomAt(1 / 1.2, ...centre()) }, icon('minus', 's')),
        h('button', { class: 'cs-btn cs-btn--small cs-btn--icon', type: 'button', 'aria-label': 'Zoom in', onclick: () => zoomAt(1.2, ...centre()) }, icon('plus', 's')),
        h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: fit }, 'Fit')) : null);
  }

  function drawLegend() {
    legend.hidden = !S.legend;
    legend.replaceChildren(
      h('h3', { class: 'cs-h3' }, 'Legend'),
      h('ul', { class: 'cs-glegend__list' },
        ...['active', 'ready', 'waiting', 'off'].map((k) => h('li', {}, h('span', { class: `cs-gdot cs-gdot--${k}` }), h('strong', {}, k === 'active' ? 'Active' : k === 'ready' ? 'Ready / idle' : k === 'waiting' ? 'Waiting' : 'Off'),
          h('span', { class: 'cs-soft' }, { active: 'working now', ready: 'has an engine, nothing running', waiting: 'needs your approval or an answer', off: 'its engine is not usable' }[k]))),
        h('li', {}, h('span', { class: 'cs-gcheck cs-gcheck--you cs-gcheck--inline' }, h('span', { class: 'cs-gcheck__who' }, icon('gate', 's'), 'You decide')), h('span', { class: 'cs-soft' }, 'the work stops until you approve')),
        h('li', {}, h('span', { class: 'cs-gcheck cs-gcheck--engine cs-gcheck--inline' }, h('span', { class: 'cs-gcheck__who' }, icon('agent', 's'), 'Codex checks')), h('span', { class: 'cs-soft' }, 'another engine reviews, then it goes on')),
        h('li', {}, h('span', { class: 'cs-gcheck cs-gcheck--both cs-gcheck--inline' }, h('span', { class: 'cs-gcheck__who' }, icon('gate', 's'), 'Codex, then you')), h('span', { class: 'cs-soft' }, 'an engine reviews first, then you approve')),
        h('li', {}, h('span', { class: 'cs-soft' }, 'An arrow with no marker: the next stage starts straight away.')),
        h('li', {}, h('span', { class: 'cs-glegend__line' }), h('span', { class: 'cs-soft' }, 'hand-off between stages')),
        h('li', {}, h('span', { class: 'cs-glegend__line cs-glegend__line--dashed' }), h('span', { class: 'cs-soft' }, 'an agent working for a stage or another agent')),
        h('li', {}, h('span', { class: 'cs-ghelper cs-ghelper--inline' }, h('span', { class: 'cs-ghelper__name' }, icon('sparkle', 's'), 'Haiku reader')), h('span', { class: 'cs-soft' }, 'a helper beside an agent: a cheap model reads long output for it, inside its turn'))));
  }
  function toggleLegend() { S.legend = !S.legend; drawBar(); drawLegend(); }

  function drawFoot() {
    const hand = S.live?.lastHandoff;
    const pending = S.live?.pending || 0;
    foot.textContent = S.mode === 'live'
      ? `${pending ? `${pending} waiting for you. ` : ''}${hand ? `Last hand-off: ${hand.from} to ${hand.to}${hand.ms ? `, ${(hand.ms / 1000).toFixed(1)} s` : ''}.` : 'No hand-off yet.'}`
      : editing() ? 'Click a node to open it. Drag to move, or use the arrow keys with Alt.' : '';
  }

  function draw() {
    recompute();
    const showGraph = S.mode !== 'versions';
    canvas.hidden = !showGraph;
    versionsHost.hidden = showGraph;
    if (showGraph) { applyView(); drawEdges(); drawNodes(); } else renderVersions(versionsHost, { versions: S.versions, head: S.head, onRestore: opts.onRestore });
    drawBar(); drawLegend(); drawFoot();
  }

  /* ---- editing ----------------------------------------------------------------------------------- */
  function commit() { opts.onChange?.(structuredClone(S.wf)); }

  function tidyAll() { for (const n of S.wf.nodes) delete n.position; draw(); requestAnimationFrame(fit); commit(); }

  function moveNode(id, x, y) {
    const n = nodeById(id);
    n.position = { x: Math.round(x), y: Math.round(y) };
    S.pos[id] = n.position;
    const b = box(n);
    const elx = nodesHost.querySelector(`[data-id="${CSS.escape(id)}"]`);
    elx?.style.setProperty('--x', `${b.x}px`);
    elx?.style.setProperty('--y', `${b.y}px`);
    drawEdges();
    for (const m of nodesHost.querySelectorAll('.cs-gcheck')) {
      const st = nodeById(m.dataset.stage);
      const next = st && nextStageOf(st);
      if (!st) continue;
      const p = checkpointPoint(box(st), next ? box(next) : null);
      m.style.setProperty('--x', `${p.x}px`);
      m.style.setProperty('--y', `${p.y}px`);
    }
  }

  function addNode(kind) {
    const anchor = (S.sel && nodeById(S.sel)) || null;
    const stage = anchor?.kind === 'stage' ? anchor : anchor?.parent ? nodeById(anchor.parent) : [...S.wf.nodes].reverse().find((n) => n.kind === 'stage');
    if (kind === 'agent' && !stage) return;
    const usable = state.engines.find((e) => e.usable)?.id || 'claude';
    const n = kind === 'stage'
      ? { id: uniqueId(S.wf, 'new-stage'), kind: 'stage', title: 'New stage', gate: { on: false, by: 'you', label: '' }, needs: [], skills: [], links: [], notes: '' }
      : { id: uniqueId(S.wf, 'new-agent'), kind: 'agent', parent: stage.id, title: 'New agent', does: '', engine: usable, model: '', consult: [], skills: [], links: [], notes: '' };
    S.wf.nodes.push(n);
    if (kind === 'stage') {
      const last = [...S.wf.nodes].reverse().find((x) => x.kind === 'stage' && x.id !== n.id);
      const from = anchor?.kind === 'stage' ? anchor : last;
      if (from) S.wf.edges.push({ from: from.id, to: n.id });
    }
    S.sel = n.id;
    draw();
    commit();
    focusNode(n.id);
    opts.onOpenNode?.(n);
  }

  function addMenu(anchor) {
    openMenu({ anchor, label: 'Add to the workflow', items: [{ group: 'Add' }, { label: 'A stage', icon: 'phase', onSelect: () => addNode('stage') }, { label: 'An agent (under the selected stage)', icon: 'agent', onSelect: () => addNode('agent') }] });
  }

  async function removeNode(id) {
    const n = nodeById(id);
    if (!n || n.kind === 'human') return;
    const kids = S.wf.nodes.filter((k) => k.parent === id);
    if (kids.length && !(await confirmDialog({ title: `Remove ${n.title}?`, message: `${n.title} has ${kids.length} agent${kids.length === 1 ? '' : 's'} under it. They are removed too.`, confirmLabel: 'Remove', danger: true }))) return;
    const gone = new Set([id, ...kids.map((k) => k.id)]);
    const oldEdges = S.wf.edges;
    S.wf.nodes = S.wf.nodes.filter((x) => !gone.has(x.id));
    S.wf.edges = S.wf.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to));
    // keep the flow connected: what led into a removed stage now leads to what followed it
    if (n.kind === 'stage') {
      const before = oldEdges.filter((e) => e.to === id).map((e) => e.from);
      const after = oldEdges.filter((e) => e.from === id).map((e) => e.to);
      for (const f of before) for (const t of after) if (nodeById(f) && nodeById(t) && !S.wf.edges.some((e) => e.from === f && e.to === t)) S.wf.edges.push({ from: f, to: t });
    }
    if (S.sel === id) S.sel = null;
    draw();
    commit();
    opts.onOpenNode?.(null);
  }

  /** Why a link cannot be made, or null when it can. */
  function linkProblem(from, to) {
    const a = nodeById(from);
    const b = nodeById(to);
    if (!a || !b) return 'That card no longer exists.';
    if (from === to) return 'A card cannot link to itself.';
    if (b.kind === 'human') return `"${b.title}" starts the flow: links go out of it, not into it.`;
    if (S.wf.edges.some((e) => e.from === from && e.to === to)) return `${a.title} is already linked to ${b.title}.`;
    return null;
  }

  function connect(from, to) {
    const problem = linkProblem(from, to);
    if (problem) { toast(problem, { kind: 'warn' }); drawEdges(); return false; }
    S.wf.edges.push({ from, to });
    draw();
    commit();
    return true;
  }

  function removeEdge(key) {
    const before = S.wf.edges.length;
    S.wf.edges = S.wf.edges.filter((e) => `${e.from}>${e.to}` !== key);
    if (S.edgeSel === key) S.edgeSel = null;
    if (S.wf.edges.length !== before) { draw(); commit(); }
  }

  function connectMenu(fromId) {
    const a = nodeById(fromId);
    const anchor = nodesHost.querySelector(`[data-id="${CSS.escape(fromId)}"]`);
    openMenu({ anchor, label: `Link ${a.title} to`, items: [{ group: `Link ${a.title} to` }, ...S.wf.nodes.filter((n) => !linkProblem(fromId, n.id)).map((n) => ({ label: n.title, icon: KIND_ICON[n.kind], onSelect: () => connect(fromId, n.id) }))] });
  }

  function startConnect(e, n) {
    e.preventDefault();
    e.stopPropagation();
    const pt = (ev) => { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left - S.panX) / S.zoom, y: (ev.clientY - r.top - S.panY) / S.zoom }; };
    S.connecting = { from: n.id, ...pt(e) };
    const cardAt = (ev) => document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.cs-gnode');
    let over = null;
    const move = (ev) => {
      Object.assign(S.connecting, pt(ev));
      drawEdges();
      const card = cardAt(ev);
      if (card !== over) { over?.removeAttribute('data-droptarget'); over = card && card.dataset.id !== n.id ? card : null; if (over) over.dataset.droptarget = linkProblem(n.id, over.dataset.id) ? 'no' : 'yes'; }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      over?.removeAttribute('data-droptarget');
      const target = cardAt(ev)?.dataset.id;
      S.connecting = null;
      if (target && target !== n.id) connect(n.id, target); else drawEdges();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ---- selection, focus, pointer ----------------------------------------------------------------- */
  function select(id, { open = true } = {}) {
    S.sel = id;
    nodesHost.querySelectorAll('.cs-gnode').forEach((x) => { x.setAttribute('aria-pressed', String(x.dataset.id === id)); });
    if (open) opts.onOpenNode?.(id ? nodeById(id) : null);
  }
  const focusNode = (id) => requestAnimationFrame(() => nodesHost.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }));

  nodesHost.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.cs-gnode');
    if (!card || e.button !== 0 || e.target.closest('.cs-gnode__handle')) return;
    const id = card.dataset.id;
    const n = nodeById(id);
    const start = { x: e.clientX, y: e.clientY, px: S.pos[id].x, py: S.pos[id].y };
    let moved = false;
    const move = (ev) => {
      if (!editing()) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      card.dataset.dragging = '';
      moveNode(id, start.px + dx / S.zoom, start.py + dy / S.zoom);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      delete card.dataset.dragging;
      if (moved) commit(); else select(n.id);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cs-gnode, .cs-gcheck, .cs-gedgebar') || e.button !== 0) return;
    const hit = e.target.closest?.('.cs-gedge__hit');
    if (hit) { e.preventDefault(); S.edgeSel = hit.dataset.edge; drawEdges(); canvas.focus({ preventScroll: true }); return; }
    if (S.edgeSel) { S.edgeSel = null; drawEdges(); }
    const start = { x: e.clientX, y: e.clientY, px: S.panX, py: S.panY };
    canvas.dataset.panning = '';
    const move = (ev) => { S.panX = start.px + ev.clientX - start.x; S.panY = start.py + ev.clientY - start.y; applyView(); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); delete canvas.dataset.panning; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  canvas.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) { hintZoom(); return; } // plain wheel: let the page scroll
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  canvas.addEventListener('keydown', (e) => {
    const card = e.target.closest?.('.cs-gnode');
    const id = card?.dataset.id;
    const key = e.key;
    if (key === '+' || key === '=') { zoomAt(1.2, ...centre()); return; }
    if (key === '-') { zoomAt(1 / 1.2, ...centre()); return; }
    if (key === '0') { fit(); return; }
    if (editing() && key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); tidyAll(); return; }
    if (S.edgeSel && !id && (key === 'Delete' || key === 'Backspace')) { e.preventDefault(); removeEdge(S.edgeSel); return; }
    if (S.edgeSel && key === 'Escape') { e.preventDefault(); S.edgeSel = null; drawEdges(); return; }
    if (!id) return;
    const dir = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' }[key];
    if (dir && e.altKey && editing()) { e.preventDefault(); const p = S.pos[id]; moveNode(id, p.x + (dir === 'right' ? NUDGE : dir === 'left' ? -NUDGE : 0), p.y + (dir === 'down' ? NUDGE : dir === 'up' ? -NUDGE : 0)); commit(); return; }
    if (dir) {
      e.preventDefault();
      const others = S.wf.nodes.filter((n) => n.id !== id).map((n) => ({ id: n.id, box: box(n) }));
      const next = neighbour(dir, box(nodeById(id)), others);
      if (next) focusNode(next);
      return;
    }
    if (key === 'Enter' || key === ' ') { e.preventDefault(); select(id); return; }
    if (editing() && (key === 'Delete' || key === 'Backspace')) { e.preventDefault(); removeNode(id); return; }
    if (editing() && key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); connectMenu(id); }
  });

  /** The first plain wheel over the graph says how to zoom, once. */
  function hintZoom() {
    if (S.hinted) return;
    S.hinted = true;
    foot.textContent = 'Hold Ctrl and scroll to zoom the graph, or use the + and - buttons.';
  }

  /* ---- public ------------------------------------------------------------------------------------ */
  function setMode(m) {
    if (!S.modes.includes(m)) return;
    S.mode = m;
    draw();
    if (m !== 'versions') requestAnimationFrame(() => { if (!S.fitted) { fit(); S.fitted = true; } });
    opts.onMode?.(m);
  }

  const onEngines = () => { if (S.mode === 'live') drawNodes(); };
  window.addEventListener('circle:engines', onEngines);

  draw();
  requestAnimationFrame(() => { fit(); S.fitted = true; });

  return {
    getWorkflow: () => structuredClone(S.wf),
    setWorkflow(wf) { S.wf = structuredClone(wf); if (S.sel && !nodeById(S.sel)) S.sel = null; draw(); },
    setMode,
    setLive(live) { S.live = live; if (S.mode === 'live') { drawNodes(); drawFoot(); } },
    setVersions(versions, head) { S.versions = versions; S.head = head; if (S.mode === 'versions') draw(); },
    select,
    tidy: tidyAll,
    remove: removeNode,
    refresh: draw,
    links: (id) => ({ out: S.wf.edges.filter((e) => e.from === id).map((e) => e.to), in: S.wf.edges.filter((e) => e.to === id).map((e) => e.from) }),
    canLink: (from, to) => !linkProblem(from, to),
    connect,
    removeEdge: (from, to) => removeEdge(`${from}>${to}`),
    updateNode(id, patch) { const n = nodeById(id); if (!n) return; Object.assign(n, patch); draw(); commit(); },
    destroy() { window.removeEventListener('circle:engines', onEngines); el.replaceChildren(); },
  };
}
