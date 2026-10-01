// The widget board (widget.html with no project): the tiles you chose, like a desktop widget stack. Edit to add,
// resize, reorder or remove tiles; every tile can also open in its own small window (widget.html?w=<kind>&size=..).
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { state, notify } from '../state.js';
import { initRequests } from './requests.js';
import { initAlerts } from './alerts.js';
import { openModal, toast } from './overlay.js';
import { KINDS, renderTile, createTileData } from './tiles.js';

const POLL_MS = 15_000;
const USAGE_MS = 5 * 60_000;
const SIZE_WORD = { s: 'Small', m: 'Medium', l: 'Large' };

async function loadShell() {
  try { const s = await api.state(); state.recent = s.recent; } catch { /* the tiles say it */ }
  try { state.projects = (await api.projects()).projects; } catch { /* ditto */ }
  notify();
}

function listen(redraw) {
  initRequests();
  initAlerts();
  for (const ev of ['circle:requests', 'circle:alerts', 'circle:run']) window.addEventListener(ev, redraw);
}

/** One tile alone in its window. */
export async function mountSingleTile(root, { kind, size, projectId, openApp }) {
  if (!KINDS[kind]) { root.replaceChildren(h('p', { class: 'cs-tile__quiet' }, 'Unknown widget.')); return; }
  const tile = { kind, size: KINDS[kind].sizes.includes(size) ? size : KINDS[kind].sizes[0], projectId: projectId || null };
  const ctx = createTileData({ openApp });
  ctx.setProject = (t, id) => { t.projectId = id; const u = new URL(location.href); u.searchParams.set('p', id); history.replaceState(null, '', u); refresh(); };
  const draw = () => root.replaceChildren(h('div', { class: 'cs-solo' }, renderTile(tile, ctx)));
  async function refresh(usage = false) { await ctx.refresh([tile], { usage, skipUsage: !usage && !ctx.usage && kind !== 'spend' }); draw(); }
  document.title = `${KINDS[kind].title} · Circle Studio`;
  draw();
  await loadShell();
  await refresh(true);
  listen(() => refresh());
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
  setInterval(() => refresh(true), USAGE_MS);
}

export async function mountBoard(root, { openApp }) {
  let tiles = [];
  let editing = false;
  const ctx = createTileData({ openApp });
  const save = async () => { try { await api.saveSettings({ widgets: tiles }); } catch (e) { toast(e.message, { kind: 'danger' }); } };
  ctx.setProject = (t, id) => { t.projectId = id; save(); refresh(); };

  function controls(t, i) {
    const k = KINDS[t.kind];
    const nextSize = k.sizes[(k.sizes.indexOf(t.size) + 1) % k.sizes.length];
    return h('div', { class: 'cs-tile__edit' },
      h('button', { class: 'cs-tile__ctl', type: 'button', 'aria-label': 'Move earlier', disabled: i === 0 || undefined, onclick: () => { [tiles[i - 1], tiles[i]] = [tiles[i], tiles[i - 1]]; save(); draw(); } }, icon('chevron-left', 's')),
      k.sizes.length > 1 ? h('button', { class: 'cs-tile__ctl cs-tile__ctl--size', type: 'button', 'aria-label': `Make it ${SIZE_WORD[nextSize].toLowerCase()}`, title: `Size: ${SIZE_WORD[t.size]} (click for ${SIZE_WORD[nextSize]})`, onclick: () => { t.size = nextSize; save(); draw(); } }, t.size.toUpperCase()) : null,
      h('button', { class: 'cs-tile__ctl', type: 'button', 'aria-label': 'Move later', disabled: i === tiles.length - 1 || undefined, onclick: () => { [tiles[i + 1], tiles[i]] = [tiles[i], tiles[i + 1]]; save(); draw(); } }, icon('chevron-right', 's')),
      h('button', { class: `cs-tile__ctl ${t.desktop === false ? '' : 'cs-tile__ctl--on'}`, type: 'button', 'aria-pressed': String(t.desktop !== false), title: t.desktop === false ? 'Not on the desktop (click to show it there)' : 'On the desktop (click to keep it only here)', 'aria-label': 'Show on the desktop', onclick: () => { t.desktop = t.desktop === false; save(); draw(); } }, icon('pin', 's')),
      h('button', { class: 'cs-tile__ctl cs-tile__ctl--x', type: 'button', 'aria-label': `Remove ${k.title}`, onclick: () => { tiles.splice(i, 1); save(); draw(); } }, icon('close', 's')));
  }

  function gallery() {
    const body = h('div', { class: 'cs-gallery' }, Object.entries(KINDS).map(([kind, k]) => h('div', { class: 'cs-gallery__item' },
      h('strong', {}, k.title), h('p', { class: 'cs-soft cs-small' }, k.about),
      h('div', { class: 'cs-row cs-row--wrap' }, k.sizes.map((size) => h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: async () => {
        tiles.push({ kind, size, projectId: null });
        ctrl.close(null);
        await save();
        await refresh();
      } }, icon('plus', 's'), SIZE_WORD[size]))))));
    const ctrl = openModal({ title: 'Add a widget', body, size: 'wide', actions: [{ label: 'Close', kind: 'quiet' }] });
  }

  function popOut(t) {
    api.openWindow('tile', t.projectId || ctx.defaultProject() || undefined, undefined, { kind: t.kind, size: t.size }).catch(() => window.open(`/widget.html?w=${t.kind}&size=${t.size}${t.projectId ? `&p=${encodeURIComponent(t.projectId)}` : ''}`, '_blank'));
  }

  function draw() {
    const bar = h('header', { class: 'cs-board__bar' }, h('span', { class: 'cs-board__mark' }, icon('mark', 'm')), h('span', { class: 'cs-board__title' }, 'Circle Studio'), h('span', { class: 'cs-grow' }),
      editing ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: gallery }, icon('plus', 's'), 'Add') : null,
      h('button', { class: 'cs-btn cs-btn--small', type: 'button', title: 'Show these tiles on the desktop itself, as widgets', onclick: async () => { try { await api.desktopWidgets('start'); toast('On your desktop now. Drag a tile to move it; right-click for options.', { kind: 'ok' }); } catch (e) { toast(e.message, { kind: 'danger' }); } } }, icon('pin', 's'), 'Put on desktop'),
      h('button', { class: `cs-btn cs-btn--small ${editing ? 'cs-btn--primary' : 'cs-btn--quiet'}`, type: 'button', 'aria-pressed': String(editing), onclick: () => { editing = !editing; draw(); } }, editing ? 'Done' : 'Edit'),
      h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Open Circle Studio', title: 'Open Circle Studio', onclick: () => openApp('#/') }, icon('external', 's')));
    const grid = h('div', { class: `cs-board ${editing ? 'cs-board--editing' : ''}` }, tiles.map((t, i) => {
      const el = renderTile(t, ctx);
      if (editing) el.append(controls(t, i));
      else el.append(h('button', { class: 'cs-tile__pop', type: 'button', 'aria-label': `Open ${KINDS[t.kind]?.title} in its own window`, title: 'Open in its own window', onclick: () => popOut(t) }, icon('external', 's')));
      return el;
    }), !tiles.length || editing ? h('button', { class: 'cs-tile cs-tile--s cs-tile--add', type: 'button', onclick: gallery }, icon('plus', 'l'), 'Add a widget') : null);
    root.replaceChildren(h('div', { class: 'cs-boardwrap' }, bar, grid));
  }

  async function refresh(usage = false) { await ctx.refresh(tiles, { usage }); draw(); }

  document.title = 'Circle Studio widgets';
  draw();
  await loadShell();
  try { tiles = (await api.settings()).settings.widgets || []; } catch { tiles = []; }
  draw();
  await ctx.refresh(tiles, { usage: false, skipUsage: true }); // quick data first; the use per provider takes longer the first time
  draw();
  refresh(true);
  listen(() => refresh());
  setInterval(() => { if (document.visibilityState === 'visible' && !editing) refresh(); }, POLL_MS);
  setInterval(() => refresh(true), USAGE_MS);
}
