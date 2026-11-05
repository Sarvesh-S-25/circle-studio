param([Parameter(ValueFromRemainingArguments=$true)][string[]]$CommandArgs)
$env:PATH = (Join-Path $PSScriptRoot '.tools/bin') + ';' + $env:PATH
$env:HYPERFRAMES_TELEMETRY_DISABLED = '1'
Push-Location $PSScriptRoot
try { & npx --yes hyperframes @CommandArgs; exit $LASTEXITCODE }
finally { Pop-Location }
