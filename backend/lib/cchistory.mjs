// The conversations the human had with Claude Code in a project folder, outside Circle Studio (the terminal, the IDE).
// Claude Code keeps each one as a JSONL transcript under ~/.claude/projects/<folder with every non-alphanumeric
// character turned into "-">/<session id>.jsonl, and each subagent run as <session id>/subagents/agent-<id>.jsonl with
// a .meta.json naming its agent type. This module only reads them. Every text it returns is redacted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { redact } from './secrets.mjs';
import { summarize } from './claude.mjs';

export const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const AGENT_RUN_RE = /^agent-[A-Za-z0-9_-]{1,64}$/;
const HEAD_BYTES = 256 * 1024;
const MAX_TEXT = 20000;

export function claudeHome(env = process.env) {
  return path.resolve(env.CIRCLE_CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

export const folderKey = (root) => path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');

export function historyDir(home, root) { return path.join(home, 'projects', folderKey(root)); }

const sameFolder = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

/** The words a person typed, or null for tool results, reminders and other machine-made user turns. */
function typedText(o) {
  if (o.type !== 'user' || o.isMeta || o.isCompactSummary) return null;
  const c = o.message?.content;
  let text = typeof c === 'string' ? c : Array.isArray(c) && c.every((b) => b?.type === 'text') ? c.map((b) => b.text).join('\n') : null;
  if (text == null) return null;
  text = text.trim();
  if (!text || text.startsWith('[Request interrupted')) return null;
  const cmd = /^<command-name>\/?([^<]+)<\/command-name>/.exec(text) || /<command-name>\/?([^<]+)<\/command-name>/.exec(text);
  if (cmd) { const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim(); return `/${cmd[1].trim()}${args ? ` ${args}` : ''}`; }
  if (/^<(local-command|system-reminder|bash-|task-notification)/.test(text)) return null;
  return text;
}

const clipText = (s, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}\n\n[... cut, ${s.length - n} more characters]` : s);

/** One line per conversation: id, title, when, size, and the subagent runs inside it. Newest first. */
export function listConversations(home, root, { limit = 40 } = {}) {
  const dir = historyDir(home, root);
  let names;
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && SESSION_RE.test(n.slice(0, -6))); } catch { return { dir, exists: false, conversations: [] }; }
  const items = [];
  for (const n of names) {
    const file = path.join(dir, n);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    items.push({ id: n.slice(0, -6), file, st });
  }
  items.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const out = [];
  for (const it of items.slice(0, limit)) {
    const head = readSlice(it.file, 0, Math.min(HEAD_BYTES, it.st.size));
    const tail = it.st.size > HEAD_BYTES ? readSlice(it.file, Math.max(HEAD_BYTES, it.st.size - HEAD_BYTES), Math.min(HEAD_BYTES, it.st.size - HEAD_BYTES)) : '';
    let title = null;
    let first = null;
    let cwd = null;
    let startedAt = null;
    let turns = 0;
    for (const line of `${head}\n${tail}`.split('\n')) {
      if (!line.startsWith('{')) continue;
      const o = parse(line);
      if (!o) continue;
      if ((o.type === 'ai-title' && o.aiTitle) || (o.type === 'custom-title' && o.customTitle) || (o.type === 'summary' && o.summary)) title = o.customTitle || o.aiTitle || o.summary;
      if (o.type === 'user' && !o.isSidechain) {
        cwd ||= o.cwd || null;
        startedAt ||= o.timestamp || null;
        const t = typedText(o);
        if (t) { turns++; first ||= t; }
      }
    }
    if (cwd && !sameFolder(cwd, root)) continue; // another folder whose name maps to the same key
    if (!first && !title) continue; // nothing a person said: an empty or tool-only run
    const subDir = path.join(path.dirname(it.file), it.id, 'subagents');
    let agents = [];
    try {
      agents = fs.readdirSync(subDir).filter((f) => f.endsWith('.meta.json')).map((f) => {
        const meta = parse(fs.readFileSync(path.join(subDir, f), 'utf8')) || {};
        return { run: f.slice(0, -'.meta.json'.length), agentType: String(meta.agentType || '').slice(0, 80), description: redact(String(meta.description || '')).slice(0, 200) };
      }).filter((a) => AGENT_RUN_RE.test(a.run));
    } catch { /* no subagents */ }
    out.push({
      id: it.id,
      title: redact(String(title || first).replace(/\s+/g, ' ').trim()).slice(0, 120),
      firstMessage: first ? redact(first.replace(/\s+/g, ' ')).slice(0, 200) : null,
      startedAt,
      lastAt: new Date(it.st.mtimeMs).toISOString(),
      bytes: it.st.size,
      turnsSeen: turns,
      agents,
    });
  }
  return { dir, exists: true, conversations: out };
}

/** The subagent runs of one agent type across the folder's conversations, newest first. */
export function agentRuns(list, agentNames) {
  const want = new Set(agentNames.filter(Boolean).map((s) => s.toLowerCase()));
  const runs = [];
  for (const c of list) for (const a of c.agents) if (want.has(a.agentType.toLowerCase())) runs.push({ ...a, sessionId: c.id, sessionTitle: c.title, lastAt: c.lastAt });
  return runs;
}

/**
 * Read one conversation (or one subagent run inside it) as chat messages: what the human typed, what Claude answered,
 * and a one-line summary of each tool it used. Only the last `limit` messages are returned.
 */
export async function readConversation(home, root, sessionId, { run = null, limit = 150 } = {}) {
  if (!SESSION_RE.test(sessionId)) return null;
  if (run && !AGENT_RUN_RE.test(run)) return null;
  const dir = historyDir(home, root);
  const file = run ? path.join(dir, sessionId, 'subagents', `${run}.jsonl`) : path.join(dir, `${sessionId}.jsonl`);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const messages = [];
  let title = null;
  let cur = null; // the assistant message being built (one API message is split over several lines)
  const flush = () => { if (cur && (cur.text.trim() || cur.tools.length)) messages.push(cur); cur = null; };
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith('{')) continue;
    const o = parse(line);
    if (!o) continue;
    if (o.type === 'ai-title' || o.type === 'custom-title' || o.type === 'summary') { title = o.customTitle || o.aiTitle || o.summary || title; continue; }
    if (!run && o.isSidechain) continue;
    if (o.isCompactSummary || (o.type === 'system' && o.subtype === 'compact_boundary')) {
      flush();
      if (messages.at(-1)?.role !== 'note') messages.push({ role: 'note', text: 'Claude Code summarised the conversation here to free up room.', at: o.timestamp || null });
      continue;
    }
    if (o.type === 'user') {
      const t = run && !messages.length && typeof o.message?.content === 'string' ? o.message.content.trim() : typedText(o);
      if (t) { flush(); messages.push({ role: 'user', text: clipText(redact(t)), at: o.timestamp || null }); }
      continue;
    }
    if (o.type !== 'assistant' || !Array.isArray(o.message?.content) || o.message.model === '<synthetic>') continue;
    const mid = o.message.id || o.uuid;
    if (!cur || cur.mid !== mid) {
      if (cur && !cur.text.trim() && cur.tools.length) cur.mid = mid; // tools first, then what it said: one message
      else { flush(); cur = { role: 'assistant', engine: 'claude', text: '', tools: [], at: o.timestamp || null, model: o.message.model || null, mid }; }
    }
    for (const b of o.message.content) {
      if (b.type === 'text' && b.text) cur.text += (cur.text ? '\n\n' : '') + b.text;
      else if (b.type === 'tool_use' && cur.tools.length < 40) cur.tools.push({ id: b.id, name: b.name, summary: redact(summarize(b.name, b.input || {}, root)), ok: true });
    }
  }
  flush();
  const total = messages.length;
  const shown = messages.slice(-limit).map(({ mid, ...m }) => (m.text ? { ...m, text: clipText(redact(m.text)) } : m));
  return { sessionId, run, title: title ? redact(String(title)).slice(0, 120) : null, bytes: st.size, lastAt: new Date(st.mtimeMs).toISOString(), total, earlier: Math.max(0, total - shown.length), messages: shown };
}
