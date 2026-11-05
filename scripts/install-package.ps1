param([switch]$NoOpen, [switch]$StageOnly, [switch]$Repair, [string]$ActivateVersion = '')
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$sourceInstallation = $null
try { $sourceInstallation = Get-Content -LiteralPath (Join-Path $source 'installation.json') -Raw -ErrorAction Stop | ConvertFrom-Json } catch { }
$installRoot = if ($env:CIRCLE_INSTALL_ROOT) { [IO.Path]::GetFullPath($env:CIRCLE_INSTALL_ROOT) } elseif ($sourceInstallation.mode -eq 'installed') { Split-Path -Parent $source } else { Join-Path $env:LOCALAPPDATA 'CircleStudio' }
if ($ActivateVersion) {
  if ($ActivateVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Choose an installed semantic version.' }
  $source = [IO.Path]::GetFullPath((Join-Path $installRoot ('app-' + $ActivateVersion)))
  if (-not $source.StartsWith(([IO.Path]::GetFullPath($installRoot).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'The selected version escapes the installation root.' }
  if (-not (Test-Path -LiteralPath $source)) { throw 'That version is not installed.' }
}
$manifestPath = Join-Path $source 'release-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'This is not a packaged Circle Studio release.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne 'circle-release/1' -or $manifest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'The release manifest is not supported.' }
$target = [IO.Path]::GetFullPath((Join-Path $installRoot ('app-' + $manifest.version)))
$dataDir = if ($env:CIRCLE_INSTALL_DATA) { [IO.Path]::GetFullPath($env:CIRCLE_INSTALL_DATA) } elseif ($sourceInstallation.mode -eq 'installed') { [IO.Path]::GetFullPath($sourceInstallation.dataDir) } else { Join-Path $installRoot 'data' }
if ($dataDir -eq $target -or $dataDir.StartsWith(($target.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Installed application code and mutable data must use separate folders.' }
if (-not $target.StartsWith(([IO.Path]::GetFullPath($installRoot).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'The installation path is invalid.' }
# Validate every file before creating a new installation; no downloads or existing data are changed.
foreach ($file in $manifest.files) {
  if ($file.path -match '(^/|\\|(^|/)\.\.(/|$)|:)' ) { throw 'The manifest contains an invalid path.' }
  $inputPath = [IO.Path]::GetFullPath((Join-Path $source $file.path))
  if (-not $inputPath.StartsWith(($source.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'An input escapes the package.' }
  if ((Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw ('Integrity check failed: ' + $file.path) }
}
$existing = Test-Path -LiteralPath $target
if ($existing -and -not ($Repair -or $ActivateVersion)) { throw 'This version is already installed. Use -Repair to verify it and recreate shortcuts, or install a newer version; user data is preserved.' }
if ($existing) {
  foreach ($file in $manifest.files) {
    $installedFile = Join-Path $target $file.path
    if (-not (Test-Path -LiteralPath $installedFile) -or (Get-FileHash -LiteralPath $installedFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {
      if ($Repair -and $source -ne $target) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $installedFile) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $source $file.path) -Destination $installedFile -Force
      } else { throw ('Installed files differ. Run -Repair from an extracted verified release package: ' + $file.path) }
    }
  }
} else { New-Item -ItemType Directory -Path $target -Force | Out-Null }
try {
  if (-not $existing) {
  foreach ($file in $manifest.files) {
    $dest = [IO.Path]::GetFullPath((Join-Path $target $file.path))
    if (-not $dest.StartsWith(($target.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'An output escapes the installation.' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $source $file.path) -Destination $dest
  }
  Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $target 'release-manifest.json')
  }
  @{ mode = 'installed'; dataDir = $dataDir } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'installation.json') -Encoding UTF8
  if ($StageOnly) { Write-Host ('Verified and staged ' + $manifest.version + ' in ' + $target); return }
  $node = Join-Path $target 'runtime/node.exe'
  if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
  $setupArgs = @((Join-Path $target 'scripts/circle.mjs'), 'install', '--yes')
  if ($NoOpen) { $setupArgs += '--no-open' }
  & $node @setupArgs
  if ($LASTEXITCODE -ne 0) { throw 'Shortcut setup failed. Your previous installation and data remain available.' }
  $currentFile = Join-Path $installRoot 'current.json'
  $previous = if (Test-Path -LiteralPath $currentFile) { (Get-Content -LiteralPath $currentFile -Raw | ConvertFrom-Json).activeVersion } else { $null }
  @{ activeVersion = $manifest.version; previousVersion = $previous; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $currentFile -Encoding UTF8
  $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\CircleStudio'
  New-Item -Path $uninstallKey -Force | Out-Null
  $ps = Join-Path $PSHOME 'powershell.exe'
  $uninstall = '"' + $ps + '" -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $target 'scripts/uninstall-package.ps1') + '"'
  $repair = '"' + $ps + '" -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $target 'scripts/install-package.ps1') + '" -Repair -NoOpen'
  $properties = @{ DisplayName = 'Circle Studio'; DisplayVersion = $manifest.version; Publisher = 'Circle Studio'; InstallLocation = $target; UninstallString = $uninstall; QuietUninstallString = ($uninstall + ' -Force'); ModifyPath = $repair; NoModify = 0; NoRepair = 0 }
  foreach ($name in $properties.Keys) { New-ItemProperty -LiteralPath $uninstallKey -Name $name -Value $properties[$name] -Force | Out-Null }
  Write-Host ('Installed Circle Studio ' + $manifest.version + ' in ' + $target)
  Write-Host ('Your data stays in ' + $dataDir)
} catch {
  Write-Host ('Installation stopped: ' + $_.Exception.Message)
  Write-Host 'No previous version or user data was deleted.'
  throw
}
