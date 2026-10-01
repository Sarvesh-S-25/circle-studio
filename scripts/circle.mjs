#!/usr/bin/env node
// Circle Studio's command line: install it on this PC, start and stop it, update it, and check that everything it needs
// is there. "Install Circle Studio.cmd" runs `install`; `npm run <command>` runs the others.
//
//   node scripts/circle.mjs install [--yes] [--startup] [--no-desktop] [--no-open]
//   node scripts/circle.mjs uninstall [--yes]          shortcuts only: your data folder stays
//   node scripts/circle.mjs open | start | stop | status
//   node scripts/circle.mjs widget <project id>
//   node scripts/circle.mjs update [--check]
//   node scripts/circle.mjs doctor
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../backend/config.mjs';
import { writeIcon } from '../backend/lib/icon.mjs';
import { shortcutPath, specialFolder, writeShortcut, removeShortcut } from '../backend/lib/desktop.mjs';
import { checkUpdate, applyUpdate, appVersion } from '../backend/lib/updater.mjs';
import { copilotLoader } from '../backend/lib/engines/proc.mjs';

const config = loadConfig();
const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flag = (f) => argv.includes(f);
const isWin = process.platform === 'win32';

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, bad: (s) => `\x1b[31m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { ok: (s) => s, warn: (s) => s, bad: (s) => s, dim: (s) => s, b: (s) => s };
const say = (s = '') => console.log(s);
const mark = { ok: c.ok('  ok  '), warn: c.warn(' note '), bad: c.bad(' miss ') };

async function ask(question, def = false) {
  if (flag('--yes')) return def;
  if (!process.stdin.isTTY) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  rl.close();
  return a ? a.startsWith('y') : def;
}

function launcher(...args) {
  return spawnSync(process.execPath, [path.join(config.appRoot, 'scripts', 'launch.mjs'), ...args], { stdio: 'inherit', windowsHide: true }).status ?? 1;
}

function version(bin, args = ['--version']) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, shell: false });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 80);
}

/** Every check the app depends on, as [state, label, detail]. */
function checks() {
  const out = [];
  if (process.env.CIRCLE_SKIP_CHECKS === '1') return [['ok', `Node.js ${process.versions.node}`, 'other checks skipped']]; // tests: never start the real CLIs
  const major = Number(process.versions.node.split('.')[0]);
  out.push([major >= 24 ? 'ok' : 'bad', `Node.js ${process.versions.node}`, major >= 24 ? '' : 'Circle Studio needs Node.js 24 or newer: https://nodejs.org']);
  out.push([isWin ? 'ok' : 'warn', `Windows: ${isWin ? 'yes' : process.platform}`, isWin ? '' : 'Built for Windows. The server runs elsewhere, but shortcuts, widgets and notifications are Windows only.']);
  try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.accessSync(config.dataDir, fs.constants.W_OK); out.push(['ok', 'Data folder', config.dataDir]); } catch { out.push(['bad', 'Data folder', `Cannot write ${config.dataDir}`]); }
  const engines = [
    ['claude', 'Claude Code', 'npm install -g @anthropic-ai/claude-code, then: claude auth login'],
    ['codex', 'Codex', 'optional: npm install -g @openai/codex, then: codex login'],
    ['agy', 'Gemini (agy)', 'optional: the agy CLI'],
    ['copilot', 'GitHub Copilot', 'optional: npm install -g @github/copilot, then: copilot (and sign in)'],
  ];
  let anyEngine = false;
  for (const [bin, label, hint] of engines) {
    // Copilot installs as an npm .cmd shim, which needs a shell: run its loader with node instead (as the app does)
    const loader = bin === 'copilot' ? copilotLoader() : null;
    const v = loader ? version(process.execPath, [loader, '--version']) : version(bin);
    if (v) anyEngine = true;
    out.push([v ? 'ok' : bin === 'claude' ? 'warn' : 'warn', `${label}${v ? `: ${v}` : ''}`, v ? '' : `not found. ${hint}`]);
  }
  if (!anyEngine) out.push(['bad', 'No AI engine found', 'Install at least one (Claude Code is the one tested most).']);
  const g = version('git');
  out.push([g ? 'ok' : 'warn', g || 'git', g ? '' : 'not found: git shows project status and updates Circle Studio. https://git-scm.com']);
  const gh = version('gh');
  out.push([gh ? 'ok' : 'warn', gh ? `GitHub CLI: ${gh}` : 'GitHub CLI', gh ? '' : 'optional: lets the app read GitHub Actions of private repositories (winget install GitHub.cli, then gh auth login).']);
  if (isWin) {
    const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].some((p) => fs.existsSync(p));
    out.push([edge ? 'ok' : 'warn', 'Microsoft Edge', edge ? 'opens Circle Studio in its own window' : 'not found: Circle Studio opens in your default browser instead']);
  }
  return out;
}

function printChecks(list) {
  for (const [state, label, detail] of list) say(`${mark[state]} ${label}${detail ? c.dim(`  ${detail}`) : ''}`);
}

async function serverHealth() {
  try {
    const r = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j.ok ? j : null;
  } catch { return null; }
}

const commands = {
  async install() {
    say(c.b(`Circle Studio ${appVersion(config.appRoot)}: installing for ${process.env.USERNAME || 'you'} on this PC\n`));
    const list = checks();
    printChecks(list);
    if (list.some(([s, l]) => s === 'bad' && l.startsWith('Node.js'))) { say(c.bad('\nInstall Node.js 24 or newer first, then run this again.')); return 1; }
    say();
    if (!isWin) { say('Not Windows: start it with `npm start` and open http://127.0.0.1:4380.'); return 0; }
    const icon = writeIcon(config.dataDir);
    const made = [];
    const put = (where, args, description) => { const lnk = shortcutPath(where, null); if (!lnk) return; writeShortcut({ lnk, appRoot: config.appRoot, args, icon, description }); made.push(lnk); };
    if (!flag('--no-desktop')) put('desktop', [], 'Open Circle Studio');
    put('startmenu', [], 'Open Circle Studio');
    const startup = flag('--startup') || (await ask('Start Circle Studio in the background when you sign in to Windows, so questions from your agents reach you as notifications?', false));
    if (startup) { const lnk = shortcutPath('startup', null); writeShortcut({ lnk, appRoot: config.appRoot, args: ['--background'], icon, description: 'Start Circle Studio in the background' }); made.push(lnk); }
    for (const m of made) say(`${mark.ok} Shortcut: ${m}`);
    say(`\n${c.ok('Installed.')} Open it from the Desktop or the Start menu (search "Circle Studio").`);
    say(c.dim('Your data (projects list, templates, chats, Inbox) lives in ' + config.dataDir + '. Nothing is sent anywhere unless you chat with an engine.'));
    if (!flag('--no-open')) launcher();
    return 0;
  },

  async uninstall() {
    if (!isWin) { say('Nothing to remove on this system.'); return 0; }
    if (!(await ask('Remove the Circle Studio shortcuts (Desktop, Start menu, sign-in, and project widgets) and stop it? Your data folder stays.', true))) return 0;
    if (await serverHealth()) launcher('--stop');
    let n = 0;
    for (const where of ['desktop', 'startmenu', 'startup']) {
      const dir = specialFolder(where);
      if (!dir) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f === 'Circle Studio.lnk' || f.endsWith(' - Circle Studio.lnk')) { removeShortcut(path.join(dir, f)); say(`${mark.ok} Removed ${path.join(dir, f)}`); n++; }
      }
    }
    say(n ? `\nRemoved ${n} shortcut${n === 1 ? '' : 's'}.` : '\nNo shortcuts were there.');
    say(c.dim(`Your data is still in ${config.dataDir}. Delete that folder yourself if you want it gone, then delete this folder.`));
    return 0;
  },

  open: () => launcher(),
  start: () => launcher('--background'),
  stop: () => launcher('--stop'),
  widget: () => { if (!argv[1]) { say('Say which project: circle widget <project id> (the id is in the address when the project is open).'); return 1; } return launcher('--widget', argv[1]); },

  async status() {
    const h = await serverHealth();
    say(h ? `${mark.ok} Running at http://127.0.0.1:${h.port} (data: ${h.dataDir})${h.stale ? c.warn('  older than the code on disk: `circle open` restarts it') : ''}` : `${mark.warn} Not running. Start it with: npm run open`);
    return 0;
  },

  async update() {
    say('Checking for an update (read only)...');
    const u = await checkUpdate(config.appRoot);
    if (u.mode === 'zip' || !u.available) { say(u.reason || `${mark.ok} Up to date (${u.version}).`); return 0; }
    say(`${mark.warn} An update is available on ${u.remote}/${u.remoteBranch}.`);
    if (flag('--check')) return 0;
    if (!u.canUpdate) { say(c.warn(u.reason)); return 1; }
    if (!(await ask('Update now? Only moves forward; it never touches your changes or data.', true))) return 0;
    const r = await applyUpdate(config.appRoot);
    if (!r.ok) { say(c.bad(r.message)); return 1; }
    say(`${mark.ok} Updated to ${r.version}:`);
    for (const ch of r.changes) say(`       ${ch}`);
    if (await serverHealth()) { say('Restarting the running app...'); launcher('--background'); }
    return 0;
  },

  async doctor() {
    say(c.b(`Circle Studio ${appVersion(config.appRoot)}, in ${config.appRoot}\n`));
    printChecks(checks());
    const h = await serverHealth();
    say(`${h ? mark.ok : mark.warn} Server: ${h ? `running on port ${h.port}${h.stale ? ', older than the code on disk' : ''}` : 'not running'}`);
    if (isWin) {
      for (const where of ['desktop', 'startmenu', 'startup']) {
        const lnk = shortcutPath(where, null);
        const there = lnk && fs.existsSync(lnk);
        say(`${there ? mark.ok : mark.warn} Shortcut, ${where === 'startup' ? 'start at sign-in' : where === 'startmenu' ? 'Start menu' : 'Desktop'}: ${there ? 'yes' : 'no'}`);
      }
    }
    const u = await checkUpdate(config.appRoot);
    say(`${u.available ? mark.warn : mark.ok} Updates: ${u.mode === 'zip' ? 'this copy was downloaded as a ZIP (no self-update)' : u.available ? `an update is available${u.canUpdate ? ' (npm run update)' : `: ${u.reason}`}` : u.reason || 'up to date'}`);
    return 0;
  },

  help() {
    say(`Circle Studio ${appVersion(config.appRoot)}

  npm run setup        install: shortcuts on the Desktop and Start menu, optional start at sign-in
  npm run open         open the app (starts it if needed)
  npm run widget -- <project id>   open a project's widget window
  npm start            run the server in this console
  npm run stop         stop the background server
  npm run status       is it running?
  npm run update       update from the git remote (only when this folder has no changes of yours)
  npm run doctor       check Node, the engines, git, shortcuts and updates
  npm run uninstall    remove the shortcuts (your data stays)
`);
    return 0;
  },
};

const fn = commands[cmd];
if (!fn) { say(`Unknown command "${cmd}".`); commands.help(); process.exit(1); }
const code = await fn();
process.exitCode = typeof code === 'number' ? code : 0;
