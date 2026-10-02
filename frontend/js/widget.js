// A project's widget: a small always-available window (pinned to the Desktop, the Start menu or the taskbar) that shows
// at a glance what runs, what waits for you, where the workflow is, git and GitHub, and the last conversation. Questions
// and approvals open right here and can be answered without the full app. /widget.html?p=<project id>
import { api } from './api.js';
import { h, icon, sigil, timeAgo, plural } from './dom.js';
import { applyTheme, notify, state } from './state.js';
import { initRequests, openRequest, engineName } from './components/requests.js';
import { initAlerts } from './components/alerts.js';
import { barSeries } from './components/charts.js';
import { mountBoard, mountSingleTile } from './components/board.js';

const id = new URLSearchParams(location.search).get('p') || '';
const root = document.getElementById('app');
const appUrl = (hash = '') => `/${hash}`;
const POLL_MS = 15_000;

applyTheme();
let pulse = null;
let loading = false;

/** Open the full app on a page, in its own app window. */
function openApp(hash) {
  api.openWindow('app', id, hash).catch(() => window.open(appUrl(hash), '_blank'));
}

const state_ = () => {
  if (!pulse) return { tone: 'quiet', word: 'Loading' };
  const waiting = pulse.pending.length + pulse.alerts.length;
  if (waiting) return { tone: 'warn', word: `${waiting} waiting for you` };
  if (pulse.live.runs.length) return { tone: 'ok', word: `${plural(pulse.live.runs.length, 'agent')} working` };
  if (pulse.stats.activity?.live) return { tone: 'ok', word: 'Team active' };
  return { tone: 'quiet', word: 'Quiet' };
};

function section(title, ...body) {
  return h('section', { class: 'cs-w__sec', 'aria-label': title }, h('h2', { class: 'cs-w__h' }, title), ...body);
}

function waitingSection() {
  const items = [
    ...pulse.pending.map((r) => h('li', {}, h('button', { class: 'cs-w__ask', type: 'button', onclick: () => openRequest(r.id) },
      icon(r.kind === 'question' ? 'chat' : r.risk === 'outside-project' ? 'warning' : 'shield', 's'),
      h('span', { class: 'cs-w__asktext' }, h('strong', {}, r.title), h('span', { class: 'cs-soft cs-small' }, `${r.nodeId || engineName(r.engine)} · ${timeAgo(r.at)}`)),
      h('span', { class: 'cs-w__go' }, r.kind === 'question' ? 'Answer' : 'Decide')))),
    ...pulse.alerts.map((a) => h('li', {}, h('button', { class: 'cs-w__ask', type: 'button', onclick: () => openApp('#/inbox') },
      icon('board', 's'), h('span', { class: 'cs-w__asktext' }, h('strong', {}, a.title || 'Your team has a question'), h('span', { class: 'cs-soft cs-small' }, 'Team question · docs/tasks/ALERTS.md')),
      h('span', { class: 'cs-w__go' }, 'Inbox')))),
  ];
  if (!items.length) return null;
  return h('section', { class: 'cs-w__sec cs-w__sec--needs', 'aria-label': 'Waiting for you' }, h('h2', { class: 'cs-w__h' }, icon('warning', 's'), 'Waiting for you'), h('ul', { class: 'cs-w__list' }, items));
}

function statStrip() {
  const st = pulse.stats;
  const tile = (n, label, hash) => h('button', { class: 'cs-w__tile', type: 'button', onclick: () => openApp(hash) }, h('span', { class: 'cs-w__num' }, String(n)), h('span', { class: 'cs-w__lab' }, label));
  const tiles = [tile(pulse.workflow?.agents ?? st.roles ?? 0, 'agents', `#/projects/${id}/workflow`)];
  if (st.board?.total) tiles.push(tile(`${st.board.done}/${st.board.total}`, 'tasks done', `#/projects/${id}/health`));
  if (st.adr?.proposed) tiles.push(tile(st.adr.proposed, st.adr.proposed === 1 ? 'decision to OK' : 'decisions to OK', `#/projects/${id}/health`));
  if (st.chat?.costUsd) tiles.push(tile(`$${st.chat.costUsd.toFixed(2)}`, 'spent here', `#/projects/${id}/chat`));
  return h('div', { class: 'cs-w__tiles' }, tiles);
}

function lookSection() {
  const items = (pulse.stats.attention || []).filter((a) => !/decision/i.test(a.title) || !pulse.stats.adr?.proposed);
  if (!items.length) return null;
  return section('Look at', h('ul', { class: 'cs-w__list' }, items.map((a) => h('li', {}, h('button', { class: 'cs-w__look', type: 'button', onclick: () => openApp(`#/projects/${id}/health`) },
    h('span', { class: `cs-pill cs-pill--${a.severity === 'danger' ? 'danger' : a.severity === 'warn' ? 'warn' : 'info'}` }, icon(a.severity === 'danger' ? 'danger' : 'warning', 's')), h('span', {}, a.title))))));
}

function nowSection() {
  const runs = pulse.live.runs;
  const act = pulse.stats.activity;
  if (!runs.length) {
    const last = act?.last;
    return section('Now', h('p', { class: 'cs-w__quiet' }, last ? `Last: ${last.agent} ${last.event || ''}${last.summary ? `, ${last.summary}` : ''} (${timeAgo(act.lastAt)})` : 'Nothing is running.'));
  }
  return section('Now', h('ul', { class: 'cs-w__list' }, runs.map((r) => h('li', { class: 'cs-w__run' },
    h('span', { class: `cs-w__dot cs-w__dot--${r.status === 'waiting' ? 'warn' : 'ok'}`, 'aria-hidden': 'true' }),
    h('span', { class: 'cs-w__runname' }, h('strong', {}, r.nodeId || 'Main session'), h('span', { class: 'cs-soft cs-small' }, `${engineName(r.engine)}${r.model ? ` · ${r.model}` : ''} · ${r.status === 'waiting' ? 'waiting for you' : 'working'}`)),
    r.contextPct != null ? h('span', { class: 'cs-w__ctx', title: 'How full its context is', style: { '--pct': `${r.contextPct}%` } }, `${r.contextPct}%`) : null))));
}

function workflowSection() {
  const wf = pulse.workflow;
  if (!wf || !wf.stages.length) return section('Workflow', h('p', { class: 'cs-w__quiet' }, 'No workflow yet. ', h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', onclick: () => openApp(`#/projects/${id}/workflow`) }, 'Set one up')));
  return section(`Workflow · v${wf.version}`, h('ol', { class: 'cs-w__stages' }, wf.stages.map((s, i) => h('li', { class: 'cs-w__stage', title: `${s.title}: ${plural(s.agents, 'agent')}${s.checkpoint ? `, then a checkpoint (${s.checkpoint})` : ''}` },
    h('span', { class: 'cs-w__stagenum' }, String(i + 1)), h('span', { class: 'cs-w__stagename' }, s.title),
    s.checkpoint ? h('span', { class: 'cs-w__check', 'aria-label': 'Checkpoint' }, icon('gate', 's')) : null))));
}

function gitSection() {
  const g = pulse.repo;
  if (!g?.isRepo) return null;
  const bits = [h('span', { class: 'cs-chip' }, icon('git', 's'), g.branch || 'detached')];
  if (g.ahead) bits.push(h('span', { class: 'cs-pill cs-pill--info' }, icon('arrow-up', 's'), `${g.ahead} to push`));
  if (g.behind) bits.push(h('span', { class: 'cs-pill cs-pill--warn' }, icon('arrow-down', 's'), `${g.behind} to pull`));
  if (g.changed) bits.push(h('span', { class: 'cs-pill cs-pill--quiet' }, `${g.changed} changed`));
  if (!g.ahead && !g.behind && !g.changed && g.upstream) bits.push(h('span', { class: 'cs-pill cs-pill--ok' }, icon('check', 's'), 'in sync'));
  const runs = pulse.github?.runs || [];
  const last = runs[0];
  const ci = last ? h('a', { class: 'cs-w__ci', href: last.url, target: '_blank', rel: 'noreferrer' },
    icon(last.status !== 'completed' ? 'spinner' : last.conclusion === 'success' ? 'check' : 'danger', 's'),
    `${last.name}: ${last.status !== 'completed' ? 'running' : last.conclusion}`) : null;
  return section('Git', h('div', { class: 'cs-row cs-row--wrap' }, ...bits),
    g.lastCommit ? h('p', { class: 'cs-soft cs-small cs-w__commit' }, h('span', { class: 'cs-mono' }, g.lastCommit.hash), ` ${g.lastCommit.subject} · ${timeAgo(g.lastCommit.at)}`) : null, ci);
}

function activitySection() {
  const days = pulse.stats.activity?.days;
  if (!days || !days.some((d) => d.count)) return null;
  const chart = barSeries(days.map((d) => ({ label: d.date.slice(5), value: d.count })), { unit: 'events' });
  return section('Last 14 days', chart);
}

function draw() {
  const s = state_();
  const head = h('header', { class: 'cs-w__head' },
    sigil(id, 'm'),
    h('div', { class: 'cs-w__title' }, h('h1', { class: 'cs-w__name' }, pulse?.project.name || id), h('span', { class: `cs-w__state cs-w__state--${s.tone}` }, h('span', { class: `cs-w__dot cs-w__dot--${s.tone}`, 'aria-hidden': 'true' }), s.word)),
    h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Refresh', title: 'Refresh', onclick: () => load(true) }, icon('refresh', 's')),
    h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Open in Circle Studio', title: 'Open in Circle Studio', onclick: () => openApp(`#/projects/${id}/workflow`) }, icon('external', 's')));
  if (!pulse) { root.replaceChildren(h('div', { class: 'cs-w' }, head, h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Loading...'))); return; }
  if (!pulse.project.exists) { root.replaceChildren(h('div', { class: 'cs-w' }, head, h('p', { class: 'cs-w__quiet' }, `The folder ${pulse.project.path} is gone.`))); return; }
  const conv = pulse.lastConversation;
  const foot = h('footer', { class: 'cs-w__foot' },
    h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => openApp(`#/projects/${id}/chat`) }, icon('chat', 's'), 'Chat'),
    conv ? h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet cs-w__conv', type: 'button', title: `Last Claude Code conversation: ${conv.title}`, onclick: () => openApp(`#/projects/${id}/chat`) }, icon('clock', 's'), h('span', { class: 'cs-w__convtext' }, conv.title)) : null);
  root.replaceChildren(h('div', { class: 'cs-w' }, head, statStrip(), waitingSection(), lookSection(), nowSection(), workflowSection(), gitSection(), activitySection(), foot,
    h('p', { class: 'cs-w__updated cs-small' }, `Updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`)));
}

async function load(fresh = false) {
  if (loading) return;
  loading = true;
  try {
    pulse = await api.pulse(id);
    document.title = `${pulse.project.name} · Circle Studio`;
    if (fresh) api.git(id, true).then((g) => { if (g.github) { pulse.github = g.github; draw(); } }).catch(() => {});
  } catch (e) {
    if (!pulse) root.replaceChildren(h('div', { class: 'cs-w' }, h('div', { class: 'cs-empty' }, icon('danger', 'l'), h('div', { class: 'cs-empty__title' }, 'Circle Studio is not answering'), h('p', {}, e.message))));
    loading = false;
    return;
  }
  loading = false;
  draw();
}

(async () => {
  const q = new URLSearchParams(location.search);
  if (q.get('w')) { await mountSingleTile(root, { kind: q.get('w'), size: q.get('size'), projectId: id || null, openApp }); return; } // one tile in its own window
  if (!id) { await mountBoard(root, { openApp }); return; } // no project: the widget board
  draw();
  try { state.projects = (await api.projects()).projects; notify(); } catch { /* the pulse says it */ }
  await load(true);
  initRequests(`widget:${id}`); // popups for approvals and questions, here in the widget
  initAlerts();
  let t = 0;
  const soon = () => { clearTimeout(t); t = setTimeout(() => load(), 300); };
  window.addEventListener('circle:requests', soon);
  window.addEventListener('circle:alerts', soon);
  window.addEventListener('circle:run', soon);
  window.addEventListener('focus', () => load());
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
})();
