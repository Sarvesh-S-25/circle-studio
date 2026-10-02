#!/usr/bin/env node
// Click-to-open launcher: makes sure Circle Studio's server is running in the background (no console window), then
// opens its own app-style window. Run it through scripts/launch.vbs (no flash of a console) or directly.
//   node scripts/launch.mjs           start the server if it is not running, open the window
//   node scripts/launch.mjs --stop    stop the background server
//   node scripts/launch.mjs --widget <project id>   open that project's small widget window
//   node scripts/launch.mjs --overview              open the widget board (the tiles you chose)
//   node scripts/launch.mjs --background            start the server only (the start-at-login shortcut)
//   node scripts/launch.mjs --widgets               also show the desktop widgets (with --background at sign-in)
// A server that is already running but older than the code on disk (after an update) is restarted automatically, so
// opening the app from the desktop always runs the newest code.
// Same port and data folder as `node backend/server.mjs`: CIRCLE_PORT and CIRCLE_DATA apply here too.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from '../backend/config.mjs';
import { openAppWindow } from '../backend/lib/desktop.mjs';
import { desktopWidgets } from '../backend/lib/deskhost.mjs';
import { WIDGET_SIZE, BOARD_SIZE } from '../backend/routes.desktop.mjs';
import { codeFingerprint } from '../backend/lib/codeversion.mjs';

const config = loadConfig();
const base = `http://127.0.0.1:${config.port}`;
const logFile = path.join(config.dataDir, 'server.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Circle Studio's /api/health answer, or null when the port is free or held by some other app. */
// (node:http, not fetch: process.exit() right after a fetch crashes Node on Windows with a libuv assertion.)
function circleHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${base}/api/health`, { agent: false, timeout: 1500 }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try {
          const body = JSON.parse(text);
          resolve(body.ok === true && typeof body.dataDir === 'string' && body.port === config.port ? body : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
const isCircleStudio = async () => (await circleHealth()) !== null;

function listeningPid() {
  const out = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true }).stdout || '';
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
    if (m && Number(m[1]) === config.port) return Number(m[2]);
  }
  return null;
}

function log(message) {
  try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.appendFileSync(logFile, `${new Date().toISOString()} launcher: ${message}\n`); } catch { /* nowhere to write it */ }
}

function fail(message) {
  log(message);
  console.error(message);
  process.exit(1);
}

/** Stop the running Circle Studio server. Returns true when it is gone. */
async function stopServer() {
  const pid = listeningPid();
  if (!pid) fail(`Circle Studio answers on port ${config.port} but its process could not be found. Close it from Task Manager (node.exe).`);
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  for (let i = 0; i < 20 && (await isCircleStudio()); i++) await sleep(250);
  return !(await isCircleStudio());
}

async function startServer() {
  if (listeningPid()) fail(`Port ${config.port} is used by another program. Close it, or set CIRCLE_PORT to a free port.`);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(config.appRoot, 'backend', 'server.mjs')], {
    cwd: config.appRoot, detached: true, stdio: ['ignore', out, out], windowsHide: true,
  });
  child.on('error', (e) => fail(`Could not start the server: ${e.message}`));
  child.unref();
  for (let i = 0; i < 40 && !(await isCircleStudio()); i++) await sleep(250);
  if (!(await isCircleStudio())) fail(`Circle Studio did not start within 10 seconds. See ${logFile}.`);
}

if (process.argv.includes('--stop')) {
  if (!(await isCircleStudio())) { console.log(`Circle Studio is not running on port ${config.port}.`); process.exit(0); }
  console.log((await stopServer()) ? 'Circle Studio stopped.' : 'Could not stop it.');
  process.exit(0);
}

const running = await circleHealth();
// CIRCLE_TEST_CODE stands in for "the code on disk changed" in tests
const onDisk = process.env.CIRCLE_TEST_CODE || codeFingerprint(config.appRoot);
// after a restart the windows that were open reconnect within seconds: the server waits for them before opening one
const restarted = Boolean(running && running.code !== onDisk);
if (restarted) {
  log(`restarting: the running server is older than the code on disk (${running.code || 'no fingerprint'} -> ${onDisk})`);
  if (!(await stopServer())) fail('Circle Studio was updated but the old server could not be stopped. Close node.exe from Task Manager and open the app again.');
  console.log('Circle Studio was updated: restarted the server.');
  await startServer();
} else if (!running) {
  await startServer();
}

/** Ask the server to show a window: it brings the one already open to the front, or opens one. False when it cannot. */
function showThroughServer(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(`${base}/api/desktop/open`, { method: 'POST', agent: false, timeout: 20_000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-Circle': '1' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(data);
  });
}

const widget = process.argv.indexOf('--widget');
const widgetId = widget > 0 ? process.argv[widget + 1] : null;
if (process.argv.includes('--widgets') && process.env.CIRCLE_NO_OPEN !== '1') desktopWidgets(config).start();
// CIRCLE_NO_OPEN=1: start the server only (used by tests). --background: the start-at-login shortcut.
// One window per thing: opening Circle Studio while it is open brings that window forward instead of a second one.
if (process.env.CIRCLE_NO_OPEN !== '1' && !process.argv.includes('--background')) {
  const settle = restarted;
  if (process.argv.includes('--overview')) {
    if (!(await showThroughServer({ kind: 'widget', settle }))) openAppWindow(`${base}/widget.html`, BOARD_SIZE);
  } else if (widgetId && /^[a-z0-9_-]{1,60}$/i.test(widgetId)) {
    if (!(await showThroughServer({ kind: 'widget', projectId: widgetId, settle }))) openAppWindow(`${base}/widget.html?p=${encodeURIComponent(widgetId)}`, WIDGET_SIZE);
  } else if (!(await showThroughServer({ kind: 'app', settle }))) openAppWindow(base);
}
process.exit(0);
