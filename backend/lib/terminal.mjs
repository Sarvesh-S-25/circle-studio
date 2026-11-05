// "Open terminal": the terminal or editor window a conversation runs in, brought to the front; or, when none is open, a
// new terminal in the project folder that carries the conversation on (`claude --resume <id>`).
// Finding the window: Claude Code titles its terminal with the conversation, and an editor (Antigravity IDE, VS Code)
// with the folder's name; only terminals and editors are looked at, never other apps.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { cleanEnv } from './run.mjs';

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// the programs a Claude Code session runs in
export const WORK_APPS = ['WindowsTerminal', 'powershell', 'pwsh', 'cmd', 'conhost', 'OpenConsole', 'Antigravity IDE', 'Antigravity', 'Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'wezterm-gui', 'alacritty', 'mintty', 'Hyper', 'Tabby'];

// How the window is found (checked on this PC, 2026-10-19): every Claude Code process (claude.exe) whose working folder is
// the project's (read from the process itself) is a session there. In Windows Terminal its console window is owned by
// the terminal's window; in an editor's terminal (Antigravity IDE, VS Code) it has no owner, so the parents are followed
// up to the editor, and of the editor's windows the one titled with the folder is taken. When no session runs there,
// a terminal or editor window with the conversation's title, or else the folder's name, is used.
const FIND_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public static class CsWork {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool on);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr R3; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI i, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, int s, out IntPtr r);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static IntPtr Ptr(IntPtr h, IntPtr a) { var b = new byte[8]; IntPtr r; ReadProcessMemory(h, a, b, 8, out r); return new IntPtr(BitConverter.ToInt64(b, 0)); }
  // the working folder of a 64-bit process of this user (its own record of it: PEB, process parameters)
  public static string Cwd(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid); if (h == IntPtr.Zero) return null;
    try {
      var pbi = new PBI(); int r; if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out r) != 0) return null;
      IntPtr pp = Ptr(h, pbi.Peb + 0x20);
      var us = new byte[16]; IntPtr rr; ReadProcessMemory(h, pp + 0x38, us, 16, out rr);
      int len = BitConverter.ToUInt16(us, 0); if (len <= 0 || len > 4096) return null;
      var s = new byte[len]; ReadProcessMemory(h, new IntPtr(BitConverter.ToInt64(us, 8)), s, len, out rr);
      return Encoding.Unicode.GetString(s);
    } catch { return null; } finally { CloseHandle(h); }
  }
  // the window that shows a console process: its console window's owner (Windows Terminal), when there is one
  public static long ConsoleOwner(int pid) {
    try {
      FreeConsole();
      if (!AttachConsole(pid)) return 0;
      IntPtr cw = GetConsoleWindow();
      IntPtr owner = cw == IntPtr.Zero ? IntPtr.Zero : GetWindow(cw, 4);
      FreeConsole();
      return owner != IntPtr.Zero && IsWindowVisible(owner) ? owner.ToInt64() : 0;
    } catch { return 0; }
  }
  public static List<string> List() {
    var all = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024);
      if (sb.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      all.Add(h.ToInt64() + "\t" + pid + "\t" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return all;
  }
  public static string Title(long hv) { var sb = new StringBuilder(1024); GetWindowText(new IntPtr(hv), sb, 1024); return sb.ToString(); }
  public static void Focus(long hv) {
    var h = new IntPtr(hv);
    if (IsIconic(h)) ShowWindow(h, 9);
    uint pid; uint fg = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint me = GetCurrentThreadId();
    bool attached = fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    BringWindowToTop(h); SetForegroundWindow(h);
    if (attached) AttachThreadInput(me, fg, false);
  }
}
'@
$apps = $env:CS_APPS -split '\|'
$want = @($env:CS_TITLES -split '\|' | Where-Object { $_.Length -ge 4 })
$folder = $env:CS_FOLDER
$name = Split-Path -Leaf $folder
$norm = { param($p) if ($p) { $p.TrimEnd('\').ToLowerInvariant() } }
$windows = @([CsWork]::List() | ForEach-Object { $h, $procId, $title = $_ -split "\t", 3; [pscustomobject]@{ h = [long]$h; pid = [int]$procId; title = $title } })
$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CreationDate)
$byId = @{}; foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }
$best = $null; $how = ''; $running = 0
# 1. a Claude Code session working in this folder (newest first)
$target = & $norm $folder
foreach ($c in @($procs | Where-Object { $_.Name -eq ($env:CS_ENGINE + '.exe') } | Sort-Object CreationDate -Descending)) {
  $cwd = & $norm ([CsWork]::Cwd([int]$c.ProcessId))
  if (-not $cwd -or ($cwd -ne $target -and -not $cwd.StartsWith($target + '\'))) { continue }
  $running++
  if ($best) { continue }
  $own = [CsWork]::ConsoleOwner([int]$c.ProcessId)
  if ($own) { $best = @($own, 'terminal'); $how = 'session'; continue }
  if ($env:CS_ONLY -eq 'terminal') { continue } # an editor's Claude Code panel is not a terminal
  # an editor's terminal: up the parents to a process with windows, and of those the one with the folder's name
  $id = [int]$c.ParentProcessId
  for ($i = 0; $i -lt 8 -and $id -and -not $best; $i++) {
    $mine = @($windows | Where-Object { $_.pid -eq $id })
    if ($mine.Count) {
      $pick = @($mine | Where-Object { $_.title.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0 })[0]
      if (-not $pick) { $pick = $mine[0] }
      $best = @($pick.h, 'editor'); $how = 'session'
    }
    $id = if ($byId.ContainsKey($id)) { [int]$byId[$id].ParentProcessId } else { 0 }
  }
}
# 2. no session found: a terminal or editor window titled with the conversation, or with the folder's name
if (-not $best) {
  $score = 0
  foreach ($w in $windows) {
    $p = if ($byId.ContainsKey($w.pid)) { ($byId[$w.pid].Name -replace '\.exe$', '') } else { '' }
    if ($apps -notcontains $p) { continue }
    $isTerm = $p -match 'Terminal|powershell|pwsh|cmd|Console|conhost|wezterm|alacritty|mintty|Hyper|Tabby'
    if ($env:CS_ONLY -eq 'terminal' -and -not $isTerm) { continue }
    $s = 0
    foreach ($t in $want) { if ($w.title.IndexOf($t, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $s = 2 } }
    if (-not $s -and $name -and $w.title.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $s = 1 }
    if ($s -gt $score) { $best = @($w.h, $(if ($isTerm) { 'terminal' } else { 'editor' })); $score = $s; $how = 'title' }
  }
}
if (-not $best) { 'none' + [char]9 + $running; exit 0 }
if ($env:CS_FOCUS -eq '1') { [CsWork]::Focus([long]$best[0]) }
'found' + [char]9 + $best[1] + [char]9 + [CsWork]::Title([long]$best[0]) + [char]9 + $how + [char]9 + $running
`;

/**
 * The terminal or editor window where Claude Code works in `folder`: { found, kind, title, how, sessions } (and brought
 * to the front when `focus`). only: 'terminal' leaves editors out (an editor's Claude Code panel is not a terminal).
 */
export function findWorkWindow({ folder, titles = [], focus = true, only = null, engine = 'claude', spawnImpl = spawn }) {
  if (process.platform !== 'win32') return Promise.resolve({ found: false });
  return new Promise((resolve) => {
    const env = { ...cleanEnv(), CS_ENGINE: ['claude', 'codex', 'copilot', 'gemini'].includes(engine) ? engine : 'claude', CS_APPS: WORK_APPS.join('|'), CS_TITLES: titles.filter(Boolean).map((t) => String(t).replace(/[|\r\n]/g, ' ').slice(0, 80)).join('|'), CS_FOLDER: path.resolve(folder || ''), CS_FOCUS: focus ? '1' : '0', CS_ONLY: only || '' };
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', FIND_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env });
    let out = '';
    child.stdout?.on('data', (c) => { out += c; });
    const timer = setTimeout(() => child.kill?.(), 15_000);
    child.on?.('error', () => { clearTimeout(timer); resolve({ found: false }); });
    child.on?.('close', () => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).find((l) => l.startsWith('found\t') || l.startsWith('none\t'));
      if (!line?.startsWith('found\t')) return resolve({ found: false, sessions: Number(line?.split('\t')[1]) || 0 });
      // kind: terminal or editor; how: a Claude Code session working there, or only a matching title
      const [, kind, title, how, sessions] = line.split('\t');
      resolve({ found: true, kind, app: kind === 'terminal' ? 'terminal' : 'editor', title: (title || '').trim(), how, sessions: Number(sessions) || 0 });
    });
  });
}

/** The PowerShell lines a new terminal runs: into the folder, then Claude Code on that conversation (or a new one). */
export function resumeScript({ folder, sessionId = null, title = '', engine = 'claude', model = null, reasoning = null }) {
  if (!['claude', 'codex', 'copilot', 'gemini'].includes(engine)) throw new Error('Unknown terminal engine.');
  if (sessionId && !(engine === 'claude' ? SESSION_RE.test(sessionId) : /^[A-Za-z0-9_-]{1,100}$/.test(sessionId))) throw new Error('That conversation id is not valid.');
  if (model && !/^[A-Za-z0-9._:-]{1,100}$/.test(model)) throw new Error('That model is not valid.');
  if (reasoning && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoning)) throw new Error('That reasoning setting is not valid.');
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const label = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot', gemini: 'Gemini' }[engine];
  const command = engine === 'codex' ? `codex${sessionId ? ` resume ${q(sessionId)}` : ''}${model ? ` --model ${q(model)}` : ''}${reasoning ? ` -c ${q(`model_reasoning_effort="${reasoning}"`)}` : ''}` : engine === 'claude' ? `claude${sessionId ? ` --resume ${sessionId}` : ''}${model ? ` --model ${q(model)}` : ''}` : engine === 'copilot' ? 'copilot' : 'agy';
  return [
    `$Host.UI.RawUI.WindowTitle = ${q(`${label} · ${path.basename(folder)}${title ? ` · ${title}` : ''}`.slice(0, 120))}`,
    `Set-Location -LiteralPath ${q(folder)}`,
    `Write-Host ${q(sessionId && ['claude', 'codex'].includes(engine) ? `Circle Studio: carrying on "${title || sessionId}" here` : `Circle Studio: a new ${label} session in this folder`)} -ForegroundColor Cyan`,
    command,
  ].join('; ');
}

/** Open that terminal (a visible PowerShell, through the same checked launcher as Let's begin). */
export function openResumeTerminal({ appRoot, folder, sessionId, title, engine = 'claude', model, reasoning, spawnImpl = spawn }) {
  if (process.platform !== 'win32') return { opened: false, why: `Open a terminal in ${folder} and run: claude${sessionId ? ` --resume ${sessionId}` : ''}` };
  const encoded = Buffer.from(resumeScript({ folder, sessionId, title, engine, model, reasoning }), 'utf16le').toString('base64');
  const child = spawnImpl(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'), [path.join(appRoot, 'scripts', 'open-terminal.vbs'), encoded], { detached: true, stdio: 'ignore', windowsHide: false, env: cleanEnv() });
  child.on?.('error', () => {});
  child.unref?.();
  return { opened: true };
}
