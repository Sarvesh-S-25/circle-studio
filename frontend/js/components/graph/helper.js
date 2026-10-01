// The workflow helper beside the graph: Circle Studio's own agent. Ask it for the best workflow for this project;
// it answers and may propose a change, which you see as a list and apply to the graph. Nothing is saved until you
// save a version.
import { api } from '../../api.js';
import { h, icon } from '../../dom.js';
import { renderMarkdown } from '../../markdown.js';
import { state } from '../../state.js';
import { toast } from '../overlay.js';

const STARTERS = [
  'What is the best workflow for this project?',
  'Make it lighter: only what a small project needs',
  'Where should an engine check the work instead of me?',
  'Which agents do not need to ask other engines?',
];

/**
 * mountHelper(side, { project, getWorkflow, onApply(workflow), onClose }) -> { destroy }
 * The conversation lives as long as the Workflow tab is open (`memory` keeps it across open/close).
 */
export function mountHelper(side, { project, getWorkflow, onApply, onClose, memory }) {
  const msgs = memory.messages;
  const log = h('div', { class: 'cs-helper__log', role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { class: 'cs-textarea', id: 'helper-input', rows: 3, placeholder: 'Describe the project or ask for a change' });
  const send = h('button', { class: 'cs-btn cs-btn--primary', type: 'button' }, icon('send', 's'), 'Ask');
  let busy = false;
  const allowed = project.permissions?.claude === true;
  const claudeOk = state.engines.find((e) => e.id === 'claude')?.usable !== false;

  function proposalCard(m) {
    const applied = m.applied;
    return h('div', { class: 'cs-helper__proposal' },
      h('div', { class: 'cs-eyebrow' }, `Proposed change${m.changes.length === 1 ? '' : 's'} (${m.changes.length})`),
      h('ul', { class: 'cs-helper__changes' }, m.changes.slice(0, 30).map((c) => h('li', {}, c)), m.changes.length > 30 ? h('li', { class: 'cs-soft' }, `and ${m.changes.length - 30} more`) : null),
      m.warnings.length ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, m.warnings.join(' '))) : null,
      applied
        ? h('p', { class: 'cs-soft cs-small' }, icon('check', 's'), ' Applied to the graph. Press Save version to keep it.')
        : h('div', { class: 'cs-row' },
          h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button', onclick: () => { onApply(m.proposal); m.applied = true; draw(); toast('Applied to the graph. Nothing is saved until you save a version.', { kind: 'ok' }); } }, icon('check', 's'), 'Apply to the graph'),
          h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: () => { m.proposal = null; m.changes = []; draw(); } }, 'Dismiss')));
  }

  function draw() {
    log.replaceChildren();
    if (!msgs.length) {
      log.append(h('div', { class: 'cs-helper__intro' },
        h('p', {}, 'I design the workflow for this project: which stages, which agents on which engine, and where the work stops for you or for an engine to check it.'),
        h('div', { class: 'cs-helper__starters' }, STARTERS.map((t) => h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => ask(t) }, t)))));
    }
    for (const m of msgs) {
      if (m.role === 'you') { log.append(h('div', { class: 'cs-helper__msg cs-helper__msg--you' }, m.text)); continue; }
      log.append(h('div', { class: 'cs-helper__msg' }, m.error ? h('div', { class: 'cs-banner cs-banner--danger' }, icon('danger', 's'), h('span', {}, m.error)) : renderMarkdown(m.text),
        m.proposal ? proposalCard(m) : null,
        m.read ? h('details', { class: 'cs-details cs-small' }, h('summary', {}, `Read: the project folder${m.read.blocks.length ? `, ${m.read.blocks.length} building blocks` : ''}${m.read.passages.length ? `, ${m.read.passages.length} passages from links` : ''}`),
          m.read.blocks.length ? h('ul', { class: 'cs-helper__changes' }, m.read.blocks.map((b) => h('li', {}, b))) : null,
          m.read.passages.length ? h('p', { class: 'cs-soft' }, `From: ${m.read.passages.join(', ')}`) : null) : null,
        m.models?.length ? h('div', { class: 'cs-soft cs-small' }, `${m.models.join(', ')}${m.ms ? `, ${(m.ms / 1000).toFixed(0)} s` : ''}`) : null));
    }
    if (busy) log.append(h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Thinking about your workflow. This can take up to two minutes.'));
    log.scrollTop = log.scrollHeight;
  }

  async function ask(text) {
    const message = (text ?? input.value).trim();
    if (!message || busy) return;
    if (!allowed) { toast('Allow "send text to an engine" for this project first (Permissions).', { kind: 'warn' }); return; }
    const history = msgs.filter((m) => m.text && !m.error).map((m) => ({ role: m.role, text: m.text })).slice(-6);
    msgs.push({ role: 'you', text: message });
    input.value = '';
    busy = true;
    send.disabled = true;
    draw();
    try {
      const r = await api.suggestWorkflow(project.id, { message, workflow: getWorkflow(), history });
      msgs.push({ role: 'helper', text: r.reply, proposal: r.proposal, changes: r.changes || [], warnings: r.warnings || [], models: r.models, ms: r.ms, read: r.read });
    } catch (e) {
      msgs.push({ role: 'helper', text: '', error: e.message });
    } finally {
      busy = false;
      send.disabled = false;
      draw();
      input.focus();
    }
  }

  send.addEventListener('click', () => ask());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ask(); } });

  side.replaceChildren(h('aside', { class: 'cs-inspector cs-helper', 'aria-label': 'Workflow helper' },
    h('div', { class: 'cs-inspector__head' }, icon('sparkle', 'm'), h('h2', { class: 'cs-h3 cs-grow' }, 'Workflow helper'),
      msgs.length ? h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: () => { msgs.length = 0; draw(); } }, 'Clear') : null,
      h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Close the helper', onclick: onClose }, icon('close', 'm'))),
    !allowed ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('lock', 's'), h('span', {}, 'This project does not allow sending text to an engine. Turn it on under Permissions to use the helper.'))
      : !claudeOk ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, 'The helper runs on Claude, which is not signed in.')) : null,
    log,
    h('div', { class: 'cs-stack cs-stack--tight' }, h('label', { class: 'cs-sr', for: 'helper-input' }, 'Ask the workflow helper'), input,
      h('div', { class: 'cs-row' }, h('span', { class: 'cs-soft cs-small cs-grow' }, 'Sent to Claude through your login. Ctrl+Enter'), send))));
  draw();
  return { destroy() { side.replaceChildren(); }, ask };
}
