param([int]$Port, [string]$DataDir, [string]$OutputDir)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$data = [IO.Path]::GetFullPath($DataDir)
if (-not $data.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf (Split-Path -Parent $data)) -notlike 'circle-demo-*' -or $Port -lt 4396) { throw 'Use isolated circle-demo data and a private port.' }
$output = [IO.Path]::GetFullPath($OutputDir)
if (-not $output.StartsWith(($repo.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must stay in this workspace.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$hostFile = Join-Path $repo 'scripts/widgets/desktop-widgets.ps1'
$source = [IO.File]::ReadAllText($hostFile)
$source = $source.Substring(0, $source.IndexOf('$app = New-Object System.Windows.Application'))
$source = $source.Replace('Local\CircleStudioDesktopWidgets', ('Local\CircleStudioNotificationQA' + $Port))
$source = $source.Replace('$PSScriptRoot', ("'" + (Split-Path -Parent $hostFile).Replace("'", "''") + "'"))
. ([scriptblock]::Create($source)) -Port $Port -DataDir $data
$qaApp = New-Object System.Windows.Application
$qaApp.ShutdownMode = 'OnExplicitShutdown'
# The main host poll is omitted; observe actual HTTP outcomes without creating unrelated team cards.
function Safe-Asks { }
function Api([string]$route, $body = $null) {
  if ($null -eq $body) { return Invoke-RestMethod "$base$route" -TimeoutSec 5 }
  return Invoke-RestMethod "$base$route" -Method Post -Headers @{ 'X-Circle' = '1' } -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec 5
}
function Pump {
  $qaApp.Dispatcher.Invoke([Action]{}, [System.Windows.Threading.DispatcherPriority]::Background)
  Start-Sleep -Milliseconds 30
}
function Wait-QA([scriptblock]$check) {
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do { Pump; $value = & $check; if ($value) { return $value } } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Native QA timed out waiting for the expected HTTP state.'
}
function Controls($parent) {
  foreach ($child in [System.Windows.LogicalTreeHelper]::GetChildren($parent)) {
    if ($child -is [System.Windows.DependencyObject]) { $child; Controls $child }
  }
}
function Click-QA($button) {
  if (-not $button -or -not $button.IsEnabled) { throw 'Expected native button is missing or disabled.' }
  $button.RaiseEvent((New-Object System.Windows.RoutedEventArgs([System.Windows.Controls.Button]::ClickEvent)))
}
function Export-QA($window, [string]$name) {
  $window.UpdateLayout(); Pump
  $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap([int][Math]::Ceiling($window.ActualWidth), [int][Math]::Ceiling($window.ActualHeight), 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($window)
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $stream = [IO.File]::Create((Join-Path $output $name))
  try { $encoder.Save($stream) } finally { $stream.Dispose() }
}
$results = @()
try {
  $project = (Api '/api/projects').projects | Where-Object { $_.id -eq 'dummy_project' } | Select-Object -First 1
  if ([IO.Path]::GetFullPath($project.path) -ne [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $data) 'dummy-project'))) { throw 'This project is not the isolated dummy fixture.' }
  $script:projects = @($project)
  foreach ($case in @('deny', 'allow', 'option', 'typed')) {
    $theme = if ($case -in @('deny', 'option')) { 'dark' } else { 'light' }
    $feed = Api "/api/widgets/feed?theme=$theme"
    $script:pal = @{}; foreach ($p in $feed.palette.PSObject.Properties) { $script:pal[$p.Name] = $p.Value }
    $message = if ($case -in @('option', 'typed')) { 'ask native question fixture' } else { 'native harmless approval fixture' }
    $null = Api '/api/overlay/say' @{ projectId = 'dummy_project'; engine = 'codex'; text = $message }
    $request = Wait-QA { (Api '/api/requests?status=pending').requests | Where-Object { $_.projectId -eq 'dummy_project' } | Select-Object -First 1 }
    $card = New-AskCard $request
    $script:asks[$request.id] = $card
    $card.Show(); Keep-Visible $card; Export-QA $card "native-codex-$case.png"
    $controls = @(Controls $card)
    if ($case -in @('allow', 'deny')) {
      $label = if ($case -eq 'allow') { 'Allow' } else { 'Deny' }
      Click-QA ($controls | Where-Object { $_ -is [System.Windows.Controls.Button] -and $_.Content.Text -eq $label } | Select-Object -First 1)
    } elseif ($case -eq 'option') {
      Click-QA ($controls | Where-Object { $_ -is [System.Windows.Controls.Button] -and $_.Tag.a -eq 'Blue' } | Select-Object -First 1)
    } else {
      $box = $controls | Where-Object { $_ -is [System.Windows.Controls.TextBox] } | Select-Object -First 1
      $box.Text = 'CIRCLE_NATIVE_TYPED_OK'
      Click-QA ($controls | Where-Object { $_ -is [System.Windows.Controls.Button] -and [System.Windows.Automation.AutomationProperties]::GetName($_) -eq 'Send your answer' } | Select-Object -First 1)
    }
    $resolved = Wait-QA { (Api '/api/requests?status=all').requests | Where-Object { $_.id -eq $request.id -and $_.status -ne 'pending' } | Select-Object -First 1 }
    $reply = Wait-QA { (Api '/api/desktop/replies').replies | Where-Object { $_.projectId -eq 'dummy_project' -and $_.at -ge $request.at } | Select-Object -First 1 }
    $expected = switch ($case) { 'allow' { 'Done.' } 'deny' { 'Declined.' } 'option' { 'Blue' } 'typed' { 'CIRCLE_NATIVE_TYPED_OK' } }
    if (-not $reply.text.Contains($expected)) { throw "Native $case did not reach the Codex adapter." }
    $results += @{ case = $case; status = $resolved.status; answerReachedEngine = $true; exactConversation = [bool]$reply.conversationId }
    $card.Close(); $script:asks.Remove($request.id)
    $completion = New-ReplyCard $reply ''
    $completion.Show(); Export-QA $completion "native-codex-completion-$case.png"; $completion.Close()
    $null = Api '/api/desktop/replies/dismiss' @{ id = $reply.id }
  }
  $report = @{ passed = $true; cases = $results; note = 'Actual WPF windows and button handlers on this PC, with fake Codex in a temporary project. Responses verified through HTTP and adapter output. No global keyboard injection or real project access.' }
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'native-notification-smoke.json') -Encoding UTF8
  $report | ConvertTo-Json -Depth 6
} finally {
  foreach ($window in @($qaApp.Windows)) { $window.Close() }
  $mutex.ReleaseMutex(); $mutex.Dispose()
}
# Explicitly exit the isolated WPF test host after successful assertions and resource disposal.
if ($report.passed) { [Environment]::Exit(0) }
