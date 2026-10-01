// The app's own data folder: small JSON files written atomically, and a per-key queue so two
// requests never write the same file at once.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './textfile.mjs';

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.queues = new Map();
    fs.mkdirSync(dataDir, { recursive: true });
  }

  abs(rel) { return path.join(this.dir, rel); }

  readJson(rel, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.abs(rel), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return fallback;
      // A corrupt file must not take the app down: keep it aside and start fresh.
      try { fs.renameSync(this.abs(rel), `${this.abs(rel)}.corrupt-${Date.now()}`); } catch { /* ignore */ }
      return fallback;
    }
  }

  writeJson(rel, value) {
    atomicWrite(this.abs(rel), `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Serialise async work per key. */
  serial(key, fn) {
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.queues.set(key, next);
    next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); }).catch(() => {});
    return next;
  }
}
