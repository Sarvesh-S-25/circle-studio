// Desktop widget tiles, macOS style: small (1x1), medium (2x1) and large (2x2). Each kind draws from data the board
// keeps fresh (ctx): /stats, a /pulse per project, /usage, and the requests and team questions that wait.
// Colour means state everywhere: working = green, waiting for you = amber, done = blue, idle = grey.
import { api } from '../api.js';
import { h, icon, sigil, timeAgo, plural } from '../dom.js';
import { state, pref, setPref } from '../state.js';
import { openRequest } from './requests.js';
import { renderMarkdown } from '../markdown.js';

export const KINDS = {
  pulse: { title: 'Activity ring', about: 'See at a glance which projects are working (the ring turns), waiting for you (amber) or just done.', sizes: ['s', 'm', 'l'] },
  status: { title: 'Agents', about: 'A ring per agent: working, waiting for you, done or idle.', sizes: ['s', 'm', 'l'], project: true },
  spend: { title: 'Spending', about: 'Use per provider over 30 days: Claude priced, Codex tokens, the others turns.', sizes: ['s', 'm', 'l'] },
  workflow: { title: 'Workflow', about: 'The stages of a project and where the work is. Switch projects in the tile.', sizes: ['s', 'm', 'l'], project: true },
  inbox: { title: 'Waiting for you', about: 'Questions and approvals from every project. Answer them here.', sizes: ['s', 'm', 'l'] },
  project: { title: 'Project', about: 'One project at a glance: status, numbers, git, the last conversation.', sizes: ['s', 'm', 'l'], project: true },
  overview: { title: 'All projects', about: 'Every project and its state.', sizes: ['s', 'm', 'l'] },
  chat: { title: 'Chat', about: 'A project\'s main chat and its agents\' chats: switch between them in the tile, open one to reply.', sizes: ['s', 'm', 'l'], project: true },
  running: { title: 'Running now', about: 'What is working right now in every project: chats here and Claude Code teams, and for how long.', sizes: ['s', 'm', 'l'] },
  mods: { title: 'Mods', about: 'Keep track of the mods that change Claude Code, and make a new one with Claude.', sizes: ['s', 'm', 'l'] },
  notices: { title: 'Notifications', about: 'What Circle Studio told you: agents asking, long runs done or failed, team questions, updates, broken connections.', sizes: ['s', 'm', 'l'] },
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
  // nothing done draws no arc (a round line end would still draw a dot)
  if (pct > 0) s.append(svg('circle', { cx: 20, cy: 20, r, class: 'cs-ring__bar', 'stroke-dasharray': `${(Math.min(100, pct) / 100) * c} ${c}`, transform: 'rotate(-90 20 20)' }));
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

/* ---- workflow: a count of stages done, the stage now and who works on it, what comes next -------- */
const STEP_WORD = { working: 'Working', waiting: 'Needs you', done: 'Done', idle: '' };

/** One segment per stage, coloured by its state, with "3 of 8 done" beside it: progress you can count. */
function stageBar(stages) {
  const done = stages.filter((s) => s.state === 'done').length;
  return h('div', { class: 'cs-tile__stagebar' },
    h('span', { class: 'cs-tile__segs', role: 'img', 'aria-label': `${done} of ${stages.length} stages done` }, stages.map((s) => h('span', { class: `cs-tile__seg cs-tile__seg--${s.state}`, title: `${s.title}: ${STATE_WORD[s.state]}` }))),
    h('span', { class: 'cs-tile__muted' }, `${done} of ${stages.length} done`));
}

function workflowTile(tile, ctx) {
  const pu = ctx.pulse(tile.projectId);
  if (!pu) return [head('Workflow', 'plan'), notYet(tile, ctx)];
  const wf = pu.workflow;
  const pick = projectPicker(tile, ctx);
  const open = () => ctx.openApp(`#/projects/${pu.project.id}/workflow`);
  const top = head(pick ? 'Workflow' : pu.project.name, 'plan', pick);
  if (!wf || !wf.stages.length) return [top, h('p', { class: 'cs-tile__quiet' }, 'No workflow yet.'), h('button', { class: 'cs-tile__cta', type: 'button', onclick: open }, 'Draw one')];
  const stages = wf.stages;
  const done = stages.filter((s) => s.state === 'done').length;
  const i = stages.findIndex((s) => s.state === 'waiting' || s.state === 'working');
  const cur = i >= 0 ? stages[i] : null;
  const next = stages[i >= 0 ? i + 1 : done] || null;
  const nowWords = cur ? `${cur.title}: ${STATE_WORD[cur.state].toLowerCase()}` : done === stages.length ? 'Every stage is done' : 'Nothing running';
  if (tile.size === 's') {
    const st = cur?.state || (done === stages.length ? 'done' : 'idle');
    return [head('Workflow', 'plan'),
      h('button', { class: 'cs-tile__bigring', type: 'button', title: `${done} of ${stages.length} stages done. Open the workflow`, onclick: open }, ring(st, (done / stages.length) * 100, `${done}/${stages.length}`)),
      h('div', { class: 'cs-tile__sub' }, nowWords),
      h('div', { class: 'cs-tile__foot' }, pick || h('span', { class: 'cs-tile__name' }, pu.project.name))];
  }
  const out = [top, stageBar(stages)];
  if (tile.size === 'm') {
    out.push(h('button', { class: 'cs-tile__now', type: 'button', onclick: open },
      h('span', { class: `cs-dotst cs-dotst--${cur?.state || 'idle'}` }),
      h('strong', {}, cur ? cur.title : nowWords),
      cur ? h('span', { class: `cs-tile__badge cs-st--${cur.state}` }, STATE_WORD[cur.state]) : null));
    const people = (cur?.who || []).filter((a) => a.state !== 'idle').slice(0, 2);
    if (people.length) out.push(h('div', { class: 'cs-tile__muted' }, people.map((a) => `${a.title}${a.detail ? `: ${a.detail}` : ''}`).join(' · ')));
  } else {
    out.push(h('ol', { class: 'cs-tile__stagelist' }, stages.slice(0, 9).map((s, k) => h('li', { class: `cs-tile__stagerow cs-st--${s.state}` },
      h('span', { class: 'cs-tile__stepdot' }, s.state === 'done' ? icon('check', 's') : String(k + 1)),
      h('span', { class: 'cs-tile__rowtext' }, h('strong', {}, s.title),
        s.state !== 'idle' ? h('span', { class: 'cs-tile__muted' }, (s.who || []).filter((a) => a.state !== 'idle').map((a) => a.title).slice(0, 2).join(', ') || plural(s.agents, 'agent')) : null),
      h('span', { class: `cs-tile__badge cs-st--${s.state}` }, STEP_WORD[s.state])))));
  }
  if (next && next !== cur) out.push(h('div', { class: 'cs-tile__sub' }, `Next: ${next.title}${next.checkpoint ? ' (you check it first)' : ''}`));
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
  if (tile.size === 's') {
    const n = counts.find(([s]) => s === st)?.[1] ?? 0;
    return [h('div', { class: 'cs-tile__head' }, sigil(pu.project.id, 's'), h('span', { class: 'cs-tile__title' }, pu.project.name)),
      h('div', { class: `cs-tile__big cs-st--${st}` }, String(n)), h('div', { class: 'cs-tile__sub' }, st === 'idle' ? 'all quiet' : STATE_WORD[st].toLowerCase()),
      h('div', { class: 'cs-tile__foot' }, projectPicker(tile, ctx) || h('button', { class: 'cs-tile__cta', type: 'button', onclick: () => ctx.openApp(`#/projects/${pu.project.id}/workflow`) }, 'Open'))];
  }
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
  if (tile.size === 's') {
    const live = s.projects.filter((p) => p.exists);
    const waiting = live.filter((p) => state.pending.some((r) => r.projectId === p.id) || state.alerts.some((a) => a.projectId === p.id)).length;
    const working = live.filter((p) => s.running.some((r) => r.projectId === p.id) || p.activity?.live).length;
    return [head('Projects', 'project'), h('div', { class: `cs-tile__big ${waiting ? 'cs-st--waiting' : ''}` }, String(live.length)),
      h('div', { class: 'cs-tile__sub' }, [working ? `${working} working` : '', waiting ? `${waiting} waiting` : ''].filter(Boolean).join(' · ') || 'all quiet')];
  }
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
  if (!c.threads?.length && tile.size === 's') return [top, h('p', { class: 'cs-tile__quiet' }, c.empty || 'No chats in this project yet.')];
  if (tile.size === 's') {
    const last = c.messages?.at(-1);
    return [h('div', { class: 'cs-tile__head' }, icon('chat', 's'), h('span', { class: 'cs-tile__title' }, c.project?.name || 'Chat')),
      last ? h('p', { class: 'cs-tile__said cs-tile__said--s' }, h('strong', {}, `${last.who}: `), last.text) : h('p', { class: 'cs-tile__quiet' }, c.empty || 'Nothing said yet.'),
      h('button', { class: 'cs-tile__cta', type: 'button', onclick: () => ctx.openApp(`#/projects/${c.project.id}/chat`) }, 'Reply')];
  }
  const threads = h('div', { class: 'cs-tile__threads', role: 'group', 'aria-label': 'Chats' }, (c.threads || []).map((t) => h('button', {
    class: 'cs-tile__thread', type: 'button', 'aria-pressed': String(t.id === c.selected), title: `${t.label}${t.lastAt ? ` · ${timeAgo(t.lastAt)}` : ''} · ${t.source}`,
    onclick: () => { if (t.id !== c.selected) ctx.setNode(tile, t.id); },
  }, t.id === 'main' ? icon('chat', 's') : null, t.label)));
  const live = c.project ? ctx.live.get(liveKey(c)) : null;
  const shownMsgs = [...(c.messages || []), ...(live ? [{ who: 'You', mine: true, text: live.you }, { who: ENGINE_NAME[live.engine] || live.engine, text: live.error ? `Stopped: ${live.error}` : live.text || '…', live: true }] : [])];
  // the chat window (one large tile alone) shows whole messages with their formatting, and scrolls
  const full = Boolean(ctx.solo) && tile.size === 'l';
  let prev = null;
  const rows = shownMsgs.map((m) => {
    const same = prev === m.who;
    prev = m.who;
    return h('li', { class: ['cs-tile__msg', m.mine && 'cs-tile__msg--mine', m.live && 'cs-tile__msg--live', same && 'cs-tile__msg--cont'] },
      same ? null : h('span', { class: 'cs-tile__who' }, m.who, full && m.at ? h('span', { class: 'cs-tile__when' }, ` · ${timeAgo(m.at)}`) : null),
      full && m.md && !m.live ? h('div', { class: 'cs-tile__md' }, renderMarkdown(m.md)) : h('span', { class: 'cs-tile__said' }, m.text),
      full && m.md && m.tools?.length ? h('span', { class: 'cs-tile__tools' }, `Used ${m.tools.join(', ')}`) : null);
  });
  const msgs = shownMsgs.length
    ? h('ol', { class: ['cs-tile__msgs', full && 'cs-tile__msgs--full'], 'aria-live': 'polite' }, rows)
    : h('p', { class: 'cs-tile__quiet' }, c.empty || 'Nothing said in this chat yet.');
  if (full && shownMsgs.length) requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });
  return [top, c.threads?.length ? threads : null, c.title && tile.size === 'l' ? h('div', { class: 'cs-tile__muted' }, c.title) : null, msgs, composer(tile, c, ctx)];
}

/* ---- replying from the tile: which engine answers, a one-line box, the answer as it comes ------------------------ */
const ENGINE_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot' };
const liveKey = (c) => `${c.project.id}|${c.selected || 'main'}`;

function composer(tile, c, ctx) {
  if (!c.project) return null;
  if (c.canReply === false) return h('p', { class: 'cs-tile__quiet cs-small' }, 'This agent ran inside a Claude Code conversation: answer it there.');
  const key = liveKey(c);
  const live = ctx.live.get(key);
  const nodeId = c.selected?.startsWith('node:') ? c.selected.slice(5) : null;
  const usable = (ctx.engines || []).filter((e) => e.usable);
  const prefKey = `chat-engine:${c.project.id}:main`;
  let engine = nodeId ? c.engine || 'claude' : (ctx.enginePref(prefKey) || c.engine || 'claude');
  if (!nodeId && usable.length && !usable.some((e) => e.id === engine)) engine = usable[0].id;
  const engineEl = nodeId || usable.length < 2
    ? h('span', { class: 'cs-tile__engine', title: nodeId ? 'This agent\'s engine, from the workflow' : 'The engine that answers' }, h('span', { class: ['cs-tile__enginedot', live && 'cs-tile__enginedot--on'], 'aria-hidden': 'true' }), ENGINE_NAME[engine] || engine)
    : h('select', { class: 'cs-tile__engine cs-tile__engine--pick', 'aria-label': 'Engine that answers', disabled: Boolean(live) || undefined, onchange: (e) => { ctx.setEnginePref(prefKey, e.target.value); ctx.redraw(); } },
      usable.map((e) => h('option', { value: e.id, selected: e.id === engine || undefined }, e.label)));
  const input = h('input', {
    class: 'cs-tile__input', type: 'text', maxlength: '4000', autocomplete: 'off', value: ctx.drafts.get(key) || '',
    placeholder: live ? `${ENGINE_NAME[engine] || engine} is working…` : `Message ${nodeId ? c.threads.find((t) => t.id === c.selected)?.label || 'the agent' : ENGINE_NAME[engine] || engine}`,
    'aria-label': 'Your message', disabled: Boolean(live) || undefined,
    oninput: (e) => ctx.drafts.set(key, e.target.value),
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } },
  });
  const go = () => {
    const text = input.value.trim();
    if (!text || live) return;
    ctx.drafts.delete(key);
    ctx.sendChat({ key, projectId: c.project.id, nodeId, engine, text });
  };
  return h('div', { class: 'cs-tile__compose' }, engineEl, input,
    live
      ? h('button', { class: 'cs-tile__send', type: 'button', 'aria-label': 'Stop', title: 'Stop', onclick: () => ctx.stopChat(key, c.project.id, nodeId) }, icon('stop', 's'))
      : h('button', { class: 'cs-tile__send', type: 'button', 'aria-label': 'Send', title: 'Send (Enter)', onclick: go }, icon('send', 's')));
}

/* ---- notifications: what Circle Studio told you ------------------------------------------------- */
const NOTICE_STATE = { question: 'waiting', approval: 'waiting', team: 'waiting', done: 'done', error: 'danger', update: 'working', connection: 'danger' };
function noticesTile(tile, ctx) {
  const n = ctx.notices;
  if (!n) return [head('Notifications', 'bell'), h('p', { class: 'cs-tile__quiet' }, 'Loading...')];
  const open = (x) => { ctx.readNotices([x.id]); ctx.openApp(x.url || '#/'); };
  if (tile.size === 's') {
    const first = n.notices[0];
    return [head('Notifications', 'bell'), h('div', { class: `cs-tile__big ${n.unread ? 'cs-st--waiting' : ''}` }, String(n.unread)),
      h('div', { class: 'cs-tile__sub' }, first ? first.title : 'Nothing new.'),
      first ? h('button', { class: 'cs-tile__cta', type: 'button', onclick: () => open(first) }, 'Open') : null];
  }
  const max = tile.size === 'm' ? 2 : 5; // large: five, so 'and N earlier' still fits
  const allRead = n.unread ? h('button', { class: 'cs-tile__linkbtn', type: 'button', onclick: () => ctx.readNotices(null) }, 'Mark all read') : null;
  return [head(n.unread ? `Notifications · ${n.unread} new` : 'Notifications', 'bell', allRead),
    n.notices.length
      ? h('ul', { class: 'cs-tile__list' }, n.notices.slice(0, max).map((x) => h('li', {}, h('button', { class: `cs-tile__row ${x.read ? 'cs-tile__row--read' : ''}`, type: 'button', onclick: () => open(x) },
        h('span', { class: `cs-dotst cs-dotst--${x.read ? 'idle' : NOTICE_STATE[x.kind] || 'idle'}` }),
        h('span', { class: 'cs-tile__rowtext' }, h('strong', {}, x.title), h('span', { class: 'cs-tile__muted' }, [timeAgo(x.at), x.body].filter(Boolean).join(' · ')))))))
      : h('p', { class: 'cs-tile__quiet' }, 'Nothing yet. When an agent asks, finishes a long run or fails, it shows here.'),
    n.notices.length > max ? h('div', { class: 'cs-tile__sub' }, `and ${n.notices.length - max} earlier`) : null];
}

/* ---- running now: what works, where, and since when ------------------------------------------- */
const RUN_WHAT = { chat: 'chat', team: 'team', terminal: 'Claude Code in a terminal' };
const runLabel = (r) => (r.source === 'team' ? `${r.name}: ${r.agent || 'team'}` : `${r.name}: ${RUN_WHAT[r.kind] || r.kind || 'run'}`);
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const forHow = (iso) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000)); return m < 1 ? 'just started' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

function runningTile(tile, ctx) {
  const s = ctx.stats;
  if (!s) return [head('Running now', 'play'), h('p', { class: 'cs-tile__quiet' }, 'Loading...')];
  const runs = s.running.slice().sort((a, b) => Date.parse(a.startedAt || 0) - Date.parse(b.startedAt || 0));
  const go = (r) => ctx.openApp(r.projectId ? `#/projects/${r.projectId}/${r.source === 'circle' ? 'chat' : 'workflow'}` : '#/');
  if (tile.size === 's') {
    return [head('Running now', 'play'), h('div', { class: `cs-tile__big ${runs.length ? 'cs-st--working' : ''}` }, String(runs.length)),
      h('div', { class: 'cs-tile__sub' }, runs[0] ? runLabel(runs[0]) : 'Nothing is running.')];
  }
  const max = tile.size === 'm' ? 2 : 4;
  const today = new Date().toDateString();
  const earlier = tile.size === 'l' ? (ctx.notices?.notices || []).filter((n) => (n.kind === 'done' || n.kind === 'error') && new Date(n.at).toDateString() === today).slice(0, 3) : [];
  return [head(runs.length ? `Running now · ${runs.length}` : 'Running now', 'play'),
    runs.length
      ? h('ul', { class: 'cs-tile__list' }, runs.slice(0, max).map((r) => h('li', {}, h('button', { class: 'cs-tile__row', type: 'button', onclick: () => go(r) },
        h('span', { class: 'cs-dotst cs-dotst--working' }),
        h('span', { class: 'cs-tile__rowtext' }, h('strong', {}, runLabel(r)), h('span', { class: 'cs-tile__muted' }, [r.startedAt ? `since ${clock(r.startedAt)} · ${forHow(r.startedAt)}` : '', r.what || ''].filter(Boolean).join(' · ')))))))
      : h('p', { class: 'cs-tile__quiet' }, 'Nothing is running. Chats, teams and Claude Code in a terminal show here while they work.'),
    runs.length > max ? h('div', { class: 'cs-tile__sub' }, `and ${runs.length - max} more`) : null,
    earlier.length ? h('div', { class: 'cs-eyebrow' }, 'Earlier today') : null,
    earlier.length ? h('ul', { class: 'cs-tile__list' }, earlier.map((n) => h('li', {}, h('span', { class: `cs-dotst cs-dotst--${n.kind === 'error' ? 'danger' : 'done'}` }), h('span', { class: 'cs-tile__rowtext' }, h('strong', {}, n.title), h('span', { class: 'cs-tile__muted' }, [clock(n.at), n.body].filter(Boolean).join(' · ')))))) : null];
}

/* ---- activity: a ring per project that turns while it works ------------------------------------ */
/** A ring that says what a project is doing: turning (working), pulsing (waiting for you), full with a tick (done). */
function liveRing(st, label, big = false) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const share = st === 'working' ? 0.3 : st === 'idle' ? 0 : 1;
  const s = svg('svg', { viewBox: '0 0 40 40', class: `cs-live cs-live--${st}`, 'aria-hidden': 'true' });
  s.append(svg('circle', { cx: 20, cy: 20, r, class: 'cs-ring__track' }));
  if (share) s.append(svg('circle', { cx: 20, cy: 20, r, class: 'cs-live__arc', 'stroke-dasharray': `${share * c} ${c}` }));
  return h('span', { class: ['cs-ringbox', big && 'cs-ringbox--big'] }, s, h('span', { class: 'cs-ring__in' }, st === 'done' ? icon('check', 's') : label));
}

function pulseRings(ctx) {
  const s = ctx.stats;
  if (!s) return null;
  const recent = (ctx.notices?.notices || []).filter((n) => n.kind === 'done' && Date.now() - Date.parse(n.at) < 15 * 60_000);
  const order = { waiting: 0, working: 1, done: 2, idle: 3 };
  return s.projects.filter((p) => p.exists).map((p) => {
    const wait = state.pending.filter((r) => r.projectId === p.id).length + state.alerts.filter((a) => a.projectId === p.id).length;
    const runs = s.running.filter((r) => r.projectId === p.id);
    const fin = recent.find((n) => n.projectId === p.id);
    const st = wait ? 'waiting' : runs.length ? 'working' : fin ? 'done' : 'idle';
    const since = runs.map((r) => r.startedAt).filter(Boolean).sort()[0];
    const word = wait ? `${wait} waiting for you` : runs.length ? (since && forHow(since) !== 'just started' ? `Working · ${forHow(since)}` : 'Working') : fin ? `Done at ${clock(fin.at)}` : 'Quiet';
    return { id: p.id, name: p.name, st, word, what: runs[0] ? runLabel(runs[0]).split(': ')[1] : '', url: wait ? '#/inbox' : `#/projects/${p.id}/${runs[0]?.source === 'circle' ? 'chat' : 'workflow'}` };
  }).sort((a, b) => order[a.st] - order[b.st]);
}

function pulseTile(tile, ctx) {
  const all = pulseRings(ctx);
  if (!all) return [head('Activity', 'mark'), h('p', { class: 'cs-tile__quiet' }, 'Loading...')];
  const busy = all.filter((r) => r.st !== 'idle');
  const shown = (busy.length ? busy : all).slice(0, tile.size === 's' ? 1 : tile.size === 'm' ? 3 : 6);
  if (!shown.length) return [head('Activity', 'mark'), h('p', { class: 'cs-tile__quiet' }, 'No project yet. Add a folder on Home.')];
  const cell = (r, big, one = big) => h('button', { class: ['cs-tile__pulse', one && 'cs-tile__pulse--one'], type: 'button', title: `${r.name}: ${r.word}${r.what ? ` (${r.what})` : ''}`, onclick: () => ctx.openApp(r.url) },
    liveRing(r.st, initials(r.name), big),
    h('span', { class: 'cs-tile__pulsetext' }, h('strong', {}, r.name), h('span', { class: `cs-st--${r.st}` }, r.word), big && r.what && tile.size !== 's' ? h('span', { class: 'cs-tile__muted' }, r.what) : null));
  if (shown.length === 1) return [head('Activity', 'mark'), h('div', { class: `cs-tile__pulses cs-tile__pulses--one cs-tile__pulses--${tile.size}` }, cell(shown[0], true))];
  const working = all.filter((r) => r.st === 'working').length;
  const waiting = all.filter((r) => r.st === 'waiting').length;
  return [head('Activity', 'mark'), h('div', { class: `cs-tile__pulses cs-tile__pulses--${tile.size}` }, shown.map((r) => cell(r, tile.size === 'l', false))),
    tile.size === 'm' ? null : h('div', { class: 'cs-tile__sub' }, [working ? `${working} working` : '', waiting ? `${waiting} waiting for you` : ''].filter(Boolean).join(' · ') || 'All quiet')];
}

/* ---- mods: what changes Claude Code, and a way to make one ------------------------------------- */
function modsTile(tile, ctx) {
  const m = ctx.mods;
  const open = () => ctx.openApp('#/mods');
  if (!m) return [head('Mods', 'sparkle'), h('p', { class: 'cs-tile__quiet' }, 'Reading your mods...')];
  const on = m.filter((x) => x.group !== 'off');
  if (tile.size === 's') {
    return [head('Mods', 'sparkle'), h('div', { class: 'cs-tile__big' }, String(on.length)), h('div', { class: 'cs-tile__sub' }, m.length ? `on, of ${m.length} installed` : 'None yet.'),
      h('button', { class: 'cs-tile__cta', type: 'button', onclick: open }, m.length ? 'Open' : 'Make one')];
  }
  const where = (x) => (x.group === 'general' ? 'everywhere' : x.group === 'project' ? (x.onIn?.length ? `in ${x.onIn.map((p) => p.name).join(', ')}` : 'some projects') : 'off');
  return [head(on.length ? `Mods · ${on.length} on` : 'Mods', 'sparkle', h('button', { class: 'cs-tile__linkbtn', type: 'button', onclick: open }, 'Make a mod')),
    m.length
      ? h('ul', { class: 'cs-tile__list' }, m.slice(0, tile.size === 'm' ? 2 : 5).map((x) => h('li', {}, h('button', { class: 'cs-tile__row', type: 'button', onclick: open },
        h('span', { class: `cs-dotst cs-dotst--${x.group === 'off' ? 'idle' : 'done'}` }),
        h('span', { class: 'cs-tile__rowtext' }, h('strong', {}, x.name), h('span', { class: 'cs-tile__muted' }, `${x.isMod ? 'Mod' : 'Plugin'} · ${where(x)}`))))))
      : h('p', { class: 'cs-tile__quiet' }, 'No mods yet. Add a ready-made one, like a tiny game for while Claude works, or ask Claude to make one.')];
}

const RENDER = { pulse: pulseTile, mods: modsTile, running: runningTile, status: statusTile, spend: spendTile, workflow: workflowTile, inbox: inboxTile, project: projectTile, overview: overviewTile, chat: chatTile, notices: noticesTile };

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
    notices: null,
    mods: null,
    solo: false, // one tile alone in its window
    pulse: (id) => pulses.get(id || ctx.defaultProject()) || null,
    chat: (tile) => chats.get(tile) || null,
    engines: null,
    live: new Map(),   // a reply on its way, per project and chat: { you, text, engine, error }
    drafts: new Map(), // what you typed and have not sent, so a refresh keeps it
    enginePref: (key) => pref(key, ''),
    setEnginePref: (key, v) => setPref(key, v),
    /** True while you type in a chat tile or a reply is on its way: a timed refresh then waits, so nothing jumps. */
    holding: () => ctx.live.size > 0 || Boolean(document.activeElement?.closest?.('.cs-tile__compose')),
    /** Send from a chat tile: the same /api/chat as the Chat tab, so approvals and questions pop up as usual. */
    async sendChat({ key, projectId, nodeId, engine, text }) {
      const live = { you: text, text: '', engine, error: null, abort: new AbortController() };
      ctx.live.set(key, live);
      ctx.redraw();
      const said = () => document.querySelectorAll('.cs-tile__msg--live .cs-tile__said').forEach((el) => { el.textContent = live.text || '…'; });
      try {
        // the model you picked for this engine in the Chat tab, if any
        await api.chat({ projectId, nodeId: nodeId || undefined, engine, model: pref(`chat-model:${engine}`, '') || undefined, message: text }, (name, d) => {
          if (name === 'text') { live.text += d.delta || ''; said(); } else if (name === 'error') live.error = d.message;
        }, live.abort.signal);
      } catch (e) { live.error = e.message; }
      if (live.error) { ctx.redraw(); await new Promise((r) => setTimeout(r, 4000)); }
      ctx.live.delete(key);
      await ctx.reload();
      document.querySelector('.cs-tile__input')?.focus({ preventScroll: true });
    },
    async stopChat(key, projectId, nodeId) {
      ctx.live.get(key)?.abort.abort();
      try { await api.stopChat(projectId, nodeId || undefined); } catch { /* already finished */ }
    },
    reload: async () => ctx.redraw(),
    defaultProject: () => state.recent.find((p) => p.exists)?.id || state.projects.find((p) => p.exists)?.id || null,
    nameOf: (id) => state.projects.find((p) => p.id === id)?.name || id,
    openApp,
    setProject: () => {},
    setNode: () => {},
    redraw: () => {},
    /** Mark some notices read (ids), or all (null), then draw again. */
    async readNotices(ids) {
      try { ctx.notices = await api.readNotices(ids || undefined); } catch { /* the next refresh shows the truth */ }
      ctx.redraw();
    },
    async refresh(tiles, { usage = false, skipUsage = false } = {}) {
      const ids = new Set(tiles.filter((t) => KINDS[t.kind]?.project && t.kind !== 'chat').map((t) => t.projectId || ctx.defaultProject()).filter(Boolean));
      const jobs = [api.stats().then((s) => { ctx.stats = s; }).catch(() => {})];
      for (const id of ids) jobs.push(api.pulse(id).then((p) => pulses.set(id, p)).catch(() => {}));
      for (const t of tiles.filter((x) => x.kind === 'chat')) jobs.push(api.widgetChat(t.projectId || ctx.defaultProject(), t.nodeId || 'main', t.size).then((c) => chats.set(t, c)).catch(() => {}));
      if (!ctx.engines && tiles.some((t) => t.kind === 'chat')) jobs.push(api.engines().then((r) => { ctx.engines = r.engines; }).catch(() => {}));
      if (tiles.some((t) => t.kind === 'mods')) jobs.push(api.mods('').then((r) => { ctx.mods = r.mods; }).catch(() => {}));
      if (tiles.some((t) => ['notices', 'pulse', 'running'].includes(t.kind))) jobs.push(api.notices(20).then((n) => { ctx.notices = n; }).catch(() => {}));
      if (!skipUsage && (usage || !ctx.usage) && tiles.some((t) => t.kind === 'spend')) jobs.push(api.usage(30).then((u) => { ctx.usage = u; }).catch(() => {}));
      await Promise.all(jobs);
    },
  };
  return ctx;
}
