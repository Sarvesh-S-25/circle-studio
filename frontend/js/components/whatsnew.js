// "What's new": shown once after an update, and any time from Settings or the palette. Plain words: what changed and
// what you should do now, including which of your projects need a look.
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { pref, setPref, state, subscribe } from '../state.js';
import { openModal, toast } from './overlay.js';

/** Change this id when there is something new to tell. */
export const RELEASE = '1.3.2';

const CHANGES = [
  ['check', 'Recover after sleep and server crashes', 'Desktop polling stays responsive while requests wait and retains your tiles during temporary outages. Stalled browser connections reconnect and resync approvals. Shortcut launches supervise the background server and recover crashes; Stop keeps it stopped.'],
  ['terminal', 'Codex terminal approvals on the desktop', 'Settings can connect Codex PermissionRequest hooks, with a backup and support for existing hooks. Restart Codex and review and trust the hook through /hooks before it runs. If Circle is unavailable, Codex keeps its terminal approval prompt.'],
  ['terminal', 'Return from Terminal to the right conversation', 'Terminal receives the displayed saved conversation and reasoning choice. A pending Codex copy gets its own provider thread before opening; other saved chats stay selected. Failed sends preserve your message as a draft. Windows test notifications now wait for actual submission instead of only reporting that a helper started.'],
  ['chat', 'Codex notifications, including quick answers', 'Finished Circle chats keep an exact conversation link. Short Codex runs notify too, and a browser without notification permission permits Windows fallback. Settings has a test button that makes no model call. Terminal approvals need the separate Codex hook connection.'],
  ['chat', 'Pin a conversation and review a handoff', 'Each chat tile can pin its own saved conversation. Provider, model and reasoning follow your selection. Review handoff prepares an editable context summary and a new draft; it preserves the source and sends nothing until you choose.'],
  ['check', 'Keep review evidence and workflow versions', 'Task evidence keeps its kind and reference. Pin workflow versions, compare their changes, and load older completed request audit records. Supported team questions can be answered from a native card after reviewing the file change.'],
  ['folder', 'Less history reading and easier packaged updates', 'Large saved chats read only requested pages with bounded caches. Generated-file retention is configurable and backup downloads stream from disk. Runtime packages stage and verify updates before activation, with repair and data-preserving removal. Current builds are unsigned.'],
  ['chat', 'Codex conversations and account limits', 'Codex discovers available models, reads local thread history, and shows provider-specific limits. Saved Circle conversations survive New chat and support archive, paging and export. Engine approval policies are shown explicitly; real-account acceptance is tracked separately.'],
  ['check', 'Tasks with evidence and optional achievements', 'Tasks & progress separates activity from accepted work. Record review evidence, dependencies and outcomes. Local achievements are optional, exportable and resettable; spending tokens never earns one.'],
  ['folder', 'Storage, diagnostics and safer recovery', 'Settings opens memory and storage diagnostics, backup and isolated restore, and previewed cleanup of old generated files. Queued messages preserve their target, and interrupted partial answers are recovered without automatically replaying work.'],
  ['chat', 'The bar: a real terminal, once not twice, and your limits',
    'In the bar (Ctrl+Alt+C), Terminal now always opens a real terminal with that chat (it brought up the editor before). Your message shows once while Claude answers. A Plan limits panel shows the 5 hours and the week, and the bar\'s line says them too.'],
  ['check', 'Answer Claude Code in your terminal from the desktop',
    'When Claude Code works in a terminal or an editor and needs your OK, the card on your desktop asks instead: Allow, Deny or your answer, and it goes on in the terminal. Turn it on in Settings, Desktop (it shows the change first), and press Try it. In the terminal on the card hands it back.'],
  ['terminal', 'Terminal: see where Claude is working',
    "Press Terminal in a project's Chat, in the bar (or type /terminal), or on a notification: the terminal or editor window where Claude Code works on that folder comes to the front. If none is open, a new terminal opens there and carries the conversation on. The notifications also have Folder, which opens the project folder in File Explorer."],
  ['chat', 'Ctrl+Alt+C is a chat bar',
    "Press Ctrl+Alt+C and just type: everything goes to Claude in the project shown, even \"hi\". Start with / for a command, answered right under the box: /usage, /status, /project name, /model sonnet, /help. The button with Claude's name switches to another ready AI tool, a line shows the folder it works in and what it is doing, and Claude's questions and approvals pop up as cards on top of the bar."],
  ['chat', 'Answer Claude\'s questions on the desktop card',
    "When Claude asks you to choose, the card at the bottom right now takes every kind of question: one click for a single choice, ticks when you can pick several, two or more questions at once with Send answers, your own words in the box, or Skip. The chat then says what was asked and what you answered. Also: Claude Code running in your terminal now opens the Chat from Home and Running now, and command answers stay put while the Chat follows your terminal."],
  ['chat', 'The Chat is Claude Code, in your window',
    "Chat now runs Claude Code as it is in your terminal: all its tools (subagents, web search, the to-do list, skills) and no extra instructions from Circle Studio; every command and change still asks you first. When Claude is working on the folder in your terminal or editor, the Chat shows it live; write to carry it on here. Type while Claude works and your message goes as soon as it finishes. /usage shows your 5-hour and weekly limits, /model sonnet switches the model, /status says where it works, /clear starts again, /resume lists earlier chats. Closing or reloading the window no longer stops an answer. Open chat (desktop, overlay) opens this Chat, and an answer that came while you were away is a short notification with Open chat. New Limits widget: your 5-hour and weekly use with reset times; turn on From your terminal too on the Widgets page to include your terminal sessions."],
  ['chat', 'See what is going on, wherever you are',
    "A message you send from the overlay or a desktop card now shows in the project's Chat as it happens (what you said, each step, the answer), and Waiting for you when it needs you. Type Circle Studio's commands right in the Chat with a slash: /waiting, /allow 1, /deny 1, /answer 1 yes, /stop, /new, /chats, /continue 2, /help (two slashes send the word to the agent). Open in editor opens the project in Antigravity IDE (or VS Code) at the file the agent worked on, with a page beside it that keeps itself up to date: working or waiting, what waits and the command that answers it, and the whole chat. An answer that came while no window was open waits for you as a card on the desktop, where you can reply. And if Circle Studio ever cannot start, it now says so in a message instead of doing nothing."],
];

export function openWhatsNew() {
  const todo = h('div', { class: 'cs-stack cs-stack--tight', 'aria-live': 'polite' }, h('div', { class: 'cs-loading' }, icon('spinner', 's'), 'Checking your projects...'));
  const body = h('div', { class: 'cs-stack' },
    h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'wn-do' }, h('h3', { class: 'cs-h3', id: 'wn-do' }, 'What to do now'), todo),
    h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'wn-new' }, h('h3', { class: 'cs-h3', id: 'wn-new' }, 'What changed'),
      h('ul', { class: 'cs-whatsnew' }, CHANGES.slice(0, 7).map(([ic, title, text]) => h('li', {}, h('span', { class: 'cs-whatsnew__icon' }, icon(ic, 'm')), h('div', {}, h('strong', {}, title), h('p', { class: 'cs-soft cs-small' }, text)))))),
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
