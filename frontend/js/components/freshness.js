// Keeping an open window on the newest Circle Studio. Every minute (and when the window comes back into view) it asks
// the server which code it runs (/api/code):
//   newer server code on disk   a banner: Restart now, or Later (hidden until this window is opened again). The server
//                               also restarts by itself once nothing is running, unless that is turned off in Settings.
//   the server restarted         the window reloads by itself, unless you are typing or a dialog is open (then it asks)
//   newer screens on disk        a banner: Reload, or Later
import { api } from '../api.js';
import { h, icon, plural } from '../dom.js';
import { confirmDialog, modalOpen } from './overlay.js';

const LATER = 'circle.fresh-later'; // sessionStorage: gone when the window closes, so it asks again next time
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const later = () => { try { return sessionStorage.getItem(LATER) === '1'; } catch { return false; } };
const setLater = () => { try { sessionStorage.setItem(LATER, '1'); } catch { /* private window: hidden until the next draw */ } };
/** Something half-typed, or a dialog open: a reload now would lose it. */
const typing = () => modalOpen() || [...document.querySelectorAll('textarea, input[type="text"], input:not([type])')].some((el) => el.value && el.value.trim());

export function watchFreshness(host) {
  const bar = h('div', { class: 'cs-fresh', role: 'status', hidden: true });
  host.prepend(bar);
  let first = null;
  let hiddenNow = false;
  let restarting = false;

  function show(text, actions, tone = 'info') {
    bar.className = `cs-fresh cs-fresh--${tone}`;
    bar.hidden = false;
    bar.replaceChildren(h('span', { class: 'cs-fresh__icon', 'aria-hidden': 'true' }, icon(tone === 'warn' ? 'warning' : 'download', 's')),
      h('span', { class: 'cs-fresh__text' }, text), h('span', { class: 'cs-grow' }), ...actions);
  }
  const hide = () => { bar.hidden = true; bar.replaceChildren(); };
  const btn = (label, fn, primary = false) => h('button', { class: ['cs-btn', 'cs-btn--small', primary ? 'cs-btn--primary' : 'cs-btn--quiet'], type: 'button', onclick: fn }, label);
  const laterBtn = () => btn('Later', () => { setLater(); hiddenNow = true; hide(); });

  async function restartNow(r) {
    if (r?.busy && !(await confirmDialog({ title: 'Restart Circle Studio now?', message: `${plural(r.busy, 'thing')} running or waiting for your answer will stop. Your projects and data are not touched.`, confirmLabel: 'Restart now', danger: true }))) return;
    restarting = true;
    show('Restarting Circle Studio with the newer version...', []);
    let res;
    try { res = await api.restartApp(); } catch (e) { restarting = false; show(`Could not restart: ${e.message}`, [laterBtn()], 'warn'); return; }
    if (!res.restarting) {
      restarting = false;
      show(res.reason || 'Circle Studio cannot restart itself here: close it and open it again.', [laterBtn()], 'warn');
      return;
    }
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      try { const c = await api.code(); if (c.code !== first.code && !c.stale) { location.reload(); return; } } catch { /* stopping and starting */ }
    }
    restarting = false;
    show('The restart is taking long. Close Circle Studio and open it again from the desktop.', [], 'warn');
  }

  async function check() {
    if (restarting) return;
    let r;
    try { r = await api.code(); } catch { return; } // restarting right now, or an older server without /api/code
    if (!first) { first = r; }
    if (r.code !== first.code && !r.stale) {
      // the server restarted into newer code: this window still runs the old screens
      if (!typing()) { location.reload(); return; }
      show('Circle Studio was updated. Reload this window when you are ready (finish what you are typing first).', [btn('Reload', () => location.reload(), true)]);
      return;
    }
    if (later() || hiddenNow) return;
    if (r.stale) {
      const when = r.autoRestart ? (r.busy ? ` It restarts by itself once ${plural(r.busy, 'thing')} running or waiting ${r.busy === 1 ? 'is' : 'are'} done.` : ' It restarts by itself in a minute.') : '';
      show(`A newer version of Circle Studio is on this PC.${when}`, [btn('Restart now', () => restartNow(r), true), laterBtn()]);
    } else if (r.ui !== first.ui) {
      show('Newer screens of Circle Studio are ready.', [btn('Reload', () => location.reload(), true), laterBtn()]);
    } else hide();
  }

  check();
  const timer = setInterval(() => { if (document.visibilityState === 'visible') check(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  return { check, stop: () => clearInterval(timer) };
}
