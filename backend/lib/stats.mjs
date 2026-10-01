// Numbers for the dashboard, read from each project's own files and Circle Studio's own records.
// Nothing here writes anything.
import fs from 'node:fs';
import path from 'node:path';
import { inspectTeam, readProjectText, P } from './team.mjs';
import { listAdrs, readBoard, describeFreeze, quickAttention } from './health.mjs';
import { redact } from './secrets.mjs';

const DAYS = 14;
const LIVE_MS = 10 * 60 * 1000;

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Read the last ~2 MB of a file, whole lines only. */
function tailLines(file, maxBytes = 2 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The team's activity log (.claude/state/activity.jsonl): events per day, who is active, is a session live. */
export function activityStats(root, now = Date.now()) {
  const days = [];
  for (let i = DAYS - 1; i >= 0; i--) days.push({ date: dayKey(new Date(now - i * 86400000)), count: 0 });
  const byDay = new Map(days.map((d) => [d.date, d]));
  const byAgent = new Map();
  let last = null;
  let total = 0;
  for (const line of tailLines(path.join(root, ...'.claude/state/activity.jsonl'.split('/')))) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    if (!last || t > last.t) last = { t, agent: e.agent || 'lead', event: e.event, summary: e.summary };
    const d = byDay.get(String(e.ts).slice(0, 10));
    if (d) { d.count++; total++; byAgent.set(e.agent || 'lead', (byAgent.get(e.agent || 'lead') || 0) + 1); }
  }
  return {
    days,
    total,
    byAgent: [...byAgent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([agent, count]) => ({ agent, count })),
    lastAt: last ? new Date(last.t).toISOString() : null,
    live: last ? now - last.t < LIVE_MS : false,
    last: last ? { agent: last.agent, event: last.event, summary: redact(String(last.summary || '')).slice(0, 120) } : null,
  };
}

export function projectStats(project, chat, now = Date.now()) {
  const base = { id: project.id, name: project.name, path: project.path, exists: project.exists, permissions: project.permissions, isTeamProject: project.isTeamProject, lastOpenedAt: project.lastOpenedAt };
  const chatStats = {
    messages: chat.messages.length,
    costUsd: chat.messages.reduce((n, m) => n + (typeof m.costUsd === 'number' ? m.costUsd : 0), 0),
    lastAt: chat.messages.length ? chat.messages[chat.messages.length - 1].at : null,
  };
  if (!project.exists) return { ...base, chat: chatStats };
  const team = inspectTeam(project.path);
  const tiers = { opus: 0, sonnet: 0, haiku: 0, drift: 0 };
  const mains = {};
  for (const r of team.roles) {
    if (r.configModel in tiers) tiers[r.configModel]++;
    if (r.drift) tiers.drift++;
    mains[r.engine.engine] = (mains[r.engine.engine] || 0) + 1;
  }
  const adrs = listAdrs(project.path);
  const board = readBoard(project.path);
  const freeze = describeFreeze(readProjectText(project.path, P.freeze));
  return {
    ...base,
    roles: team.roles.length,
    tiers,
    mains,
    adr: { accepted: adrs.filter((a) => a.status === 'accepted').length, proposed: adrs.filter((a) => a.status === 'proposed').length, other: adrs.filter((a) => !['accepted', 'proposed'].includes(a.status)).length },
    board: { open: board.open, total: board.total ?? 0, done: Math.max(0, (board.total ?? 0) - board.open) },
    frozen: freeze.frozen,
    activity: activityStats(project.path, now),
    chat: chatStats,
    attention: quickAttention(project.path),
  };
}

export function computeStats(app, now = Date.now()) {
  const projects = app.projects.list().map((p) => projectStats(p, app.chats.get(p.id), now));
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const running = [
    ...app.sessions.active().map((r) => ({ source: 'circle', kind: r.kind, projectId: r.projectId, name: r.projectId ? names.get(r.projectId) || r.projectId : 'Advisor', startedAt: r.startedAt })),
    ...projects.filter((p) => p.activity?.live).map((p) => ({ source: 'team', kind: 'team', projectId: p.id, name: p.name, agent: p.activity.last.agent, what: p.activity.last.summary || p.activity.last.event, startedAt: p.activity.lastAt })),
  ];
  return {
    generatedAt: new Date(now).toISOString(),
    totals: {
      projects: projects.length,
      running: running.length,
      attention: projects.reduce((n, p) => n + (p.attention?.length || 0), 0),
      skills: app.library.list().length,
      messages: projects.reduce((n, p) => n + p.chat.messages, 0),
      costUsd: projects.reduce((n, p) => n + p.chat.costUsd, 0),
    },
    running,
    projects,
  };
}
