// Approvals and questions from agents, as popups. One event stream for the whole app keeps state.pending current;
// the oldest pending request opens a popup with the exact command, path or diff. Closing a popup ("Decide later")
// only hides it: the request stays in the Inbox and the badge until it is answered.
import { api } from '../api.js';
import { h, icon, timeAgo } from '../dom.js';
import { notify, state } from '../state.js';
import { openModal, toast } from './overlay.js';
import { comeForward, desktopAlert, setWaitingCount } from './notify.js';

let started = false;
const countWaiting = () => setWaitingCount(state.pending.length + state.alerts.filter((a) => a.open !== false).length);
let shown = null;
const snoozed = new Set();

const ENGINE = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot', team: 'Team' };
export const engineName = (id) => ENGINE[id] || id;
const projectName = (id) => state.projects.find((p) => p.id === id)?.name || id;
const announce = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));

/** `windowKey`: what this window shows ('app', 'board', 'widget:<id>', 'tile:<kind>:<size>[:<id>]'). */
export function initRequests(windowKey = '') {
  if (started) return;
  started = true;
  reload();
  window.addEventListener('circle:requests', countWaiting);
  window.addEventListener('circle:alerts', countWaiting);
  api.events((name, data) => {
    if (name === 'sync') {
      state.pending = data.requests || [];
      const ids = new Set(state.pending.map((r) => r.id));
      for (const id of snoozed) if (!ids.has(id)) snoozed.delete(id);
      if (shown && !ids.has(shown.id)) shown.ctrl.close('sent');
      notify(); announce('circle:requests', null); showNext();
    } else if (name === 'show') {
      // Circle Studio was opened again: this window comes forward (on the page asked for) instead of a second one
      if (typeof data.hash === 'string' && data.hash.startsWith('#/') && location.pathname === '/') location.hash = data.hash;
      comeForward(data.mark);
    } else if (name === 'request') {
      if (!state.pending.some((r) => r.id === data.id)) {
        state.pending.push(data);
        // the desktop card already asks, with its own Allow and Deny: no second notification from this window
        if (!data.carded) desktopAlert({ title: `${projectName(data.projectId)}: ${data.nodeId || engineName(data.engine)} ${data.kind === 'question' ? 'has a question' : 'asks to go ahead'}`, body: data.title || '', tag: data.id, onClick: () => openRequest(data.id) });
      }
      notify();
      announce('circle:requests', data);
      showNext();
    } else if (name === 'request-resolved') {
      state.pending = state.pending.filter((r) => r.id !== data.id);
      snoozed.delete(data.id);
      if (shown?.id === data.id) shown.ctrl.close(null);
      notify();
      announce('circle:requests', data);
      showNext();
    } else if (name === 'run' || name === 'usage') announce('circle:run', data);
    else if (name === 'progress') announce('circle:progress', data);
    else if (name === 'notice') {
      announce('circle:notice', data);
      if (['done', 'error', 'update', 'connection'].includes(data.kind) && data.notify !== false && !data.carded) desktopAlert({ title: data.title, body: data.body || '', tag: data.id, onClick: () => { location.hash = data.url || '#/inbox'; } });
    }
  }, windowKey);
}

async function reload() {
  try {
    state.pending = (await api.requests('pending')).requests.slice().reverse();
    notify();
    announce('circle:requests', null);
    showNext();
  } catch { /* the server may still be starting: the event stream will tell us */ }
}

function showNext() {
  if (shown) return;
  const next = state.pending.find((r) => !snoozed.has(r.id));
  if (next) show(next);
}

/** Open the popup for one request (used by the Inbox and by graph nodes that are waiting). */
export function openRequest(id) {
  const rec = state.pending.find((r) => r.id === id);
  if (!rec) return;
  snoozed.delete(id);
  if (shown && shown.id !== id) { const cur = shown; snoozed.add(cur.id); cur.ctrl.close(null); }
  if (!shown) show(rec);
}

function metaLine(rec) {
  // from Claude Code in a terminal or an editor: the folder it works in
  const where = rec.source === 'terminal' ? `${engineName(rec.engine)} in your terminal · ${rec.folder || rec.folderName}` : `${engineName(rec.engine)} · ${projectName(rec.projectId)}`;
  return h('p', { class: 'cs-soft cs-small' }, `${where}${rec.nodeId ? ` · ${rec.nodeId}` : ''} · ${timeAgo(rec.at)}`);
}

function riskBanner(rec) {
  if (rec.risk === 'outside-project') {
    return h('div', { class: 'cs-banner cs-banner--warn', role: 'alert' }, h('span', { class: 'cs-banner__icon' }, icon('warning', 's')),
      h('div', {}, h('strong', {}, 'This reaches outside the project folder.'), h('ul', { class: 'cs-prose' }, (rec.reasons || []).map((r) => h('li', {}, r)))));
  }
  return h('div', { class: 'cs-banner cs-banner--info' }, h('span', { class: 'cs-banner__icon' }, icon('shield', 's')), h('span', {}, `Runs in ${projectName(rec.projectId)}. Check the exact text below before you allow it.`));
}

// "Allow from now on": only the choices the server says fit this request (rec.remember)
export const REMEMBER = {
  run: 'Allow this kind of step for the rest of this run',
  edits: 'Always allow edits in this project (turn off in Permissions)',
  'reads-outside': 'Always allow reading files outside this project (turn off in Permissions)',
};

function rememberChoice(rec) {
  const opts = (rec.remember || []).filter((k) => REMEMBER[k]);
  if (!opts.length) return null;
  const name = `remember-${rec.id}`;
  const row = (value, label) => h('label', { class: 'cs-radio' }, h('input', { type: 'radio', name, value, checked: value === '' || undefined }), h('span', {}, label));
  const node = h('fieldset', { class: 'cs-field' }, h('legend', { class: 'cs-field__label' }, 'When you allow it'),
    h('div', { class: 'cs-stack cs-stack--tight' }, row('', 'Just this once'), opts.map((k) => row(k, REMEMBER[k]))));
  return { node, value: () => node.querySelector(`input[name="${name}"]:checked`)?.value || '' };
}

function questionForm(rec) {
  const fields = rec.questions.map((q, i) => {
    const name = `q${i}`;
    const type = q.multiSelect ? 'checkbox' : 'radio';
    const other = h('input', { class: 'cs-input', type: 'text', 'aria-label': `Something else for: ${q.question}`, placeholder: 'Something else' });
    const options = q.options.map((o, k) => h('label', { class: 'cs-radio' }, h('input', { type, name, value: o.label, checked: (!q.multiSelect && k === 0) || undefined }), h('span', {}, h('strong', {}, o.label), o.description ? h('span', { class: 'cs-soft' }, ` ${o.description}`) : null)));
    return { q, name, other, node: h('fieldset', { class: 'cs-field' }, h('legend', { class: 'cs-field__label' }, q.header ? `${q.header}: ${q.question}` : q.question), h('div', { class: 'cs-stack cs-stack--tight' }, options, other)) };
  });
  const collect = () => {
    const answers = {};
    for (const f of fields) {
      const typed = f.other.value.trim();
      const chosen = [...f.node.querySelectorAll(`input[name="${f.name}"]:checked`)].map((x) => x.value);
      answers[f.q.id || f.q.question] = f.q.multiSelect ? [...chosen, ...(typed ? [typed] : [])] : (typed || chosen[0] || '');
    }
    return answers;
  };
  return { el: h('div', { class: 'cs-stack' }, fields.map((f) => f.node)), collect };
}

function show(rec) {
  const isQuestion = rec.kind === 'question';
  let remember = null;
  const body = h('div', { class: 'cs-stack' }, metaLine(rec));
  let form = null;
  if (isQuestion) {
    form = questionForm(rec);
    body.append(form.el);
  } else {
    body.append(riskBanner(rec), h('div', { class: 'cs-cmd', tabindex: 0, role: 'region', 'aria-label': 'Exactly what the agent wants to do' }, rec.detail || rec.title));
    remember = rememberChoice(rec);
    if (remember) body.append(remember.node);
  }
  const more = state.pending.length - 1;
  if (more > 0) body.append(h('p', { class: 'cs-soft cs-small' }, `${more} more waiting for you.`));

  const send = async (ctrl, payload) => {
    ctrl.setBusy(true);
    try {
      await api.respond(rec.id, payload);
      ctrl.close('sent');
    } catch (e) {
      ctrl.setBusy(false);
      if (e.status === 409) { toast('That was already answered or the run ended.', { kind: 'info' }); ctrl.close(null); } else toast(e.message, { kind: 'danger' });
    }
  };
  // a terminal's request can also be answered there: the popup and the card go, Claude Code asks in the terminal
  const toTerminal = rec.source === 'terminal' ? [{ label: 'In the terminal', kind: 'quiet', onClick: async (c) => { try { await api.releaseToTerminal(rec.id); } catch { /* already answered */ } c.close('sent'); } }] : [];
  const actions = isQuestion
    ? [...toTerminal, { label: 'Decide later', kind: 'quiet', onClick: (c) => c.close(null) }, { label: 'Send answer', kind: 'primary', id: 'req-send', onClick: (c) => send(c, { decision: 'answer', answers: form.collect() }) }]
    : [...toTerminal, { label: 'Decide later', kind: 'quiet', onClick: (c) => c.close(null) }, { label: 'Deny', id: 'req-deny', onClick: (c) => send(c, { decision: 'deny' }) }, { label: 'Allow', kind: 'primary', id: 'req-allow', onClick: (c) => send(c, { decision: 'allow', ...(remember?.value() ? { remember: remember.value() } : {}) }) }];
  const ctrl = openModal({
    title: isQuestion ? (rec.questions[0]?.header || 'The agent has a question') : rec.title,
    body, actions, top: true, size: 'wide',
    onClose: (result) => { shown = null; if (result !== 'sent') snoozed.add(rec.id); setTimeout(showNext, 0); },
  });
  shown = { id: rec.id, ctrl };
  ctrl.el.addEventListener('keydown', (e) => {
    if (isQuestion || e.ctrlKey || e.metaKey || e.altKey || e.target.matches?.('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'a') { e.preventDefault(); ctrl.button('req-allow')?.click(); }
    else if (k === 'd') { e.preventDefault(); ctrl.button('req-deny')?.click(); }
  });
}
