// Project Skills tab: what is installed here, and installing from the library.
import { h, icon, tierChip, chainView } from '../dom.js';
import { state, refreshSkills } from '../state.js';
import { renderInspector } from '../components/inspector.js';
import { SKILL_TYPE, dropTarget, installSkill } from '../components/dnd.js';
import { openMenu } from '../components/overlay.js';

export async function mount(el, pctx) {
  const { project } = pctx;
  await refreshSkills().catch(() => {});
  const grid = h('div', { class: 'cs-grid' });

  function inspect(name) {
    pctx.side.replaceChildren(renderInspector({ project, team: pctx.team, target: { kind: 'skill', name }, onClose: () => pctx.side.replaceChildren(), onApplied: () => pctx.reload() }));
  }

  function draw() {
    const t = pctx.team;
    grid.replaceChildren();
    if (!t.skills.length) grid.append(h('div', { class: 'cs-empty' }, icon('skill', 'l'), h('div', { class: 'cs-empty__title' }, 'No skills installed here'), h('p', {}, 'Use "Install from library".')));
    for (const s of t.skills) {
      grid.append(h('button', { class: 'cs-card cs-team__tab', type: 'button', onclick: () => inspect(s.name) },
        h('div', { class: 'cs-card__head' }, icon('skill', 's'), h('span', { class: 'cs-card__title' }, s.name)),
        h('div', { class: 'cs-card__desc' }, s.description || 'No description'),
        h('div', { class: 'cs-card__meta' }, tierChip(s.model || 'inherit'), `${s.files} file${s.files === 1 ? '' : 's'}`, s.engine ? chainView(s.engine) : null)));
    }
  }

  const installBtn = h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: () => {
    if (!state.skills.length) { location.hash = '#/library'; return; }
    openMenu({ anchor: installBtn, label: 'Install from library', items: [{ group: 'Install from library' }, ...state.skills.map((s) => ({ label: s.name, icon: 'skill', onSelect: () => installSkill(project.id, s.name).then((r) => r && pctx.reload()) }))] });
  } }, icon('plus', 's'), 'Install from library');

  dropTarget(el, [SKILL_TYPE], (p) => installSkill(project.id, p.name).then((r) => r && pctx.reload()), 'cs-card--drop');
  el.append(h('div', { class: 'cs-stack' },
    h('div', { class: 'cs-row cs-row--wrap cs-row--between' }, h('div', {}, h('h2', { class: 'cs-h2' }, `Skills in ${project.name}`), h('p', { class: 'cs-soft cs-small' }, 'Click a skill to change it.')), installBtn),
    grid));
  draw();
  return { destroy: () => pctx.side.replaceChildren() };
}
