#!/usr/bin/env node
// Reusable probe: how to stop a spawned `claude` (or any process tree) reliably on Windows.
//
//   node spawn-kill-probe.mjs --fake [--method kill|taskkill|both] [--detached]
//        No model call. Builds a 3-level tree of node.exe processes (root -> child -> grandchild),
//        stops it with the chosen method and reports which PIDs survived (checked with tasklist).
//        --detached spawns the grandchild with { detached: true } (it escapes libuv's kill-on-close job object),
//        which is the case where child.kill() leaves an orphan and taskkill /T /F does not.
//
//   node spawn-kill-probe.mjs --live [--method kill|taskkill] [--tree] [--claude <path>] [--cwd <dir>]
//        ONE real, cheap claude call (haiku). Spawns claude with child_process.spawn (no shell), sends the prompt on
//        stdin, waits for the first text delta (i.e. stops it mid-stream), stops it with the chosen method and reports
//        the descendants that were alive at the moment of the kill and the ones still alive afterwards.
//        --tree keeps the default settings/MCP servers so claude has a real subprocess tree (npx/node MCP servers);
//        without it the lean read-only argv the app uses is run (claude.exe has no children then).
//        The call is aborted after the first text delta, so it costs a fraction of a cent.
//
// What it proves (see docs/research/claude-live.md, "Kill recipe"):
//   * child.kill() on Windows is TerminateProcess on that ONE pid. Plain Node-spawned descendants still die with it
//     (libuv puts them in a kill-on-close job object), but a detached descendant, or one started outside that job,
//     is NOT touched and becomes an orphan.
//   * `taskkill /PID <pid> /T /F` walks the parent-pid links at call time and terminates the whole tree.
//   * tasklist can confirm the result; never kill by image name (other claude.exe/node.exe belong to other sessions).
//
// Reuse: `import { killTree } from './spawn-kill-probe.mjs'` (the import does not run the demo).
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

// ---------------------------------------------------------------- recipe (copy this into backend/lib/run.mjs)
/**
 * Stop `child` and every process it started. Resolves { ok, method, code }.
 * - Windows: `taskkill /PID <pid> /T /F` (no shell). Exit 0 = tree terminated, 128 = pid already gone.
 *   If taskkill cannot run or fails, falls back to child.kill() (root only) and says so (ok:false).
 * - POSIX: SIGKILL to the process group when the child was spawned with { detached: true }, else to the child.
 * Call it while the child is still alive: once the root has exited, its children can no longer be found.
 */
export function killTree(child, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      resolve({ ok: true, method: 'already-exited' });
      return;
    }
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      resolve({ ok: true, method: 'sigkill' });
      return;
    }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const fallback = (why) => { try { child.kill(); } catch { /* gone */ } done({ ok: false, method: 'child.kill-fallback', why }); };
    const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => fallback('taskkill timed out'), timeoutMs);
    tk.on('error', (e) => fallback('taskkill spawn error ' + (e.code || e.message)));
    tk.on('close', (code) => (code === 0 || code === 128 ? done({ ok: true, method: 'taskkill', code }) : fallback('taskkill exit ' + code)));
  });
}

// ---------------------------------------------------------------- verification helpers (tests only)
export function listProcesses() {
  const ps = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  try { const j = JSON.parse(r.stdout); return Array.isArray(j) ? j : [j]; } catch { return []; }
}
export function descendantsOf(rootPid, procs = listProcesses()) {
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  const out = []; const queue = [rootPid]; const seen = new Set(queue);
  while (queue.length) for (const c of kids.get(queue.shift()) || []) if (!seen.has(c.ProcessId)) { seen.add(c.ProcessId); out.push({ pid: c.ProcessId, ppid: c.ParentProcessId, name: c.Name }); queue.push(c.ProcessId); }
  return out;
}
// tasklist is the cheap existence check (the brief asks for it); note: in Git Bash use MSYS_NO_PATHCONV=1, in Node no such issue
export function isAlive(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  return new RegExp(`"${pid}"`).test(r.stdout || '');
}
export function forceKillPids(pids) { for (const p of pids) spawnSync('taskkill', ['/PID', String(p), '/F'], { windowsHide: true }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- demos
async function fakeDemo(method, { detached = false } = {}) {
  const grand = "setInterval(()=>{},1000)";
  const child = `const {spawn}=require('child_process');const g=spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:'ignore',windowsHide:true${detached ? ',detached:true' : ''}});console.log('GRAND '+g.pid);setInterval(()=>{},1000)`;
  const root = `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','pipe','ignore'],windowsHide:true});c.stdout.on('data',d=>process.stdout.write(d));console.log('CHILD '+c.pid);setInterval(()=>{},1000)`;
  const p = spawn(process.execPath, ['-e', root], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let out = ''; const dec = new StringDecoder('utf8'); p.stdout.on('data', (d) => { out += dec.write(d); });
  for (let i = 0; i < 50 && !/GRAND \d+/.test(out); i++) await sleep(100);
  const childPid = Number((/CHILD (\d+)/.exec(out) || [])[1]); const grandPid = Number((/GRAND (\d+)/.exec(out) || [])[1]);
  const pids = [p.pid, childPid, grandPid];
  const before = pids.map(isAlive);
  const t0 = Date.now();
  let killRes;
  if (method === 'kill') { p.kill(); killRes = { ok: true, method: 'child.kill' }; } else killRes = await killTree(p);
  const killMs = Date.now() - t0;
  await sleep(700);
  const after = pids.map(isAlive);
  const report = { mode: 'fake', detachedGrandchild: detached, method: method === 'kill' ? 'child.kill()' : 'taskkill /T /F (killTree)', pids: { root: p.pid, child: childPid, grandchild: grandPid }, aliveBefore: before, aliveAfter: after, killMs, killRes, orphans: pids.filter((_, i) => after[i]), exit: { code: p.exitCode, signal: p.signalCode } };
  forceKillPids(report.orphans); // never leave anything behind
  return report;
}

async function liveDemo(method, { claude, cwd, tree }) {
  const lean = ['--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--allowedTools', 'Read,Grep,Glob', '--tools', 'Read,Grep,Glob', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--disable-slash-commands'];
  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--model', 'haiku', ...(tree ? ['--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Glob'] : lean)];
  const env = { ...process.env }; for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_EXECPATH']) delete env[k];
  const child = spawn(claude, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const t0 = Date.now(); let buf = ''; let stderr = ''; const dec = new StringDecoder('utf8'); let gotDelta = false; let deltas = 0;
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end('Write the integers from 1 to 300 separated by commas, in plain text, with no other words.');
  const report = { mode: 'live', method: method === 'kill' ? 'child.kill()' : 'taskkill /T /F (killTree)', argv: ['claude', ...args], rootPid: child.pid };
  await new Promise((resolve) => {
    child.stdout.on('data', async (d) => {
      buf += dec.write(d); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'stream_event' && o.event && o.event.delta && o.event.delta.type === 'text_delta') deltas++;
        if (!gotDelta && deltas > 0) {
          gotDelta = true; report.firstDeltaMs = Date.now() - t0;
          const procs = listProcesses(); const tree = descendantsOf(child.pid, procs);
          report.descendantsAtKill = tree; const pids = [child.pid, ...tree.map((p) => p.pid)];
          const k0 = Date.now();
          report.killRes = method === 'kill' ? (child.kill(), { ok: true, method: 'child.kill' }) : await killTree(child);
          report.killMs = Date.now() - k0;
          await sleep(2500);
          report.aliveAfter = pids.filter(isAlive);
          report.orphans = report.aliveAfter.filter((p) => p !== child.pid);
          forceKillPids(report.aliveAfter);
          resolve();
        }
      }
    });
    child.on('close', (code, signal) => { report.exit = { code, signal }; if (!gotDelta) { report.note = 'process ended before any text delta; stderr: ' + stderr.slice(0, 300); resolve(); } });
    child.on('error', (e) => { report.error = e.code || e.message; resolve(); });
    setTimeout(() => { if (!gotDelta) { report.note = 'timeout waiting for first delta'; killTree(child).then(resolve); } }, 240000);
  });
  await sleep(300);
  report.exit = report.exit || { code: child.exitCode, signal: child.signalCode };
  return report;
}

// ---------------------------------------------------------------- CLI
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2); const has = (f) => a.includes(f); const val = (f, d) => (a.includes(f) ? a[a.indexOf(f) + 1] : d);
  if (process.platform !== 'win32') console.error('note: the taskkill recipe is Windows-only; this probe is meant for Windows 11');
  const method = val('--method', 'both');
  if (has('--live')) {
    const claude = val('--claude', 'claude'); const cwd = val('--cwd', process.cwd());
    const methods = method === 'both' ? ['kill', 'taskkill'] : [method];
    for (const m of methods) console.log(JSON.stringify(await liveDemo(m, { claude, cwd, tree: has('--tree') }), null, 1));
  } else {
    const methods = method === 'both' ? ['kill', 'taskkill'] : [method];
    const variants = has('--detached') ? [true] : [false, true];
    for (const d of variants) for (const m of methods) console.log(JSON.stringify(await fakeDemo(m, { detached: d }), null, 1));
  }
}
