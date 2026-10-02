// Ctrl+K: jump anywhere, run anything. Also the shortcut sheet (?).
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { state, applyTheme, currentTheme, setPref } from '../state.js';
import { openModal } from './overlay.js';
import { openNewProject } from './newproject.js';

const TABS = [['workflow', 'Workflow'], ['team', 'Team'], ['skills', 'Skills'], ['health', 'Health'], ['cost', 'Cost'], ['chat', 'Chat']];

export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  setPref('theme', next);
  applyTheme();
  return next;
}

function commands() {
  const list = [
    { label: 'Go to Home', icon: 'home', kbd: 'g h', run: () => { location.hash = '#/'; } },
    { label: 'Go to Library', icon: 'library', kbd: 'g l', run: () => { location.hash = '#/library'; } },
    { label: 'Go to Advisor', icon: 'advisor', kbd: 'g a', run: () => { location.hash = '#/advisor'; } },
    { label: 'Go to the Inbox', icon: 'board', kbd: 'g i', run: () => { location.hash = '#/inbox'; } },
    { label: 'Go to Keys (paste an API key for a tool)', icon: 'key', run: () => { location.hash = '#/keys'; } },
    { label: "Let's begin: set up Claude Code, Codex, Gemini or Copilot", icon: 'sparkle', run: () => { location.hash = '#/start'; } },
    { label: 'Every connection on this PC (manager, security check)', icon: 'link', run: () => { location.hash = '#/connections'; } },
    { label: 'Go to Settings', icon: 'settings', run: () => { location.hash = '#/settings'; } },
    { label: 'New project...', icon: 'plus', run: () => openNewProject() },
    { label: 'Import skills from GitHub...', icon: 'github', run: () => { location.hash = '#/import'; } },
    { label: 'New skill', icon: 'skill', run: () => { location.hash = '#/library/new'; } },
    { label: 'Switch light / dark', icon: 'contrast', run: () => toggleTheme() },
    { label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', run: () => openShortcuts() },
    { label: "What's new", icon: 'sparkle', run: () => import('./whatsnew.js').then((m) => m.openWhatsNew()) },
    { label: 'Go to Widgets (choose desktop widgets)', icon: 'widgets', run: () => { location.hash = '#/widgets'; } },
    { label: 'Open the widget board in its own window', icon: 'pin', run: () => api.openWindow('widget') },
    { label: 'Ask Circle: what to do next, how do I...', icon: 'sparkle', kbd: 'Ctrl J', run: () => import('./guide.js').then((m) => m.openGuide()) },
  ];
  for (const p of state.projects.filter((x) => x.exists)) {
    for (const [tab, name] of TABS) list.push({ label: `${p.name}: ${name}`, icon: tab === 'chat' ? 'chat' : tab === 'health' ? 'health' : tab === 'team' ? 'team' : tab === 'skills' ? 'skill' : tab === 'cost' ? 'cost' : 'plan', run: () => { location.hash = `#/projects/${p.id}/${tab}`; } });
  }
  for (const s of state.skills) list.push({ label: `Skill: ${s.name}`, icon: 'skill', run: () => { location.hash = `#/library/${s.name}`; } });
  return list;
}

const matches = (label, q) => {
  const l = label.toLowerCase();
  let at = 0;
  for (const ch of q) { at = l.indexOf(ch, at); if (at < 0) return false; at++; }
  return true;
};

export function openPalette() {
  const all = commands();
  let shown = all;
  let active = 0;
  const input = h('input', { class: 'cs-input cs-palette__input', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-label': 'Type a command', placeholder: 'Type a command, a project or a skill', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'cs-palette__list', id: 'palette-list', role: 'listbox' });
  const body = h('div', {}, input, list);
  const ctrl = openModal({ title: 'Command palette', body, bare: true, top: true, dismissable: true, initialFocus: 'input' });
  const draw = () => {
    list.replaceChildren(...(shown.length ? shown.slice(0, 40).map((c, i) => h('button', {
      class: 'cs-menu__item', role: 'option', type: 'button', id: `pal-${i}`, 'aria-selected': String(i === active), 'data-active': String(i === active),
      onclick: () => { ctrl.close(); setTimeout(c.run, 0); },
    }, icon(c.icon, 's'), h('span', { class: 'cs-grow' }, c.label), c.kbd ? h('kbd', {}, c.kbd) : null)) : [h('div', { class: 'cs-empty' }, 'Nothing matches.')]));
    input.setAttribute('aria-activedescendant', shown.length ? `pal-${active}` : '');
    list.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    shown = q ? all.filter((c) => matches(c.label, q)) : all;
    active = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(shown.length - 1, active + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(); }
    else if (e.key === 'Enter' && shown[active]) { e.preventDefault(); const c = shown[active]; ctrl.close(); setTimeout(c.run, 0); }
  });
  draw();
  return ctrl;
}

const SHORTCUTS = [
  ['Ctrl K', 'Command palette'],
  ['Ctrl J', 'Ask Circle: next steps and help'],
  ['Alt Shift Left / Right', 'Make the side panel wider or narrower (or drag its left edge)'],
  ['/', 'Focus "What do you want to create today?"'],
  ['?', 'This sheet'],
  ['Esc', 'Close the top overlay or menu'],
  ['g then h / l / a / i', 'Go to Home / Library / Advisor / Inbox'],
  ['g then p / c', 'Go to the current project\'s Workflow / Chat'],
  ['Alt 1 to 6', 'Project tabs: Workflow, Team, Skills, Health, Cost, Chat'],
  ['A / D', 'In an approval popup: Allow / Deny'],
  ['Graph: arrows, Enter, C, T, Delete', 'Jump to a neighbour, open, connect, tidy, remove'],
  ['Alt Up / Down', 'Move an engine up or down'],
  ['A', 'On a focused skill or agent: add it to a project'],
  ['Ctrl Enter', 'Send a chat message, save a skill, run the advisor'],
  ['Ctrl B', 'Show or hide the taskbar on a narrow window'],
  ['Arrow keys', 'Move between tabs, menu items and list rows'],
];

export function openShortcuts() {
  return openModal({
    title: 'Keyboard shortcuts',
    body: h('table', { class: 'cs-table' }, h('tbody', {}, SHORTCUTS.map(([k, d]) => h('tr', {}, h('td', {}, k.split(' ').map((p) => (['then', 'to', '/'].includes(p) && k.includes('then') ? ` ${p} ` : h('kbd', {}, p)))), h('td', {}, d))))),
    actions: [{ label: 'Close', kind: 'primary', onClick: (c) => c.close(null) }],
  });
}
