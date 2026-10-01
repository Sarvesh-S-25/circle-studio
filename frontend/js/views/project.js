// A project: header, tabs (Plan, Team, Skills, Health, Chat) and the side inspector.
import { api } from '../api.js';
import { h, icon, sigil, copyText, statusPill } from '../dom.js';
import { refreshProjects, refreshShell } from '../state.js';
import { confirmDialog, toast } from '../components/overlay.js';
import { askPermissions, permissionSummary } from '../components/permissions.js';
import { gitChip, widgetMenu } from '../components/gitpanel.js';

const TABS = [['workflow', 'Workflow', 'plan'], ['team', 'Team', 'team'], ['skills', 'Skills', 'skill'], ['health', 'Health', 'health'], ['cost', 'Cost', 'cost'], ['chat', 'Chat', 'chat']];
const MODULES = {
  workflow: () => import('./workflow.js'),
  team: () => import('./team.js'),
  skills: () => import('./pskills.js'),
  health: () => import('./health.js'),
  cost: () => import('./cost.js'),
  chat: () => import('./chat.js'),
};

export async function mount(el, ctx) {
  const { id, tab } = ctx.params;
  let data;
  try {
    data = await api.project(id, true);
  } catch (e) {
    el.replaceChildren(h('div', { class: 'cs-empty' }, icon('folder', 'l'), h('div', { class: 'cs-empty__title' }, 'No such project'), h('p', {}, e.message), h('a', { class: 'cs-btn', href: '#/' }, 'Back home')));
    return {};
  }
  const pctx = {
    project: data.project,
    team: data.team,
    side: ctx.side,
    id,
    inspector: null,
    async reload() {
      const d = await api.project(id);
      pctx.project = d.project;
      pctx.team = d.team;
      refreshShell().catch(() => {});
      await drawTab();
      await drawChips();
    },
    closeInspector() { ctx.side.replaceChildren(); pctx.inspector = null; },
  };

  if (!data.project.exists) {
    el.replaceChildren(h('div', { class: 'cs-empty' }, icon('folder', 'l'), h('div', { class: 'cs-empty__title' }, `${data.project.name} is missing`), h('p', { class: 'cs-mono' }, data.project.path),
      h('button', { class: 'cs-btn', type: 'button', onclick: async () => { if (await confirmDialog({ title: 'Forget this project?', message: 'Only Circle Studio\'s record is removed. No files are touched.', confirmLabel: 'Forget' })) { await api.removeProject(id); await Promise.all([refreshProjects(), refreshShell()]); location.hash = '#/'; } } }, 'Forget this project')));
    return {};
  }

  const chips = h('div', { class: 'cs-row cs-row--wrap' });
  const tabBar = h('div', { class: 'cs-tabs', role: 'tablist', 'aria-label': 'Project sections' });
  const panel = h('div', { role: 'tabpanel', id: 'tab-panel', tabindex: '-1', 'aria-labelledby': `tab-${tab}` });
  let inst = null;

  TABS.forEach(([key, label, ic], n) => {
    const a = h('a', { class: 'cs-tab', role: 'tab', id: `tab-${key}`, href: `#/projects/${id}/${key}`, 'aria-selected': String(key === tab), tabindex: key === tab ? '0' : '-1', 'aria-controls': 'tab-panel', title: `Alt+${n + 1}` }, icon(ic, 's'), label);
    tabBar.append(a);
  });
  tabBar.addEventListener('keydown', (e) => {
    const keys = TABS.map((t) => t[0]);
    const at = keys.indexOf(tab);
    let to = null;
    if (e.key === 'ArrowRight') to = keys[(at + 1) % keys.length];
    else if (e.key === 'ArrowLeft') to = keys[(at + keys.length - 1) % keys.length];
    else if (e.key === 'Home') to = keys[0];
    else if (e.key === 'End') to = keys[keys.length - 1];
    if (to) { e.preventDefault(); location.hash = `#/projects/${id}/${to}`; }
  });

  async function drawChips() {
    try {
      const hl = await api.health_of(id);
      chips.replaceChildren();
      // the same plain words as the Health tab, one chip per thing that needs you now, each a link there
      for (const i of hl.items.filter((x) => x.group === 'now').slice(0, 3)) {
        chips.append(h('a', { class: 'cs-chiplink', href: `#/projects/${id}/health`, title: i.detail }, statusPill(i.severity === 'danger' ? 'danger' : 'warn', i.title)));
      }
      if (!chips.children.length) chips.append(h('a', { class: 'cs-chiplink', href: `#/projects/${id}/health` }, statusPill('ok', hl.counts.look ? 'Nothing blocked' : 'All good')));
    } catch { /* the header chips are a nicety */ }
  }

  async function drawTab() {
    inst?.destroy?.();
    pctx.closeInspector();
    panel.replaceChildren(h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Loading...'));
    const mod = await MODULES[tab]();
    const holder = h('div');
    panel.replaceChildren(holder);
    inst = await mod.mount(holder, pctx);
  }

  el.append(
    h('header', { class: 'cs-head' },
      h('span', { class: 'cs-project-sigil' }, sigil(id, 'l')),
      h('div', { class: 'cs-head__title' }, h('h1', { class: 'cs-h1', id: 'main-title' }, data.project.name),
        h('div', { class: 'cs-row' }, h('span', { class: 'cs-mono cs-soft cs-project-path', title: data.project.path }, data.project.path),
          h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon cs-btn--small', type: 'button', 'aria-label': 'Copy the project path', onclick: async () => toast((await copyText(data.project.path)) ? 'Path copied.' : 'Could not copy.', { kind: 'info', ms: 2000 }) }, icon('copy', 's')))),
      chips,
      gitChip(data.project),
      h('button', { class: 'cs-btn cs-btn--small', type: 'button', title: 'A small window for this project: what runs, what waits for you. Pin it to the Desktop or Start menu.', 'aria-haspopup': 'menu', onclick: (e) => widgetMenu(e.currentTarget, data.project) }, icon('pin', 's'), 'Widget'),
      h('button', { class: 'cs-btn cs-btn--small', type: 'button', title: `Allowed: ${permissionSummary(data.project.permissions).join(', ') || 'read only'}`, onclick: async () => {
        const next = await askPermissions({ name: data.project.name, path: data.project.path, current: pctx.project.permissions, confirmLabel: 'Save' });
        if (!next) return;
        await api.setPermissions(id, next);
        toast('Permissions saved.', { kind: 'ok', ms: 2000 });
        location.reload();
      } }, icon('lock', 's'), 'Permissions')),
    tabBar, panel);
  await drawTab();
  drawChips();
  return { destroy: () => { inst?.destroy?.(); ctx.side.replaceChildren(); } };
}
