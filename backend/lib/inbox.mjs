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
    if (list.length > CAP) list.length = CAP;
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
}
