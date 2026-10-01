// Home: what needs you, what runs, and every project at a glance. Each card shows only what is really there: the
// workflow, git, the last Claude Code conversation, 30 days of use, and the team's numbers when it has them.
import { api } from '../api.js';
import { h, icon, sigil, statusPill, timeAgo, plural } from '../dom.js';
import { state, subscribe } from '../state.js';
import { openNewProject } from '../components/newproject.js';
import { openFolder, browseForFolder } from '../components/openfolder.js';
import { askPermissions } from '../components/permissions.js';
import { barSeries } from '../components/charts.js';
import { toast } from '../components/overlay.js';
import { openRequest } from '../components/requests.js';
import { widgetMenu, openGitPanel } from '../components/gitpanel.js';

const usd = (n) => (n >= 100 ? `$${Math.round(n)}` : n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? 'under $0.01' : '$0');
const greeting = () => { const hr = new Date().getHours(); return hr < 5 ? 'Working late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'; };

export async function mount(el) {
  const pathInput = h('input', { class: 'cs-input', id: 'home-path', placeholder: 'or paste a folder path, then Enter', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Folder path' });
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); openFolder(pathInput.value); } });
  const summary = h('p', { class: 'cs-home__summary' });
  const needsEl = h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'h-needs' });
  const tiles = h('div', { class: 'cs-tiles' });
  const runningEl = h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'h-running' });
  const projectsEl = h('section', { class: 'cs-stack', 'aria-labelledby': 'h-projects' });
  const claudeEl = h('div', { class: 'cs-home__claude' });
  let stats = null;
  const pulses = new Map(); // project id -> /pulse answer
  const costs = new Map(); // project id -> 30-day usage from /cost
  let timer = null;
  let slow = null;
  let alive = true;

  const waiting = () => state.pending.length + state.alerts.length;
  const usage30 = () => [...costs.values()].reduce((n, c) => n + (c?.total?.usd || 0), 0);

  function drawTop() {
    if (!stats) return;
    const t = stats.totals;
    const bits = [];
    if (waiting()) bits.push(`${plural(waiting(), 'thing')} ${waiting() === 1 ? 'waits' : 'wait'} for you`);
    if (t.running) bits.push(`${plural(t.running, 'agent')} working`);
    if (t.attention) bits.push(`${plural(t.attention, 'project')} to look at`);
    summary.textContent = bits.length ? `${bits.join(' · ')}.` : t.projects ? 'All quiet. Pick up where you left off below.' : 'Choose a folder to start.';
    const u = usage30();
    tiles.replaceChildren(...[
      ['Projects', t.projects, 'project', '#/'],
      ['Working now', t.running, 'play', null],
      ['Waiting for you', waiting(), 'warning', '#/inbox'],
      ['Claude use, 30 days', costs.size ? usd(u) : '...', 'cost', null, 'At API prices, from Claude Code\'s own records in each folder. On a Pro or Max plan you pay the subscription.'],
    ].map(([label, v, ic, href, title]) => h(href ? 'a' : 'div', { class: ['cs-tile', label === 'Waiting for you' && waiting() && 'cs-tile--warn'], href: href || undefined, title }, icon(ic, 's'), h('div', { class: 'cs-tile__n' }, String(v)), h('div', { class: 'cs-soft cs-small' }, label))));

    // Needs you: requests from agents, team questions, then the worst problem of each project
    const cards = [];
    for (const r of state.pending.slice(0, 3)) cards.push(h('button', { class: 'cs-needcard cs-needcard--warn', type: 'button', onclick: () => openRequest(r.id) }, icon(r.kind === 'question' ? 'chat' : 'shield', 's'), h('span', { class: 'cs-needcard__text' }, h('strong', {}, r.title), h('span', { class: 'cs-soft cs-small' }, `${state.projects.find((p) => p.id === r.projectId)?.name || r.projectId} · ${r.nodeId || r.engine} · ${timeAgo(r.at)}`)), h('span', { class: 'cs-needcard__go' }, r.kind === 'question' ? 'Answer' : 'Decide')));
    for (const a of state.alerts.slice(0, 2)) cards.push(h('a', { class: 'cs-needcard cs-needcard--warn', href: '#/inbox' }, icon('board', 's'), h('span', { class: 'cs-needcard__text' }, h('strong', {}, a.title || 'A team question'), h('span', { class: 'cs-soft cs-small' }, `${a.projectName} · team question`)), h('span', { class: 'cs-needcard__go' }, 'Inbox')));
    for (const p of stats.projects) {
      const top = (p.attention || []).find((x) => x.severity === 'danger');
      if (top && cards.length < 6) cards.push(h('a', { class: 'cs-needcard cs-needcard--danger', href: `#/projects/${p.id}/health` }, icon('danger', 's'), h('span', { class: 'cs-needcard__text' }, h('strong', {}, top.title), h('span', { class: 'cs-soft cs-small' }, p.name)), h('span', { class: 'cs-needcard__go' }, 'Health')));
    }
    needsEl.replaceChildren(...(cards.length ? [h('h2', { class: 'cs-h2', id: 'h-needs' }, 'Needs you'), h('div', { class: 'cs-needs' }, cards)] : []));
    needsEl.hidden = !cards.length;

    runningEl.replaceChildren();
    runningEl.hidden = !stats.running.length;
    if (stats.running.length) runningEl.append(h('h2', { class: 'cs-h2', id: 'h-running' }, 'Working now'));
    for (const r of stats.running) {
      runningEl.append(h('a', { class: 'cs-card cs-row cs-runrow', href: r.projectId ? `#/projects/${r.projectId}/${r.source === 'circle' ? 'chat' : 'health'}` : '#/advisor' },
        icon('spinner', 's'), h('strong', {}, r.name),
        h('span', { class: 'cs-pill cs-pill--quiet' }, r.source === 'circle' ? (r.kind === 'advisor' ? 'Advisor' : 'Chat') : 'Team session'),
        h('span', { class: 'cs-grow cs-soft cs-small cs-runrow__what' }, r.agent ? `${r.agent}: ${r.what}` : ''), h('span', { class: 'cs-soft cs-small' }, timeAgo(r.startedAt))));
    }
    const c = state.health?.claude;
    claudeEl.replaceChildren(c && (!c.installed || !c.loggedIn) ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, !c.installed ? 'Claude Code is not installed: chat with Claude is off. Other engines still work (Settings).' : 'Claude is not signed in. Run `claude auth login` in a terminal.')) : '');
  }

  function statusOf(p) {
    const pu = pulses.get(p.id);
    const wait = (pu?.pending.length || 0) + (pu?.alerts.length || 0);
    if (!p.exists) return ['warn', 'Folder missing'];
    if (wait) return ['warn', `${wait} waiting`];
    if (pu?.live.runs.length || p.activity?.live) return ['ok', 'Working'];
    if ((p.attention || []).some((a) => a.severity === 'danger')) return ['danger', 'Blocked'];
    return [null, 'Quiet'];
  }

  function projectCard(p) {
    const pu = pulses.get(p.id);
    const cost = costs.get(p.id);
    const [tone, word] = statusOf(p);
    const card = h('article', { class: ['cs-pcard', tone && `cs-pcard--${tone}`], 'aria-label': p.name });
    const head = h('header', { class: 'cs-pcard__head' }, h('span', { class: 'cs-pcard__sigil' }, sigil(p.id, 'm')),
      h('div', { class: 'cs-pcard__title' }, h('a', { class: 'cs-pcard__name', href: `#/projects/${p.id}/workflow` }, p.name), h('span', { class: 'cs-mono cs-soft cs-small cs-pcard__path', title: p.path }, p.path)),
      h('span', { class: `cs-pcard__state cs-pcard__state--${tone || 'quiet'}` }, h('span', { class: 'cs-pcard__dot', 'aria-hidden': 'true' }), word));
    card.append(head);
    if (!p.exists) {
      card.append(h('p', { class: 'cs-soft cs-small' }, 'The folder is gone. Open the project to forget it.'));
      return card;
    }
    const facts = h('dl', { class: 'cs-pcard__facts' });
    const fact = (label, value, onclick) => facts.append(h('dt', {}, label), h('dd', {}, onclick ? h('button', { class: 'cs-linkbtn', type: 'button', onclick }, value) : value));
    if (pu?.workflow) fact('Workflow', pu.workflow.stages.length ? `${plural(pu.workflow.stages.length, 'stage')} · ${plural(pu.workflow.agents, 'agent')} · v${pu.workflow.version}` : 'Not set up yet');
    if (pu?.repo?.isRepo) {
      const g = pu.repo;
      const bits = [g.branch || 'detached', g.ahead ? `${g.ahead} to push` : '', g.behind ? `${g.behind} to pull` : '', g.changed ? `${g.changed} changed` : '', !g.ahead && !g.behind && !g.changed && g.upstream ? 'in sync' : ''].filter(Boolean);
      fact('Git', bits.join(' · '), () => openGitPanel(p));
    }
    if (pu?.lastConversation) fact('Last talk', h('a', { href: `#/projects/${p.id}/chat`, title: 'Your last Claude Code conversation here' }, `${pu.lastConversation.title} · ${timeAgo(pu.lastConversation.lastAt)}`));
    if (p.roles) fact('Team', [plural(p.roles, 'role'), p.board?.total ? `${p.board.done}/${p.board.total} tasks done` : '', p.adr?.proposed ? `${plural(p.adr.proposed, 'decision')} to OK` : ''].filter(Boolean).join(' · '));
    if (facts.children.length) card.append(facts);
    if (cost?.found && cost.total.answers) {
      const chart = barSeries(cost.byDay.map((d) => ({ label: d.date.slice(5), value: Math.round(d.usd * 100) / 100 })), { unit: 'dollars' });
      card.append(h('a', { class: 'cs-pcard__use', href: `#/projects/${p.id}/cost`, title: 'At API prices. Open the Cost tab for details and ways to spend less.' },
        h('span', { class: 'cs-pcard__usenum' }, usd(cost.total.usd)), h('span', { class: 'cs-soft cs-small' }, `Claude use, 30 days · ${plural(cost.sessions, 'session')}`), chart));
    }
    const chips = (p.attention || []).map((a) => h('a', { class: 'cs-chiplink', href: `#/projects/${p.id}/health` }, statusPill(a.severity === 'danger' ? 'danger' : 'warn', a.title)));
    if (chips.length) card.append(h('div', { class: 'cs-row cs-row--wrap' }, chips));
    card.append(h('footer', { class: 'cs-pcard__foot' },
      h('a', { class: 'cs-btn cs-btn--small cs-btn--primary', href: `#/projects/${p.id}/workflow` }, 'Open'),
      h('a', { class: 'cs-btn cs-btn--small', href: `#/projects/${p.id}/chat` }, icon('chat', 's'), 'Chat'),
      h('button', { class: 'cs-btn cs-btn--small', type: 'button', 'aria-haspopup': 'menu', onclick: (e) => widgetMenu(e.currentTarget, p) }, icon('pin', 's'), 'Widget'),
      h('span', { class: 'cs-grow' }),
      h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': `Permissions for ${p.name}`, title: 'Permissions', onclick: async () => {
        const next = await askPermissions({ name: p.name, path: p.path, current: p.permissions, confirmLabel: 'Save' });
        if (next) { await api.setPermissions(p.id, next); toast('Permissions saved.', { kind: 'ok', ms: 2000 }); load(); }
      } }, icon('lock', 's'))));
    return card;
  }

  function drawProjects() {
    if (!stats) return;
    projectsEl.replaceChildren(h('div', { class: 'cs-row cs-row--between cs-row--wrap' }, h('h2', { class: 'cs-h2', id: 'h-projects' }, 'Projects'),
      h('div', { class: 'cs-row cs-row--wrap cs-home__pick' },
        h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: () => browseForFolder() }, icon('folder', 's'), 'Open a folder'),
        h('div', { class: 'cs-home__path' }, pathInput),
        h('button', { class: 'cs-btn', type: 'button', onclick: () => openNewProject() }, icon('plus', 's'), 'New project'))));
    if (!stats.projects.length) {
      projectsEl.append(h('div', { class: 'cs-empty cs-home__empty' }, icon('folder', 'l'), h('div', { class: 'cs-empty__title' }, 'Which folder should I work on?'), h('p', {}, 'Open a project folder, or describe a new one in "What do you want to create today?". Circle Studio asks what it may do there first.'),
        h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: () => browseForFolder() }, icon('folder', 's'), 'Open a folder')));
      return;
    }
    projectsEl.append(h('div', { class: 'cs-projectgrid' }, stats.projects.map(projectCard)));
  }

  function draw() { drawTop(); drawProjects(); }

  let lastKey = '';
  async function load() {
    try { stats = await api.stats(); } catch (e) { toast(e.message, { kind: 'danger' }); return; }
    if (!alive) return;
    // redraw the cards only when something on them changed, and never under the cursor of someone typing a path
    const key = JSON.stringify(stats.projects.map(({ activity, ...p }) => ({ ...p, live: activity?.live })));
    if (key !== lastKey && !projectsEl.contains(document.activeElement)) { lastKey = key; draw(); } else drawTop();
  }

  /** The per-project details: pulses first (quick), then 30 days of use (reads transcripts once, then cached). */
  const safeDraw = () => (projectsEl.contains(document.activeElement) ? drawTop() : draw());

  async function loadDetails() {
    for (const p of (stats?.projects || []).filter((x) => x.exists)) {
      try { pulses.set(p.id, await api.pulse(p.id)); } catch { /* the card shows less */ }
      if (!alive) return;
    }
    safeDraw();
    for (const p of (stats?.projects || []).filter((x) => x.exists)) {
      try { costs.set(p.id, (await api.cost(p.id)).usage); } catch { costs.set(p.id, null); }
      if (!alive) return;
      safeDraw();
    }
  }

  el.append(h('div', { class: 'cs-stack cs-stack--loose cs-home' },
    h('header', { class: 'cs-home__hero' }, h('h1', { class: 'cs-home__hello', id: 'main-title' }, greeting()), summary, claudeEl),
    tiles, needsEl, runningEl, projectsEl));
  await load();
  loadDetails();
  const off = subscribe(() => { if (alive) drawTop(); });
  timer = setInterval(() => { if (!document.hidden) load(); }, 5000);
  slow = setInterval(() => { if (!document.hidden) loadDetails(); }, 60_000);
  return { destroy: () => { alive = false; off(); clearInterval(timer); clearInterval(slow); } };
}
