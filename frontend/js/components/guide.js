// "Ask Circle" (Ctrl+J): a drawer with what to do next (worked out here, no AI) and a question box. Built-in help
// answers with no engine at all; a question can also go to any engine you are signed in to, read-only.
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { pref, setPref, state, subscribe } from '../state.js';
import { openRequest } from './requests.js';
import { alertsOn, alertsPermission, enableAlerts } from './notify.js';
import { openGitPanel } from './gitpanel.js';

let open = null;
const STARTERS = ['How do I link agents in the graph?', 'Why is my project expensive?', 'Where do I answer my agents?', 'How do I put a project on my desktop?'];
const currentProjectId = () => /^#\/projects\/([^/]+)/.exec(location.hash)?.[1] || null;

/** Things worth doing now, from what the app already knows. */
function nextSteps() {
  const steps = [];
  const go = (hash) => () => { location.hash = hash; closeGuide(); };
  if (state.pending.length) steps.push({ icon: 'warning', tone: 'warn', title: `${state.pending.length} ${state.pending.length === 1 ? 'request waits' : 'requests wait'} for you`, text: state.pending[0].title, action: 'Answer', run: () => { closeGuide(); openRequest(state.pending[0].id); } });
  if (state.alerts.length) steps.push({ icon: 'board', tone: 'warn', title: `${state.alerts.length} team ${state.alerts.length === 1 ? 'question' : 'questions'}`, text: state.alerts[0].title || '', action: 'Inbox', run: go('#/inbox') });
  if (!state.projects.length) steps.push({ icon: 'folder', tone: 'info', title: 'Start with a folder', text: 'Open a project folder, or describe a new one.', action: 'Home', run: go('#/') });
  if (state.engines.length && !state.engines.some((e) => e.usable)) steps.push({ icon: 'key', tone: 'warn', title: 'No engine is signed in', text: 'Sign in to Claude Code, Codex, Gemini or Copilot in a terminal.', action: 'Settings', run: go('#/settings') });
  if (state.update?.available) steps.push({ icon: 'download', tone: 'info', title: 'A newer Circle Studio is ready', text: state.update.canUpdate ? 'Update and restart from Settings.' : state.update.reason, action: 'Settings', run: go('#/settings') });
  if (alertsOn() && alertsPermission() === 'default') steps.push({ icon: 'warning', tone: 'info', title: 'Let Circle Studio tell you when agents ask', text: 'One click; Windows asks once.', action: 'Turn on', run: async () => { await enableAlerts(); draw(); } });
  for (const a of state.attention.slice(0, 3)) {
    const top = a.items.find((i) => i.severity === 'danger') || a.items[0];
    if (top) steps.push({ icon: top.severity === 'danger' ? 'danger' : 'warning', tone: top.severity === 'danger' ? 'danger' : 'warn', title: `${a.name}: ${top.title}`, text: a.items.length > 1 ? `and ${a.items.length - 1} more` : 'See Health for what to do.', action: 'Health', run: go(`#/projects/${a.projectId}/health`) });
  }
  return steps;
}

function topicAction(t) {
  const pid = currentProjectId() || state.recent[0]?.id;
  if (t.href.startsWith('#/')) return () => { location.hash = t.href; closeGuide(); };
  if (!pid) return () => { location.hash = '#/'; closeGuide(); };
  if (t.href === 'git') return () => { const p = state.projects.find((x) => x.id === pid); closeGuide(); if (p) openGitPanel(p); };
  const tab = t.href === 'widget' ? 'workflow' : t.href;
  return () => { location.hash = `#/projects/${pid}/${tab}`; closeGuide(); };
}

let body = null;
let answer = null;
let unsub = null;

function draw() {
  if (!body) return;
  const steps = nextSteps();
  body.querySelector('.cs-guide__steps')?.replaceChildren(...(steps.length
    ? steps.map((s) => h('li', { class: `cs-guide__step cs-guide__step--${s.tone}` }, icon(s.icon, 's'), h('div', { class: 'cs-grow' }, h('strong', {}, s.title), s.text ? h('p', { class: 'cs-soft cs-small' }, s.text) : null), h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: s.run }, s.action)))
    : [h('li', { class: 'cs-soft' }, 'Nothing needs you right now.')]));
}

async function ask(text, engineSel, input, askBtn) {
  const q = (text ?? input.value).trim();
  if (!q) return;
  input.value = q;
  askBtn.disabled = true;
  const engine = engineSel.value;
  setPref('guide-engine', engine);
  answer.replaceChildren(h('div', { class: 'cs-loading' }, icon('spinner', 's'), engine === 'none' ? 'Searching the help...' : 'Thinking...'));
  let r;
  try { r = await api.guide(q, engine || undefined); } catch (e) { answer.replaceChildren(h('p', { class: 'cs-soft' }, e.message)); askBtn.disabled = false; return; }
  askBtn.disabled = false;
  answer.replaceChildren(
    r.reply ? h('div', { class: 'cs-guide__reply' }, h('div', { class: 'cs-eyebrow' }, `${r.engine.label} says`), renderMarkdown(r.reply)) : null,
    r.error ? h('p', { class: 'cs-soft cs-small' }, r.error) : null,
    r.note ? h('p', { class: 'cs-soft cs-small' }, r.note) : null,
    r.topics.length ? h('div', { class: 'cs-stack cs-stack--tight' }, h('div', { class: 'cs-eyebrow' }, r.reply ? 'Related help' : 'From the help'),
      ...r.topics.map((t) => h('div', { class: 'cs-guide__topic' }, h('strong', {}, t.title), h('p', { class: 'cs-small' }, t.text), h('div', {}, h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: topicAction(t) }, icon('chevron-right', 's'), 'Take me there')))))
      : !r.reply ? h('p', { class: 'cs-soft' }, 'No help topic matches. Try other words, or pick an engine to ask.') : null);
}

export function openGuide() {
  if (open) { open.querySelector('textarea')?.focus(); return; }
  const usable = state.engines.filter((e) => e.usable);
  const saved = pref('guide-engine', '');
  const engineSel = h('select', { class: 'cs-select cs-select--small', 'aria-label': 'Who answers' },
    usable.map((e) => h('option', { value: e.id, selected: saved === e.id || undefined }, e.label)),
    h('option', { value: 'none', selected: saved === 'none' || !usable.length || undefined }, 'Built-in help only (no AI)'));
  const input = h('textarea', { class: 'cs-textarea', rows: 2, placeholder: 'Ask anything about Circle Studio or what to do next', 'aria-label': 'Your question' });
  const askBtn = h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: () => ask(null, engineSel, input, askBtn) }, icon('send', 's'), 'Ask');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(null, engineSel, input, askBtn); } });
  answer = h('div', { class: 'cs-stack', 'aria-live': 'polite' }, h('div', { class: 'cs-row cs-row--wrap' }, STARTERS.map((s) => h('button', { class: 'cs-chip', type: 'button', onclick: () => ask(s, engineSel, input, askBtn) }, s))));
  body = h('div', { class: 'cs-guide__body' },
    h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'guide-next' }, h('h3', { class: 'cs-eyebrow', id: 'guide-next' }, 'Next steps'), h('ul', { class: 'cs-guide__steps' })),
    h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'guide-ask' }, h('h3', { class: 'cs-eyebrow', id: 'guide-ask' }, 'Ask'), input,
      h('div', { class: 'cs-row cs-row--wrap' }, engineSel, h('span', { class: 'cs-grow' }), askBtn),
      h('p', { class: 'cs-soft cs-small' }, 'An engine answers read-only, from a short summary of your projects (names and what needs you), never your files.')),
    answer);
  open = h('aside', { class: 'cs-guide', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'guide-title' },
    h('header', { class: 'cs-guide__head' }, h('span', { class: 'cs-guide__mark' }, icon('sparkle', 'm')), h('h2', { class: 'cs-h3 cs-grow', id: 'guide-title' }, 'Ask Circle'), h('kbd', { class: 'cs-small' }, 'Ctrl+J'),
      h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Close Ask Circle', onclick: closeGuide }, icon('close', 'm'))),
    body);
  open.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeGuide(); } });
  document.getElementById('overlays').append(open);
  draw();
  unsub = subscribe(draw);
  input.focus();
}

export function closeGuide() {
  unsub?.();
  unsub = null;
  open?.remove();
  open = null;
  body = null;
}

export const toggleGuide = () => (open ? closeGuide() : openGuide());
