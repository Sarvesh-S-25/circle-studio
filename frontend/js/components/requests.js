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
    if (name === 'show') {
      // Circle Studio was opened again: this window comes forward (on the page asked for) instead of a second one
      if (typeof data.hash === 'string' && data.hash.startsWith('#/') && location.pathname === '/') location.hash = data.hash;
      comeForward(data.mark);
    } else if (name === 'request') {
      if (!state.pending.some((r) => r.id === data.id)) {
        state.pending.push(data);
        desktopAlert({ title: `${projectName(data.projectId)}: ${data.nodeId || engineName(data.engine)} ${data.kind === 'question' ? 'has a question' : 'asks to go ahead'}`, body: data.title || '', tag: data.id, onClick: () => openRequest(data.id) });
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
  return h('p', { class: 'cs-soft cs-small' }, `${engineName(rec.engine)} · ${projectName(rec.projectId)}${rec.nodeId ? ` · ${rec.nodeId}` : ''} · ${timeAgo(rec.at)}`);
}

function riskBanner(rec) {
  if (rec.risk === 'outside-project') {
    return h('div', { class: 'cs-banner cs-banner--warn', role: 'alert' }, h('span', { class: 'cs-banner__icon' }, icon('warning', 's')),
      h('div', {}, h('strong', {}, 'This reaches outside the project folder.'), h('ul', { class: 'cs-prose' }, (rec.reasons || []).map((r) => h('li', {}, r)))));
  }
  return h('div', { class: 'cs-banner cs-banner--info' }, h('span', { class: 'cs-banner__icon' }, icon('shield', 's')), h('span', {}, `Runs in ${projectName(rec.projectId)}. Check the exact text below before you allow it.`));
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
      answers[f.q.question] = f.q.multiSelect ? [...chosen, ...(typed ? [typed] : [])] : (typed || chosen[0] || '');
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
    if (rec.risk === 'normal') {
      remember = h('input', { class: 'cs-switch__input', type: 'checkbox', id: 'req-remember' });
      body.append(h('label', { class: 'cs-switch', for: 'req-remember' }, remember, h('span', { class: 'cs-switch__track' }), h('span', {}, 'Allow the same kind of step for the rest of this run')));
    }
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
  const actions = isQuestion
    ? [{ label: 'Decide later', kind: 'quiet', onClick: (c) => c.close(null) }, { label: 'Send answer', kind: 'primary', id: 'req-send', onClick: (c) => send(c, { decision: 'answer', answers: form.collect() }) }]
    : [{ label: 'Decide later', kind: 'quiet', onClick: (c) => c.close(null) }, { label: 'Deny', id: 'req-deny', onClick: (c) => send(c, { decision: 'deny' }) }, { label: 'Allow', kind: 'primary', id: 'req-allow', onClick: (c) => send(c, { decision: 'allow', ...(remember?.checked ? { remember: 'run' } : {}) }) }];
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
