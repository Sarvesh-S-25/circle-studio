param([int]$Port, [string]$DataDir, [string]$OutputDir)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$data = [IO.Path]::GetFullPath($DataDir)
if (-not $data.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf (Split-Path -Parent $data)) -notlike 'circle-demo-*' -or $Port -lt 4396) { throw 'Use isolated demo data.' }
$hostFile = Join-Path $repo 'scripts/widgets/desktop-widgets.ps1'
$source = [IO.File]::ReadAllText($hostFile)
$source = $source.Substring(0, $source.IndexOf('$app = New-Object System.Windows.Application'))
$source = $source.Replace('Local\CircleStudioDesktopWidgets', ('Local\CircleStudioPollingQA' + $Port))
$source = $source.Replace('$PSScriptRoot', ("'" + (Split-Path -Parent $hostFile).Replace("'", "''") + "'"))
. ([scriptblock]::Create($source)) -Port $Port -DataDir $data
Add-Type -ReferencedAssemblies System.Net.Http -TypeDefinition @'
using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
public class CircleSlowHttp : HttpMessageHandler {
  public int Count;
  public TaskCompletionSource<HttpResponseMessage> Pending = new TaskCompletionSource<HttpResponseMessage>();
  protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) { Count++; return Pending.Task; }
  public void Finish() { Pending.SetResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"ok\":true,\"tiles\":[]}") }); }
}
'@
$script:desktopHttp.Dispose()
$handler = New-Object CircleSlowHttp
$script:desktopHttp = New-Object System.Net.Http.HttpClient($handler)
try {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $first = Read-DesktopBatch 'qa' @('/slow') 15
  for ($i = 0; $i -lt 100; $i++) { $again = Read-DesktopBatch 'qa' @('/slow') 15 }
  $watch.Stop()
  if ($null -ne $first -or $null -ne $again -or $handler.Count -ne 1) { throw 'Pending reads overlapped or returned a premature result.' }
  if ($watch.ElapsedMilliseconds -gt 1000) { throw 'Polling blocked the dispatcher.' }
  $handler.Finish()
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  do { $result = Read-DesktopBatch 'qa' @('/slow') 15; if ($null -eq $result) { Start-Sleep -Milliseconds 10 } } while ($null -eq $result -and [DateTime]::UtcNow -lt $deadline)
  if (-not $result[0].ok) { throw 'Completed response was lost.' }
  # Simulate the first dispatcher tick after a long suspend: the existing batch becomes eligible once.
  $script:desktopReads['qa'].next = [DateTime]::UtcNow.AddHours(-1)
  $null = Read-DesktopBatch 'qa' @('/slow') 15
  if ($handler.Count -ne 2) { throw 'Resume did not start exactly one new batch.' }
  $report = @{ passed = $true; pendingPolls = 101; pendingRequests = 1; dispatcherMilliseconds = $watch.ElapsedMilliseconds; completedResultRead = $true; resumeBatchStarted = $true }
  New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
  $report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDir 'native-poll-recovery.json')
  $report | ConvertTo-Json
} finally { $script:desktopHttp.Dispose(); $mutex.ReleaseMutex() }
