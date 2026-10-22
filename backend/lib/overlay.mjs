// The overlay (Ctrl+Alt+C, like the Xbox Game Bar): the screen dims, panels show what goes on, and a command box takes
// what you type. This file is the part that can be tested without a screen: reading a command, finding the
// project or agent it names, the PC's numbers and the small panels the overlay draws. The desktop host
// (scripts/widgets/desktop-widgets.ps1) only lays the panels out; routes.overlay.mjs runs the commands.
import os from 'node:os';

// Every command, as the help lists it. `words` are what you can type first; the rest of the line is its argument.
// who asks, when it is not a workflow agent: the engine by name
const ENGINE_NAMES = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot', gemini: 'Gemini' };

export const COMMANDS = [
  { id: 'help', words: ['help', '?', 'commands'], use: 'help', says: 'Everything you can type' },
  { id: 'project', words: ['project', 'use', 'switch', 'p'], use: 'project <name>', says: 'Show another project here' },
  { id: 'open', words: ['open', 'go', 'show'], use: 'open <page or project>', says: 'Open Circle Studio there: home, inbox, settings, widgets, mods, chat, workflow, history' },
  { id: 'chat', words: ['chat'], use: 'chat', says: "Open this project's chat window" },
  { id: 'ask', words: ['ask', 'say', 'tell'], use: 'ask <message>', says: "Send it to this project's main chat (plain text works too)" },
  { id: 'newchat', words: ['new', 'fresh'], use: 'new', says: 'Start a new chat in this project' },
  { id: 'chats', words: ['chats', 'conversations', 'history', 'earlier'], use: 'chats', says: 'Earlier conversations in this folder (terminal, IDE or here), numbered' },
  { id: 'continue', words: ['continue', 'resume'], use: 'continue [number or words]', says: 'Carry on an earlier conversation (the last one, or that one)' },
  { id: 'folder', words: ['folder', 'add'], use: 'folder', says: 'Choose another folder to work in' },
  { id: 'run', words: ['run', 'start'], use: 'run <agent> <message>', says: 'Give one agent of the workflow some work' },
  { id: 'stop', words: ['stop', 'cancel'], use: 'stop [agent]', says: 'Stop what runs in this project' },
  { id: 'waiting', words: ['waiting', 'inbox', 'asks', 'pending'], use: 'waiting', says: 'What waits for you, numbered' },
  { id: 'allow', words: ['allow', 'yes', 'ok', 'approve'], use: 'allow [number]', says: 'Allow what waits (the first, or that number)' },
  { id: 'deny', words: ['deny', 'no', 'refuse'], use: 'deny [number]', says: 'Refuse it' },
  { id: 'answer', words: ['answer', 'reply'], use: 'answer [number] <answer>', says: 'Answer a question (an option number works)' },
  { id: 'running', words: ['running', 'status', 'now'], use: 'running', says: 'What works right now' },
  { id: 'workflow', words: ['workflow', 'stages', 'team'], use: 'workflow', says: 'Where the workflow is' },
  { id: 'usage', words: ['usage', 'spend', 'spending', 'cost'], use: 'usage', says: 'Spending and use, 30 days' },
  { id: 'git', words: ['git', 'branch', 'changes'], use: 'git', says: 'Branch and changed files (read only)' },
  { id: 'pc', words: ['pc', 'cpu', 'memory', 'perf'], use: 'pc', says: "This PC's processor and memory" },
  { id: 'mods', words: ['mods', 'mod', 'plugins'], use: 'mods  ·  mod check <name>', says: 'Your mods, or check one with Claude Code' },
  { id: 'hide', words: ['hide', 'close', 'exit', 'esc', 'bye'], use: 'hide', says: 'Put everything back (Esc or Ctrl+Alt+C too)' },
];
const BY_WORD = new Map(COMMANDS.flatMap((c) => c.words.map((w) => [w, c.id])));

// The pages `open` knows, and the Circle Studio address of each (a project page needs the project).
export const PAGES = {
  home: '#/', folder: '#/open-folder', inbox: '#/inbox', settings: '#/settings', widgets: '#/widgets', mods: '#/mods', skills: '#/skills',
  templates: '#/templates', connections: '#/connections', usage: '#/usage',
  chat: 'project:chat', workflow: 'project:workflow', history: 'project:history', plan: 'project:plan', health: 'project:health',
};

/**
 * What a typed line asks for: `{ id, rest }`. A line that starts with no known word is sent to the chat when it reads
 * like a sentence (two words or more, or ending in "?"); one unknown word is a typo, not a message, so it is `unknown`.
 */
/** In a chat box: `/waiting`, `/allow 1`... are Circle Studio's commands; anything else (a sentence, `/compact`, a
 * project's own slash command, or `//waiting` to send the word itself) goes to the agent. Null when it is not ours. */
export function chatCommand(text) {
  const line = String(text ?? '').trim();
  if (!line.startsWith('/') || line.startsWith('//')) return null;
  const first = (/^\/(\S+)/.exec(line)?.[1] || '').toLowerCase().replace(/[:,]$/, '');
  return BY_WORD.has(first) ? parseCommand(line) : null;
}

export function parseCommand(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return { id: 'empty', rest: '' };
  if (line.startsWith('/')) return parseCommand(line.slice(1));
  if (line.startsWith('@')) return { id: 'run', rest: line.slice(1) }; // @planner do this
  const m = /^(\S+)\s*(.*)$/.exec(line);
  const first = m[1].toLowerCase().replace(/[:,]$/, '');
  const id = BY_WORD.get(first);
  if (id) return { id, rest: m[2].trim() };
  if (line.includes(' ') || line.endsWith('?')) return { id: 'ask', rest: line };
  return { id: 'unknown', rest: line };
}

const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** The one item whose name or id best matches `q`: exact, then starts with, then contains. Null when none or unsure. */
export function findByName(list, q, names = (x) => [x.name, x.id]) {
  const want = fold(q);
  if (!want) return null;
  for (const test of [(n) => n === want, (n) => n.startsWith(want), (n) => n.includes(want)]) {
    const hits = list.filter((x) => names(x).some((n) => n && test(fold(n))));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return { ambiguous: hits };
  }
  return null;
}

/** `run planner: write the plan` -> the agent named first and the message after it (a ":" may separate them). */
export function splitAgent(rest, agents) {
  const words = String(rest || '').split(' ');
  // the longest run of first words that names one agent ("code reviewer fix it" finds "Code reviewer")
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    const name = words.slice(0, n).join(' ').replace(/[:,]$/, '');
    const hit = findByName(agents, name, (a) => [a.title, a.id]);
    if (hit && !hit.ambiguous) return { agent: hit, message: words.slice(n).join(' ').replace(/^[:,-]\s*/, '').trim() };
  }
  return { agent: null, message: String(rest || '').trim() };
}

/** `answer 2 yes please` -> which waiting request (1-based, default the first) and the words. */
export function splitNumber(rest) {
  const m = /^#?(\d{1,2})\b\s*(.*)$/.exec(String(rest || '').trim());
  return m ? { n: Number(m[1]), text: m[2].trim() } : { n: 1, text: String(rest || '').trim() };
}

// ---- this PC ----------------------------------------------------------------------------------------------------
// The processor share is measured between two looks (os.cpus() counts time since boot), so the first look after start
// compares with a short sample taken then. Memory is what Windows reports as in use.
let lastCpu = null;
const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
export function pcStats({ now = Date.now() } = {}) {
  const cur = cpuTimes();
  let cpu = null;
  if (lastCpu && cur.total > lastCpu.total) cpu = Math.round(100 * (1 - (cur.idle - lastCpu.idle) / (cur.total - lastCpu.total)));
  lastCpu = cur;
  const total = os.totalmem();
  const used = total - os.freemem();
  const gb = (b) => Math.round((b / 1024 ** 3) * 10) / 10;
  const up = Math.round(os.uptime() / 60);
  return {
    cpu: cpu === null ? null : Math.max(0, Math.min(100, cpu)),
    cores: os.cpus().length,
    cpuName: (os.cpus()[0]?.model || '').replace(/\s+/g, ' ').replace(/\(R\)|\(TM\)|CPU|Processor/gi, '').replace(/\s+/g, ' ').trim().slice(0, 48),
    memPct: Math.round((used / total) * 100),
    memUsedGb: gb(used),
    memTotalGb: gb(total),
    uptime: up < 60 ? `${up} min` : up < 1440 ? `${Math.floor(up / 60)} h ${up % 60} min` : `${Math.floor(up / 1440)} d ${Math.floor((up % 1440) / 60)} h`,
    at: new Date(now).toISOString(),
  };
}
pcStats(); // the first sample, so the first real look already has a share

// ---- the panels ---------------------------------------------------------------------------------------------------
const usd = (n) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 100 ? `$${Math.round(n)}` : `$${(n || 0).toFixed(2)}`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const STATE_WORD = { working: 'Working', waiting: 'Needs you', done: 'Done', idle: 'Not started' };

/** What waits for you, numbered the way `allow 2` and `answer 2 ...` count. */
export function waitingPanel(pending, nameOf) {
  return pending.map((r, i) => {
    const q = r.kind === 'question' ? (r.questions || [])[0] : null;
    return {
      n: i + 1, id: r.id, kind: r.kind, project: r.source === 'terminal' ? `${r.folderName} (terminal)` : nameOf(r.projectId), who: r.nodeId || ENGINE_NAMES[r.engine] || 'the agent',
      title: clip(q ? q.question : r.title, 120), detail: r.kind === 'approval' ? clip(r.detail, 140) : '',
      options: q ? (q.options || []).slice(0, 4).map((o, k) => `${k + 1}. ${clip(o.label, 40)}`) : [],
      outside: r.risk === 'outside-project',
    };
  });
}

/** Widgets that can be added to the overlay from its Widgets menu (the rest of the board's kinds are panels already). */
/**
 * While an answer comes in, the bar shows it as "live"; real Claude Code has already written that turn (your message and
 * the start of the answer) into the conversation the list is read from, so that copy is left out: once, not twice.
 */
export function withoutLive(talk, live) {
  if (!talk || !live || live.done || !live.you) return talk;
  const you = String(live.you).slice(0, 200); // the list cuts long messages
  const at = talk.messages.findLastIndex((m) => m.mine && String(m.text).slice(0, 200) === you);
  return at < 0 ? talk : { ...talk, messages: talk.messages.slice(0, at) };
}

export const OVERLAY_EXTRAS = [
  { kind: 'pulse', label: 'Activity rings' },
  { kind: 'status', label: 'Agents' },
  { kind: 'project', label: 'Project at a glance' },
  { kind: 'overview', label: 'All projects' },
  { kind: 'mods', label: 'Mods' },
];

/** The projects for the switcher, in their usual order: whether each needs you, works or is quiet, in a few words. */
export function projectChoices(list, running = [], pending = [], currentId = null) {
  return list.map((p) => {
    const waiting = pending.filter((r) => r.projectId === p.id).length;
    const runs = running.filter((r) => r.projectId === p.id).length;
    const state = waiting ? 'waiting' : runs ? 'working' : 'idle';
    const word = waiting ? `${plural(waiting, 'thing')} ${waiting === 1 ? 'waits' : 'wait'} for you` : runs ? (runs === 1 ? 'Working' : `${runs} running`) : 'Quiet';
    return { id: p.id, name: p.name, state, word, waiting, running: runs, current: p.id === currentId };
  });
}

/** The workflow, drawn small: each stage in order with its state and a dot per agent, and the line between them. */
export function workflowMap(wf) {
  if (!wf || !wf.stages?.length) return null;
  const stages = wf.stages.slice(0, 10).map((s, i) => ({
    n: i + 1, title: clip(s.title, 18), state: s.state, word: STATE_WORD[s.state] || '',
    agents: (s.who || []).slice(0, 6).map((a) => ({ title: clip(a.title, 24), state: a.state })),
    checkpoint: Boolean(s.checkpoint),
  }));
  const done = wf.stages.filter((s) => s.state === 'done').length;
  const cur = wf.stages.find((s) => s.state === 'waiting' || s.state === 'working');
  return { stages, more: Math.max(0, wf.stages.length - stages.length), done, total: wf.stages.length, now: cur ? `${cur.title}: ${STATE_WORD[cur.state].toLowerCase()}` : done === wf.stages.length ? 'Every stage is done' : 'Nothing running' };
}

/** Spending in a few words: Claude at API prices over 30 days, today, and the other engines' use. */
export function usagePanel(u) {
  if (!u) return null;
  const c = u.providers.find((p) => p.id === 'claude');
  const day = (c?.byDay || []).at(-1); // the list ends with today
  return {
    total: usd(c?.usd || 0), today: usd(day?.usd || 0), note: 'Claude at API prices, 30 days',
    rows: u.providers.map((p) => ({ label: p.label, value: p.measured === 'usd' ? usd(p.usd) : p.measured === 'tokens' ? ((t) => (t >= 1e6 ? `${(t / 1e6).toFixed(1)}M tokens` : t >= 1000 ? `${Math.round(t / 1000)}k tokens` : plural(t, 'token')))(p.tokensIn + p.tokensOut) : plural(p.turns || 0, 'turn') })),
    bars: (c?.byDay || []).slice(-14).map((d) => d.usd || 0),
  };
}

/** Git in a few words, read only. */
export function gitPanel(repo) {
  if (!repo?.isRepo) return { isRepo: false, line: 'Not a git folder.' };
  return {
    isRepo: true, branch: repo.branch || '(no branch)', changed: repo.changed || 0, ahead: repo.ahead || 0, behind: repo.behind || 0,
    line: [repo.changed ? `${plural(repo.changed, 'file')} changed` : 'nothing changed', repo.ahead ? `${repo.ahead} to push` : '', repo.behind ? `${repo.behind} to pull` : ''].filter(Boolean).join(' · '),
    last: repo.lastCommit ? clip(repo.lastCommit.subject, 70) : '',
  };
}

/** Help, as lines. */
export const helpLines = () => COMMANDS.map((c) => `${c.use.padEnd(26)} ${c.says}`);
