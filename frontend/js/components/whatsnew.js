// "What's new": shown once after an update, and any time from Settings or the palette. Plain words: what changed and
// what you should do now, including which of your projects need a look.
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { pref, setPref, state, subscribe } from '../state.js';
import { openModal, toast } from './overlay.js';

/** Change this id when there is something new to tell. */
export const RELEASE = '2026-10-18-overlay';

const CHANGES = [
  ['pin', 'Ctrl+Alt+C now opens an overlay, like the Xbox Game Bar',
    'Press Ctrl+Alt+C anywhere: the screen dims, your desktop tiles come forward, and panels show what waits for you (with Allow and Deny), what runs, your workflow drawn small, the chat, this PC (processor, memory, the time), spending, git and notifications. Type in the box at the bottom: help lists everything. A sentence goes to the project\'s chat and the answer streams in; allow 1, deny 1 and answer 1 2 handle what waits; run planner write the plan gives one agent work; project, open inbox, chat, stop, pc, usage, git, mods and mod check do what they say. Drag a panel to move it. Esc or the same keys put it all back.'],
  ['pin', 'Work from your desktop: answer agents there, Ctrl+Alt+C, an activity ring',
    'When an agent wants to run something or has a question, a card now pops up at the bottom right of your screen with Allow and Deny (or the answers to pick): no need to open the Inbox. Press Ctrl+Alt+C anywhere to bring every Circle Studio tile in front of your windows, and again to put them back. New tiles: Activity (a ring per project that turns while it works and pulses amber while it waits for you) and Mods. Running now says where and since when, including Claude Code in a terminal. The Workflow tile counts stages done and names the one now; the Chat window shows whole messages, formatted. Settings, Desktop: "Ask me on the desktop".'],
  ['sparkle', 'Make your own mods, and check them',
    'Mods, Make your own: add a ready-made mod to a project (waiting-game, a tiny game while Claude works; turn-check, a line after each turn on how full the context is and whether tests ran after a change), or describe one and Claude builds it in the project, every file asked first. Check loads any mod the way Claude Code will and runs its tests. A project\'s rules (lanes, local only, you do git) now sit behind one line instead of six switches.'],
  ['sparkle', 'Mods, a new workflow graph, and chat from a widget',
    'Mods (in the menu, and a tab in each project): your Claude Code mods and plugins, sorted into For every project, Only this project and Off, with what each changes (chat look, prompt and context, tool checks, skills, tools...). Turn one on or off for one project (you see the change to .claude/settings.json first) or for every project. Workflow: stages are numbered on one line, agents hang off their stage, a hovered card lights up what it is linked to, Tidy glides into place, and a map in the corner moves you around a big team. The Chat widget now has a box to reply and shows which engine answers; on the desktop, click the Chat tile to open a small chat window. From a terminal: npm run mods, npm run chat. And after an update, Circle Studio restarts into the new version by itself once nothing is running (Settings, Updates), or a banner offers Restart now or Later.'],
  ['bell', 'Notifications, Running now, and small tiles',
    'Widgets, Edit tiles, Add: Notifications keeps what Circle Studio told you (an agent asking, a long run finished or failed, a team question, an update, a broken connection), even while a window was open; tap one to go there, or Mark all read. Running now shows what works right now in every project, and for how long. Every tile now also comes small. In Workflow, an agent\'s Helper has "Write only the helper files": it adds the Haiku helper without rewriting your agent files.'],
  ['library', 'Helpers on the graph, and Patterns to explore',
    'An agent\'s Haiku reader now shows beside it on the graph (dashed: it works inside that agent\'s turn). Choose "when it decides" or "automatically above" a context limit: then long command output, pages and searches are shortened by Haiku once its context is that full, with the full output kept in a file. Workflow, Patterns: ways to shape the team with when they pay off and when not, which fit your agents and why (from what each really used), and Try on an agent, unsaved, with Undo. The Cost tab shows what condensing saved.'],
  ['chat', 'A Chat widget, and widgets you can switch and lock',
    'Widgets, Edit tiles, Add, Chat (medium or large): a project\'s main chat and its agents\' chats; tap one to read it, tap the title to open it and reply. Every project tile switches project from its title (on the desktop, click the name with the arrow, or right-click). Lock in place (right-click, or the Widgets page) keeps the tiles where they are. Desktop widgets started before an update now restart on their own, so a tap reuses your Circle Studio window instead of opening another.'],
  ['sparkle', "Let's begin, for people new to it",
    "The first time, Circle Studio asks which AI tools you use (Claude Code, Codex, Gemini, Copilot), shows which are ready, and gives the exact install and sign-in steps, with a button that runs them in a terminal. Sign in to GitHub there too (optional; Circle Studio never sees your token). Open it any time from the AI tools line at the bottom of the menu."],
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
    // an older server does not report its code at all (newer code on disk is offered by the banner, freshness.js)
    if (s.health.code === undefined) {
      toast('Circle Studio was updated, but this window still talks to the old version. Close this window and open Circle Studio again from the desktop to finish.', { kind: 'warn', ms: 0 });
    }
  });
}
