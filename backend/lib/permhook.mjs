// "Answer Claude Code's terminal questions on the desktop": Circle Studio's PermissionRequest hook in your Claude Code
// settings (~/.claude/settings.json). Shown before it is changed, the file backed up first, removed in one click; any
// other hook you have is kept as it is.
import fs from 'node:fs';
import path from 'node:path';

const MARK = 'permission-hook.mjs';
const ours = (entry) => (entry?.hooks || []).some((h) => typeof h?.command === 'string' && h.command.includes(MARK));

function read(claudeHome) {
  const file = path.join(claudeHome, 'settings.json');
  try { return { file, settings: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return { file, settings: e.code === 'ENOENT' ? {} : null }; }
}

/** The entry this app adds: every request (matcher *), up to 10 minutes to answer. */
export function hookEntry({ appRoot, nodePath = process.execPath, port = 4380 }) {
  const cmd = `"${nodePath}" "${path.join(appRoot, 'scripts', MARK)}"${port !== 4380 ? ` --port ${port}` : ''}`;
  return { matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 600 }] };
}

/** { on, canSet, why, before, after } for the preview (before and after: the PermissionRequest hooks). */
export function permHookState({ claudeHome, appRoot, nodePath = process.execPath, port = 4380 }) {
  const { settings } = read(claudeHome);
  if (!settings) return { on: false, canSet: false, why: 'Your Claude Code settings file could not be read.' };
  const list = Array.isArray(settings.hooks?.PermissionRequest) ? settings.hooks.PermissionRequest : [];
  const on = list.some(ours);
  const after = on ? list.filter((e) => !ours(e)) : [...list, hookEntry({ appRoot, nodePath, port })];
  return { on, canSet: true, before: list, after };
}

/** Turn it on or off. The settings file is copied to Circle Studio's backups first. */
export function setPermHook(on, { claudeHome, dataDir, appRoot, nodePath = process.execPath, port = 4380 }) {
  const st = permHookState({ claudeHome, appRoot, nodePath, port });
  if (!st.canSet) throw Object.assign(new Error(st.why), { status: 400 });
  if (st.on === on) return st;
  const { file, settings } = read(claudeHome);
  const backups = path.join(dataDir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backups, `claude-settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const hooks = { ...(settings.hooks || {}) };
  if (st.after.length) hooks.PermissionRequest = st.after; else delete hooks.PermissionRequest;
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.circle.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return permHookState({ claudeHome, appRoot, nodePath, port });
}
