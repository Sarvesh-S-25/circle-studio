#!/usr/bin/env node
// Circle Studio: condense long tool output for the agents you chose (Workflow, the agent, its Haiku reader, "automatic").
// A Claude Code PostToolUse hook. When the agent's context is fuller than its limit and a tool answered with a lot of
// text (a command's output, a web page, search results, an MCP tool), Haiku reads it and the agent gets a short version
// instead, with the path of the full output so it can read exact lines when it needs them. Files the agent reads with
// Read are never condensed: it may edit them and needs the exact text. Anything unexpected leaves the output as it was.
// Settings: circle-condense.json next to this file (written by Circle Studio). Node built-ins only; no shell.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHARS_PER_TOKEN = 4;
const pass = () => process.exit(0); // leave the output alone

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function stdin() {
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

/** How full the context is: the last answer's input (fresh + cached) over the window, from the transcript's tail. */
function contextShare(file, window) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('"usage"')) continue;
      try {
        const u = JSON.parse(line)?.message?.usage;
        if (!u) continue;
        const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        return used / window;
      } catch { /* a partial line at the cut */ }
    }
  } catch { /* no transcript */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

/** The transcript of this agent: a subagent writes its own (<session>/subagents/agent-<id>.jsonl) next to the main one. */
function transcriptOf(input) {
  const main = input.transcript_path;
  if (!main || !input.agent_id) return main;
  const dir = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents');
  const own = path.join(dir, `agent-${input.agent_id}.jsonl`);
  return fs.existsSync(own) ? own : main;
}

/** The text a tool answered with. */
function outputText(r) {
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return '';
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') return [r.stdout, r.stderr].filter(Boolean).join('\n');
  for (const k of ['result', 'output', 'content', 'text']) if (typeof r[k] === 'string') return r[k];
  if (Array.isArray(r.content)) return r.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return JSON.stringify(r, null, 1);
}

/**
 * The tool's answer with its text replaced, in the same shape (Claude Code keeps the original when the shape differs:
 * a command answers { stdout, stderr, ... }, a page { result, ... }). Null when the shape is unknown: then nothing changes.
 */
export function reshape(r, text) {
  if (typeof r === 'string') return text;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.stdout === 'string' || typeof r.stderr === 'string') return { ...r, stdout: text, stderr: '' };
  for (const k of ['result', 'output', 'content', 'text']) if (typeof r[k] === 'string') return { ...r, [k]: text };
  if (Array.isArray(r.content)) return { ...r, content: [{ type: 'text', text }] };
  return null;
}

/** Claude Code's own program, without a shell: claude.exe, or the script behind npm's claude.cmd. */
function claudeCli() {
  // tests: a stand-in for Claude, so a test never calls the real one
  if (process.env.CIRCLE_CONDENSE_TEST_CLI) return { bin: process.execPath, prefix: [process.env.CIRCLE_CONDENSE_TEST_CLI] };
  if (process.platform !== 'win32') return { bin: 'claude', prefix: [] };
  const dirs = [...String(process.env.PATH || process.env.Path || '').split(path.delimiter), process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), path.join(os.homedir(), '.local', 'bin')].filter(Boolean);
  for (const d of dirs) { const exe = path.join(d, 'claude.exe'); if (fs.existsSync(exe)) return { bin: exe, prefix: [] }; }
  for (const d of dirs) {
    const cmd = path.join(d, 'claude.cmd');
    if (!fs.existsSync(cmd)) continue;
    const m = /"%dp0%\\([^"]+\.js)"/.exec(fs.readFileSync(cmd, 'utf8'));
    if (m && fs.existsSync(path.join(d, m[1]))) return { bin: process.execPath, prefix: [path.join(d, m[1])] };
  }
  return null;
}

function haiku(prompt, timeoutMs) {
  const cli = claudeCli();
  if (!cli) return Promise.resolve(null);
  return new Promise((resolve) => {
    // in a neutral folder, so this project's settings and hooks do not run again; marked so it never condenses itself
    const child = spawn(cli.bin, [...cli.prefix, '-p', '--model', 'haiku', '--max-turns', '1', '--output-format', 'text'], { cwd: os.tmpdir(), env: { ...process.env, CIRCLE_CONDENSING: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 && out.trim() ? out.trim() : null); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

async function main() {
  if (process.env.CIRCLE_CONDENSING) pass();
  const cfg = readJson(path.join(HERE, 'circle-condense.json'));
  if (!cfg) pass();
  let input;
  try { input = JSON.parse(await stdin()); } catch { pass(); }
  if (input.hook_event_name !== 'PostToolUse' || input.tool_name === 'Read') pass();
  const who = input.agent_type || 'main';
  const rule = cfg.agents?.[who];
  if (!rule) pass();
  const text = outputText(input.tool_response);
  const tokens = Math.round(text.length / CHARS_PER_TOKEN);
  if (tokens < (cfg.minTokens || 4000) || reshape(input.tool_response, '') === null) pass();
  const share = contextShare(transcriptOf(input), cfg.window || Number(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS) || 200_000);
  const above = (rule.above ?? 60) / 100;
  if (share !== null && share < above) pass();

  // keep the full output where the agent can read it
  const dir = input.scratchpad_dir && fs.existsSync(input.scratchpad_dir) ? path.join(input.scratchpad_dir, 'condensed') : path.join(os.tmpdir(), 'circle-condensed', String(input.session_id || 'session').replace(/[^\w-]/g, ''));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(input.tool_name).replace(/[^\w-]/g, '_')}.txt`);
  fs.writeFileSync(file, text);

  const asked = JSON.stringify(input.tool_input || {}).slice(0, 600);
  const summary = await haiku([
    `An AI coding agent ran the tool ${input.tool_name} with ${asked}. Its output is below. Condense it for that agent.`,
    'Keep everything it needs to act: errors and warnings word for word, failing test names, file paths with line numbers, numbers, versions, commands, and the overall result. Drop repetition, progress lines and noise. At most 30 lines. Do not add advice.',
    '', '<output>', text.slice(0, 400_000), '</output>',
  ].join('\n'), cfg.timeoutMs || 45_000);
  if (!summary) pass();

  const now = Math.round(summary.length / CHARS_PER_TOKEN);
  const pct = share === null ? '' : ` (the context was ${Math.round(share * 100)}% full)`;
  const note = `[Circle Studio condensed: ${input.tool_name} output was ${tokens} tokens, now ${now}${pct}. The full output is in ${file}; read the exact lines from there when you need them.]`;
  const answer = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: reshape(input.tool_response, `${note}\n\n${summary}`) } });
  process.stdout.write(answer, () => process.exit(0)); // wait for the pipe: exiting at once can cut the answer on Windows
}

// run as a hook (not when a test imports it)
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch(() => pass());
