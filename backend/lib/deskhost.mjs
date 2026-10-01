// The native desktop widgets: one PowerShell process (scripts/widgets/desktop-widgets.ps1) that draws each tile as a
// borderless WPF window on the desktop and reads /api/widgets/feed. Started, stopped and checked from here. It is
// started through scripts/widgets/start-widgets.vbs (wscript, a hidden window, not waited for): a PowerShell started
// detached straight from Node exits at once on Windows. One host per Windows user (the script holds a named mutex)
// and it writes its own PID to the data folder, which is how it is found again.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export function hostScript(appRoot) { return path.join(appRoot, 'scripts', 'widgets', 'desktop-widgets.ps1'); }

/** wscript.exe and its arguments (no shell). */
export function hostCommand({ appRoot, port, dataDir }) {
  return { file: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'), args: [path.join(appRoot, 'scripts', 'widgets', 'start-widgets.vbs'), String(port), dataDir] };
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function desktopWidgets(config, { spawnImpl = spawn } = {}) {
  const pidFile = path.join(config.dataDir, 'desktop-widgets.pid');
  const readPid = () => { try { return Number(fs.readFileSync(pidFile, 'utf8').trim()) || null; } catch { return null; } };
  const status = () => {
    const pid = readPid();
    return { platform: process.platform, running: alive(pid), pid: alive(pid) ? pid : null };
  };
  return {
    status,
    start() {
      if (process.platform !== 'win32') return { ...status(), error: 'Desktop widgets need Windows.' };
      if (status().running) return status();
      const { file, args } = hostCommand({ appRoot: config.appRoot, port: config.port, dataDir: config.dataDir });
      const child = spawnImpl(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on?.('error', () => {});
      child.unref?.();
      return { platform: process.platform, running: true, pid: null, started: true };
    },
    stop() {
      const pid = readPid();
      if (pid && alive(pid)) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      try { fs.rmSync(pidFile); } catch { /* already gone */ }
      return { platform: process.platform, running: false, pid: null, stopped: Boolean(pid) };
    },
  };
}
