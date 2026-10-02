import { api } from '../api.js';
import { h, icon, statusPill } from '../dom.js';
import { applyTheme, pref, setPref, state, refreshEngines, refreshShell } from '../state.js';
import { openShortcuts } from '../components/palette.js';
import { openWhatsNew } from '../components/whatsnew.js';
import { toast, confirmDialog } from '../components/overlay.js';
import { alertsPermission, enableAlerts } from '../components/notify.js';
import { updateSection } from '../components/updates.js';

const YESNO = { relay: 'Asks you first, through the app', none: 'Not possible from here', unverified: 'Not proven yet' };

function engineCard(e, recheck) {
  const c = e.capabilities;
  const pill = !e.installed ? statusPill('danger', 'Not installed') : e.loggedIn === false ? statusPill('warn', 'Not signed in') : e.loggedIn === null ? statusPill('info', 'Sign-in unknown') : statusPill('ok', 'Signed in');
  return h('section', { class: 'cs-card cs-engine', 'aria-labelledby': `eng-${e.id}` },
    h('div', { class: 'cs-row cs-row--between' }, h('h3', { class: 'cs-h3', id: `eng-${e.id}` }, e.label), pill),
    e.version ? h('p', { class: 'cs-soft cs-small cs-mono' }, e.version) : null,
    e.detail ? h('p', { class: 'cs-soft cs-small' }, `Signed in (${e.detail}). No API key is used or stored.`) : null,
    !e.usable && e.loginHint ? h('p', { class: 'cs-soft' }, e.loginHint) : null,
    h('ul', { class: 'cs-engine__caps' },
      h('li', {}, `Commands and edits: ${c.shell === 'approvals' ? 'each one asks you first' : 'none, it answers and reads only'}`),
      h('li', {}, `Permission requests: ${YESNO[c.approvals]}`),
      h('li', {}, `Its questions to you: ${YESNO[c.questions]}`),
      h('li', {}, `Continues a conversation: ${c.resume ? 'yes' : 'no'}`),
      h('li', {}, `Skills folder: ${c.skillsDirs.length ? c.skillsDirs.join(', ') : 'unknown'}`),
      h('li', {}, `Reads project instructions from: ${c.instructionsFile || 'unknown'}`),
      h('li', {}, `Tested live on this PC: ${c.liveVerified ? 'yes' : 'no'}`)),
    ...e.notes.map((n) => h('p', { class: 'cs-soft cs-small' }, n)),
    h('div', {}, h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: recheck }, icon('refresh', 's'), 'Check again')));
}

export async function mount(el) {
  await refreshShell().catch(() => {});
  const hl = state.health || (await api.health());

  const radio = (name, value, label, current, onPick) => h('label', { class: 'cs-radio', dataset: { checked: String(current === value) } },
    h('input', { type: 'radio', name, value, checked: current === value || undefined, onchange: () => onPick(value) }), h('span', {}, label));

  const themeBox = h('div', { class: 'cs-radios', role: 'radiogroup', 'aria-label': 'Theme' });
  const densityBox = h('div', { class: 'cs-radios', role: 'radiogroup', 'aria-label': 'Density' });
  function drawPrefs() {
    const theme = pref('theme', 'system');
    const density = pref('density', 'comfortable');
    themeBox.replaceChildren(...[['system', 'Follow the system'], ['light', 'Light (Vellum)'], ['dark', 'Dark (Graphite)']].map(([v, l]) => radio('theme', v, l, theme, (x) => { setPref('theme', x); applyTheme(); drawPrefs(); })));
    densityBox.replaceChildren(...[['comfortable', 'Comfortable'], ['compact', 'Compact']].map(([v, l]) => radio('density', v, l, density, (x) => { setPref('density', x); applyTheme(); drawPrefs(); })));
  }
  drawPrefs();

  const engines = h('div', { class: 'cs-engines' });
  async function recheck() {
    try { await refreshEngines(true); drawEngines(); toast('Engines checked.', { kind: 'ok', ms: 2000 }); } catch (e) { toast(e.message, { kind: 'danger' }); }
  }
  function drawEngines() { engines.replaceChildren(...(state.engines.length ? state.engines.map((e) => engineCard(e, recheck)) : [h('p', { class: 'cs-soft' }, 'Checking the engines...')])); }
  drawEngines();
  refreshEngines(true).then(drawEngines).catch(() => {}); // a fresh look, without holding the page up (it asks every engine)

  /* ---- desktop: alerts, start at login, shortcuts ---------------------------------------------------- */
  const desk = h('div', { class: 'cs-stack' }, h('p', { class: 'cs-soft' }, 'Loading...'));
  const sw = (label, checked, on, hint) => h('div', { class: 'cs-stack cs-stack--tight' }, h('label', { class: 'cs-switch' }, h('input', { class: 'cs-switch__input', type: 'checkbox', checked: checked || undefined, onchange: (e) => on(e.target.checked, e.target) }), h('span', { class: 'cs-switch__track' }), h('span', {}, label)), hint ? h('span', { class: 'cs-soft cs-small' }, hint) : null);
  async function drawDesktop() {
    let s;
    try { s = await api.settings(); } catch (e) { desk.replaceChildren(h('p', { class: 'cs-soft' }, e.message)); return; }
    const perm = alertsPermission();
    const sc = s.desktop.shortcuts;
    const permNote = perm === 'granted' ? 'Windows notifications are allowed for this window.' : perm === 'denied' ? 'This window is blocked from showing notifications: allow them in the site settings (the lock icon by the address).' : perm === 'unsupported' ? 'This browser cannot show notifications.' : 'Turning this on asks Windows for permission once.';
    const pinBtn = (where, label) => h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: async () => {
      try { await api.shortcut({ where, remove: Boolean(sc?.[where]) }); toast(sc?.[where] ? `Removed from ${label}.` : `Added to ${label}.`, { kind: 'ok' }); drawDesktop(); } catch (e) { toast(e.message, { kind: 'danger' }); }
    } }, icon(sc?.[where] ? 'unlock' : 'pin', 's'), sc?.[where] ? `Remove from ${label}` : `Add to ${label}`);
    desk.replaceChildren(
      sw('Tell me when an agent or my team asks something', s.settings.desktopAlerts !== false, async (on, box) => {
        setPref('desktopAlerts', on);
        await api.saveSettings({ desktopAlerts: on });
        if (on) { const p = await enableAlerts(); if (p === 'denied') { toast('Notifications are blocked for this window. Allow them in the site settings.', { kind: 'warn' }); } }
        drawDesktop();
      }, `A Windows notification when this window is in the background, and when no Circle Studio window is open at all. ${permNote}`),
      sc ? sw('Start Circle Studio when I sign in to Windows', sc.startup, async (on) => {
        try { await api.shortcut({ where: 'startup', remove: !on }); toast(on ? 'Circle Studio starts at sign-in, in the background (no window).' : 'It no longer starts at sign-in.', { kind: 'ok' }); } catch (e) { toast(e.message, { kind: 'danger' }); }
        drawDesktop();
      }, 'Starts quietly in the background, so the alerts above reach you even before you open the app.') : null,
      sc ? widgetRow(s, sc) : null,
      sc ? h('div', { class: 'cs-stack cs-stack--tight' }, h('strong', {}, 'Shortcuts to the app'), h('div', { class: 'cs-row cs-row--wrap' }, pinBtn('desktop', 'the Desktop'), pinBtn('startmenu', 'the Start menu'))) : null);
  }

  // The native desktop widgets: real tiles on the desktop, not windows or shortcuts.
  function widgetRow(s, sc) {
    const row = h('div', { class: 'cs-stack cs-stack--tight' }, h('strong', {}, 'Desktop widgets'), h('span', { class: 'cs-soft cs-small' }, 'Checking...'));
    api.desktopWidgets('status').then((st) => {
      const toggle = async (on) => {
        try {
          await api.desktopWidgets(on ? 'start' : 'stop');
          if (sc.startup) await api.shortcut({ where: 'startup' }); // the sign-in shortcut brings them back too
          toast(on ? 'Your widgets are on the desktop. Drag one to move it; right-click for options.' : 'The widgets are off the desktop.', { kind: 'ok' });
        } catch (e) { toast(e.message, { kind: 'danger' }); }
        drawDesktop();
      };
      row.replaceChildren(h('strong', {}, 'Desktop widgets'),
        h('span', { class: 'cs-soft cs-small' }, 'Rounded tiles that sit on your desktop, like phone and Mac widgets: rings for every agent (green working, amber waiting for you, blue done, grey idle), spending by provider, a workflow, what waits for you. Drag one to move it, click it to open Circle Studio there, right-click to keep them above windows or close them. They come back whenever Circle Studio runs.'),
        h('div', { class: 'cs-row cs-row--wrap' },
          st.running ? h('span', { class: 'cs-pill cs-pill--ok' }, icon('check', 's'), 'On the desktop') : null,
          h('button', { class: `cs-btn cs-btn--small ${st.running ? '' : 'cs-btn--primary'}`, type: 'button', onclick: () => toggle(!st.running) }, icon(st.running ? 'close' : 'pin', 's'), st.running ? 'Take them off the desktop' : 'Show widgets on the desktop'),
          h('a', { class: 'cs-btn cs-btn--small', href: '#/widgets' }, icon('edit', 's'), 'Choose widgets')));
    }).catch(() => row.replaceChildren(h('strong', {}, 'Desktop widgets'), h('span', { class: 'cs-soft cs-small' }, 'Not available here.')));
    return row;
  }
  drawDesktop();

  const row = (label, value) => h('tr', {}, h('th', { scope: 'row' }, label), h('td', {}, value));
  el.append(h('div', { class: 'cs-stack cs-stack--loose cs-settings' },
    h('h1', { class: 'cs-h1', id: 'main-title' }, 'Settings'),
    h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 's-look' }, h('h2', { class: 'cs-h2', id: 's-look' }, 'Look'), themeBox, densityBox,
      h('p', { class: 'cs-soft cs-small' }, 'Kept in this browser only.')),
    h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 's-desk' }, h('h2', { class: 'cs-h2', id: 's-desk' }, 'Desktop'), desk),
    h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 's-upd' }, h('h2', { class: 'cs-h2', id: 's-upd' }, 'Updates'), updateSection()),
    h('section', { class: 'cs-stack', 'aria-labelledby': 's-eng' }, h('div', { class: 'cs-row cs-row--between' }, h('h2', { class: 'cs-h2', id: 's-eng' }, 'Engines'), h('button', { class: 'cs-btn', type: 'button', onclick: recheck }, icon('refresh', 's'), 'Check all again')),
      h('p', { class: 'cs-soft' }, 'The AI tools Circle Studio can drive, each through your own sign-in in a terminal. No API key is used or stored.'), engines),
    h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 's-where' }, h('h2', { class: 'cs-h2', id: 's-where' }, 'Where things live'),
      h('table', { class: 'cs-table' }, h('tbody', {},
        row('Address', h('code', {}, `http://127.0.0.1:${hl.port}`)),
        row('Data folder (templates, library, chats, Inbox)', h('code', {}, hl.dataDir)),
        row('New projects go in', h('code', {}, hl.projectsRoot)),
        row('GitHub', hl.github.token ? 'Using GITHUB_TOKEN from the environment (never stored)' : 'Unauthenticated: 60 requests per hour')))),
    h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 's-priv' }, h('h2', { class: 'cs-h2', id: 's-priv' }, 'What leaves this PC'),
      h('ul', { class: 'cs-prose' }, h('li', {}, 'What you send in a chat, the Advisor or a node chat, through the engine you picked (its own CLI, its own sign-in).'), h('li', {}, 'Whatever that engine itself does with your project files, which you approve step by step.'), h('li', {}, 'Reads from github.com when you paste a repository URL, and the Actions and pull requests of a project you turn GitHub on for.'), h('li', {}, 'A page you index in the Catalog (fetched once), and a connection test to a remote MCP server when you press Check on Connections.'), h('li', {}, 'Never: your connector keys. They stay in the vault on this PC, encrypted for your Windows account.')),
      h('button', { class: 'cs-btn', type: 'button', onclick: openShortcuts }, icon('keyboard', 's'), 'Keyboard shortcuts'),
      h('button', { class: 'cs-btn', type: 'button', onclick: openWhatsNew }, icon('sparkle', 's'), "What's new"))));
  return {};
}
