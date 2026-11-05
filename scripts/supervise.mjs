// Detached launcher companion. Restarts a crashed server; revoking its token stops recovery.
// Each child exit is logged before a fresh process starts, preserving the crash evidence.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from '../backend/config.mjs';

const config = loadConfig();
const token = process.argv[2];
const file = path.join(config.dataDir, 'server-supervisor.json');
let child = null;
let retry = null;
let failures = 0;
let started = 0;
let stopping = false;
function owns() { try { return JSON.parse(fs.readFileSync(file, 'utf8')).token === token; } catch { return false; } }
function log(message) { console.error(`${new Date().toISOString()} supervisor: ${message}`); }
function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(retry); clearInterval(watch);
  child?.kill();
}
function start() {
  if (stopping || !owns()) { stop(); return; }
  started = Date.now();
  child = spawn(process.execPath, [path.join(config.appRoot, 'backend/server.mjs')], { cwd: config.appRoot, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  fs.writeFileSync(file, JSON.stringify({ token, pid: process.pid, serverPid: child.pid }));
  child.once('error', (e) => log(`could not start server: ${e.message}`));
  child.once('close', (code, signal) => {
    child = null;
    if (stopping || !owns()) { stop(); return; }
    if (Date.now() - started > 60_000) failures = 0;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
    log(`server exited (${signal || code}); retrying in ${delay} ms`);
    retry = setTimeout(start, delay);
  });
}
const watch = setInterval(() => { if (!owns()) stop(); }, 1000);
process.on('SIGINT', stop); process.on('SIGTERM', stop);
start();
