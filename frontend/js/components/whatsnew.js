// "What's new": shown once after an update, and any time from Settings or the palette. Plain words: what changed and
// what you should do now, including which of your projects need a look.
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { pref, setPref, state, subscribe } from '../state.js';
import { openModal, toast } from './overlay.js';

/** Change this id when there is something new to tell. */
export const RELEASE = '2026-10-02-one-window';

const CHANGES = [
  ['widgets', 'One window, and Widgets in the menu',
    'Opening Circle Studio while it is already open brings that window to the front instead of opening another one; the same goes for the widget board and each project\'s widget, and for clicks on the desktop widgets. Widgets now has its own page in the menu, below Connections: choose and arrange your tiles there, and put them on the desktop or take them off.'],
  ['link', 'Connections fix themselves',
    'Connections, Manager: every connector grouped across your projects, with what is broken, copied over and over, set up for folders that are gone, or keeping a key in plain text, and a button that fixes each one. "Fix it for me" repeats a working setup; "Make it one shared server" replaces the copies; pasting a key saves it in your Windows environment so no file holds it. Every fix shows its steps first, backs up Claude Code\'s config, puts it back if a step fails, and tests the server afterwards. Circle Studio also checks every few hours and tells you when a connection breaks.'],
  ['pin', 'Real widgets on your desktop',
    'Settings, Desktop, "Show widgets on the desktop": rounded tiles that live on the desktop itself (not windows, not shortcuts): agent rings, spending, a workflow, what waits for you. Drag them anywhere; click to open Circle Studio there; right-click to keep them above windows or close them. In a project, Widget, "Put its agents and workflow on the desktop".'],
  ['link', 'Broken connections get fixed',
    'On Connections, Test starts a server the way an engine would and says why it fails in plain words, with commands to copy. When the same server works in another project, it gives you the exact commands to repeat that setup. "Ask Claude to fix it" reads the error and the code and proposes a config fix (applied through the usual review) and advice for the code.'],
  ['pin', 'Desktop widgets you choose',
    'Settings, Desktop, Widget board (or Ctrl+K "Open the widget board"): rings for every agent (green working, amber waiting for you, blue done, grey idle), spending by provider, a workflow tile you can switch between projects, what waits for you. Press Edit to add, resize or reorder; each tile can open in its own small window.'],
  ['link', 'Connections and a key vault',
    'The new Connections page lists every MCP server each engine uses, checks that it works, and flags keys written in plain text, unpinned downloads, risky agent settings and passwords in git remotes. The key vault keeps connector keys encrypted for your Windows account and gives them only to the projects you allow.'],
  ['sparkle', 'The workflow helper reads your project',
    'It now reads the folder (stack, size, docs, tests, existing agents), the building blocks you already have (Library, Catalog) and the pages you indexed, and recommends from those. Describe with Haiku writes one-line descriptions for the catalog.'],
];

export function openWhatsNew() {
  const todo = h('div', { class: 'cs-stack cs-stack--tight', 'aria-live': 'polite' }, h('div', { class: 'cs-loading' }, icon('spinner', 's'), 'Checking your projects...'));
  const body = h('div', { class: 'cs-stack' },
    h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'wn-do' }, h('h3', { class: 'cs-h3', id: 'wn-do' }, 'What to do now'), todo),
    h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'wn-new' }, h('h3', { class: 'cs-h3', id: 'wn-new' }, 'What changed'),
      h('ul', { class: 'cs-whatsnew' }, CHANGES.map(([ic, title, text]) => h('li', {}, h('span', { class: 'cs-whatsnew__icon' }, icon(ic, 'm')), h('div', {}, h('strong', {}, title), h('p', { class: 'cs-soft cs-small' }, text)))))),
    h('p', { class: 'cs-soft cs-small' }, 'Nothing in your projects changes by itself: files are only written after you review them. You can open this again from Settings.'));
  const ctrl = openModal({ title: 'What\'s new in Circle Studio', size: 'wide', body, actions: [{ label: 'Got it', kind: 'primary', onClick: (c) => c.close(null) }] });
  setPref('seen-release', RELEASE);
  findWork(todo, ctrl);
  return ctrl;
}

/** Which projects need something from the human after this update. */
async function findWork(todo, ctrl) {
  const items = [];
  for (const p of state.projects.filter((x) => x.exists)) {
    try {
      const wf = await api.workflow(p.id);
      const agents = wf.workflow.nodes.filter((n) => n.kind === 'agent').length;
      if (wf.autoTemplate) {
        items.push({ p, text: `Shows the "${wf.autoTemplate.templateName}" template, not its own agents. Open it and press "Use the agents in this folder" (or "Start blank").` });
      } else if (!wf.workflow.nodes.some((n) => n.kind === 'stage')) {
        items.push({ p, text: 'Has no workflow yet. Open it and ask the Workflow helper, or pick a template.' });
      } else if (wf.origin === 'agents' && wf.versions.length === 1 && agents) {
        items.push({ p, text: `Its ${agents} agents are in one stage. Arrange them into stages with checkpoints, or ask the Workflow helper.` });
      }
    } catch { /* a project that cannot be read is shown in its own Health tab */ }
  }
  const go = (p) => { ctrl.close(null); location.hash = `#/projects/${p.id}/workflow`; };
  todo.replaceChildren(...(items.length
    ? items.map(({ p, text }) => h('div', { class: 'cs-card cs-row cs-row--wrap' }, h('div', { class: 'cs-grow' }, h('strong', {}, p.name), h('p', { class: 'cs-soft cs-small' }, text)),
      h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => go(p) }, 'Open')))
    : [h('p', {}, state.projects.length ? 'Nothing: your projects are fine as they are.' : 'Nothing yet. Choose a folder on the Home page to start.')]));
}

/** At start: show "What's new" once per release, and warn when the server still runs older code. */
export function checkForNews() {
  if (pref('seen-release', '') !== RELEASE) openWhatsNew();
  let warned = false;
  const off = subscribe((s) => {
    if (warned || !s.health) return;
    warned = true;
    off();
    // an older server does not report its code at all; a current one says whether newer code is on disk
    if (s.health.stale === true || s.health.code === undefined) {
      toast('Circle Studio was updated, but this window still talks to the old version. Close this window and open Circle Studio again from the desktop to finish.', { kind: 'warn', ms: 0 });
    }
  });
}
