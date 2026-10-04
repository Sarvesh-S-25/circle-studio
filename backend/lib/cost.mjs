// What a project costs to run with Claude Code, and how to make it cheaper. Read only.
//  1. What every new session loads before you type (CLAUDE.md and its @imports, your own ~/.claude/CLAUDE.md, the
//     agents' and skills' descriptions), and what loads when an agent or skill runs (its body).
//  2. The model each agent runs on, and what that costs per million tokens.
//  3. What the folder really used: Claude Code's own transcripts (~/.claude/projects/...) record the tokens of every
//     answer, so the last 30 days are summed per model, per day and per agent, and priced at API rates.
//  4. Problems that cost money, each with a cheaper option the human can apply through the usual review.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseFrontMatter, fieldString } from './frontmatter.mjs';
import { historyDir, SESSION_RE } from './cchistory.mjs';
import { priceOf, costOf, tokensOf, PRICES_AS_OF, ALIASES } from './pricing.mjs';
import { redact } from './secrets.mjs';

const read = (abs) => { try { return fs.readFileSync(abs, 'utf8'); } catch { return null; } };
const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

/** CLAUDE.md with its @imports (up to 4 levels, inside the project or the home folder only). */
function withImports(abs, root, seen = new Set(), depth = 0) {
  const text = read(abs);
  if (text == null || seen.has(abs.toLowerCase())) return [];
  seen.add(abs.toLowerCase());
  const out = [{ abs, text }];
  if (depth >= 4) return out;
  const noCode = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  for (const m of noCode.matchAll(/(?:^|\s)@((?:~\/|\.{0,2}\/)?[\w./-]+\.\w+)/g)) {
    const target = m[1].startsWith('~/') ? path.join(process.env.USERPROFILE || process.env.HOME || '', m[1].slice(2)) : path.resolve(path.dirname(abs), m[1]);
    out.push(...withImports(target, root, seen, depth + 1));
  }
  return out;
}

function frontMatter(text) {
  const fm = parseFrontMatter(text || '');
  if (!fm.ok) return { name: null, description: '', model: null, body: text || '' };
  return { name: fieldString(fm, 'name'), description: fieldString(fm, 'description') || '', model: fieldString(fm, 'model'), body: fm.body };
}

function listMd(dir) { try { return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).map((f) => path.join(dir, f)); } catch { return []; } }
function listSkills(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name, 'SKILL.md')).filter((p) => fs.existsSync(p)); } catch { return []; }
}

/** What loads into Claude's context: always (every session) and on use (when an agent or skill runs). */
export function contextWeight(rootIn, { claudeHome }) {
  const root = path.resolve(rootIn);
  const always = [];
  const onUse = [];
  const add = (list, item) => list.push({ ...item, tokens: item.tokens ?? tokensOf(item.text), text: undefined });
  for (const name of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')]) {
    for (const f of withImports(path.join(root, name), root)) {
      add(always, { kind: f.abs === path.join(root, name) ? 'instructions' : 'import', path: f.abs.startsWith(root) ? rel(root, f.abs) : f.abs, text: f.text, note: f.abs === path.join(root, name) ? 'Read at the start of every session.' : 'Pulled in by an @import, every session.' });
    }
  }
  const userMd = path.join(claudeHome, 'CLAUDE.md');
  if (read(userMd) != null) add(always, { kind: 'yours', path: '~/.claude/CLAUDE.md', text: read(userMd), note: 'Your own instructions: loaded in every project.' });
  const agents = [];
  for (const f of listMd(path.join(root, '.claude', 'agents'))) {
    const a = frontMatter(read(f));
    agents.push({ file: rel(root, f), name: a.name || path.basename(f, '.md'), model: a.model, descriptionTokens: tokensOf(a.description), bodyTokens: tokensOf(a.body) });
    add(always, { kind: 'agent-description', path: rel(root, f), tokens: tokensOf(a.description) + 15, note: 'Its description is listed for the main session, so it can hand work to it.' });
    add(onUse, { kind: 'agent', path: rel(root, f), tokens: tokensOf(a.body), note: `Loads when ${a.name || 'this agent'} runs.` });
  }
  const skillDirs = [[path.join(root, '.claude', 'skills'), false], [path.join(claudeHome, 'skills'), true]];
  for (const [dir, user] of skillDirs) {
    for (const f of listSkills(dir)) {
      const s = frontMatter(read(f));
      const where = user ? `~/.claude/skills/${path.basename(path.dirname(f))}/SKILL.md` : rel(root, f);
      add(always, { kind: 'skill-description', path: where, tokens: tokensOf(`${s.name || ''} ${s.description}`) + 10, note: user ? 'Your skill: its description is in every project.' : 'Its name and description are always listed.', long: s.description.length > 1024 });
      add(onUse, { kind: 'skill', path: where, tokens: tokensOf(s.body), note: 'Loads when the skill is used.' });
    }
  }
  const agentsMd = read(path.join(root, 'AGENTS.md'));
  const others = agentsMd != null ? [{ path: 'AGENTS.md', tokens: tokensOf(agentsMd), note: 'Read by Codex and Copilot every session (Claude only when CLAUDE.md imports it).' }] : [];
  const geminiMd = read(path.join(root, 'GEMINI.md'));
  if (geminiMd != null) others.push({ path: 'GEMINI.md', tokens: tokensOf(geminiMd), note: 'Read by Gemini every session.' });
  let mcp = [];
  try { mcp = Object.keys(JSON.parse(read(path.join(root, '.mcp.json')) || '{}').mcpServers || {}); } catch { /* not JSON */ }
  const hooks = [];
  for (const f of [path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')]) {
    try { for (const [event, list] of Object.entries(JSON.parse(read(f) || '{}').hooks || {})) hooks.push({ event, count: Array.isArray(list) ? list.length : 1, file: rel(root, f) }); } catch { /* not JSON */ }
  }
  const sum = (l) => l.reduce((n, x) => n + x.tokens, 0);
  return { always: always.sort((a, b) => b.tokens - a.tokens), onUse: onUse.sort((a, b) => b.tokens - a.tokens), alwaysTokens: sum(always), others, mcp, hooks, agents, claudeMdText: read(path.join(root, 'CLAUDE.md')) || '', agentsMdText: agentsMd || '' };
}

/* ---- measured usage from Claude Code's transcripts ------------------------------------------------- */

const usageCache = new Map(); // file -> { key, records }

async function fileUsage(file, agentType) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = usageCache.get(file);
  if (hit && hit.key === key) return hit.records;
  const seen = new Set();
  const records = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    // a tool output that Circle Studio's condense hook shortened (its note says how much)
    const cut = line.includes('Circle Studio condensed:') && /Circle Studio condensed: (\w+) output was (\d+) tokens, now (\d+)/.exec(line);
    if (cut) {
      let day = '';
      try { day = String(JSON.parse(line).timestamp || '').slice(0, 10); } catch { /* keep the counts */ }
      records.push({ kind: 'condensed', day, agent: agentType, tool: cut[1], was: Number(cut[2]), now: Number(cut[3]) });
      continue;
    }
    if (!line.includes('"usage"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (o.type !== 'assistant' || !m?.usage || m.model === '<synthetic>') continue;
    const id = m.id || o.requestId || o.uuid;
    if (seen.has(id)) continue; // one answer is written over several lines, each with the same usage
    seen.add(id);
    const u = m.usage;
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
    records.push({
      day: String(o.timestamp || '').slice(0, 10), model: m.model, agent: agentType,
      input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite1h: w1h, cacheWrite5m: Math.max(0, (u.cache_creation_input_tokens || 0) - w1h),
    });
  }
  usageCache.set(file, { key, records });
  return records;
}

/** Tokens and API-price dollars over the last `days`, from every transcript in the folder (and its subagent runs). */
export async function measuredUsage(rootIn, { claudeHome, days = 30, now = Date.now() } = {}) {
  return usageInDir(historyDir(claudeHome, path.resolve(rootIn)), { days, now });
}

/** The same, for one folder of Claude Code transcripts (~/.claude/projects/<key>). */
export async function usageInDir(dir, { days = 30, now = Date.now() } = {}) {
  const since = new Date(now - days * 86400000).toISOString().slice(0, 10);
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl') && SESSION_RE.test(n.slice(0, -6))); } catch { return { found: false, days, since }; }
  const all = [];
  let sessions = 0;
  for (const n of files) {
    const abs = path.join(dir, n);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    if (st.mtime.toISOString().slice(0, 10) < since) continue;
    sessions++;
    all.push(...(await fileUsage(abs, 'main session')));
    const sub = path.join(dir, n.slice(0, -6), 'subagents');
    let subs = [];
    try { subs = fs.readdirSync(sub).filter((f) => f.endsWith('.jsonl')); } catch { /* none */ }
    for (const f of subs) {
      let type = 'subagent';
      try { type = JSON.parse(fs.readFileSync(path.join(sub, f.replace(/\.jsonl$/, '.meta.json')), 'utf8')).agentType || type; } catch { /* no meta */ }
      all.push(...(await fileUsage(path.join(sub, f), String(type).slice(0, 60))));
    }
  }
  // condensed outputs: how many, and the tokens that stayed out of the agents' context
  const cuts = all.filter((r) => r.kind === 'condensed' && (!r.day || r.day >= since));
  const condensed = { count: cuts.length, was: 0, now: 0, byAgent: {} };
  for (const c of cuts) {
    condensed.was += c.was; condensed.now += c.now;
    const a = (condensed.byAgent[c.agent] ||= { count: 0, saved: 0 });
    a.count++; a.saved += Math.max(0, c.was - c.now);
  }
  const recs = all.filter((r) => r.kind !== 'condensed' && r.day >= since);
  const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, usd: 0, answers: 0 });
  const addTo = (t, r) => { for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h']) t[k] += r[k]; t.usd += costOf(r.model, r) || 0; t.answers++; };
  const byModel = new Map();
  const byAgent = new Map();
  const byDay = new Map();
  const total = blank();
  for (const r of recs) {
    addTo(total, r);
    const mk = priceOf(r.model)?.label || r.model;
    if (!byModel.has(mk)) byModel.set(mk, blank());
    addTo(byModel.get(mk), r);
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, blank());
    addTo(byAgent.get(r.agent), r);
    if (!byDay.has(r.day)) byDay.set(r.day, 0);
    byDay.set(r.day, byDay.get(r.day) + (costOf(r.model, r) || 0));
  }
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) { const d = new Date(now - i * 86400000).toISOString().slice(0, 10); dayList.push({ date: d, usd: byDay.get(d) || 0 }); }
  const sorted = (m) => [...m.entries()].map(([name, t]) => ({ name, ...t })).sort((a, b) => b.usd - a.usd);
  const inputSide = total.input + total.cacheRead + total.cacheWrite5m + total.cacheWrite1h;
  return { found: true, days, since, sessions, total, cacheShare: inputSide ? total.cacheRead / inputSide : null, byModel: sorted(byModel), byAgent: sorted(byAgent).slice(0, 12), byDay: dayList, condensed };
}

/* ---- the model each agent runs on, problems, cheaper options ---------------------------------------- */

const SIMPLE_ROLE = /\b(research|scrap|search|find|scan|lint|format|doc|docs|readme|changelog|summar|text|copy|translate|test-run|runner|version|deploy|migrat|tidy|clean)/i;
const HARD_ROLE = /\b(architect|plan|security|review|design|reason|stack|audit|lead|orchestrat)/i;
const RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };
const familyOf = (model) => { const id = priceOf(model)?.id || ''; return Object.keys(RANK).find((f) => id.includes(f)) || null; };

export function agentCosts(workflow, weight) {
  const out = [];
  const nodes = workflow?.nodes?.filter((n) => n.kind === 'agent') || [];
  const byName = new Map(weight.agents.map((a) => [a.name.toLowerCase(), a]));
  const seen = new Set();
  for (const n of nodes) {
    const file = byName.get(n.id.toLowerCase()) || byName.get(String(n.title).toLowerCase());
    if (file) seen.add(file.name.toLowerCase());
    out.push({ id: n.id, title: n.title, engine: n.engine || 'claude', model: n.model || file?.model || null, does: n.does || '', inWorkflow: true, bodyTokens: file?.bodyTokens ?? null, reader: n.reader === true, condense: n.condense || null });
  }
  for (const a of weight.agents) if (!seen.has(a.name.toLowerCase())) out.push({ id: a.name, title: a.name, engine: 'claude', model: a.model, does: '', inWorkflow: false, bodyTokens: a.bodyTokens });
  return out.map((a) => {
    const p = a.engine === 'claude' ? priceOf(a.model || 'inherit') : null;
    return { ...a, price: p ? { label: p.label, input: p.input, output: p.output } : null };
  });
}

export function findIssues({ weight, agents, usage }) {
  const issues = [];
  const md = weight.always.find((x) => x.path === 'CLAUDE.md');
  const imported = weight.always.filter((x) => x.kind === 'import').reduce((n, x) => n + x.tokens, 0);
  if (weight.alwaysTokens > 12000) issues.push({ id: 'heavy-start', severity: 'warn', title: `About ${Math.round(weight.alwaysTokens / 1000)}k tokens load before you type`, detail: 'Every session (and every agent hand-off that re-reads it) pays for this. Move long reference text into skills or docs that load only when needed.', tech: 'The always-loaded total: CLAUDE.md, its @imports, ~/.claude/CLAUDE.md, agent and skill descriptions.' });
  if (md && md.tokens > 4000) issues.push({ id: 'claude-md-long', severity: md.tokens > 8000 ? 'warn' : 'info', title: `CLAUDE.md is long (about ${Math.round(md.tokens / 1000)}k tokens)`, detail: 'Keep the rules every session needs; move how-tos, history and examples into docs/ or a skill.', path: 'CLAUDE.md' });
  if (imported > 6000) issues.push({ id: 'imports', severity: 'info', title: `@imports add about ${Math.round(imported / 1000)}k tokens to every session`, detail: 'Imported files load in full each time. Link to the ones that are only sometimes needed instead of importing them.' });
  const a = weight.claudeMdText;
  const b = weight.agentsMdText;
  if (a && b) {
    const lines = (t) => new Set(t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 30));
    const la = lines(a);
    const shared = [...lines(b)].filter((l) => la.has(l)).length;
    if (la.size && shared / la.size > 0.3 && /@AGENTS\.md/.test(a)) issues.push({ id: 'duplicate', severity: 'warn', title: 'CLAUDE.md imports AGENTS.md and repeats much of it', detail: `${shared} long lines are in both, so Claude reads them twice every session.` });
  }
  for (const s of weight.always.filter((x) => x.long)) issues.push({ id: `skill-desc:${s.path}`, severity: 'info', title: `A skill description is very long (${s.path})`, detail: 'Descriptions are always loaded; keep them to a sentence or two about when to use the skill.', path: s.path });
  if (weight.mcp.length > 4) issues.push({ id: 'mcp', severity: 'info', title: `${weight.mcp.length} MCP servers are configured`, detail: 'Each server adds tool definitions to the context. Turn off the ones this project does not use.', tech: weight.mcp.join(', ') });
  for (const ag of agents) {
    if (ag.engine !== 'claude') continue;
    const fam = familyOf(ag.model);
    const text = `${ag.id} ${ag.title} ${ag.does}`;
    if (!ag.model) issues.push({ id: `inherit:${ag.id}`, severity: 'info', title: `${ag.title} has no model of its own`, detail: 'It runs on whatever the main session uses (often the most expensive). Give it one.', fix: { agent: ag.id, model: SIMPLE_ROLE.test(text) && !HARD_ROLE.test(text) ? 'haiku' : 'sonnet' } });
    else if (fam && RANK[fam] >= 3 && SIMPLE_ROLE.test(text) && !HARD_ROLE.test(text)) issues.push({ id: `overkill:${ag.id}`, severity: 'warn', title: `${ag.title} runs on ${priceOf(ag.model).label} for routine work`, detail: `Its job reads as routine. Sonnet costs about half as much and usually does this as well.`, fix: { agent: ag.id, model: 'sonnet' } });
    else if (fam === 'sonnet' && /\b(scrap|search|find|scan|lint|format|summar|translate|version)/i.test(text) && !HARD_ROLE.test(text)) issues.push({ id: `lighter:${ag.id}`, severity: 'info', title: `${ag.title} could try Haiku`, detail: 'Haiku costs half of Sonnet and is quick at searching, scanning and formatting. Try it and switch back if the results get worse.', fix: { agent: ag.id, model: 'haiku' } });
  }
  // The condenser pattern: an expensive agent that mostly reads (reviews, research, debugging long logs) and carries a
  // big context on every answer. Measured from its own transcripts, so it is only suggested where it would show.
  for (const u of usage?.byAgent || []) {
    const ag = agents.find((a) => a.id.toLowerCase() === String(u.name).toLowerCase() || String(a.title).toLowerCase() === String(u.name).toLowerCase());
    if (!ag || ag.engine !== 'claude' || ag.reader || ag.condense || u.answers < 10) continue;
    const fam = familyOf(ag.model);
    const perAnswer = (u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h) / u.answers;
    const text = `${ag.id} ${ag.title} ${ag.does}`;
    if ((fam === 'opus' || fam === 'sonnet') && perAnswer > 60_000 && /\b(review|research|audit|debug|analy|investigat|test|read|scan|plan)/i.test(text)) {
      const share = u.usd ? Math.round(((u.usd - (costOf(priceOf(ag.model)?.id, { output: u.output }) || 0)) / u.usd) * 100) : null;
      issues.push({ id: `reader:${ag.id}`, severity: 'info', title: `${ag.title} carries about ${Math.round(perAnswer / 1000)}k tokens on every answer`, detail: `Reading is${share != null ? ` about ${share}% of` : ''} its cost. A Haiku reader can read the long files and logs for it and hand back a few lines, so its own context stays small. Worth it for an agent that reads much and edits little.`, fix: { agent: ag.id, reader: true } });
    }
  }
  if (usage?.found && usage.total.answers > 20 && usage.cacheShare != null && usage.cacheShare < 0.5) issues.push({ id: 'cache', severity: 'info', title: 'Little of the context is reused from the cache', detail: 'Short sessions that start over pay full price for the same instructions again. Longer sessions, or fewer restarts, reuse them for a tenth of the price.' });
  return issues;
}

/** The whole Cost view for one project. */
export async function projectCost(root, { claudeHome, workflow, chats }) {
  const weight = contextWeight(root, { claudeHome });
  const agents = agentCosts(workflow, weight);
  const usage = await measuredUsage(root, { claudeHome });
  const issues = findIssues({ weight, agents, usage });
  const circle = { usd: chats.reduce((n, m) => n + (typeof m.costUsd === 'number' ? m.costUsd : 0), 0), answers: chats.filter((m) => m.role === 'assistant').length };
  const main = priceOf('sonnet');
  const startUsd = (weight.alwaysTokens / 1e6) * main.input;
  const { claudeMdText, agentsMdText, ...w } = weight;
  return {
    pricesAsOf: PRICES_AS_OF,
    aliases: ALIASES,
    weight: { ...w, always: w.always.map((x) => ({ ...x, path: redact(x.path) })), startUsd, startUsdCached: startUsd * 0.1 },
    agents,
    usage,
    circle,
    issues,
  };
}
