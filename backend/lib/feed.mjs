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

const BUILD = { status: statusTile, spend: spendTile, workflow: workflowTile, inbox: inboxTile, project: projectTile, overview: overviewTile };

/** The tiles that are shown on the desktop, each with a stable key for its saved position. */
export function buildFeed({ tiles, pulseOf, usage, stats, pending, alerts, nameOf, palette, defaultProject }) {
  const ctx = { pulseOf: (id) => pulseOf(id || defaultProject), usage, stats, pending, alerts, nameOf };
  const seen = new Map();
  const out = [];
  for (const t of tiles.filter((x) => x.desktop !== false)) {
    const base = `${t.kind}:${t.size}:${t.projectId || '-'}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    let body;
    try { body = BUILD[t.kind](t, ctx); } catch (e) { body = { title: t.kind, empty: `Could not draw: ${e.message}` }; }
    out.push({ key: `${base}:${n}`, kind: t.kind, size: t.size, ...body });
  }
  return { at: new Date().toISOString(), palette, tiles: out };
}
