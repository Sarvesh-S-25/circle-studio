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

/**
 * Where a project's workflow is: how many stages are done (a count, not a guess), the stage now and who works on it,
 * and what comes next. Small: the count in a ring. Medium: the track and the stage now. Large: every stage with its
 * people.
 */
function workflowTile(t, ctx) {
  const pu = ctx.pulseOf(t.projectId);
  if (!pu) return { title: 'Workflow', empty: 'No project yet.' };
  const wf = pu.workflow;
  const url = `#/projects/${pu.project.id}/workflow`;
  if (!wf || !wf.stages.length) return { title: pu.project.name, empty: 'No workflow yet. Open it to draw one.', url };
  const stages = wf.stages;
  const done = stages.filter((s) => s.state === 'done').length;
  const i = stages.findIndex((s) => s.state === 'waiting' || s.state === 'working');
  const cur = i >= 0 ? stages[i] : null;
  const next = stages[i >= 0 ? i + 1 : done] || null;
  const now = cur ? `${cur.title}: ${STATE_WORD[cur.state].toLowerCase()}` : done === stages.length ? 'Every stage is done' : 'Nothing running';
  const progress = { done, total: stages.length, pct: Math.round((done / stages.length) * 100), state: cur?.state || (done === stages.length ? 'done' : 'idle') };
  if (t.size === 's') return { title: pu.project.name, progress, sub: now, url };
  const people = (cur?.who || []).filter((a) => a.state !== 'idle').slice(0, 3).map((a) => ({ title: a.title, sub: a.detail || STATE_WORD[a.state], state: a.state }));
  return {
    title: pu.project.name,
    progress,
    now: { title: cur ? cur.title : now, word: cur ? STATE_WORD[cur.state] : '', state: cur?.state || 'idle', n: i >= 0 ? i + 1 : null },
    next: next && next !== cur ? `Next: ${next.title}${next.checkpoint ? ' (you check it first)' : ''}` : '',
    stages: t.size === 'l' ? stages.slice(0, 9).map((s, k) => ({ n: k + 1, title: s.title, state: s.state, who: (s.who || []).filter((a) => a.state !== 'idle').map((a) => a.title).slice(0, 2).join(', ') || plural(s.agents, 'agent') })) : null,
    items: t.size === 'm' ? people.slice(0, 2) : [],
    url,
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
    return { title: name, sub: last ? `${last.who}: ${last.text}` : c.empty || 'Nothing said yet.', empty: null, url: c.project ? `#/projects/${c.project.id}/chat` : '#/', chatWindow: c.project?.id || null };
  }
  return {
    title: name,
    chat: { selected: c.selected, threads: (c.threads || []).map((x) => ({ id: x.id, label: x.label, on: x.id === c.selected })), messages: c.messages || [], heading: c.title || null },
    empty: c.empty || null,
    url: c.project ? `#/projects/${c.project.id}/chat` : '#/',
    chatWindow: c.project?.id || null, // a click opens the project's chat window, to reply on the desktop
    engine: c.engine || null,
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
    items: notices.slice(0, t.size === 'm' ? 2 : 5).map((n) => ({ title: n.title, sub: [ago(n.at, now), n.body].filter(Boolean).join(' · '), state: n.read ? 'idle' : NOTICE_STATE[n.kind] })),
    empty: notices.length ? null : 'Nothing yet. When an agent asks, finishes a long run or fails, it shows here.',
    url: notices[0]?.url || '#/',
  };
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const forHow = (iso, now) => { const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)); return m < 1 ? 'just started' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const RUN_WHAT = { chat: 'chat', team: 'team', terminal: 'Claude Code in a terminal' };
export const runLabel = (r) => (r.source === 'team' ? `${r.name}: ${r.agent || 'team'}` : `${r.name}: ${RUN_WHAT[r.kind] || r.kind || 'run'}`);

/** What works right now, where and since when: chats here, Claude Code teams, Claude Code in a terminal. */
function runningTile(t, ctx) {
  const s = ctx.stats;
  if (!s) return { title: 'Running now', empty: 'Loading...' };
  const now = ctx.now();
  const runs = s.running.slice().sort((a, b) => Date.parse(a.startedAt || 0) - Date.parse(b.startedAt || 0));
  const url = (r) => (r?.projectId ? `#/projects/${r.projectId}/${r.source === 'circle' ? 'chat' : 'workflow'}` : '#/');
  if (t.size === 's') return { title: 'Running now', big: String(runs.length), bigState: runs.length ? 'working' : 'idle', sub: runs[0] ? runLabel(runs[0]) : 'Nothing is running.', url: url(runs[0]) };
  // large: what finished or failed earlier today, under what runs now
  const today = new Date(now).toDateString();
  const earlier = t.size === 'l' ? (ctx.notices?.notices || []).filter((n) => (n.kind === 'done' || n.kind === 'error') && new Date(n.at).toDateString() === today).slice(0, 3)
    .map((n) => ({ title: n.title, sub: `${clock(n.at)}${n.body ? ` · ${n.body}` : ''}`, state: n.kind === 'error' ? 'danger' : 'done' })) : [];
  return {
    title: runs.length ? `Running now · ${runs.length}` : 'Running now',
    items: [...runs.slice(0, t.size === 'm' ? 2 : 4).map((r) => ({ title: runLabel(r), sub: [r.startedAt ? `since ${clock(r.startedAt)} · ${forHow(r.startedAt, now)}` : '', r.what || ''].filter(Boolean).join(' · '), state: 'working' })), ...earlier],
    empty: runs.length || earlier.length ? null : 'Nothing is running. Chats, teams and Claude Code in a terminal show here while they work.',
    url: url(runs[0]),
  };
}

/**
 * The activity ring: one ring per project with something going on, turning while it works, amber while it waits for
 * you, a full blue ring when it has just finished. Small: the one that needs you most. Words go with every colour.
 */
function pulseTile(t, ctx) {
  const s = ctx.stats;
  if (!s) return { title: 'Activity', empty: 'Loading...' };
  const now = ctx.now();
  const recent = (ctx.notices?.notices || []).filter((n) => n.kind === 'done' && now - Date.parse(n.at) < 15 * 60_000);
  const rings = s.projects.filter((p) => p.exists).map((p) => {
    const wait = ctx.pending.filter((r) => r.projectId === p.id).length + ctx.alerts.filter((a) => a.projectId === p.id).length;
    const runs = s.running.filter((r) => r.projectId === p.id);
    const fin = recent.find((n) => n.projectId === p.id);
    const state = wait ? 'waiting' : runs.length ? 'working' : fin ? 'done' : 'idle';
    const since = runs.map((r) => r.startedAt).filter(Boolean).sort()[0];
    const word = wait ? `${wait} waiting for you` : runs.length ? (since && forHow(since, now) !== 'just started' ? `Working · ${forHow(since, now)}` : 'Working') : fin ? `Done at ${clock(fin.at)}` : 'Quiet';
    return { id: p.id, label: initials(p.name), name: p.name, state, word, what: runs[0] ? runLabel(runs[0]).split(': ')[1] : '', url: wait ? '#/inbox' : `#/projects/${p.id}/${runs[0]?.source === 'circle' ? 'chat' : 'workflow'}` };
  }).sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const busy = rings.filter((r) => r.state !== 'idle');
  const shown = (busy.length ? busy : rings).slice(0, t.size === 's' ? 1 : t.size === 'm' ? 3 : 6);
  if (!shown.length) return { title: 'Activity', empty: 'No project yet.', url: '#/' };
  const working = rings.filter((r) => r.state === 'working').length;
  const waiting = rings.filter((r) => r.state === 'waiting').length;
  return {
    title: 'Activity',
    activity: shown,
    // one ring says it all under itself; several get a line adding them up
    sub: shown.length > 1 ? [working ? `${working} working` : '', waiting ? `${waiting} waiting for you` : ''].filter(Boolean).join(' · ') || 'All quiet' : '',
    url: shown[0].url,
  };
}

/** Your Claude Code mods: how many are on, and where. A click opens the Mods page (make one, add a ready-made one). */
function modsTile(t, ctx) {
  const m = ctx.mods;
  if (!m) return { title: 'Mods', empty: 'Reading your mods...', url: '#/mods' };
  const on = m.filter((x) => x.group !== 'off');
  if (t.size === 's') return { title: 'Mods', big: String(on.length), bigState: 'idle', sub: m.length ? `on, of ${m.length} installed` : 'None yet. Click to make one.', url: '#/mods' };
  return {
    title: on.length ? `Mods · ${on.length} on` : 'Mods',
    items: m.slice(0, t.size === 'm' ? 2 : 5).map((x) => ({ title: x.name, sub: [x.isMod ? 'Mod' : 'Plugin', x.group === 'general' ? 'everywhere' : x.group === 'project' ? (x.onIn?.length ? `in ${x.onIn.map((p) => p.name).join(', ')}` : 'some projects') : 'off'].join(' · '), state: x.group === 'off' ? 'idle' : 'done' })),
    empty: m.length ? null : 'No mods yet. Add a ready-made one, or ask Claude to make one.',
    url: '#/mods',
  };
}

const BUILD = { pulse: pulseTile, mods: modsTile, running: runningTile, status: statusTile, spend: spendTile, workflow: workflowTile, inbox: inboxTile, project: projectTile, overview: overviewTile, chat: chatTile, notices: noticesTile };
const PROJECT_KINDS = new Set(['status', 'workflow', 'project', 'chat']);

/**
 * The tiles that are shown on the desktop. Each has a key for its saved place that stays the same when the tile is
 * switched to another project, its index on the board (to switch it), and for project tiles the project it shows.
 */
export function buildFeed({ tiles, pulseOf, usage, stats, pending, alerts, nameOf, palette, defaultProject, chats = new Map(), projects = [], locked = false, notices = null, mods = null, asks = true, now = Date.now() }) {
  const ctx = { pulseOf: (id) => pulseOf(id || defaultProject), usage, stats, pending, alerts, nameOf, chatAt: (t) => chats.get(tiles.indexOf(t)) || null, notices, mods, now: () => now };
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
  return { at: new Date().toISOString(), palette, projects, locked, asks, tiles: out };
}
