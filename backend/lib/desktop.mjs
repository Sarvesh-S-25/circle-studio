// Windows desktop integration: app settings, shortcuts (Desktop, Start menu, start at login), app windows (the full app
// and the small per-project widget), and Windows notifications for questions that arrive while no window is open.
// Everything runs fixed programs with fixed scripts (never through a shell); data goes in through environment variables.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { redact } from './secrets.mjs';

export const DEFAULT_SETTINGS = {
  desktopAlerts: true, desktopWidgets: false, github: {}, updates: { check: 'daily', lastCheck: null },
  // the widget board: tiles in order (kind, size s/m/l, the project for project tiles)
  widgets: [{ kind: 'spend', size: 'm', projectId: null }, { kind: 'inbox', size: 's', projectId: null }, { kind: 'status', size: 's', projectId: null }, { kind: 'workflow', size: 'm', projectId: null }],
};

export class Settings {
  constructor(store) { this.store = store; }
  get() {
    const s = this.store.readJson('settings.json', {}) || {};
    return { ...DEFAULT_SETTINGS, ...s, github: { ...(s.github || {}) }, updates: { ...DEFAULT_SETTINGS.updates, ...(s.updates || {}) } };
  }
  set(patch) {
    return this.store.serial('settings', () => {
      const next = { ...this.get(), ...patch };
      this.store.writeJson('settings.json', next);
      return next;
    });
  }
}

const ps = (script, env = {}) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: { ...process.env, ...env } });

/** Folders a shortcut can go to. */
export function specialFolder(which) {
  const name = { desktop: 'Desktop', startmenu: 'Programs', startup: 'Startup' }[which];
  if (!name || process.platform !== 'win32') return null;
  if (process.env.CIRCLE_SHORTCUT_DIR) return path.join(process.env.CIRCLE_SHORTCUT_DIR, name); // tests: never the real folders
  const r = ps(`[Environment]::GetFolderPath('${name}')`);
  return r.status === 0 ? r.stdout.trim() || null : null;
}

const safeFile = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Circle Studio';

/** The .lnk path for a shortcut: the app (no project) or one project's widget. */
export function shortcutPath(where, project, { overview = false } = {}) {
  const dir = specialFolder(where);
  if (!dir) return null;
  return path.join(dir, project ? `${safeFile(project.name)} - Circle Studio.lnk` : overview ? 'Widgets - Circle Studio.lnk' : 'Circle Studio.lnk');
}

/** Write a shortcut that runs scripts/launch.vbs with `args`. Returns the .lnk path. */
export function writeShortcut({ lnk, appRoot, args = [], icon, description }) {
  if (process.platform !== 'win32') throw new Error('Shortcuts are made on Windows only.');
  const script = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CS_LNK)',
    "$s.TargetPath = Join-Path $env:SystemRoot 'System32\\wscript.exe'",
    '$s.Arguments = $env:CS_ARGS',
    '$s.WorkingDirectory = $env:CS_ROOT',
    'if ($env:CS_ICO) { $s.IconLocation = $env:CS_ICO }',
    '$s.Description = $env:CS_DESC',
    '$s.Save()',
  ].join('; ');
  const vbs = path.join(appRoot, 'scripts', 'launch.vbs');
  const quoted = [vbs, ...args].map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ');
  fs.mkdirSync(path.dirname(lnk), { recursive: true });
  const r = ps(script, { CS_LNK: lnk, CS_ARGS: quoted, CS_ROOT: appRoot, CS_ICO: icon && fs.existsSync(icon) ? icon : '', CS_DESC: description || 'Open Circle Studio' });
  if (r.status !== 0) throw new Error((r.stderr || 'PowerShell could not create the shortcut.').trim().slice(0, 300));
  return lnk;
}

export function removeShortcut(lnk) {
  if (lnk && fs.existsSync(lnk) && lnk.toLowerCase().endsWith('.lnk')) fs.rmSync(lnk);
}

const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];

/** Open a URL in its own app window (Edge --app), or the default browser when Edge is missing. */
export function openAppWindow(url, { width, height } = {}) {
  const edge = EDGE.find((p) => fs.existsSync(p));
  const size = width && height ? [`--window-size=${Math.round(width)},${Math.round(height)}`] : [];
  const child = edge ? spawn(edge, [`--app=${url}`, ...size], { detached: true, stdio: 'ignore' }) : spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return Boolean(edge);
}

// Finds the visible window whose title contains CS_MARK (the open Circle Studio window adds it to its title for a
// moment), restores it when minimized and brings it to the front. Windows lets a background process do that only with
// the foreground thread's input attached, so it attaches for the call.
const FOCUS_SCRIPT = `Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class CsFocus {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  public static bool Focus(string mark) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(1024);
      GetWindowText(h, sb, 1024);
      if (sb.ToString().Contains(mark)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    if (IsIconic(found)) ShowWindow(found, 9);
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint me = GetCurrentThreadId();
    bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(found);
    SetForegroundWindow(found);
    if (attached) AttachThreadInput(me, fg, false);
    return true;
  }
}
'@
for ($i = 0; $i -lt 25; $i++) { if ([CsFocus]::Focus($env:CS_MARK)) { 'focused'; exit 0 }; Start-Sleep -Milliseconds 200 }
'not found'; exit 1`;

/** Bring the window whose title contains `mark` to the front. Resolves true when it was found (within about 5 s). */
export function focusWindowMarked(mark) {
  if (process.platform !== 'win32' || !mark) return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', FOCUS_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, CS_MARK: mark } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', () => { clearTimeout(timer); resolve(out.includes('focused')); });
  });
}

/** A Windows notification (toast). Clicking it opens `url` in the browser. Fire and forget. */
export function windowsToast({ title, body, url }) {
  if (process.platform !== 'win32') return false;
  const esc = (s) => redact(String(s ?? '')).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]).slice(0, 240);
  const xml = `<toast activationType="protocol" launch="${esc(url)}" scenario="reminder"><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual><actions><action content="Open" activationType="protocol" arguments="${esc(url)}"/><action content="Later" activationType="system" arguments="dismiss"/></actions></toast>`;
  const script = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    '$x.LoadXml($env:CS_TOAST)',
    // PowerShell's own app id: a toast needs a registered one, and this is registered on every Windows install
    "$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, CS_TOAST: xml } });
  child.on('error', () => {});
  child.unref();
  return true;
}
