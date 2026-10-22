// Opening a project, and the file an agent is working on, in your editor: Antigravity IDE when it is installed, else
// VS Code. Each is started through its own command line (cli.js run by its own exe, the way its .cmd does), never
// through a shell, with the folder and the file as plain arguments. Only a file inside the project is ever opened.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cleanEnv } from './run.mjs';

const EDITORS = [
  { name: 'Antigravity IDE', dir: ['Antigravity IDE'], exe: 'Antigravity IDE.exe' },
  { name: 'VS Code', dir: ['Microsoft VS Code'], exe: 'Code.exe' },
];

/** The editor to open things in, or null: { name, exe, cli }. */
export function findEditor(env = process.env) {
  const roots = [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.ProgramFiles].filter(Boolean);
  for (const e of EDITORS) {
    for (const r of roots) {
      const home = path.join(r, ...e.dir);
      const exe = path.join(home, e.exe);
      const cli = path.join(home, 'resources', 'app', 'out', 'cli.js');
      if (fs.existsSync(exe) && fs.existsSync(cli)) return { name: e.name, exe, cli };
    }
  }
  return null;
}

/**
 * The file an agent last worked on, from its tool lines ("Edit src/a.js", "Write ...", "Read ..."), newest first:
 * a written file before a read one. A path outside the folder, or one that is gone, is skipped. Returns a full path.
 */
export function workingFile(root, toolLines) {
  const lines = toolLines.slice().reverse();
  for (const want of [/^(?:Edit|Write|MultiEdit) (.+)$/, /^Read (.+)$/]) {
    for (const l of lines) {
      const m = want.exec(String(l || '').trim());
      if (!m) continue;
      const abs = path.resolve(root, m[1]);
      const rel = path.relative(root, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      try { if (fs.statSync(abs).isFile()) return abs; } catch { /* gone */ }
    }
  }
  return null;
}

/** Open the folder (a file in it, and other pages such as the chat) in the editor. { opened, editor, file } or { opened: false, why }. */
export function openInEditor({ folder, file = null, also = [], editor = findEditor(), spawnImpl = spawn }) {
  if (!editor) return { opened: false, why: 'Neither Antigravity IDE nor VS Code is installed for this Windows user.' };
  const args = [editor.cli, folder, ...also, ...(file ? ['--goto', file] : [])];
  const env = { ...cleanEnv(), ELECTRON_RUN_AS_NODE: '1' };
  delete env.VSCODE_DEV;
  const child = spawnImpl(editor.exe, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
  child.on?.('error', () => {});
  child.unref?.();
  return { opened: true, editor: editor.name, file };
}
