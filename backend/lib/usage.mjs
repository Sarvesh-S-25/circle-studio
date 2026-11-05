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
import { BoundedCache } from './cache.mjs';

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

const codexCache = new BoundedCache();

async function codexSession(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = codexCache.get(file);
  if (hit?.key === key) return hit.data;
  // Growing logs are read from their previous byte offset; keep a partial last line until it is complete.
  const canAppend = hit && hit.birthtime === st.birthtimeMs && st.size > hit.offset;
  const state = canAppend ? structuredClone(hit.state) : { cwd: null, model: null, at: null, last: { input_tokens: 0, output_tokens: 0 }, byDay: {}, byModel: {}, remainder: '' };
  const consume = (line) => {
    let o; try { o = JSON.parse(line); } catch { return; }
    if (o.type === 'session_meta') { state.cwd ||= o.payload?.cwd || null; state.at ||= o.payload?.timestamp || o.timestamp; }
    if (o.type === 'turn_context') state.model = o.payload?.model || state.model;
    if (o.payload?.type !== 'token_count') return;
    const t = o.payload?.info?.total_token_usage;
    if (!t) return;
    const input = Math.max(0, Number(t.input_tokens) || 0);
    const output = Math.max(0, Number(t.output_tokens) || 0); // includes reasoning; it is not added again
    const di = input >= state.last.input_tokens ? input - state.last.input_tokens : input;
    const dout = output >= state.last.output_tokens ? output - state.last.output_tokens : output;
    const stamp = o.timestamp || state.at || st.mtime.toISOString();
    const date = String(stamp).slice(0, 10);
    state.byDay[date] ||= { input: 0, output: 0 };
    state.byDay[date].input += di; state.byDay[date].output += dout;
    const modelKey = state.model || 'unknown';
    state.byModel[modelKey] = (state.byModel[modelKey] || 0) + di + dout;
    state.last = { input_tokens: input, output_tokens: output };
  };
  let rest = Buffer.from(state.remainder || '', 'base64');
  const stream = fs.createReadStream(file, { start: canAppend ? hit.offset : 0, end: Math.max(0, st.size - 1) });
  for await (const chunk of stream) {
    rest = Buffer.concat([rest, chunk]);
    let newline;
    while ((newline = rest.indexOf(10)) >= 0) { consume(rest.subarray(0, newline).toString('utf8')); rest = rest.subarray(newline + 1); }
    if (rest.length > 8 * 1024 * 1024) throw new Error('A Codex log record exceeded the supported size.');
  }
  // A complete final JSON record without a newline is valid; only an incomplete record is carried forward.
  let pending = rest;
  if (rest.length) { try { const line = rest.toString('utf8'); JSON.parse(line); consume(line); pending = Buffer.alloc(0); } catch { /* partial write, including incomplete UTF-8 */ } }
  state.remainder = pending.toString('base64');
  const data = { cwd: state.cwd, model: state.model, at: state.at || st.mtime.toISOString(), byDay: state.byDay, byModel: state.byModel };
  codexCache.set(file, { key, data, state, offset: st.size, birthtime: st.birthtimeMs });
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
  const dirs = [];
  const walk = (dir, depth = 0) => {
    if (depth === 3) { dirs.push(dir); return; }
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isDirectory() && /^\d{2,4}$/.test(e.name)) walk(path.join(dir, e.name), depth + 1);
  };
  walk(base);
  for (const dir of dirs) {
    let files = []; try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let s; try { s = await codexSession(file); } catch { continue; }
      if (!s) continue;
      const dates = Object.entries(s.byDay).filter(([date]) => byDay.has(date));
      const input = dates.reduce((n, [, d]) => n + d.input, 0);
      const output = dates.reduce((n, [, d]) => n + d.output, 0);
      if (!input && !output) continue;
      sessions++;
      tokensIn += input;
      tokensOut += output;
      for (const [date, d] of dates) byDay.set(date, byDay.get(date) + d.input + d.output);
      const k = s.cwd ? path.resolve(s.cwd).toLowerCase() : 'unknown';
      byFolder.set(k, (byFolder.get(k) || 0) + input + output);
    }
  }
  return { found: true, sessions, tokensIn, tokensOut, byDay: [...byDay].map(([date, tokens]) => ({ date, tokens })), byFolder: [...byFolder].map(([folder, tokens]) => ({ name: path.basename(folder), path: folder, tokens })).sort((a, b) => b.tokens - a.tokens), coverage: 'Token counter deltas by recorded event date; missing timestamps use session metadata. Not a billing statement.' };
}

/** Turns run from Circle Studio per engine (all engines), from the app's own chat records. */
export function circleTurns(chats, { days = 30, now = Date.now() } = {}) {
  const since = dayOf(now - days * 86400000);
  const out = {};
  for (const c of chats) for (const m of c.messages || []) {
    if (m.role !== 'assistant' || String(m.at || '').slice(0, 10) < since) continue;
    const e = m.engine || 'claude';
    out[e] ||= { turns: 0, usd: 0 };
    out[e].turns += m.turns || 1;
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
