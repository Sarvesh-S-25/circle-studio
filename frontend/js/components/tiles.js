// Desktop widget tiles, macOS style: small (1x1), medium (2x1) and large (2x2). Each kind draws from data the board
// keeps fresh (ctx): /stats, a /pulse per project, /usage, and the requests and team questions that wait.
// Colour means state everywhere: working = green, waiting for you = amber, done = blue, idle = grey.
import { api } from '../api.js';
import { h, icon, sigil, timeAgo, plural } from '../dom.js';
import { state } from '../state.js';
import { openRequest } from './requests.js';

export const KINDS = {
  status: { title: 'Agents', about: 'A ring per agent: working, waiting for you, done or idle.', sizes: ['s', 'm', 'l'], project: true },
  spend: { title: 'Spending', about: 'Use per provider over 30 days: Claude priced, Codex tokens, the others turns.', sizes: ['s', 'm', 'l'] },
  workflow: { title: 'Workflow', about: 'The stages of a project and where the work is. Switch projects in the tile.', sizes: ['m', 'l'], project: true },
  inbox: { title: 'Waiting for you', about: 'Questions and approvals from every project. Answer them here.', sizes: ['s', 'm', 'l'] },
  project: { title: 'Project', about: 'One project at a glance: status, numbers, git, the last conversation.', sizes: ['m', 'l'], project: true },
  overview: { title: 'All projects', about: 'Every project and its state.', sizes: ['m', 'l'] },
  chat: { title: 'Chat', about: 'A project\'s main chat and its agents\' chats: switch between them in the tile, open one to reply.', sizes: ['m', 'l'], project: true },
};

const STATE_WORD = { working: 'Working', waiting: 'Waiting for you', done: 'Done', idle: 'Idle' };
const usd = (n) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 100 ? `$${Math.round(n)}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(2)}` : '$0');
const kTok = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };

/** A progress ring: `pct` 0..100 of the circle, tinted by state, with a label inside. */
export function ring(stateName, pct, inner) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const s = svg('svg', { viewBox: '0 0 40 40', class: `cs-ring cs-ring--${stateName}`, 'aria-hidden': 'true' });
  s.append(svg('circle', { cx: 20, cy: 20, r, class: 'cs-ring__track' }));
  s.append(svg('circle', { cx: 20, cy: 20, r, class: 'cs-ring__bar', 'stroke-dasharray': `${(Math.max(0, Math.min(100, pct)) / 100) * c} ${c}`, transform: 'rotate(-90 20 20)' }));
  return h('span', { class: 'cs-ringbox' }, s, inner ? h('span', { class: 'cs-ring__in' }, inner) : null);
}
const ringPct = (a) => (a.state === 'working' ? (a.contextPct ?? 66) : a.state === 'waiting' || a.state === 'done' ? 100 : 18);
const initials = (t) => String(t || '?').replace(/[^A-Za-z0-9 -]/g, '').split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

function projectPicker(tile, ctx) {
  const list = state.projects.filter((p) => p.exists);
  if (list.length < 2) return null;
  return h('select', { class: 'cs-tile__pick', 'aria-label': 'Project', onchange: (e) => ctx.setProject(tile, e.target.value) },
    list.map((p) => h('option', { value: p.id, selected: p.id === tile.projectId || undefined }, p.name)));
}

const head = (title, ic, extra) => h('div', { class: 'cs-tile__head' }, ic ? icon(ic, 's') : null, h('span', { class: 'cs-tile__title' }, title), h('span', { class: 'cs-grow' }), extra || null);

/** A project tile with nothing to show yet: still loading, or no project at all (never a made-up one). */
const notYet = (tile, ctx) => h('p', { class: 'cs-tile__quiet' }, tile.projectId || ctx.defaultProject() ? 'Loading...' : 'No project yet. Add a folder on Home.');

/* ---- agents: status rings ---------------------------------------------------------------------- */
function statusTile(tile, ctx) {
  const pu = ctx.pulse(tile.projectId);
  if (!pu) return [head('Agents', 'agent'), notYet(tile, ctx)];
  const agents = pu.agents || [];
  const order = { waiting: 0, working: 1, done: 2, idle: 3 };
  const top = agents.slice().sort((a, b) => order[a.state] - order[b.state]);
  const name = pu.project.name;
  if (tile.size === 's') {
    return [h('div', { class: 'cs-tile__rings4' }, top.slice(0, 4).map((a) => h('span', { title: `${a.title}: ${STATE_WORD[a.state]}` }, ring(a.state, ringPct(a), initials(a.title))))),
      h('div', { class: 'cs-tile__foot' }, projectPicker(tile, ctx) || h('span', { class: 'cs-tile__name' }, name))];
  }
  const max = tile.size === 'm' ? 4 : 8;
  const pick = projectPicker(tile, ctx);
  return [head(pick ? 'Agents' : name, 'agent', pick),
    h('div', { class: tile.size === 'm' ? 'cs-tile__ringrow' : 'cs-tile__ringgrid' }, top.slice(0, max).map((a) => h('div', { class: 'cs-tile__agent', title: a.detail || '' },
      ring(a.state, ringPct(a), initials(a.title)), h('span', { class: 'cs-tile__agentname' }, a.title), h('span', { class: `cs-tile__agentstate cs-st--${a.state}` }, STATE_WORD[a.state])))),
    tile.size === 'l' ? legend() : null];
}
const legend = () => h('div', { class: 'cs-tile__legend' }, ['working', 'waiting', 'done', 'idle'].map((s) => h('span', {}, h('span', { class: `cs-dotst cs-dotst--${s}` }), STATE_WORD[s])));

/* ---- spending by provider ---------------------------------------------------------------------- */
function spendTile(tile, ctx) {
  const u = ctx.usage;
  if (!u) return [head('Spending', 'cost'), h('p', { class: 'cs-tile__quiet' }, 'Adding up your use...')];
  const claude = u.providers.find((p) => p.id === 'claude');
  if (tile.size === 's') {
    return [head('30 days', 'cost'), h('div', { class: 'cs-tile__big' }, usd(claude.usd)), h('div', { class: 'cs-tile__sub' }, `Claude at API prices · ${kTok(claude.tokensIn + claude.tokensOut)} tokens`)];
  }
  const rows = u.providers.map((p) => {
    const value = p.measured === 'usd' ? usd(p.usd) : p.measured === 'tokens' ? `${kTok(p.tokensIn + p.tokensOut)} tok` : `${p.turns} ${p.turns === 1 ? 'turn' : 'turns'}`;
    const share = p.measured === 'usd' ? 100 : p.measured === 'tokens' ? Math.min(100, ((p.tokensIn + p.tokensOut) / Math.max(1, claude.tokensIn + claude.tokensOut)) * 100) : Math.min(100, p.turns * 5);
    return h('div', { class: 'cs-tile__prov', title: p.note }, h('span', { class: `cs-tile__provname cs-prov--${p.id}` }, p.label), h('span', { class: 'cs-tile__provbar' }, h('span', { class: `cs-tile__provfill cs-prov--${p.id}`, style: { '--pct': `${Math.max(2, share)}%` } })), h('span', { class: 'cs-tile__provval' }, value));
  });
  const out = [head('Spending · 30 days', 'cost', h('span', { class: 'cs-tile__big cs-tile__big--inline' }, usd(claude.usd))), h('div', { class: 'cs-tile__provs' }, rows)];
  if (tile.size === 'l') {
    const max = Math.max(...claude.byDay.map((d) => d.usd), 0.01);
    out.push(h('div', { class: 'cs-tile__days', role: 'img', 'aria-label': 'Claude use per day' }, claude.byDay.map((d) => h('span', { class: 'cs-tile__day', title: `${d.date}: ${usd(d.usd)}`, style: { '--pct': `${Math.max(3, (d.usd / max) * 100)}%` } }))));
    out.push(h('div', { class: 'cs-tile__folders' }, u.claudeFolders.slice(0, 3).map((f) => h('span', {}, h('strong', {}, f.name), ` ${usd(f.usd)}`))));
  }
  out.push(h('div', { class: 'cs-tile__note' }, 'Claude priced at API rates; on Pro or Max you pay the plan.'));
  return out;
}

/* ---- workflow ---------------------------------------------------------------------------------- */
function workflowTile(tile, ctx) {
  const pu = ctx.pulse(tile.projectId);
  if (!pu) return [head('Workflow', 'plan'), notYet(tile, ctx)];
  const wf = pu.workflow;
  const pick = projectPicker(tile, ctx);
  const top = head(pick ? 'Workflow' : pu.project.name, 'plan', pick);
  if (!wf || !wf.stages.length) return [top, h('p', { class: 'cs-tile__quiet' }, 'No workflow yet.')];
  const stages = wf.stages;
  const now = stages.findIndex((s) => s.state === 'waiting' || s.state === 'working');
  const steps = h('ol', { class: 'cs-tile__steps' }, stages.map((s, i) => h('li', { class: `cs-tile__step cs-st--${s.state}`, title: `${s.title}: ${STATE_WORD[s.state]}${s.checkpoint ? `, then a checkpoint (${s.checkpoint})` : ''}` },
    h('span', { class: 'cs-tile__stepdot' }, s.state === 'done' ? icon('check', 's') : String(i + 1)),
    tile.size === 'l' || stages.length <= 5 ? h('span', { class: 'cs-tile__steplabel' }, s.title) : null)));
  const cur = now >= 0 ? stages[now] : null;
  const out = [top, steps, h('div', { class: 'cs-tile__sub' }, cur ? `${cur.title}: ${STATE_WORD[cur.state].toLowerCase()}` : `${plural(stages.length, 'stage')} · ${plural(wf.agents, 'agent')} · v${wf.version}`)];
  if (tile.size === 'l') {
    const busy = (pu.agents || []).filter((a) => a.state === 'working' || a.state === 'waiting').slice(0, 4);
    out.push(h('ul', { class: 'cs-tile__list' }, busy.length ? busy.map((a) => h('li', {}, h('span', { class: `cs-dotst cs-dotst--${a.state}` }), h('strong', {}, a.title), h('span', { class: 'cs-tile__muted' }, a.detail || STATE_WORD[a.state]))) : h('li', { class: 'cs-tile__muted' }, 'Nobody is working right now.')));
  }
  return out;
}

/* ---- waiting for you --------------------------------------------------------------------------- */
function inboxTile(tile, ctx) {
  const items = [...state.pending.map((r) => ({ title: r.title, sub: `${ctx.nameOf(r.projectId)} · ${timeAgo(r.at)}`, run: () => openRequest(r.id), kind: r.kind })), ...state.alerts.map((a) => ({ title: a.title || 'A team question', sub: `${a.projectName} · team`, run: () => ctx.openApp('#/inbox'), kind: 'team' }))];
  const n = items.length;
  if (tile.size === 's') {
    return [head('For you', 'warning'), h('div', { class: `cs-tile__big ${n ? 'cs-st--waiting' : ''}` }, String(n)), h('div', { class: 'cs-tile__sub' }, n ? items[0].title : 'Nothing waits for you.'),
      n ? h('button', { class: 'cs-tile__cta', type: 'button', onclick: items[0].run }, items[0].kind === 'question' ? 'Answer' : 'Open') : null];
  }
  const max = tile.size === 'm' ? 2 : 6;
  return [head(n ? `${n} waiting for you` : 'Waiting for you', 'warning'),
    n ? h('ul', { class: 'cs-tile__list' }, items.slice(0, max).map((it) => h('li', {}, h('button', { class: 'cs-tile__row', type: 'button', onclick: it.run }, h('span', { class: 'cs-dotst cs-dotst--waiting' }), h('span', { class: 'cs-tile__rowtext' }, h('strong', {}, it.title), h('span', { class: 'cs-tile__muted' }, it.sub)), h('span', { class: 'cs-tile__go' }, it.kind === 'question' ? 'Answer' : 'Open')))))
      : h('p', { class: 'cs-tile__quiet' }, 'Nothing waits for you. Agents that ask will show here.'),
    n > max ? h('div', { class: 'cs-tile__sub' }, `and ${n - max} more`) : null];
}

/* ---- one project ------------------------------------------------------------------------------- */
function projectTile(tile, ctx) {
  const pu = ctx.pulse(tile.projectId);
  if (!pu) return [head('Project', 'project'), notYet(tile, ctx)];
  const agents = pu.agents || [];
  const counts = ['working', 'waiting', 'done'].map((s) => [s, agents.filter((a) => a.state === s).length]);
  const st = counts.find(([s, n]) => s === 'waiting' && n) ? 'waiting' : counts.find(([s, n]) => s === 'working' && n) ? 'working' : 'idle';
  const out = [h('div', { class: 'cs-tile__head' }, sigil(pu.project.id, 's'), h('span', { class: 'cs-tile__title' }, pu.project.name), h('span', { class: 'cs-grow' }), projectPicker(tile, ctx) || h('span', { class: `cs-tile__badge cs-st--${st}` }, STATE_WORD[st])),
    h('div', { class: 'cs-tile__stats' }, counts.map(([s, n]) => h('span', { class: `cs-tile__stat cs-st--${s}` }, h('strong', {}, String(n)), STATE_WORD[s].toLowerCase())))];
  const g = pu.repo;
  if (g?.isRepo) out.push(h('div', { class: 'cs-tile__sub' }, icon('git', 's'), ` ${[g.branch, g.ahead ? `${g.ahead} to push` : '', g.changed ? `${g.changed} changed` : ''].filter(Boolean).join(' · ')}`));
  if (tile.size === 'l') {
    if (pu.lastConversation) out.push(h('div', { class: 'cs-tile__sub' }, icon('clock', 's'), ` ${pu.lastConversation.title} · ${timeAgo(pu.lastConversation.lastAt)}`));
    out.push(h('ul', { class: 'cs-tile__list' }, (pu.stats.attention || []).slice(0, 3).map((a) => h('li', {}, h('span', { class: `cs-dotst cs-dotst--${a.severity === 'danger' ? 'danger' : 'waiting'}` }), a.title))));
  }
  out.push(h('button', { class: 'cs-tile__cta', type: 'button', onclick: () => ctx.openApp(`#/projects/${pu.project.id}/workflow`) }, 'Open'));
  return out;
}

/* ---- all projects ------------------------------------------------------------------------------ */
function overviewTile(tile, ctx) {
  const s = ctx.stats;
  if (!s) return [head('Projects', 'project'), h('p', { class: 'cs-tile__quiet' }, 'Loading...')];
  const rows = s.projects.filter((p) => p.exists).slice(0, tile.size === 'm' ? 3 : 8).map((p) => {
    const wait = state.pending.filter((r) => r.projectId === p.id).length + state.alerts.filter((a) => a.projectId === p.id).length;
    const run = s.running.some((r) => r.projectId === p.id) || p.activity?.live;
    const st = wait ? 'waiting' : run ? 'working' : (p.attention || []).some((a) => a.severity === 'danger') ? 'danger' : 'idle';
    return h('li', {}, h('button', { class: 'cs-tile__row', type: 'button', onclick: () => ctx.openApp(`#/projects/${p.id}/workflow`) }, sigil(p.id, 's'), h('span', { class: 'cs-tile__rowtext' }, h('strong', {}, p.name)), h('span', { class: `cs-tile__badge cs-st--${st === 'danger' ? 'danger' : st}` }, wait ? `${wait} waiting` : st === 'danger' ? 'Blocked' : STATE_WORD[st])));
  });
  return [head(`${plural(s.totals.projects, 'project')}`, 'project'), h('ul', { class: 'cs-tile__list' }, rows)];
}

/* ---- chat: the main chat and the agents' chats of one project ---------------------------------- */
function chatTile(tile, ctx) {
  const c = ctx.chat(tile);
  const pick = projectPicker(tile, ctx);
  if (!c) return [head('Chat', 'chat', pick), notYet(tile, ctx)];
  // the title opens the chat (the whole conversation, to reply)
  const top = h('div', { class: 'cs-tile__head' }, icon('chat', 's'), h('button', { class: 'cs-tile__titlebtn', type: 'button', title: 'Open this chat in Circle Studio', onclick: () => ctx.openApp(`#/projects/${c.project.id}/chat`) }, pick ? 'Chat' : c.project?.name || 'Chat', icon('external', 's')), h('span', { class: 'cs-grow' }), pick);
  if (!c.threads?.length) return [top, h('p', { class: 'cs-tile__quiet' }, c.empty || 'No chats in this project yet.')];
  const threads = h('div', { class: 'cs-tile__threads', role: 'group', 'aria-label': 'Chats' }, c.threads.map((t) => h('button', {
    class: 'cs-tile__thread', type: 'button', 'aria-pressed': String(t.id === c.selected), title: `${t.label}${t.lastAt ? ` · ${timeAgo(t.lastAt)}` : ''} · ${t.source}`,
    onclick: () => { if (t.id !== c.selected) ctx.setNode(tile, t.id); },
  }, t.id === 'main' ? icon('chat', 's') : null, t.label)));
  const msgs = c.messages?.length
    ? h('ol', { class: 'cs-tile__msgs' }, c.messages.map((m) => h('li', { class: `cs-tile__msg ${m.mine ? 'cs-tile__msg--mine' : ''}` }, h('span', { class: 'cs-tile__who' }, m.who), h('span', { class: 'cs-tile__said' }, m.text))))
    : h('p', { class: 'cs-tile__quiet' }, c.empty || 'Nothing said in this chat yet.');
  return [top, threads, c.title && tile.size === 'l' ? h('div', { class: 'cs-tile__muted' }, c.title) : null, msgs,
    tile.size === 'l' ? h('button', { class: 'cs-tile__cta', type: 'button', onclick: () => ctx.openApp(`#/projects/${c.project.id}/chat`) }, 'Open the chat') : null];
}

const RENDER = { status: statusTile, spend: spendTile, workflow: workflowTile, inbox: inboxTile, project: projectTile, overview: overviewTile, chat: chatTile };

/** Draw one tile into a fresh element. */
export function renderTile(tile, ctx) {
  const el = h('section', { class: `cs-tile cs-tile--${tile.size} cs-tile--${tile.kind}`, 'aria-label': KINDS[tile.kind]?.title || tile.kind });
  try { el.append(...RENDER[tile.kind](tile, ctx).filter(Boolean)); } catch (e) { el.append(h('p', { class: 'cs-tile__quiet' }, `Could not draw: ${e.message}`)); }
  return el;
}

/** The data the tiles read, refreshed by the board. */
export function createTileData({ openApp }) {
  const pulses = new Map();
  const chats = new WeakMap(); // tile -> its chat
  const ctx = {
    stats: null,
    usage: null,
    pulse: (id) => pulses.get(id || ctx.defaultProject()) || null,
    chat: (tile) => chats.get(tile) || null,
    defaultProject: () => state.recent.find((p) => p.exists)?.id || state.projects.find((p) => p.exists)?.id || null,
    nameOf: (id) => state.projects.find((p) => p.id === id)?.name || id,
    openApp,
    setProject: () => {},
    setNode: () => {},
    async refresh(tiles, { usage = false, skipUsage = false } = {}) {
      const ids = new Set(tiles.filter((t) => KINDS[t.kind]?.project && t.kind !== 'chat').map((t) => t.projectId || ctx.defaultProject()).filter(Boolean));
      const jobs = [api.stats().then((s) => { ctx.stats = s; }).catch(() => {})];
      for (const id of ids) jobs.push(api.pulse(id).then((p) => pulses.set(id, p)).catch(() => {}));
      for (const t of tiles.filter((x) => x.kind === 'chat')) jobs.push(api.widgetChat(t.projectId || ctx.defaultProject(), t.nodeId || 'main', t.size).then((c) => chats.set(t, c)).catch(() => {}));
      if (!skipUsage && (usage || !ctx.usage) && tiles.some((t) => t.kind === 'spend')) jobs.push(api.usage(30).then((u) => { ctx.usage = u; }).catch(() => {}));
      await Promise.all(jobs);
    },
  };
  return ctx;
}
