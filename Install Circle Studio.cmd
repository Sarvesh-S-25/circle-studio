@echo off
rem Double-click to install Circle Studio for this Windows user: checks Node.js, adds shortcuts, opens the app.
rem Nothing needs administrator rights and nothing is downloaded. To remove it: npm run uninstall
setlocal
cd /d "%~dp0"
title Circle Studio setup
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Circle Studio needs Node.js 24 or newer, and it is not installed.
  echo Install it from https://nodejs.org ^(the LTS button^), then double-click this file again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  echo.
  for /f "delims=" %%v in ('node --version') do echo Circle Studio needs Node.js 24 or newer. This PC has %%v.
  echo Update it from https://nodejs.org, then double-click this file again.
  echo.
  pause
  exit /b 1
)
node "%~dp0scripts\circle.mjs" install %*
echo.
pause
