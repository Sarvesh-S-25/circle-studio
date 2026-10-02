// "What's new": shown once after an update, and any time from Settings or the palette. Plain words: what changed and
// what you should do now, including which of your projects need a look.
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { pref, setPref, state, subscribe } from '../state.js';
import { openModal, toast } from './overlay.js';

/** Change this id when there is something new to tell. */
export const RELEASE = '2026-10-02-chat-widget';

const CHANGES = [
  ['chat', 'A Chat widget, and widgets you can switch and lock',
    'Widgets, Edit tiles, Add, Chat (medium or large): a project\'s main chat and its agents\' chats; tap one to read it, tap the title to open it and reply. Every project tile switches project from its title (on the desktop, click the name with the arrow, or right-click). Lock in place (right-click, or the Widgets page) keeps the tiles where they are. Desktop widgets started before an update now restart on their own, so a tap reuses your Circle Studio window instead of opening another.'],
  ['sparkle', "Let's begin, for people new to it",
    "The first time, Circle Studio asks which AI tools you use (Claude Code, Codex, Gemini, Copilot), shows which are ready, and gives the exact install and sign-in steps, with a button that runs them in a terminal. Sign in to GitHub there too (optional; Circle Studio never sees your token). Open it any time from the AI tools line at the bottom of the menu."],
  ['key', 'Keys in the menu, tools in each project',
    'Keys (where Connections was): paste an API key once. Each project has a Connections tab: the tools its agents can use, including what your Claude Code plugins bring, whether each works, and buttons to give a key, add a tool or remove one. Adding something the project already has (for example from a plugin) is flagged before anything changes.'],
  ['skill', 'Skills found for you',
    'In the Workflow helper, "Find skills" works out what your agents lack, searches GitHub, and suggests a few skills with what each does and which agent it is for. Tick the ones you want: they go to your library and to their agents. Paste a GitHub link and it shows what is in it.'],
  ['widgets', 'One window, and Widgets in the menu',
    'Opening Circle Studio while it is already open brings that window to the front instead of opening another one; the same goes for the widget board and each project\'s widget, and for clicks on the desktop widgets. Widgets now has its own page in the menu, below Connections: choose and arrange your tiles there, and put them on the desktop or take them off.'],
  ['link', 'Connections fix themselves',
    'Connections, Manager: every connector grouped across your projects, with what is broken, copied over and over, set up for folders that are gone, or keeping a key in plain text, and a button that fixes each one. "Fix it for me" repeats a working setup; "Make it one shared server" replaces the copies; pasting a key saves it in your Windows environment so no file holds it. Every fix shows its steps first, backs up Claude Code\'s config, puts it back if a step fails, and tests the server afterwards. Circle Studio also checks every few hours and tells you when a connection breaks.'],
  ['pin', 'Real widgets on your desktop',
    'Settings, Desktop, "Show widgets on the desktop": rounded tiles that live on the desktop itself (not windows, not shortcuts): agent rings, spending, a workflow, what waits for you. Drag them anywhere; click to open Circle Studio there; right-click to keep them above windows or close them. In a project, Widget, "Put its agents and workflow on the desktop".'],
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
