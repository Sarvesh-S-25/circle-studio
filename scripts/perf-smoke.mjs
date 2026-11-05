// Reproducible, local-only storage/heap scenario. No provider processes or real application data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Store } from '../backend/lib/store.mjs';
import { Chats } from '../backend/lib/records.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-perf-'));
const store = new Store(root);
const key = 'dummy__main__codex';
const id = randomUUID();
const at = new Date().toISOString();
let large = { version: 2, conversationId: id, sessionId: 'dummy-thread', startedAt: at, messages: Array.from({ length: 20000 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', engine: 'codex', at, text: `Fixture ${i}: ${'x'.repeat(500)}` })) };
store.writeJson(`conversations/${key}/${id}.json`, large);
store.writeJson(`chats/${key}.json`, { ...large, totalMessages: large.messages.length, messages: large.messages.slice(-200) });
const entries = Array.from({ length: 1000 }, (_, i) => ({ id: i ? randomUUID() : id, messages: i ? 2 : 20000, engine: 'codex', title: `Dummy ${i}`, lastAt: at, dailyUsage: [{ day: at.slice(0, 10), engine: 'codex', turns: i ? 1 : 10000, usd: 0 }] }));
store.writeJson(`conversations/${key}/index.json`, { version: 1, conversations: entries });
large = null;
global.gc?.();
const chats = new Chats(store);
const baseline = process.memoryUsage();
const counters = { bytes: 0, reads: 0 };
const read = fs.readFileSync;
const readSync = fs.readSync;
let wholeRead = false;
fs.readFileSync = function(file, ...args) { wholeRead = true; try { const result = read.call(this, file, ...args); if (String(file).startsWith(root)) { counters.reads++; counters.bytes += Buffer.byteLength(result); } return result; } finally { wholeRead = false; } };
fs.readSync = function(...args) { const count = readSync.apply(this, args); if (!wholeRead) { counters.reads++; counters.bytes += count; } return count; };
const started = performance.now();
let peakRss = baseline.rss;
function uncachedPage(offset) { const c = store.readJson(`conversations/${key}/${id}.json`, null); return { ...c, messages: c.messages.slice(offset, offset + 150) }; }
for (let cycle = 0; cycle < 100; cycle++) {
  const offset = cycle % 10 * 150;
  let page;
  if (process.argv.includes('--uncached')) {
    store.readJson(`conversations/${key}/index.json`, {}).conversations.filter((c) => !c.archived).sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(cycle % 25 * 40, cycle % 25 * 40 + 40);
    page = uncachedPage(offset);
  } else { chats.list(key, { offset: cycle % 25 * 40 }); page = chats.read(key, id, { offset }); }
  if (page.messages.length !== 150) throw new Error('Incomplete transcript page');
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}
const elapsedMs = performance.now() - started;
fs.readFileSync = read;
fs.readSync = readSync;
global.gc?.();
const result = { scenario: '1000-chat-index/20000-message-transcript/100-page-opens', node: process.version, platform: process.platform, arch: process.arch, at, elapsedMs: Math.round(elapsedMs), reads: counters.reads, bytesRead: counters.bytes, baseline, settled: process.memoryUsage(), peakRss, gcAvailable: typeof global.gc === 'function', note: 'Synthetic isolated Node storage workload; excludes browser, desktop host and providers. RSS includes runtime allocations and is not a whole-product footprint.' };
const outAt = process.argv.indexOf('--output');
if (outAt >= 0) { const output = path.resolve(process.argv[outAt + 1]); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(result, null, 2)); }
console.log(JSON.stringify(result, null, 2));
// This directory is created by this script and never contains user data.
if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('circle-perf-')) throw new Error('Unexpected fixture path');
fs.rmSync(root, { recursive: true, force: true });
