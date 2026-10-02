// The native desktop widgets: one PowerShell process (scripts/widgets/desktop-widgets.ps1) that draws each tile as a
// borderless WPF window on the desktop and reads /api/widgets/feed. Started, stopped and checked from here. It is
// started through scripts/widgets/start-widgets.vbs (wscript, a hidden window, not waited for): a PowerShell started
// detached straight from Node exits at once on Windows. One host per Windows user (the script holds a named mutex)
// and it writes its own PID to the data folder, which is how it is found again.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export function hostScript(appRoot) { return path.join(appRoot, 'scripts', 'widgets', 'desktop-widgets.ps1'); }

/** wscript.exe and its arguments (no shell). */
export function hostCommand({ appRoot, port, dataDir }) {
  // never a folder literally named "undefined" next to the code: no data folder means the app's own
  const data = typeof dataDir === 'string' && dataDir ? dataDir : path.join(appRoot, 'data');
  return { file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'), args: [path.join(appRoot, 'scripts', 'widgets', 'start-widgets.vbs'), String(port), data] };
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** A fingerprint of the widget scripts, so widgets started from older code are restarted after an update. */
export function hostVersion(appRoot) {
  const h = crypto.createHash('sha1');
  for (const f of [hostScript(appRoot), path.join(appRoot, 'scripts', 'widgets', 'start-widgets.vbs')]) { try { h.update(fs.readFileSync(f)); } catch { /* missing */ } }
  return h.digest('hex').slice(0, 16);
}

export function desktopWidgets(config, { spawnImpl = spawn, killImpl = null } = {}) {
  const pidFile = path.join(config.dataDir, 'desktop-widgets.pid');
  const versionFile = path.join(config.dataDir, 'desktop-widgets.version');
  const readPid = () => { try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) || null; } catch { return null; } };
  const status = () => {
    const pid = readPid();
    return { platform: process.platform, running: alive(pid), pid: alive(pid) ? pid : null };
  };
  const api = {
    status,
    start() {
      if (process.platform !== 'win32') return { ...status(), error: 'Desktop widgets need Windows.' };
      const want = hostVersion(config.appRoot);
      let had = '';
      try { had = fs.readFileSync(versionFile, 'utf8').trim(); } catch { /* never recorded: older widgets */ }
      const restarted = status().running;
      if (restarted) {
        if (had === want) return status();
        api.stop(); // started from older code: start them again so clicks and tiles behave like the app now does
      }
      const { file, args } = hostCommand({ appRoot: config.appRoot, port: config.port, dataDir: config.dataDir });
      const child = spawnImpl(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on?.('error', () => {});
      child.unref?.();
      try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(versionFile, want); } catch { /* the next start tries again */ }
      return { platform: process.platform, running: true, pid: null, started: true, restarted };
    },
    stop() {
      const pid = readPid();
      if (pid && alive(pid)) (killImpl || ((p) => spawnSync('taskkill.exe', ['/PID', String(p), '/T', '/F'], { windowsHide: true })))(pid);
      try { fs.rmSync(pidFile); } catch { /* already gone */ }
      return { platform: process.platform, running: false, pid: null, stopped: Boolean(pid) };
    },
  };
  return api;
}
