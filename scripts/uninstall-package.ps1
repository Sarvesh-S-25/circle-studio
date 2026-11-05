param([switch]$RemoveData, [switch]$Force, [switch]$Preview)
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$pointer = Get-Content -LiteralPath (Join-Path $appRoot 'installation.json') -Raw | ConvertFrom-Json
$installRoot = [IO.Path]::GetFullPath((Split-Path -Parent $appRoot))
if ($pointer.mode -ne 'installed' -or (Split-Path -Leaf $appRoot) -notmatch '^app-\d+\.\d+\.\d+$') { throw 'This is not a versioned installation.' }
$dataDir = [IO.Path]::GetFullPath($pointer.dataDir)
$targets = @(Get-ChildItem -LiteralPath $installRoot -Directory | Where-Object { $_.Name -match '^app-\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'release-manifest.json')) } | ForEach-Object { [IO.Path]::GetFullPath($_.FullName) })
foreach ($target in $targets) {
  if (-not $target.StartsWith(($installRoot.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase) -or (Get-Item -LiteralPath $target).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'An installation target is outside its verified root or is a link.' }
}
if ($RemoveData -and ($dataDir -eq $installRoot -or $targets -contains $dataDir -or -not (Test-Path -LiteralPath $dataDir))) { throw 'The data removal path is not a separate existing data folder.' }
if ($Preview) { @{ code = $targets; data = $dataDir; removesData = [bool]$RemoveData; note = 'Chats and settings are preserved unless RemoveData is explicitly requested.' } | ConvertTo-Json -Depth 4; return }
if (-not $Force) {
  Add-Type -AssemblyName PresentationFramework
  $message = if ($RemoveData) { "Remove Circle Studio AND its saved data at $dataDir? This cannot be undone. Export a backup first." } else { "Remove Circle Studio? Your chats and settings stay at $dataDir." }
  if ([System.Windows.MessageBox]::Show($message, 'Uninstall Circle Studio', 'YesNo', 'Warning') -ne 'Yes') { return }
}
$node = Join-Path $appRoot 'runtime/node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
& $node (Join-Path $appRoot 'scripts/circle.mjs') uninstall --yes
if ($LASTEXITCODE -ne 0) { throw 'Stop Circle Studio and try uninstalling again. Data was not removed.' }
foreach ($target in $targets) { Remove-Item -LiteralPath $target -Recurse -Force }
if ($RemoveData) {
  # User explicitly selected this exact absolute data directory above; never follow a replacement link.
  if ((Get-Item -LiteralPath $dataDir).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Data removal refused because the folder is a link.' }
  Remove-Item -LiteralPath $dataDir -Recurse -Force
}
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CircleStudio'
if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key }
Write-Host $(if ($RemoveData) { 'Circle Studio and the selected data folder were removed.' } else { 'Circle Studio was removed. Your data was preserved.' })
