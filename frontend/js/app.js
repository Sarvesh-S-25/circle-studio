// Boot, shell and hash router.
import { h, icon } from './dom.js';
import { applyTheme, refreshEngines, refreshProjects, refreshShell, refreshSkills, state } from './state.js';
import { initRequests } from './components/requests.js';
import { initAlerts } from './components/alerts.js';
import { checkForNews } from './components/whatsnew.js';
import { loadUpdateState } from './components/updates.js';
import { toggleGuide } from './components/guide.js';
import { initPanelSize } from './components/panelsize.js';
import { buildRail } from './components/rail.js';
import { openPalette, openShortcuts } from './components/palette.js';
import { initWindowDrop } from './components/dnd.js';
import { toast, modalOpen } from './components/overlay.js';

const VIEWS = {
  home: () => import('./views/home.js'),
  project: () => import('./views/project.js'),
  library: () => import('./views/library.js'),
  skill: () => import('./views/skilleditor.js'),
  advisor: () => import('./views/advisor.js'),
  settings: () => import('./views/settings.js'),
  inbox: () => import('./views/inbox.js'),
  connections: () => import('./views/connections.js'),
};

const TABS = ['workflow', 'team', 'skills', 'health', 'cost', 'chat'];

function parseRoute(hash) {
  const parts = (hash || '#/').replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return { view: 'home', params: {} };
  if (parts[0] === 'projects' && parts[1]) return { view: 'project', params: { id: parts[1], tab: TABS.includes(parts[2]) ? parts[2] : 'workflow' } };
  if (parts[0] === 'library' && parts[1]) return { view: 'skill', params: { name: parts[1] } };
  if (parts[0] === 'library') return { view: 'library', params: {} };
  if (parts[0] === 'import') return { view: 'library', params: { importOpen: true } };
  if (parts[0] === 'advisor') return { view: 'advisor', params: {} };
  if (parts[0] === 'settings') return { view: 'settings', params: {} };
  if (parts[0] === 'inbox') return { view: 'inbox', params: {} };
  if (parts[0] === 'connections') return { view: 'connections', params: { projectId: parts[1] || '' } };
  return { view: 'home', params: {} };
}

applyTheme();
const root = document.getElementById('app');
const rail = buildRail();
const main = h('main', { class: 'cs-main', id: 'main' });
const topbar = h('div', { class: 'cs-topbar' },
  h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Open the taskbar (Ctrl+B)', onclick: () => toggleRail() }, icon('menu', 'm')),
  h('span', { class: 'cs-brand' }, icon('mark', 'm'), 'Circle Studio'));
const content = h('div', { class: 'cs-content' });
const app = h('div', { class: 'cs-app', 'data-rail': 'closed' }, rail.el, h('div', { class: 'cs-rail-scrim', onclick: () => toggleRail(false) }), main);
main.append(topbar, content);
root.append(app);

function toggleRail(open) {
  const next = open ?? app.getAttribute('data-rail') !== 'open';
  app.setAttribute('data-rail', next ? 'open' : 'closed');
}

let current = null;
let token = 0;

async function route() {
  const my = ++token;
  toggleRail(false);
  const { view, params } = parseRoute(location.hash);
  if (current?.destroy) { try { current.destroy(); } catch { /* ignore */ } }
  current = null;
  const el = h('div', { class: 'cs-view', tabindex: '-1' }, h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Loading...'));
  const side = h('div', { class: 'cs-side' });
  content.replaceChildren(el, side);
  try {
    const mod = await VIEWS[view]();
    if (my !== token) return;
    el.replaceChildren();
    const inst = await mod.mount(el, { params, side, navigate: (hash) => { location.hash = hash; } });
    if (my !== token) { inst?.destroy?.(); return; }
    current = inst || null;
  } catch (e) {
    if (my !== token) return;
    el.replaceChildren(h('div', { class: 'cs-empty' }, icon('danger', 'l'), h('div', { class: 'cs-empty__title' }, 'This page could not load'), h('p', {}, e.message || String(e))));
  }
  if (my === token) el.focus({ preventScroll: true });
}

window.addEventListener('hashchange', route);

/* ---- global shortcuts -------------------------------------------------------------------------- */
const typing = (t) => t instanceof HTMLElement && (t.matches('input, textarea, select') || t.isContentEditable);
let chord = null;
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (!modalOpen()) openPalette(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); toggleRail(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); toggleGuide(); return; }
  if (modalOpen()) return;
  if (e.altKey && /^[1-6]$/.test(e.key)) {
    const id = /^#\/projects\/([^/]+)/.exec(location.hash)?.[1] || state.recent[0]?.id;
    if (id) { e.preventDefault(); location.hash = `#/projects/${id}/${TABS[Number(e.key) - 1]}`; }
    return;
  }
  if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (chord) {
    const k = e.key.toLowerCase();
    chord = null;
    const id = /^#\/projects\/([^/]+)/.exec(location.hash)?.[1] || state.recent[0]?.id;
    const go = { h: '#/', l: '#/library', a: '#/advisor', p: id && `#/projects/${id}/workflow`, i: '#/inbox', c: id && `#/projects/${id}/chat` }[k];
    if (go) { e.preventDefault(); location.hash = go; }
    return;
  }
  if (e.key === 'g') { chord = true; setTimeout(() => { chord = null; }, 1200); return; }
  if (e.key === '/') { e.preventDefault(); if (matchMedia('(max-width: 48rem)').matches) toggleRail(true); rail.focusCreate(); return; }
  if (e.key === '?') { e.preventDefault(); openShortcuts(); }
});

initWindowDrop();
initPanelSize();

(async () => {
  try {
    await Promise.all([refreshShell(), refreshProjects(), refreshSkills()]);
  } catch (e) {
    toast(e.message, { kind: 'danger', ms: 0 });
  }
  route();
  initRequests();
  initAlerts();
  checkForNews();
  loadUpdateState();
  refreshEngines().catch(() => {}); // slow (each engine is asked): never hold the page up for it
})();
