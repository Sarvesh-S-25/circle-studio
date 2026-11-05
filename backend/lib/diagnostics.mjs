import { execFile } from 'node:child_process';
import { cleanEnv } from './run.mjs';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$roots = @($env:CIRCLE_MEASURE_PIDS.Split(',') | ForEach-Object { [int]$_ })
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name)
$owned = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($root in $roots) { [void]$owned.Add($root) }
for ($depth = 0; $depth -lt 12; $depth++) {
  $added = 0
  foreach ($row in $all) { if ($owned.Contains([int]$row.ParentProcessId) -and $owned.Add([int]$row.ProcessId)) { $added++ } }
  if ($added -eq 0 -or $owned.Count -gt 200) { break }
}
$rows = @()
foreach ($taskPid in $owned) {
  $meta = $all | Where-Object { $_.ProcessId -eq $taskPid } | Select-Object -First 1
  if (-not $meta -or $meta.Name -match '^(msedge|chrome|chromium|firefox|powershell|pwsh|conhost|OpenConsole)\.exe$' -and -not ($roots -contains $taskPid)) { continue }
  try { $proc = Get-Process -Id $taskPid -ErrorAction Stop; $rows += @{ pid = $taskPid; name = $proc.ProcessName; workingSet = $proc.WorkingSet64; privateBytes = $proc.PrivateMemorySize64; cpuSeconds = $proc.TotalProcessorTime.TotalSeconds; handles = $proc.HandleCount } } catch {}
}
ConvertTo-Json -InputObject @($rows) -Compress
`;

export function measureOwnedProcesses(pids, { execImpl = execFile } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ available: false, note: 'Detailed owned-process measurement currently supports Windows.' });
  const ids = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  return new Promise((resolve) => execImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { env: { ...cleanEnv(), CIRCLE_MEASURE_PIDS: ids.join(',') }, windowsHide: true, timeout: 8000, maxBuffer: 256 * 1024 }, (error, stdout) => {
    if (error) { resolve({ available: false, note: 'Process measurement was unavailable. Node counters remain available.' }); return; }
    try {
      const rows = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
      const processes = (Array.isArray(rows) ? rows : [rows]).slice(0, 200).filter((p) => ids.includes(p.pid) || Number.isInteger(p.pid)).map((p) => ({ pid: p.pid, name: String(p.name).slice(0, 80), workingSet: Math.max(0, Number(p.workingSet) || 0), privateBytes: Math.max(0, Number(p.privateBytes) || 0), cpuSeconds: Math.max(0, Number(p.cpuSeconds) || 0), handles: Math.max(0, Number(p.handles) || 0) }));
      resolve({ available: true, at: new Date().toISOString(), processes, privateBytes: processes.reduce((n, p) => n + p.privateBytes, 0), note: 'One explicit Windows sample of this server, its owned protocol descendants and desktop host when running. Shared browser processes and this temporary sampler are excluded. Working sets can share pages; do not sum them or add Node heap/external into a process total. Private bytes measure committed private allocations, not just resident memory.' });
    } catch { resolve({ available: false, note: 'Process measurement returned an unsupported shape.' }); }
  })).catch(() => ({ available: false, note: 'Process measurement was unavailable. Node counters remain available.' }));
}
