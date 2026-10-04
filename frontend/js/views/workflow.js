// The project's Workflow tab: the graph (edit, live, versions), saving versions, the brief, and writing files.
// The graph is the plan. Nothing in the project changes until you review the files and press Write.
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { state } from '../state.js';
import { mountGraph } from '../components/graph/index.js';
import { openNodePanel } from '../components/graph/nodepanel.js';
import { mountHelper } from '../components/graph/helper.js';
import { mountPatterns } from '../components/graph/patterns.js';
import { pref, setPref } from '../state.js';
import { suggestBump } from '../components/graph/layout.js';
import { reviewChanges } from '../components/diffreview.js';
import { openRequest } from '../components/requests.js';
import { openMenu, openModal, toast } from '../components/overlay.js';

const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const LEVEL_WORD = { patch: 'patch: a setting changed', minor: 'minor: something was added', major: 'major: something was removed or reordered' };

export async function mount(el, pctx) {
  const { project } = pctx;
  const [wfRes, planRes] = await Promise.all([api.workflow(project.id), api.plan(project.id)]);
  let record = wfRes;
  let plan = planRes.plan;
  let current = structuredClone(record.workflow);
  let dirty = false;
  let panel = null;
  let mode = 'edit';
  let liveTimer = null;
  let planTimer = null;
  const status = h('span', { class: 'cs-soft cs-small', role: 'status' });
  const dirtyPill = h('span', { class: 'cs-pill cs-pill--warn', hidden: true }, 'Unsaved changes');
  const versionPill = h('span', { class: 'cs-pill cs-pill--quiet' });
  const warnEl = h('div', { class: 'cs-stack cs-stack--tight', 'aria-label': 'Workflow warnings' });
  const saveBtn = h('button', { class: 'cs-btn', type: 'button', disabled: true, onclick: () => saveDialog() }, icon('check', 's'), 'Save version');
  const graphHost = h('div');
  let graph = null;
  let helper = null;
  const helperMemory = { messages: [] };
  const helperBtn = h('button', { class: 'cs-btn', type: 'button', 'aria-pressed': 'false', onclick: () => (helper ? closeHelper() : showHelper(true)) }, icon('sparkle', 's'), 'Workflow helper');
  // the pattern store: ways to shape the team, which fit and why, try one on an agent (unsaved)
  let patterns = null;
  const patternsBtn = h('button', { class: 'cs-btn', type: 'button', 'aria-pressed': 'false', title: 'Ways to shape your team, with when they pay off; try one on an agent', onclick: () => (patterns ? closePatterns() : showPatterns()) }, icon('library', 's'), 'Patterns');
  function showPatterns() {
    if (mode === 'versions') return;
    panel?.destroy(); panel = null;
    if (helper) { helper.destroy(); helper = null; helperBtn.setAttribute('aria-pressed', 'false'); }
    patterns?.destroy();
    patterns = mountPatterns(pctx.side, {
      project,
      getWorkflow: () => graph.getWorkflow(),
      onApply: (wf) => { graph.setWorkflow(wf); markDirty(graph.getWorkflow()); },
      onOpenNode: (n) => openNode(n),
      onClose: closePatterns,
    });
    patternsBtn.setAttribute('aria-pressed', 'true');
  }
  function closePatterns() { patterns?.destroy(); patterns = null; patternsBtn.setAttribute('aria-pressed', 'false'); }

  /* ---- where this workflow came from: never pretend a template is the project ------------------------ */
  const startEl = h('div', { class: 'cs-stack cs-stack--tight' });
  const dismissKey = `wf-template-ok-${project.id}`;
  async function adoptWorkflow(wf, note) {
    try {
      const r = await api.saveWorkflow(project.id, { workflow: wf, note });
      adopt(r);
      toast(`Saved v${r.version || r.head}.`, { kind: 'ok' });
    } catch (e) { toast(e.message, { kind: 'danger' }); }
  }
  function applyUnsaved(wf) { graph.setWorkflow(wf); markDirty(graph.getWorkflow()); drawStart(); requestAnimationFrame(() => graph.tidy()); }
  async function templateMenu(anchor) {
    let list = [];
    try { list = (await api.templates()).templates || []; } catch (e) { toast(e.message, { kind: 'danger' }); return; }
    if (!list.length) { toast('There are no templates yet.', { kind: 'info' }); return; }
    openMenu({ anchor, label: 'Start from a template', items: [{ group: 'Start from a template (you still save it)' }, ...list.map((t) => ({ label: t.name, icon: 'plan', onSelect: async () => {
      try { const t2 = await api.template(t.id); applyUnsaved({ ...t2.workflow, name: current.name }); toast(`Put "${t.name}" on the graph. Change it, then Save version.`, { kind: 'ok' }); } catch (e) { toast(e.message, { kind: 'danger' }); }
    } }))] });
  }
  function drawStart() {
    drawStartInner();
    startEl.hidden = !startEl.children.length;
  }
  function drawStartInner() {
    startEl.replaceChildren();
    const auto = record.autoTemplate;
    if (auto && pref(dismissKey, '') !== 'yes' && !dirty) {
      const folder = auto.folder;
      startEl.append(h('div', { class: 'cs-banner cs-banner--warn', role: 'status' }, h('span', { class: 'cs-banner__icon' }, icon('warning', 's')),
        h('div', { class: 'cs-stack cs-stack--tight cs-grow' },
          h('strong', {}, `This is the "${auto.templateName}" template, not this project.`),
          h('span', {}, `An older version of Circle Studio put it here by itself. None of it was read from the folder. ${folder.origin === 'agents' ? `The folder has ${folder.workflow.nodes.filter((n) => n.kind === 'agent').length} agent files of its own.` : folder.origin === 'file' ? 'The folder has its own workflow.json.' : 'The folder has no agents or workflow yet.'}`),
          h('div', { class: 'cs-row cs-row--wrap' },
            folder.origin !== 'blank' ? h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button', onclick: () => adoptWorkflow(folder.workflow, `Replaced the template copy: ${folder.note}`) }, folder.origin === 'file' ? 'Use the folder\'s workflow.json' : 'Use the agents in this folder') : null,
            h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => adoptWorkflow({ ...folder.workflow, nodes: folder.workflow.nodes.filter((n) => n.kind === 'human'), edges: [] }, 'Replaced the template copy with a blank workflow') }, 'Start blank'),
            h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: () => { setPref(dismissKey, 'yes'); drawStart(); } }, 'Keep the template')))));
      return;
    }
    const wf = graph ? graph.getWorkflow() : current;
    if (!wf.nodes.some((n) => n.kind === 'stage')) {
      const agents = wf.nodes.filter((n) => n.kind === 'agent').length;
      startEl.append(h('div', { class: 'cs-card cs-wfstart' },
        h('h3', { class: 'cs-h3' }, 'This project has no workflow yet'),
        h('p', { class: 'cs-soft' }, agents ? `There are ${agents} agents but no stages.` : 'Nothing in the folder describes one. Pick how to start; nothing is saved until you press Save version.'),
        h('div', { class: 'cs-row cs-row--wrap' },
          h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: () => { showHelper(true); helper?.ask('Design the best workflow for this project from its brief and its folder.'); } }, icon('sparkle', 's'), 'Ask the helper to design it'),
          h('button', { class: 'cs-btn', type: 'button', onclick: (e) => templateMenu(e.currentTarget) }, icon('plan', 's'), 'Start from a template...'),
          h('span', { class: 'cs-soft cs-small' }, 'or use Add on the graph'))));
    }
  }

  /** The side panel shows the helper when no node is open and the helper is switched on. */
  function showHelper(force = false) {
    if (force) setPref('helper', 'on');
    if (pref('helper', innerWidth >= 1440 ? 'on' : 'off') !== 'on' || mode === 'versions') return;
    panel?.destroy();
    panel = null;
    closePatterns();
    helper?.destroy();
    helper = mountHelper(pctx.side, {
      project, memory: helperMemory,
      getWorkflow: () => graph.getWorkflow(),
      onApply: (wf) => { graph.setWorkflow(wf); markDirty(graph.getWorkflow()); },
      onClose: closeHelper,
    });
    helperBtn.setAttribute('aria-pressed', 'true');
    if (force) pctx.side.querySelector('#helper-input')?.focus();
  }
  function closeHelper() {
    setPref('helper', 'off');
    helper?.destroy();
    helper = null;
    helperBtn.setAttribute('aria-pressed', 'false');
  }

  /* ---- graph ------------------------------------------------------------------------------------- */
  function markDirty(wf) {
    current = wf;
    dirty = JSON.stringify(wf) !== JSON.stringify(record.workflow);
    dirtyPill.hidden = !dirty;
    saveBtn.disabled = !dirty;
    drawStart();
  }

  function openNode(n, { focus } = {}) {
    if (!n) { panel?.destroy(); panel = null; showHelper(); return; }
    if (mode === 'live') {
      const waiting = state.pending.find((r) => r.projectId === project.id && r.nodeId === n.id);
      if (waiting) { openRequest(waiting.id); return; }
    }
    panel?.destroy();
    if (helper) { helper.destroy(); helper = null; helperBtn.setAttribute('aria-pressed', 'false'); }
    closePatterns();
    panel = openNodePanel(pctx.side, { node: graph.getWorkflow().nodes.find((x) => x.id === n.id), workflow: () => graph.getWorkflow(), graph, project, focus });
  }

  graph = mountGraph(graphHost, {
    workflow: current, mode: 'edit', modes: ['edit', 'live', 'versions'], projectId: project.id, versions: record.versions, head: record.head,
    onChange: markDirty, onOpenNode: openNode, onRestore: restore,
    onMode: (m) => { mode = m; if (m === 'live') startLive(); else stopLive(); if (m === 'versions') { panel?.destroy(); panel = null; helper?.destroy(); helper = null; closePatterns(); } else if (!panel && !helper && !patterns) showHelper(); },
  });

  async function restore(version) {
    try {
      const r = await api.restoreWorkflow(project.id, version);
      adopt(r);
      toast(`Restored v${version} as v${r.version}.`, { kind: 'ok' });
    } catch (e) { toast(e.message, { kind: 'danger' }); }
  }

  function adopt(r) {
    record = r;
    current = structuredClone(r.workflow);
    dirty = false;
    dirtyPill.hidden = true;
    saveBtn.disabled = true;
    versionPill.textContent = `v${r.head}`;
    graph.setWorkflow(current);
    graph.setVersions(r.versions, r.head);
    drawWarnings();
    drawOptions();
    drawStart();
  }

  /* ---- live -------------------------------------------------------------------------------------- */
  async function pollLive() {
    try { graph.setLive(await api.live(project.id)); } catch { /* the graph keeps its last picture */ }
  }
  function startLive() { stopLive(); pollLive(); liveTimer = setInterval(pollLive, 3000); }
  function stopLive() { clearInterval(liveTimer); liveTimer = null; }
  const onLiveEvent = () => { if (liveTimer) pollLive(); };
  window.addEventListener('circle:run', onLiveEvent);
  window.addEventListener('circle:requests', onLiveEvent);

  /* ---- saving a version -------------------------------------------------------------------------- */
  function saveDialog() {
    const level = suggestBump(record.workflow, current) || 'patch';
    const note = h('input', { class: 'cs-input', id: 'ver-note', placeholder: 'What changed (optional)' });
    const bump = h('select', { class: 'cs-select', id: 'ver-bump', 'aria-label': 'Version level' },
      h('option', { value: '' }, `Suggested: ${LEVEL_WORD[level]}`), ...['patch', 'minor', 'major'].map((l) => h('option', { value: l }, LEVEL_WORD[l])));
    return openModal({
      title: 'Save a version', size: 'narrow', initialFocus: '#ver-note',
      body: h('div', { class: 'cs-stack' }, h('p', { class: 'cs-soft' }, `The current version is v${record.head}. Every save is kept in the Versions view.`),
        h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'ver-note' }, 'Note'), note),
        h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'ver-bump' }, 'Version level'), bump)),
      actions: [{ label: 'Cancel', kind: 'quiet', onClick: (c) => c.close(null) }, { label: 'Save version', kind: 'primary', onClick: async (c) => {
        c.setBusy(true);
        try {
          const r = await api.saveWorkflow(project.id, { workflow: current, note: note.value.trim() || undefined, bump: bump.value || undefined });
          c.close('saved');
          adopt(r);
          toast(r.unchanged ? 'Nothing changed, so no new version.' : `Saved v${r.version}.`, { kind: 'ok' });
        } catch (e) { c.setBusy(false); toast(e.message, { kind: 'danger' }); }
      } }],
    });
  }

  async function writeFiles() {
    if (dirty) { saveDialog(); toast('Save a version first, then write the files.', { kind: 'info' }); return; }
    const ops = [{ op: 'plan-write' }, { op: 'workflow-write' }];
    const has = pctx.team?.roster?.humanDoesGit === true;
    if (pctx.team?.roster && record.workflow.flags.humanDoesGit !== has) ops.push({ op: 'human-git', value: record.workflow.flags.humanDoesGit });
    const r = await reviewChanges({ projectId: project.id, ops, title: 'Write the brief, the workflow and the config files', applyLabel: 'Write files' });
    if (r) pctx.reload();
  }

  /* ---- warnings ---------------------------------------------------------------------------------- */
  function drawWarnings() {
    const order = { danger: 0, warn: 1, info: 2 };
    warnEl.replaceChildren(...(record.warnings || []).slice().sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3)).map((w) => h('div', { class: `cs-banner cs-banner--${w.severity === 'danger' ? 'danger' : w.severity === 'warn' ? 'warn' : 'info'}` },
      h('span', { class: 'cs-banner__icon' }, icon(w.severity === 'info' ? 'info' : w.severity === 'danger' ? 'danger' : 'warning', 's')), h('span', { class: 'cs-grow' }, w.message),
      w.nodeId ? h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', onclick: () => graph.select(w.nodeId) }, 'Open') : null)));
    warnEl.hidden = !warnEl.children.length;
  }

  /* ---- brief and options ------------------------------------------------------------------------- */
  const savePlanSoon = () => {
    status.textContent = 'Saving...';
    clearTimeout(planTimer);
    planTimer = setTimeout(async () => {
      planTimer = null;
      try { plan = (await api.savePlan(project.id, plan)).plan; status.textContent = 'Brief saved in Circle Studio'; } catch (e) { status.textContent = `Not saved: ${e.message}`; }
    }, 500);
  };
  const field = (label, id, value, on, { area = false, hint, rows = 3 } = {}) => {
    const input = area ? h('textarea', { class: 'cs-textarea', id, rows }, value) : h('input', { class: 'cs-input', id, value });
    input.addEventListener('input', () => { on(input.value); savePlanSoon(); });
    return h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: id }, label), input, hint ? h('span', { class: 'cs-field__hint' }, hint) : null);
  };
  const sw = (label, checked, on, hint) => h('label', { class: 'cs-switch' }, h('input', { class: 'cs-switch__input', type: 'checkbox', checked: checked || undefined, onchange: (e) => on(e.target.checked) }), h('span', { class: 'cs-switch__track' }), h('span', {}, label, hint ? h('span', { class: 'cs-soft cs-small' }, ` ${hint}`) : null));

  const b = plan.brief;
  const briefEl = h('details', { class: 'cs-card cs-plan__brief' },
    h('summary', { class: 'cs-h3' }, 'Brief: what the team reads first'),
    h('div', { class: 'cs-stack' },
      field('Idea', 'b-idea', plan.idea, (v) => { plan.idea = v; }, { area: true, rows: 2 }),
      field('What it is', 'b-what', b.what, (v) => { b.what = v; }, { area: true, rows: 2 }),
      field('Who uses it', 'b-who', b.who, (v) => { b.who = v; }, { area: true, rows: 2 }),
      field('Must have (one per line)', 'b-must', b.mustHave.join('\n'), (v) => { b.mustHave = lines(v); }, { area: true, rows: 4 }),
      field('Explicitly not doing (one per line)', 'b-not', b.notDoing.join('\n'), (v) => { b.notDoing = lines(v); }, { area: true, rows: 3, hint: 'The most valuable section: every line saves a conversation later.' }),
      h('div', { class: 'cs-grid' },
        field('Deadline', 'b-dl', b.constraints.deadline, (v) => { b.constraints.deadline = v; }),
        field('Budget', 'b-bud', b.constraints.budget, (v) => { b.constraints.budget = v; }),
        field('Stack we must fit', 'b-stack', b.constraints.stack, (v) => { b.constraints.stack = v; }),
        field('Platforms', 'b-plat', b.constraints.platforms, (v) => { b.constraints.platforms = v; }),
        field('Compliance', 'b-comp', b.constraints.compliance, (v) => { b.constraints.compliance = v; })),
      field('Existing code', 'b-code', b.existingCode, (v) => { b.existingCode = v; }),
      field('Anything else', 'b-else', b.anythingElse, (v) => { b.anythingElse = v; }, { area: true })));

  const optionsEl = h('div', { class: 'cs-card cs-stack cs-stack--tight' });
  function drawOptions() {
    const set = (apply) => { const w = graph.getWorkflow(); apply(w); graph.setWorkflow(w); markDirty(w); drawOptions(); };
    const w = current;
    const lane = (k, label) => sw(label, w.lanes[k], (v) => set((x) => { x.lanes[k] = v; }));
    optionsEl.replaceChildren(
      h('div', { class: 'cs-row cs-row--wrap' }, h('span', { class: 'cs-eyebrow' }, 'Lanes'), lane('frontend', 'Frontend'), lane('backend', 'Backend'), lane('contract', 'Shared contract'), lane('migrations', 'Migrations')),
      h('div', { class: 'cs-row cs-row--wrap' },
        sw('Local only', w.flags.localOnly, (v) => set((x) => { x.flags.localOnly = v; }), '(no hosting)'),
        sw('Human does git', w.flags.humanDoesGit, (v) => set((x) => { x.flags.humanDoesGit = v; }), '(push.md + .gitignore)')));
  }

  const pinsEl = h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'pins-h' });
  function drawPins() {
    pinsEl.replaceChildren();
    pinsEl.hidden = !plan.pins.length;
    if (!plan.pins.length) return;
    const stages = current.nodes.filter((n) => n.kind === 'stage');
    pinsEl.append(h('h2', { class: 'cs-h2', id: 'pins-h' }, 'Pinned from the advisor'));
    for (const x of plan.pins) {
      pinsEl.append(h('div', { class: 'cs-card cs-row' },
        h('input', { type: 'checkbox', checked: x.done || undefined, 'aria-label': `${x.title} is done`, onchange: (e) => { x.done = e.target.checked; savePlanSoon(); drawPins(); } }),
        h('span', { class: `cs-pill ${x.kind === 'issue' ? 'cs-pill--warn' : x.kind === 'build' ? 'cs-pill--info' : 'cs-pill--ok'}` }, x.kind),
        h('div', { class: 'cs-grow' }, h('div', { class: x.done ? 'cs-soft' : '' }, x.title), x.detail ? h('div', { class: 'cs-soft cs-small' }, x.detail) : null),
        h('select', { class: 'cs-select', 'aria-label': `Stage for ${x.title}`, onchange: (e) => { x.phaseId = e.target.value || null; savePlanSoon(); } }, h('option', { value: '' }, 'No stage'), stages.map((s) => h('option', { value: s.id, selected: x.phaseId === s.id || undefined }, s.title))),
        h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon cs-btn--small', type: 'button', 'aria-label': `Remove pin ${x.title}`, onclick: () => { plan.pins.splice(plan.pins.indexOf(x), 1); savePlanSoon(); drawPins(); } }, icon('trash', 's'))));
    }
  }

  versionPill.textContent = `v${record.head}`;
  el.append(h('div', { class: 'cs-stack cs-stack--loose' },
    h('div', { class: 'cs-row cs-row--wrap cs-row--between' },
      h('div', {}, h('div', { class: 'cs-row' }, h('h2', { class: 'cs-h2' }, 'Workflow'), versionPill, dirtyPill), h('p', { class: 'cs-soft cs-small' }, 'Click a node to change it or talk to it. A marker on an arrow is a checkpoint: who checks the work before the next stage.')),
      h('div', { class: 'cs-row cs-row--wrap' }, status, helperBtn, patternsBtn, saveBtn, h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: writeFiles }, icon('diff', 's'), 'Review and write files'))),
    startEl, warnEl, graphHost, optionsEl, briefEl, pinsEl));
  drawWarnings();
  drawOptions();
  drawPins();
  drawStart();
  requestAnimationFrame(() => showHelper());

  return { destroy() {
    stopLive();
    patterns?.destroy();
    window.removeEventListener('circle:run', onLiveEvent);
    window.removeEventListener('circle:requests', onLiveEvent);
    if (planTimer) { clearTimeout(planTimer); api.savePlan(project.id, plan).catch(() => {}); }
    panel?.destroy();
    graph?.destroy();
    helper?.destroy();
  } };
}
