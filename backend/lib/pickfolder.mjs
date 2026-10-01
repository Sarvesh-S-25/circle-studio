// A browser cannot tell an app where a folder lives, so the server asks Windows to show its own folder
// dialog on this PC. One at a time; the answer is an absolute path (or null when cancelled).
import { runCommand } from './run.mjs';

const SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$owner = New-Object System.Windows.Forms.Form',
  '$owner.TopMost = $true',
  '$owner.ShowInTaskbar = $false',
  '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
  '$d.Description = "Choose the folder Circle Studio should work on"',
  '$d.ShowNewFolderButton = $true',
  'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $d.SelectedPath }',
].join('; ');

let busy = false;

export async function pickFolder() {
  if (process.platform !== 'win32') return { path: null, unsupported: true };
  if (busy) return { path: null, busy: true };
  busy = true;
  try {
    const r = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT], { timeoutMs: 5 * 60 * 1000 });
    const out = r.stdout.trim().split(/\r?\n/).pop() || '';
    return { path: out || null };
  } finally {
    busy = false;
  }
}
