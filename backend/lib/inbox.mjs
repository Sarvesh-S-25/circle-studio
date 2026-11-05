// The Inbox: every approval and question an agent raised, kept so the human can find it, check it and remember it.
// One file per project under data/inbox/, newest first, capped. Everything stored is already redacted.
import fs from 'node:fs';
import { redact } from './secrets.mjs';

const CAP = 1000;
const FINAL = new Set(['allowed', 'denied', 'answered', 'expired', 'auto-denied']);

/** Redact every string inside a JSON-like value. */
export function redactDeep(value, depth = 0) {
  if (typeof value === 'string') return redact(value);
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, depth + 1)]));
}

export class Inbox {
  constructor({ store }) {
    this.store = store;
    this.byProject = new Map();
    let names = [];
    try { names = fs.readdirSync(store.abs('inbox')).filter((n) => n.endsWith('.json')); } catch { /* first run */ }
    for (const n of names) {
      const id = n.slice(0, -5);
      const j = store.readJson(`inbox/${n}`, null);
      if (j && Array.isArray(j.requests)) this.byProject.set(id, j.requests);
    }
    this.#expireStale();
  }

  /** Whatever was still waiting when the app last stopped can never be answered now. */
  #expireStale() {
    const now = new Date().toISOString();
    for (const [pid, list] of this.byProject) {
      let changed = false;
      for (const r of list) if (r.status === 'pending') { r.status = 'expired'; r.resolvedAt = now; changed = true; }
      if (changed) this.#save(pid);
    }
  }

  #save(projectId) { this.store.writeJson(`inbox/${projectId}.json`, { version: 1, requests: this.byProject.get(projectId) || [] }); }

  add(record) {
    const rec = redactDeep(record);
    const list = this.byProject.get(rec.projectId) || [];
    list.unshift(rec);
    // Active approvals must remain answerable even when completed history reaches its retention cap.
    if (list.length > CAP) {
      let completed = 0;
      const kept = list.filter((r) => r.status === 'pending' || completed++ < CAP);
      const keepIds = new Set(kept.map((r) => r.id));
      const removed = list.filter((r) => !keepIds.has(r.id));
      if (removed.length) {
        fs.mkdirSync(this.store.abs('inbox-archive'), { recursive: true });
        fs.appendFileSync(this.store.abs(`inbox-archive/${rec.projectId}.jsonl`), removed.reverse().map((r) => JSON.stringify(r)).join('\n') + '\n');
      }
      list.splice(0, list.length, ...kept);
    }
    this.byProject.set(rec.projectId, list);
    this.#save(rec.projectId);
    return rec;
  }

  get(id) {
    for (const list of this.byProject.values()) { const r = list.find((x) => x.id === id); if (r) return r; }
    return null;
  }

  /** Change a stored record. A record that is already final is never changed again. */
  update(id, patch) {
    const rec = this.get(id);
    if (!rec || FINAL.has(rec.status)) return null;
    Object.assign(rec, redactDeep(patch));
    this.#save(rec.projectId);
    return rec;
  }

  list({ status = 'all', projectId } = {}) {
    const lists = projectId ? [this.byProject.get(projectId) || []] : [...this.byProject.values()];
    return lists.flat().filter((r) => status === 'all' || (status === 'pending' ? r.status === 'pending' : r.status === status)).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  pendingCount(projectId) { return (this.byProject.get(projectId) || []).filter((r) => r.status === 'pending').length; }

  archivePage(projectId, cursor = null, limit = 100) {
    const file = this.store.abs(`inbox-archive/${projectId}.jsonl`);
    let fd; try { fd = fs.openSync(file, 'r'); } catch { return { requests: [], nextCursor: null }; }
    try {
      let end = cursor == null || cursor === '' ? fs.fstatSync(fd).size : Math.max(0, Math.min(fs.fstatSync(fd).size, Math.trunc(Number(cursor) || 0)));
      let carry = Buffer.alloc(0); const requests = [];
      while (end > 0) {
        const start = Math.max(0, end - 65536); const block = Buffer.alloc(end - start); fs.readSync(fd, block, 0, block.length, start);
        const data = Buffer.concat([block, carry]); let last = data.length;
        for (let i = data.length - 1; i >= 0; i--) if (data[i] === 10) {
          const line = data.subarray(i + 1, last).toString('utf8').trim(); last = i;
          if (line) { try { requests.push(JSON.parse(line)); } catch { /* malformed archive row */ } }
          if (requests.length >= limit) return { requests, nextCursor: start + i + 1 || null };
        }
        carry = data.subarray(0, last); if (carry.length > 4 * 1024 * 1024) throw new Error('An audit record exceeds the read limit.');
        end = start;
      }
      if (carry.length) { try { requests.push(JSON.parse(carry.toString('utf8'))); } catch { /* malformed row */ } }
      return { requests, nextCursor: null };
    } finally { fs.closeSync(fd); }
  }
}
