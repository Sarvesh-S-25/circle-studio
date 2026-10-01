// Updates for Circle Studio itself: the badge in the taskbar, the Settings section, and the update itself (git moves
// the app forward, the launcher restarts the server, this window reloads and shows "What's new").
import { api } from '../api.js';
import { h, icon, timeAgo } from '../dom.js';
import { notify, state } from '../state.js';
import { confirmDialog, openModal, toast } from './overlay.js';

export async function loadUpdateState() {
  try { const u = await api.update(); state.update = u.update; state.version = u.version; notify(); } catch { /* an older server */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Update now: confirm, fast-forward, wait for the restarted server, reload. */
export async function runUpdate() {
  if (!(await confirmDialog({ title: 'Update Circle Studio now?', message: 'It moves this copy forward to the newest version and restarts. Your projects, data and any running chat are not touched, but a running chat stops.', confirmLabel: 'Update and restart' }))) return;
  const msg = h('p', {}, 'Updating...');
  const ctrl = openModal({ title: 'Updating Circle Studio', body: h('div', { class: 'cs-stack' }, h('div', { class: 'cs-loading' }, icon('spinner', 'm'), msg)), actions: [], dismissable: false });
  let r;
  try { r = await api.applyUpdate(); } catch (e) { ctrl.close(null); toast(e.message, { kind: 'danger', ms: 0 }); return; }
  const before = state.health?.code;
  msg.textContent = `Updated to ${r.version}. Restarting...`;
  if (!r.restarting) { ctrl.close(null); toast('Updated. Close Circle Studio and open it again to finish.', { kind: 'ok', ms: 0 }); return; }
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    try {
      const hl = await api.health();
      if (hl.code && hl.code !== before && !hl.stale) { location.reload(); return; }
    } catch { /* restarting */ }
  }
  ctrl.close(null);
  toast('Updated, but the restart is taking long. Close Circle Studio and open it again from the desktop.', { kind: 'warn', ms: 0 });
}

/** The Updates section of Settings. */
export function updateSection() {
  const box = h('div', { class: 'cs-stack cs-stack--tight' }, h('p', { class: 'cs-soft' }, 'Loading...'));
  async function draw(check = false) {
    if (check) box.replaceChildren(h('div', { class: 'cs-loading' }, icon('spinner', 's'), 'Asking the remote (read only)...'));
    let u;
    try { u = await api.update(check); } catch (e) { box.replaceChildren(h('p', { class: 'cs-soft' }, e.message)); return; }
    state.update = u.update;
    notify();
    const up = u.update;
    const line = !up ? 'Not checked yet.'
      : up.mode === 'zip' ? up.reason
        : up.available ? (up.canUpdate ? 'A newer version is ready.' : `A newer version exists, but: ${up.reason}`)
          : up.reason || 'Up to date.';
    box.replaceChildren(
      h('p', {}, h('strong', {}, `Version ${u.version}`), up?.mode === 'git' && up.branch ? h('span', { class: 'cs-soft' }, ` · ${up.branch}${up.url ? ` from ${up.url}` : ''}`) : null),
      h('p', { class: up?.available ? '' : 'cs-soft' }, line),
      up?.at ? h('p', { class: 'cs-soft cs-small' }, `Last checked ${timeAgo(up.at)}. ${u.check === 'off' ? 'Daily checks are off.' : 'Checked once a day while it runs.'}`) : null,
      h('div', { class: 'cs-row cs-row--wrap' },
        up?.available && up.canUpdate ? h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: runUpdate }, icon('download', 's'), 'Update and restart') : null,
        h('button', { class: 'cs-btn', type: 'button', onclick: () => draw(true) }, icon('refresh', 's'), 'Check now'),
        h('label', { class: 'cs-switch' }, h('input', { class: 'cs-switch__input', type: 'checkbox', checked: u.check !== 'off' || undefined, onchange: async (e) => { await api.saveSettings({ updates: { check: e.target.checked ? 'daily' : 'off' } }); draw(); } }), h('span', { class: 'cs-switch__track' }), h('span', {}, 'Check once a day'))),
      h('p', { class: 'cs-soft cs-small' }, 'The check only reads the remote. The update runs only when you press it, and only moves forward: if you changed files in the app\'s folder it says so and waits for you.'));
  }
  draw();
  return box;
}
