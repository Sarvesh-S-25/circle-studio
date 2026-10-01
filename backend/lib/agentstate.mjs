// What each agent of a project is doing now: working, waiting for you, done (finished in the last day) or idle.
// From what is really recorded: Circle Studio's own runs and requests, Claude Code's transcripts (the main session and
// each subagent run, by when its file last changed), and a team's activity log (.claude/state/activity.jsonl).
import fs from 'node:fs';
import path from 'node:path';
import { historyDir, SESSION_RE } from './cchistory.mjs';
import { redact } from './secrets.mjs';

const WORKING_MS = 3 * 60 * 1000; // a transcript written in the last 3 minutes: still working
const DONE_MS = 24 * 60 * 60 * 1000; // finished within a day: done; older: idle

function lastActivity(root) {
  const file = path.join(root, '.claude', 'state', 'activity.jsonl');
  const by = new Map();
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return by; }
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    const k = String(e.agent || 'lead').toLowerCase();
    const prev = by.get(k);
    if (!prev || t >= prev.t) by.set(k, { t, event: String(e.event || ''), summary: redact(String(e.summary || '')).slice(0, 120) });
  }
  return by;
}

/** Recent Claude Code runs per agent type (subagents) and of the main session. */
function transcriptRuns(root, claudeHome, now) {
  const dir = historyDir(claudeHome, root);
  const runs = new Map();
  let main = null;
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && SESSION_RE.test(n.slice(0, -6))); } catch { return { runs, main }; }
  for (const n of names) {
    let st;
    try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
    if (now - st.mtimeMs > DONE_MS * 7) continue;
    if (!main || st.mtimeMs > main.t) main = { t: st.mtimeMs };
    const sub = path.join(dir, n.slice(0, -6), 'subagents');
    let files = [];
    try { files = fs.readdirSync(sub).filter((f) => f.endsWith('.meta.json')); } catch { continue; }
    for (const f of files) {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(sub, f), 'utf8')); } catch { /* none */ }
      let t = 0;
      try { t = fs.statSync(path.join(sub, f.replace(/\.meta\.json$/, '.jsonl'))).mtimeMs; } catch { continue; }
      const k = String(meta.agentType || '').toLowerCase();
      if (!k) continue;
      const prev = runs.get(k);
      if (!prev || t > prev.t) runs.set(k, { t, summary: redact(String(meta.description || '')).slice(0, 120) });
    }
  }
  return { runs, main };
}

const word = { working: 'working', waiting: 'waiting for you', done: 'done', idle: 'idle' };

function stateFrom(t, now) {
  if (!t) return 'idle';
  if (now - t < WORKING_MS) return 'working';
  if (now - t < DONE_MS) return 'done';
  return 'idle';
}

/**
 * [{ id, title, engine, model, state, word, detail, at, contextPct }] for the main session and every agent of the
 * workflow (or of .claude/agents when there is no workflow).
 */
export function agentStates({ root, workflow, live, pending, claudeHome, now = Date.now() }) {
  const activity = lastActivity(root);
  const { runs, main } = transcriptRuns(root, claudeHome, now);
  const agents = (workflow?.nodes || []).filter((n) => n.kind === 'agent');
  const list = [{ id: null, title: 'Main session', engine: 'claude', model: null }, ...agents.map((n) => ({ id: n.id, title: n.title || n.id, engine: n.engine || 'claude', model: n.model || null }))];
  return list.map((a) => {
    const key = (a.id || 'lead').toLowerCase();
    const titleKey = String(a.title).toLowerCase();
    const run = live.runs.find((r) => (r.nodeId || null) === a.id);
    const waits = pending.filter((r) => (r.nodeId || null) === a.id);
    const act = activity.get(key) || activity.get(titleKey);
    const tr = a.id ? runs.get(key) || runs.get(titleKey) : main;
    const t = Math.max(act?.t || 0, tr?.t || 0);
    let state = stateFrom(t, now);
    if (run) state = run.status === 'waiting' ? 'waiting' : 'working';
    if (waits.length) state = 'waiting';
    const detail = waits[0]?.title || (state === 'working' && act && act.t === t ? act.summary || act.event : '') || tr?.summary || act?.summary || '';
    return { id: a.id, title: a.title, engine: a.engine, model: run?.model || a.model, state, word: word[state], detail, at: t ? new Date(t).toISOString() : null, contextPct: run?.contextPct ?? null };
  });
}
