// Starting engine CLIs: never through a shell, always with a clean environment, always killable as a tree.
// Also the line reader every engine protocol here uses (one JSON object per line).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { cleanEnv, killTree, runCommand } from '../run.mjs';

export { killTree, runCommand };

/**
 * Start a CLI. `bin` may be a name on PATH (resolved by the OS, .exe only) or an absolute path. Returns the child or
 * throws. `extraEnv` adds variables for this run (keys from the vault); credentials are still stripped by cleanEnv.
 */
export function startChild(bin, args, { cwd, env, extraEnv } = {}) {
  return spawn(bin, args, { cwd, env: cleanEnv({ ...(env || process.env), ...(extraEnv || {}) }), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Feed `onLine` every complete line of a stream. Returns a flush function for the last partial line. */
export function lineReader(stream, onLine) {
  const dec = new StringDecoder('utf8');
  let buf = '';
  stream.on('data', (chunk) => {
    buf += dec.write(chunk);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  return () => {
    const rest = (buf + dec.end()).trim();
    buf = '';
    if (rest) onLine(rest);
  };
}

export const parseLine = (line) => {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
};

/** The GitHub Copilot CLI is run as `node npm-loader.js` (the .cmd shim needs a shell). Null when it is not installed. */
export function copilotLoader(env = process.env) {
  const candidates = [
    env.CIRCLE_COPILOT_LOADER,
    env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@github', 'copilot', 'npm-loader.js'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@github', 'copilot', 'npm-loader.js'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Find a CLI the way a terminal would, without a shell: an .exe on PATH or in the usual install folders (so a tool
 * installed while Circle Studio runs is found without a restart), or an npm .cmd launcher, which is read to run its
 * real target: `node <script>` or the .exe it points at. Returns { bin, prefix } or null when it is not installed.
 * Names other than these few are never resolved: this only ever starts what the engines and gh are.
 */
export function resolveCli(name, env = process.env) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(name)) return null;
  if (process.platform !== 'win32') return { bin: name, prefix: [] };
  const home = os.homedir();
  const extra = [
    env.APPDATA && path.join(env.APPDATA, 'npm'),
    path.join(home, 'AppData', 'Roaming', 'npm'),
    path.join(home, '.local', 'bin'), // Claude Code's own installer
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, name, 'bin'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'GitHub CLI'),
  ];
  const dirs = [...new Set([...String(env.PATH || env.Path || '').split(path.delimiter), ...extra].filter(Boolean).map((d) => d.replace(/^"|"$/g, '')))];
  for (const d of dirs) {
    const exe = path.join(d, `${name}.exe`);
    if (isFile(exe)) return { bin: exe, prefix: [] };
  }
  for (const d of dirs) {
    const cmd = path.join(d, `${name}.cmd`);
    if (!isFile(cmd)) continue;
    let text = '';
    try { text = fs.readFileSync(cmd, 'utf8'); } catch { continue; }
    const line = text.split(/\r?\n/).reverse().find((l) => l.includes('%dp0%\\'));
    const m = line && /"%dp0%\\([^"]+)"/.exec(line);
    if (!m) continue;
    const target = path.resolve(d, m[1]);
    if (!target.startsWith(path.resolve(d)) || !isFile(target)) continue;
    if (/\.exe$/i.test(target)) return { bin: target, prefix: [] };
    if (line.includes('%_prog%')) return { bin: process.execPath, prefix: [target] }; // npm's "run it with node"
  }
  return null;
}
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

const first = (text) => (text || '').trim().split('\n')[0].trim() || null;

/** Run a CLI once for its version line (no model call). */
export async function versionOf(bin, args = ['--version'], timeoutMs = 10_000) {
  const r = await runCommand(bin, args, { timeoutMs });
  if (r.error === 'ENOENT') return { installed: false, version: null };
  return { installed: true, version: first(r.stdout) || first(r.stderr) };
}
