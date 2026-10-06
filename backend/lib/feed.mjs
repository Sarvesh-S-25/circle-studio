// What the native desktop widgets draw: every tile of the widget board, already turned into text, rings, rows and
// bars, plus the palette from tokens.css. The desktop host (scripts/widgets/desktop-widgets.ps1) only lays it out, so
// all wording and logic live here and are tested here.
const STATE_WORD = { working: 'Working', waiting: 'Waiting for you', done: 'Done', idle: 'Idle', danger: 'Blocked' };
const usd = (n) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 100 ? `$${Math.round(n)}` : `$${(n || 0).toFixed(2)}`);
const kTok = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0));
const initials = (t) => String(t || '?').replace(/[^A-Za-z0-9 -]/g, '').split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const ringPct = (a) => (a.state === 'working' ? (a.contextPct ?? 66) : a.state === 'waiting' || a.state === 'done' ? 100 : 18);
const ORDER = { waiting: 0, working: 1, done: 2, idle: 3 };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function statusTile(t, ctx) {
  const pu = ctx.pulseOf(t.projectId);
  if (!pu) return { title: 'Agents', empty: 'No project yet.' };
  const agents = (pu.agents || []).slice().sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const max = t.size === 's' ? 4 : t.size === 'm' ? 4 : 8;
  return { title: pu.project.name, rings: agents.slice(0, max).map((a) => ({ label: initials(a.title), name: a.title, state: a.state, word: STATE_WORD[a.state], pct: ringPct(a), detail: a.detail || '' })), url: `#/projects/${pu.project.id}/workflow` };
}

function spendTile(t, ctx) {
  const u = ctx.usage;
  if (!u) return { title: 'Spending', empty: 'Adding up your use...' };
  const c = u.providers.find((p) => p.id === 'claude');
  const total = Math.max(1, c.tokensIn + c.tokensOut);
  const rows = u.providers.map((p) => ({
    label: p.label, color: { claude: 'gate', codex: 'info', gemini: 'accent', copilot: 'ok' }[p.id],
    value: p.measured === 'usd' ? usd(p.usd) : p.measured === 'tokens' ? `${kTok(p.tokensIn + p.tokensOut)} tok` : plural(p.turns, 'turn'),
    pct: p.measured === 'usd' ? 100 : p.measured === 'tokens' ? Math.max(2, Math.min(100, ((p.tokensIn + p.tokensOut) / total) * 100)) : Math.max(2, Math.min(100, p.turns * 5)),
  }));
  const max = Math.max(...c.byDay.map((d) => d.usd), 0.01);
  return {
    title: t.size === 's' ? '30 days' : 'Spending · 30 days', big: usd(c.usd), sub: 'Claude at API prices',
    rows: t.size === 's' ? [] : rows,
    bars: t.size === 'l' ? c.byDay.map((d) => Math.max(3, Math.round((d.usd / max) * 100))) : [],
    note: t.size === 'l' ? (u.claudeFolders || []).slice(0, 3).map((f) => `${f.name} ${usd(f.usd)}`).join('  ·  ') : '',
    url: '#/',
  };
}

function workflowTile(t, ctx) {
  const pu = ctx.pulseOf(t.projectId);
  if (!pu) return { title: 'Workflow', empty: 'No project yet.' };
  const wf = pu.workflow;
  if (!wf || !wf.stages.length) return { title: pu.project.name, empty: 'No workflow yet.', url: `#/projects/${pu.project.id}/workflow` };
  const cur = wf.stages.find((s) => s.state === 'waiting' || s.state === 'working');
  if (t.size === 's') {
    const done = wf.stages.filter((s) => s.state === 'done').length;
    return { title: pu.project.name, big: `${done}/${wf.stages.length}`, bigState: cur?.state === 'waiting' ? 'waiting' : 'idle', sub: cur ? `${cur.title}: ${STATE_WORD[cur.state].toLowerCase()}` : 'stages done', url: `#/projects/${pu.project.id}/workflow` };
  }
  return {
    title: pu.project.name,
    steps: wf.stages.slice(0, t.size === 'l' ? 8 : 6).map((s, i) => ({ n: i + 1, label: s.title, state: s.state })),
    sub: cur ? `${cur.title}: ${STATE_WORD[cur.state].toLowerCase()}` : `${plural(wf.stages.length, 'stage')} · ${plural(wf.agents, 'agent')} · v${wf.version}`,
    items: t.size === 'l' ? (pu.agents || []).filter((a) => a.state === 'working' || a.state === 'waiting').slice(0, 4).map((a) => ({ title: a.title, sub: a.detail || STATE_WORD[a.state], state: a.state })) : [],
    url: `#/projects/${pu.project.id}/workflow`,
  };
}

function inboxTile(t, ctx) {
  const items = [
    ...ctx.pending.map((r) => ({ title: r.title, sub: `${ctx.nameOf(r.projectId)} · ${r.kind === 'question' ? 'question' : 'approval'}`, state: 'waiting' })),
    ...ctx.alerts.map((a) => ({ title: a.title || 'A team question', sub: `${a.projectName} · team`, state: 'waiting' })),
  ];
  return {
    title: t.size === 's' ? 'For you' : items.length ? `${items.length} waiting for you` : 'Waiting for you',
    big: t.size === 's' ? String(items.length) : null, bigState: items.length ? 'waiting' : 'idle',
    sub: t.size === 's' ? (items[0]?.title || 'Nothing waits for you.') : '',
    items: t.size === 's' ? [] : items.slice(0, t.size === 'm' ? 2 : 6),
    empty: t.size !== 's' && !items.length ? 'Nothing waits for you.' : null,
    url: '#/inbox',
  };
}

function projectTile(t, ctx) {
  const pu = ctx.pulseOf(t.projectId);
  if (!pu) return { title: 'Project', empty: 'No project yet.' };
  const agents = pu.agents || [];
  const g = pu.repo;
  if (t.size === 's') {
    const waiting = agents.filter((a) => a.state === 'waiting').length;
    const working = agents.filter((a) => a.state === 'working').length;
    return { title: pu.project.name, big: String(waiting || working), bigState: waiting ? 'waiting' : 'idle', sub: waiting ? 'waiting for you' : working ? 'working' : g?.isRepo ? [g.branch, g.changed ? `${g.changed} changed` : ''].filter(Boolean).join(' · ') : 'all quiet', url: `#/projects/${pu.project.id}/workflow` };
  }
  return {
    title: pu.project.name,
    stats: ['working', 'waiting', 'done'].map((s) => ({ n: agents.filter((a) => a.state === s).length, label: STATE_WORD[s].toLowerCase(), state: s })),
    lines: [g?.isRepo ? [g.branch, g.ahead ? `${g.ahead} to push` : '', g.changed ? `${g.changed} changed` : ''].filter(Boolean).join(' · ') : '', t.size === 'l' && pu.lastConversation ? `Last: ${pu.lastConversation.title}` : ''].filter(Boolean),
    items: t.size === 'l' ? (pu.stats.attention || []).slice(0, 3).map((a) => ({ title: a.title, sub: '', state: a.severity === 'danger' ? 'danger' : 'waiting' })) : [],
    url: `#/projects/${pu.project.id}/workflow`,
  };
}

function overviewTile(t, ctx) {
  const s = ctx.stats;
  if (!s) return { title: 'Projects', empty: 'Loading...' };
  if (t.size === 's') {
    const live = s.projects.filter((p) => p.exists);
    const waiting = live.filter((p) => ctx.pending.some((r) => r.projectId === p.id) || ctx.alerts.some((a) => a.projectId === p.id)).length;
    const working = live.filter((p) => s.running.some((r) => r.projectId === p.id) || p.activity?.live).length;
    return { title: 'Projects', big: String(live.length), bigState: waiting ? 'waiting' : 'idle', sub: [working ? `${working} working` : '', waiting ? `${waiting} waiting` : ''].filter(Boolean).join(' · ') || 'all quiet', url: '#/' };
  }
  return {
    title: plural(s.totals.projects, 'project'),
    items: s.projects.filter((p) => p.exists).slice(0, t.size === 'm' ? 3 : 8).map((p) => {
      const wait = ctx.pending.filter((r) => r.projectId === p.id).length + ctx.alerts.filter((a) => a.projectId === p.id).length;
      const st = wait ? 'waiting' : s.running.some((r) => r.projectId === p.id) || p.activity?.live ? 'working' : (p.attention || []).some((a) => a.severity === 'danger') ? 'danger' : 'idle';
      return { title: p.name, sub: wait ? `${wait} waiting` : STATE_WORD[st], state: st, url: `#/projects/${p.id}/workflow` };
    }),
    url: '#/',
  };
}

/** The chat of one project: the threads to switch between, and the last messages of the one shown. */
function chatTile(t, ctx) {
  const c = ctx.chatAt(t);
  if (!c) return { title: 'Chat', empty: 'No project yet.' };
  const name = c.project?.name || 'Chat';
  if (t.size === 's') {
    const last = (c.messages || []).at(-1);
    return { title: name, sub: last ? `${last.who}: ${last.text}` : c.empty || 'Nothing said yet.', empty: null, url: c.project ? `#/projects/${c.project.id}/chat` : '#/' };
  }
  return {
    title: name,
    chat: { selected: c.selected, threads: (c.threads || []).map((x) => ({ id: x.id, label: x.label, on: x.id === c.selected })), messages: c.messages || [], heading: c.title || null },
    empty: c.empty || null,
    url: c.project ? `#/projects/${c.project.id}/chat` : '#/',
  };
}

const NOTICE_STATE = { question: 'waiting', approval: 'waiting', team: 'waiting', done: 'done', error: 'danger', update: 'working', connection: 'danger' };
const ago = (iso, now) => { const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)); return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };

/** What Circle Studio told you lately (lib/notices.mjs): unread ones first in the count, newest first in the list. */
function noticesTile(t, ctx) {
  const { notices = [], unread = 0 } = ctx.notices || {};
  const now = ctx.now();
  if (t.size === 's') return { title: 'Notifications', big: String(unread), bigState: unread ? 'waiting' : 'idle', sub: notices[0]?.title || 'Nothing new.', url: notices[0]?.url || '#/' };
  return {
    title: unread ? `Notifications · ${unread} new` : 'Notifications',
    items: notices.slice(0, t.size === 'm' ? 2 : 6).map((n) => ({ title: n.title, sub: [ago(n.at, now), n.body].filter(Boolean).join(' · '), state: n.read ? 'idle' : NOTICE_STATE[n.kind] })),
    empty: notices.length ? null : 'Nothing yet. When an agent asks, finishes a long run or fails, it shows here.',
    url: notices[0]?.url || '#/',
  };
}

/** What works right now, in every project: chats in Circle Studio and Claude Code teams that are active. */
function runningTile(t, ctx) {
  const s = ctx.stats;
  if (!s) return { title: 'Running now', empty: 'Loading...' };
  const now = ctx.now();
  const runs = s.running.slice().sort((a, b) => Date.parse(a.startedAt || 0) - Date.parse(b.startedAt || 0));
  const label = (r) => (r.source === 'team' ? `${r.name}: ${r.agent || 'team'}` : `${r.name}: ${r.kind === 'chat' ? 'chat' : r.kind || 'run'}`);
  if (t.size === 's') return { title: 'Running now', big: String(runs.length), bigState: 'idle', sub: runs[0] ? label(runs[0]) : 'Nothing is running.', url: runs[0]?.projectId ? `#/projects/${runs[0].projectId}/workflow` : '#/' };
  return {
    title: runs.length ? `Running now · ${runs.length}` : 'Running now',
    items: runs.slice(0, t.size === 'm' ? 2 : 6).map((r) => ({ title: label(r), sub: [r.startedAt ? (ago(r.startedAt, now) === 'now' ? 'just started' : `for ${ago(r.startedAt, now)}`) : '', r.what || ''].filter(Boolean).join(' · '), state: 'working' })),
    empty: runs.length ? null : 'Nothing is running.',
    url: '#/',
  };
}

const BUILD = { running: runningTile, status: statusTile, spend: spendTile, workflow: workflowTile, inbox: inboxTile, project: projectTile, overview: overviewTile, chat: chatTile, notices: noticesTile };
const PROJECT_KINDS = new Set(['status', 'workflow', 'project', 'chat']);

/**
 * The tiles that are shown on the desktop. Each has a key for its saved place that stays the same when the tile is
 * switched to another project, its index on the board (to switch it), and for project tiles the project it shows.
 */
export function buildFeed({ tiles, pulseOf, usage, stats, pending, alerts, nameOf, palette, defaultProject, chats = new Map(), projects = [], locked = false, notices = null, now = Date.now() }) {
  const ctx = { pulseOf: (id) => pulseOf(id || defaultProject), usage, stats, pending, alerts, nameOf, chatAt: (t) => chats.get(tiles.indexOf(t)) || null, notices, now: () => now };
  const seen = new Map();
  const out = [];
  tiles.forEach((t, index) => {
    if (t.desktop === false) return;
    const base = `${t.kind}:${t.size}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    let body;
    try { body = BUILD[t.kind](t, ctx); } catch (e) { body = { title: t.kind, empty: `Could not draw: ${e.message}` }; }
    const pick = PROJECT_KINDS.has(t.kind) ? { projectId: t.projectId || defaultProject || null, canPick: projects.length > 1 } : {};
    out.push({ key: `${base}:${n}`, oldKey: `${base}:${t.projectId || '-'}:${n}`, index, kind: t.kind, size: t.size, ...pick, ...body });
  });
  return { at: new Date().toISOString(), palette, projects, locked, tiles: out };
}
