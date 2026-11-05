param([int]$Port, [string]$DataDir, [string]$OutputDir)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$data = [IO.Path]::GetFullPath($DataDir)
if (-not $data.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf (Split-Path -Parent $data)) -notlike 'circle-demo-*' -or $Port -lt 4396) { throw 'Native QA requires an isolated circle-demo temporary data folder and private port.' }
$output = [IO.Path]::GetFullPath($OutputDir)
if (-not $output.StartsWith(($repo.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'QA artifacts must stay in the workspace.' }
New-Item -ItemType Directory -Path $output -Force | Out-Null
$hostFile = Join-Path $repo 'scripts/widgets/desktop-widgets.ps1'
$source = [IO.File]::ReadAllText($hostFile)
$source = $source.Substring(0, $source.IndexOf('$app = New-Object System.Windows.Application'))
$source = $source.Replace('Local\CircleStudioDesktopWidgets', ('Local\CircleStudioDummyQA' + $Port))
$widgetsRoot = (Split-Path -Parent $hostFile).Replace("'", "''")
$source = $source.Replace('$PSScriptRoot', ("'" + $widgetsRoot + "'"))
# Load the real drawing/actions code with a distinct mutex and no main loop or global hotkey registration.
. ([scriptblock]::Create($source)) -Port $Port -DataDir $data
$qaApp = New-Object System.Windows.Application
$qaApp.ShutdownMode = 'OnExplicitShutdown'
$project = (Invoke-RestMethod "http://127.0.0.1:$Port/api/projects").projects | Where-Object { $_.id -eq 'dummy_project' } | Select-Object -First 1
if ([IO.Path]::GetFullPath($project.path) -ne [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $data) 'dummy-project'))) { throw 'The test project is not owned by this isolated demo.' }
$fixtureFile = Join-Path $project.path 'docs/tasks/ALERTS.md'
[IO.File]::WriteAllText($fixtureFile, "# Dummy questions`n`n## A-001 - Review the dummy choice`n`n- **Status:** open`n- **Question for the human:** Which dummy database?`n- **Options:** SQLite; Memory`n- **Answer:**`n")
function Export-QAWindow($window, [string]$name) {
  $window.UpdateLayout()
  $window.Dispatcher.Invoke([Action]{}, [System.Windows.Threading.DispatcherPriority]::Render)
  $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap([int][Math]::Ceiling($window.ActualWidth), [int][Math]::Ceiling($window.ActualHeight), 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($window)
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $stream = [IO.File]::Create((Join-Path $output $name))
  try { $encoder.Save($stream) } finally { $stream.Dispose() }
}
$results = @()
try {
  foreach ($theme in @('dark', 'light')) {
    $feed = Invoke-RestMethod "http://127.0.0.1:$Port/api/widgets/feed?theme=$theme"
    $script:pal = @{}; foreach ($p in $feed.palette.PSObject.Properties) { $script:pal[$p.Name] = $p.Value }
    $r = [pscustomobject]@{ projectId = 'dummy_project'; projectName = 'Isolated dummy project'; alertId = 'A-001'; title = 'Review the dummy choice'; question = 'Which dummy database?'; options = 'SQLite; Memory'; answerable = $true }
    $card = New-TeamCard $r
    $card.Show(); Export-QAWindow $card ("native-team-$theme.png")
    $card.Left = -10000; $card.Top = -10000; Keep-Visible $card
    if ($card.Left -lt [System.Windows.SystemParameters]::WorkArea.Left -or $card.Top -lt [System.Windows.SystemParameters]::WorkArea.Top) { throw 'Off-screen card recovery failed.' }
    $results += @{ theme = $theme; width = $card.ActualWidth; height = $card.ActualHeight; controls = $card.Content.Child.Children.Count }
    if ($theme -eq 'light') {
      $answerBox = $card.Content.Child.Children | Where-Object { $_ -is [System.Windows.Controls.TextBox] } | Select-Object -First 1
      $answerBox.Text = 'SQLite (isolated native review fixture)'
      $reviewButton = $card.Content.Child.Children | Where-Object { $_ -is [System.Windows.Controls.Button] -and $_.Content.Text -eq 'Review file change' } | Select-Object -First 1
      $reviewTimer = New-Object System.Windows.Threading.DispatcherTimer
      $reviewTimer.Interval = [TimeSpan]::FromMilliseconds(250)
      $reviewTimer.Add_Tick({ param($sender, $event)
        foreach ($dialog in @($qaApp.Windows)) {
          if ($dialog.Title -eq 'Review team answer') {
            Export-QAWindow $dialog 'native-team-diff.png'
            $sender.Stop(); $dialog.DialogResult = $true; break
          }
        }
      })
      $reviewTimer.Start()
      $reviewButton.RaiseEvent((New-Object System.Windows.RoutedEventArgs([System.Windows.Controls.Button]::ClickEvent)))
      $reviewTimer.Stop()
    }
    $card.Close()
  }
  $project = (Invoke-RestMethod "http://127.0.0.1:$Port/api/projects").projects | Where-Object { $_.id -eq 'dummy_project' } | Select-Object -First 1
  $file = Join-Path $project.path 'docs/tasks/ALERTS.md'
  if ((Get-Content -LiteralPath $file -Raw) -notmatch 'SQLite \(isolated native review fixture\)') { throw 'The native reviewed answer was not written.' }
  $proc = Get-Process -Id $PID
  $report = @{ passed = $true; cards = $results; reviewedAnswer = $true; memory = @{ resident = $proc.WorkingSet64; private = $proc.PrivateMemorySize64 }; note = 'Actual WPF drawing and reviewed-file-change action, scoped to dummy data. No OS key injection, global hotkeys or real-project writes. PNGs render the owned WPF visual tree, not the user screen.' }
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'native-smoke.json') -Encoding UTF8
  $report | ConvertTo-Json -Depth 5
} finally {
  foreach ($window in @($qaApp.Windows)) { $window.Close() }
  $qaApp.Shutdown(); $mutex.ReleaseMutex(); $mutex.Dispose()
}
