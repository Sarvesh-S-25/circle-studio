// Team: the matrix of every role's tier and engine chain, with drift flags; click any tab to inspect.
import { h, icon, tierChip, chainView } from '../dom.js';
import { renderInspector } from '../components/inspector.js';
import { AGENT_TYPE, SKILL_TYPE, addKeyboardPath, dragSource, dropTarget, installAgent, installSkill } from '../components/dnd.js';
import { reviewChanges } from '../components/diffreview.js';

const GROUPS = [
  ['Core', ['splitter', 'executor', 'auditor', 'texter', 'versioner']],
  ['Think', ['planner', 'stack-advisor', 'security', 'business-auditor', 'scaler', 'researcher']],
  ['Build', ['fe-builder', 'be-builder', 'migrator', 'connector', 'qa']],
  ['Design and ship', ['designer', 'design-tooling', 'deployer']],
];

export async function mount(el, pctx) {
  const { team, project } = pctx;
  if (!team.files.modelsJson && !team.roles.length) {
    el.append(h('div', { class: 'cs-empty' }, icon('team', 'l'), h('div', { class: 'cs-empty__title' }, 'No team here yet'), h('p', {}, 'This folder has no models.json or agents.')));
    return {};
  }
  let selected = null;
  const container = h('div', { class: 'cs-stack cs-stack--loose' });

  function select(target) {
    selected = target;
    pctx.side.replaceChildren();
    if (target) {
      pctx.side.append(renderInspector({ project, team: pctx.team, target, onClose: () => { selected = null; pctx.side.replaceChildren(); draw(); }, onApplied: () => pctx.reload() }));
      pctx.side.querySelector('input[type="radio"]:checked, .cs-btn')?.focus?.();
    }
    draw();
  }

  function roleTab(r) {
    const b = h('button', {
      class: ['cs-card', 'cs-team__tab', selected?.kind === 'agent' && selected.name === r.role && 'cs-card--selected'], type: 'button', 'aria-pressed': String(selected?.kind === 'agent' && selected.name === r.role),
      onclick: () => select({ kind: 'agent', name: r.role }), title: r.description,
    },
      h('div', { class: 'cs-card__head' }, icon('agent', 's'), h('span', { class: 'cs-card__title' }, r.role), h('span', { class: 'cs-grow' }),
        r.optional && !r.enabled ? h('span', { class: 'cs-pill cs-pill--quiet' }, 'off') : null,
        r.drift ? h('span', { class: 'cs-pill cs-pill--warn', title: `Agent file says ${r.agentModel}` }, icon('warning', 's'), 'drift') : null),
      h('div', { class: 'cs-row cs-row--wrap' }, tierChip(r.configModel || r.agentModel), h('span', { class: 'cs-grow' })),
      chainView(r.engine));
    dragSource(b, AGENT_TYPE, { role: r.role, from: project.id });
    addKeyboardPath(b, `Add ${r.role} to`, (p) => installAgent(p.id, r.role, project.id));
    return b;
  }

  function draw() {
    const t = pctx.team;
    const known = new Set(GROUPS.flatMap((g) => g[1]));
    const groups = GROUPS.map(([name, roles]) => [name, t.roles.filter((r) => roles.includes(r.role))]);
    const rest = t.roles.filter((r) => !known.has(r.role));
    if (rest.length) groups.push(['Other', rest]);
    const engineSel = h('select', { class: 'cs-select', id: 'def-engine', 'aria-label': 'Default engine for every role' }, ['gemini', 'copilot', 'codex'].map((e) => h('option', { value: e, selected: t.defaults.engine === e || undefined }, e)));
    container.replaceChildren(
      h('div', { class: 'cs-row cs-row--wrap cs-row--between' },
        h('div', {}, h('h2', { class: 'cs-h2' }, `Team (${t.roles.length})`), h('p', { class: 'cs-soft cs-small' }, 'Click a role to change it.')),
        t.files.consultConfig ? h('div', { class: 'cs-row' }, h('label', { class: 'cs-small', for: 'def-engine' }, 'Main engine for all roles'), engineSel,
          h('button', { class: 'cs-btn', type: 'button', onclick: () => reviewChanges({ projectId: project.id, ops: [{ op: 'engines-default', engine: engineSel.value }], title: `Make ${engineSel.value} the first engine everywhere` }).then((r) => r && pctx.reload()) }, 'Review')) : null),
      t.engineHealth.length ? h('div', { class: 'cs-row cs-row--wrap' }, h('span', { class: 'cs-eyebrow' }, 'Engines'), t.engineHealth.map((e) => h('span', { class: `cs-pill ${e.state === 'ok' ? 'cs-pill--ok' : 'cs-pill--warn'}`, title: e.reason || '' }, icon(e.state === 'ok' ? 'check' : 'warning', 's'), `${e.name}: ${e.state}`))) : null,
      t.problems.length ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, t.problems.map((p) => `${p.file}: ${p.message}`).join(' | '))) : null,
      ...groups.filter(([, rs]) => rs.length).map(([name, rs]) => h('section', { class: 'cs-stack cs-stack--tight', 'aria-label': name }, h('h3', { class: 'cs-eyebrow' }, name), h('div', { class: 'cs-grid' }, rs.map(roleTab)))),
      t.skills.length ? h('section', { class: 'cs-stack cs-stack--tight', 'aria-label': 'Skills installed in this project' }, h('h3', { class: 'cs-eyebrow' }, `Skills installed here (${t.skills.length})`),
        h('div', { class: 'cs-grid' }, t.skills.map((s) => h('button', { class: ['cs-card', 'cs-team__tab', selected?.kind === 'skill' && selected.name === s.name && 'cs-card--selected'], type: 'button', onclick: () => select({ kind: 'skill', name: s.name }) },
          h('div', { class: 'cs-card__head' }, icon('skill', 's'), h('span', { class: 'cs-card__title' }, s.name)), h('div', { class: 'cs-row' }, tierChip(s.model || 'inherit')), s.engine ? chainView(s.engine) : null)))) : null);
  }

  dropTarget(el, [SKILL_TYPE, AGENT_TYPE], (payload, type) => (type === SKILL_TYPE ? installSkill(project.id, payload.name).then((r) => r && pctx.reload()) : payload.from ? installAgent(project.id, payload.role, payload.from).then((r) => r && pctx.reload()) : null), 'cs-card--drop');
  el.append(container);
  draw();
  return { destroy: () => pctx.side.replaceChildren() };
}
