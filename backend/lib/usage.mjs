// Spending and use per provider, across every folder on this PC, from what each tool records itself (read only):
//  - Claude Code: ~/.claude/projects/*/<session>.jsonl, every answer's tokens, priced at API rates (lib/pricing.mjs).
//  - Codex: ~/.codex/sessions/YYYY/MM/DD/*.jsonl, the session's token totals. No price: there is no verified OpenAI
//    price table here, so Codex shows tokens only.
//  - Gemini and Copilot keep no usage this app can read: only the turns run from Circle Studio are counted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { usageInDir } from './cost.mjs';

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

function dayList(days, now) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayOf(now - i * 86400000));
  return out;
}

/** Claude Code across every folder it has worked in. */
export async function claudeUsage(claudeHome, { days = 30, now = Date.now() } = {}) {
  const root = path.join(claudeHome, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return { found: false }; }
  const byDay = new Map(dayList(days, now).map((d) => [d, 0]));
  const byFolder = [];
  const byModel = new Map();
  let usd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let answers = 0;
  for (const name of dirs) {
    const u = await usageInDir(path.join(root, name), { days, now });
    if (!u.found || !u.total?.answers) continue;
    usd += u.total.usd;
    answers += u.total.answers;
    tokensIn += u.total.input + u.total.cacheRead + u.total.cacheWrite5m + u.total.cacheWrite1h;
    tokensOut += u.total.output;
    for (const d of u.byDay) if (byDay.has(d.date)) byDay.set(d.date, byDay.get(d.date) + d.usd);
    for (const m of u.byModel) byModel.set(m.name, (byModel.get(m.name) || 0) + m.usd);
    byFolder.push({ key: name, usd: u.total.usd, answers: u.total.answers });
  }
  return { found: true, usd, answers, tokensIn, tokensOut, byDay: [...byDay].map(([date, v]) => ({ date, usd: v })), byModel: [...byModel].map(([name, v]) => ({ name, usd: v })).sort((a, b) => b.usd - a.usd), byFolder: byFolder.sort((a, b) => b.usd - a.usd) };
}

const codexCache = new Map();

async function codexSession(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = codexCache.get(file);
  if (hit?.key === key) return hit.data;
  let cwd = null;
  let last = null;
  let model = null;
  let at = null;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!cwd && line.includes('"session_meta"')) { try { const o = JSON.parse(line); cwd = o.payload?.cwd || null; at = o.payload?.timestamp || o.timestamp; } catch { /* skip */ } }
    if (!model && line.includes('"turn_context"')) { try { model = JSON.parse(line).payload?.model || null; } catch { /* skip */ } }
    if (line.includes('"token_count"')) { try { const t = JSON.parse(line).payload?.info?.total_token_usage; if (t) last = t; } catch { /* skip */ } }
  }
  const data = { cwd, model, at: at || st.mtime.toISOString(), tokensIn: last?.input_tokens || 0, tokensOut: (last?.output_tokens || 0) + (last?.reasoning_output_tokens || 0) };
  codexCache.set(file, { key, data });
  return data;
}

/** Codex sessions in the window: tokens per day, per folder. */
export async function codexUsage(codexHome = path.join(os.homedir(), '.codex'), { days = 30, now = Date.now() } = {}) {
  const base = path.join(codexHome, 'sessions');
  if (!fs.existsSync(base)) return { found: false };
  const list = dayList(days, now);
  const byDay = new Map(list.map((d) => [d, 0]));
  const byFolder = new Map();
  let tokensIn = 0;
  let tokensOut = 0;
  let sessions = 0;
  for (const d of list) {
    const dir = path.join(base, d.slice(0, 4), d.slice(5, 7), d.slice(8, 10));
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const s = await codexSession(path.join(dir, f));
      if (!s || !(s.tokensIn + s.tokensOut)) continue;
      sessions++;
      tokensIn += s.tokensIn;
      tokensOut += s.tokensOut;
      byDay.set(d, byDay.get(d) + s.tokensIn + s.tokensOut);
      const k = s.cwd ? path.basename(s.cwd) : 'unknown';
      byFolder.set(k, (byFolder.get(k) || 0) + s.tokensIn + s.tokensOut);
    }
  }
  return { found: true, sessions, tokensIn, tokensOut, byDay: [...byDay].map(([date, tokens]) => ({ date, tokens })), byFolder: [...byFolder].map(([name, tokens]) => ({ name, tokens })).sort((a, b) => b.tokens - a.tokens) };
}

/** Turns run from Circle Studio per engine (all engines), from the app's own chat records. */
export function circleTurns(chats, { days = 30, now = Date.now() } = {}) {
  const since = dayOf(now - days * 86400000);
  const out = {};
  for (const c of chats) for (const m of c.messages || []) {
    if (m.role !== 'assistant' || String(m.at || '').slice(0, 10) < since) continue;
    const e = m.engine || 'claude';
    out[e] ||= { turns: 0, usd: 0 };
    out[e].turns++;
    if (typeof m.costUsd === 'number') out[e].usd += m.costUsd;
  }
  return out;
}

/** The spending widget's answer: one row per provider, honest about what is measured. */
export async function providerUsage({ claudeHome, codexHome, chats, days = 30, now = Date.now() }) {
  const [claude, codex] = await Promise.all([claudeUsage(claudeHome, { days, now }), codexUsage(codexHome, { days, now })]);
  const turns = circleTurns(chats, { days, now });
  return {
    days,
    providers: [
      { id: 'claude', label: 'Claude', measured: 'usd', found: claude.found, usd: claude.usd || 0, tokensIn: claude.tokensIn || 0, tokensOut: claude.tokensOut || 0, answers: claude.answers || 0, byDay: claude.byDay || [], byModel: claude.byModel || [], note: 'At API prices from Claude Code\'s own records. On a Pro or Max plan you pay the subscription.' },
      { id: 'codex', label: 'Codex', measured: 'tokens', found: codex.found, tokensIn: codex.tokensIn || 0, tokensOut: codex.tokensOut || 0, sessions: codex.sessions || 0, byDay: codex.byDay || [], note: 'Tokens from Codex\'s own session files. Not priced here.' },
      { id: 'gemini', label: 'Gemini', measured: 'turns', found: true, turns: turns.gemini?.turns || 0, note: 'Only turns run from Circle Studio: Gemini keeps no usage this app can read.' },
      { id: 'copilot', label: 'Copilot', measured: 'turns', found: true, turns: turns.copilot?.turns || 0, note: 'Only turns run from Circle Studio: billed by your Copilot plan.' },
    ],
    claudeFolders: (claude.byFolder || []).slice(0, 8),
    codexFolders: (codex.byFolder || []).slice(0, 8),
  };
}
