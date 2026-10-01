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

const first = (text) => (text || '').trim().split('\n')[0].trim() || null;

/** Run a CLI once for its version line (no model call). */
export async function versionOf(bin, args = ['--version'], timeoutMs = 10_000) {
  const r = await runCommand(bin, args, { timeoutMs });
  if (r.error === 'ENOENT') return { installed: false, version: null };
  return { installed: true, version: first(r.stdout) || first(r.stderr) };
}
