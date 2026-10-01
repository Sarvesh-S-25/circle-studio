// Running other programs: never through a shell, always with a clean environment, always killable
// as a whole tree.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// Variables that must never reach a child: credentials and the markers of a parent Claude Code session.
const STRIP = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_OAUTH_TOKEN',
];

export function cleanEnv(base = process.env) {
  const env = { ...base };
  for (const k of STRIP) delete env[k];
  return env;
}

/**
 * Stop `child` and every process it started (recipe verified in tests/fixtures/claude/spawn-kill-probe.mjs).
 * Windows: `taskkill /PID <pid> /T /F` without a shell. Call while the child is still alive.
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
    tk.on('error', (e) => fallback(`taskkill spawn error ${e.code || e.message}`));
    tk.on('close', (code) => (code === 0 || code === 128 ? done({ ok: true, method: 'taskkill', code }) : fallback(`taskkill exit ${code}`)));
  });
}

/**
 * Run a program to completion. No shell. Output is capped. Resolves { code, stdout, stderr, timedOut, error? }.
 */
export function runCommand(cmd, args, { cwd, timeoutMs = 30_000, maxBytes = 256 * 1024, env, input } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || cleanEnv(), windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: e.code || e.message });
      return;
    }
    const out = { stdout: '', stderr: '' };
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let timedOut = false;
    let finished = false;
    const finish = (r) => { if (!finished) { finished = true; clearTimeout(timer); resolve(r); } };
    const collect = (name) => (chunk) => {
      if (out[name].length < maxBytes) out[name] += decoders[name].write(chunk);
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (e) => finish({ code: null, ...out, timedOut, error: e.code || e.message }));
    child.on('close', (code) => finish({ code, ...out, timedOut }));
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    if (input !== undefined) child.stdin.end(input);
  });
}
