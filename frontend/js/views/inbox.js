// The Inbox: every approval and question an agent raised. Waiting ones first, then the history, so you can find a
// request, check exactly what it was and what you answered, and remember what happened.
import { api } from '../api.js';
import { h, icon, plural, timeAgo } from '../dom.js';
import { state } from '../state.js';
import { engineName, openRequest } from '../components/requests.js';
import { reviewChanges } from '../components/diffreview.js';
import { loadAlerts } from '../components/alerts.js';
import { toast } from '../components/overlay.js';

const STATUS = {
  pending: ['warn', 'Waiting for you'], allowed: ['ok', 'Allowed'], denied: ['danger', 'Denied'], answered: ['ok', 'Answered'],
  expired: ['info', 'Expired'], 'auto-denied': ['danger', 'Refused by the app'],
};
const projectName = (id) => state.projects.find((p) => p.id === id)?.name || id;

// A question from a team's docs/tasks/ALERTS.md, shaped like an Inbox request so it sorts, filters and searches with them.
const alertRecord = (a) => ({
  id: `alert:${a.projectId}:${a.id}`, kind: 'alert', alert: a, projectId: a.projectId, nodeId: null, engine: 'team',
  status: a.open ? 'pending' : 'answered', title: `${a.id} · ${a.title || 'Question from the team'}`, detail: `${a.question || ''} ${a.options || ''}`,
  at: a.at || null, resolvedAt: null, runId: 'docs/tasks/ALERTS.md', answer: a.answer || undefined, reasons: [],
  // "Raised: 2026-09-30 by texter" has a date but no time: show that date, not a made-up "13 hours ago".
  atLabel: /\d{2}:\d{2}/.test(a.raised || '') ? null : /\d{4}-\d{2}-\d{2}/.exec(a.raised || '')?.[0] || null,
});

// An alert's "Options" is one free-text line. When it reads as "a (cost); b (cost)", offer each choice as a button
// that fills the answer box with its short form; anything else just shows the line and the human types.
const optionChoices = (text) => {
  const parts = String(text || '').split(';').map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.map((full) => ({ full, short: full.replace(/\s*[([].*$/, '').trim() || full })) : [];
};

export async function mount(el) {
  let all = [];
  const drafts = new Map(); // what was typed into each alert's answer box, kept across redraws
  const filters = { status: 'all', project: '', kind: '', q: '' };
  const list = h('div', { class: 'cs-stack cs-stack--tight', role: 'list' });
  const count = h('p', { class: 'cs-soft cs-small', role: 'status' });

  const sel = (label, key, options) => h('label', { class: 'cs-field' }, h('span', { class: 'cs-field__label' }, label),
    h('select', { class: 'cs-select', onchange: (e) => { filters[key] = e.target.value; draw(); } }, options.map(([v, l]) => h('option', { value: v, selected: filters[key] === v || undefined }, l))));
  const search = h('input', { class: 'cs-input', type: 'search', placeholder: 'Search commands, files and answers', 'aria-label': 'Search the Inbox', oninput: (e) => { filters.q = e.target.value.toLowerCase(); draw(); } });

  function matches(r) {
    if (filters.status === 'pending' && r.status !== 'pending') return false;
    if (filters.status === 'done' && r.status === 'pending') return false;
    if (filters.project && r.projectId !== filters.project) return false;
    if (filters.kind && r.kind !== filters.kind) return false;
    if (filters.q && !`${r.title} ${r.detail} ${JSON.stringify(r.answer || '')} ${r.note || ''}`.toLowerCase().includes(filters.q)) return false;
    return true;
  }

  // The team's question, its options, what waits on it, and (while open) a box to answer it. Answering shows the exact
  // change to docs/tasks/ALERTS.md first, like every write Circle Studio makes into a project.
  function alertBody(r) {
    const a = r.alert;
    const box = h('textarea', { class: 'cs-textarea', rows: 2, maxlength: 600, 'aria-label': `Your answer to ${a.id}`, placeholder: 'Type your answer. Pick one of the options above, or say something else.', oninput: (e) => drafts.set(r.id, e.target.value) });
    box.value = drafts.get(r.id) || '';
    const send = async () => {
      const text = box.value.trim();
      if (!text) { toast('Type an answer first.', { kind: 'warn' }); box.focus(); return; }
      const done = await reviewChanges({ projectId: a.projectId, ops: [{ op: 'alert-answer', id: a.id, answer: text }], title: `Answer ${a.id}`, applyLabel: 'Write answer' });
      if (!done) return;
      drafts.delete(r.id);
      await loadAlerts();
      await load();
    };
    return [
      h('p', {}, h('strong', {}, a.question || a.title)),
      a.options ? h('p', { class: 'cs-soft' }, `Options: ${a.options}`) : null,
      a.blocks ? h('p', { class: 'cs-soft cs-small' }, `Waiting on this: ${a.blocks}`) : null,
      a.answer ? h('p', {}, h('span', { class: 'cs-soft' }, 'Answer: '), a.answer) : null,
      a.open && optionChoices(a.options).length ? h('div', { class: 'cs-row cs-row--wrap', role: 'group', 'aria-label': 'Pick an option to start your answer' },
        optionChoices(a.options).map((c) => h('button', { class: 'cs-btn cs-btn--small', type: 'button', title: c.full, onclick: () => { box.value = c.short; drafts.set(r.id, c.short); box.focus(); } }, c.short))) : null,
      a.open ? h('label', { class: 'cs-field' }, h('span', { class: 'cs-field__label' }, 'Your answer'), box) : null,
      a.open ? h('div', { class: 'cs-row cs-row--wrap' },
        h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button', onclick: send }, 'Review and write answer'),
        h('span', { class: 'cs-soft cs-small' }, 'Goes into the project\'s docs/tasks/ALERTS.md after you review it. The team sees it the next time it reads that file.')) : null,
    ];
  }

  function row(r) {
    const [sev, word] = STATUS[r.status] || ['info', r.status];
    const when = r.atLabel ? `raised ${r.atLabel}` : r.at ? new Date(r.at).toLocaleString() : 'date not given';
    const body = h('div', { class: 'cs-stack cs-stack--tight cs-inbox__detail' },
      ...(r.kind === 'alert' ? alertBody(r) : [
        r.kind === 'question'
          ? h('div', {}, r.questions.map((q) => h('p', {}, h('strong', {}, q.question), r.answer ? h('span', { class: 'cs-soft' }, ` Your answer: ${r.answer[q.question] ?? ''}`) : null)))
          : h('div', { class: 'cs-cmd', tabindex: 0 }, r.detail || r.title),
      ]),
      r.reasons?.length ? h('ul', { class: 'cs-prose' }, r.reasons.map((x) => h('li', {}, x))) : null,
      r.note ? h('p', { class: 'cs-soft' }, `Note: ${r.note}`) : null,
      h('p', { class: 'cs-soft cs-small' }, `${when}${r.resolvedAt ? ` · resolved ${timeAgo(r.resolvedAt)}` : ''} · ${r.kind === 'alert' ? r.runId : `run ${r.runId}`}`),
      r.status === 'pending' && r.kind !== 'alert' ? h('div', {}, h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button', onclick: () => openRequest(r.id) }, 'Open the popup')) : null);
    return h('details', { class: 'cs-card cs-inbox__row', role: 'listitem', open: r.status === 'pending' || undefined },
      h('summary', { class: 'cs-row cs-row--wrap' },
        h('span', { class: `cs-pill cs-pill--${sev}` }, word),
        h('span', { class: 'cs-grow' }, h('strong', {}, r.title), h('span', { class: 'cs-soft cs-small' }, ` · ${projectName(r.projectId)}${r.nodeId ? ` · ${r.nodeId}` : ''} · ${engineName(r.engine)}`)),
        r.risk === 'outside-project' ? h('span', { class: 'cs-pill cs-pill--warn' }, 'outside the project') : null,
        h('span', { class: 'cs-soft cs-small' }, r.atLabel || (r.at ? timeAgo(r.at) : ''))),
      body);
  }

  function draw() {
    const shown = all.filter(matches);
    const waiting = all.filter((r) => r.status === 'pending').length;
    count.textContent = `${plural(shown.length, 'request')}${waiting ? `, ${waiting} waiting for you` : ''}.`;
    list.replaceChildren(...(shown.length ? shown.map(row) : [h('div', { class: 'cs-empty' }, icon('board', 'l'), h('div', { class: 'cs-empty__title' }, 'Nothing here'), h('p', {}, 'When an agent wants to run a command, change a file or ask you something, it shows up here and as a popup.'))]));
  }

  async function load() {
    try { all = (await api.requests('all')).requests; } catch (e) { list.replaceChildren(h('div', { class: 'cs-banner cs-banner--danger' }, e.message)); return; }
    // Team questions are read from files, so a failure here must not hide the agents' requests above.
    try { all = all.concat((await api.alerts('all')).alerts.map(alertRecord)); } catch { /* the request list is still right */ }
    all.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || String(b.at || '').localeCompare(String(a.at || '')));
    draw();
  }
  const onChange = () => load();
  window.addEventListener('circle:requests', onChange);
  window.addEventListener('circle:alerts', onChange);

  el.append(h('div', { class: 'cs-stack cs-stack--loose' },
    h('div', { class: 'cs-row cs-row--wrap cs-row--between' }, h('div', {}, h('h1', { class: 'cs-h1', id: 'main-title' }, 'Inbox'), h('p', { class: 'cs-soft' }, 'Everything the agents asked you, and what you decided.')), count),
    h('div', { class: 'cs-row cs-row--wrap' },
      sel('Show', 'status', [['all', 'Everything'], ['pending', 'Waiting for me'], ['done', 'Already decided']]),
      sel('Project', 'project', [['', 'All projects'], ...state.projects.map((p) => [p.id, p.name])]),
      sel('Kind', 'kind', [['', 'All kinds'], ['approval', 'Approvals'], ['question', 'Agent questions'], ['alert', 'Team questions']]),
      h('label', { class: 'cs-field cs-grow' }, h('span', { class: 'cs-field__label' }, 'Search'), search)),
    list));
  await load();
  return { destroy: () => { window.removeEventListener('circle:requests', onChange); window.removeEventListener('circle:alerts', onChange); } };
}
