// What Circle Studio told you, kept: an agent asked, your team has a question, an agent finished or failed, an update
// is ready, a connection broke. The Notifications tile and the desktop widget read it; a Windows toast is only shown
// when no window is open, but every notice is kept here (the newest 60, in data/notices.json, never in a project).
import { randomBytes } from 'node:crypto';
import { redact } from './secrets.mjs';

const FILE = 'notices.json';
const MAX = 60;
export const NOTICE_KINDS = ['question', 'approval', 'team', 'done', 'error', 'update', 'connection'];
export function notificationAllowed(settings, kind, now = new Date()) {
  if (['question', 'approval', 'team'].includes(kind)) return true;
  const options = settings.desktopNotifications || {};
  if (options[kind] === false) return false;
  if (!['done', 'update'].includes(kind)) return true;
  if (!options.quietHours) return true;
  const minutes = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(s || ''); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
  const start = minutes(options.start); const end = minutes(options.end); const current = now.getHours() * 60 + now.getMinutes();
  if (start == null || end == null || start === end) return true;
  return !(start < end ? current >= start && current < end : current >= start || current < end);
}
const clip = (s, n) => redact(String(s ?? '')).replace(/\s+/g, ' ').trim().slice(0, n);

export class Notices {
  constructor(store, { now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
    const saved = store.readJson(FILE, { notices: [] });
    this.items = Array.isArray(saved?.notices) ? saved.notices.filter((n) => n && NOTICE_KINDS.includes(n.kind)).slice(0, MAX) : [];
    this.listeners = new Set();
  }

  #save() { try { this.store.writeJson(FILE, { notices: this.items }); } catch { /* a full disk must not stop the app */ } }

  /** Keep one notice. The same kind and title within a minute is the same notice (a retry, a second poll). */
  add({ kind, title, body = '', projectId = null, url = '#/', eventId = null, engine = null, conversationId = null, runId = null }) {
    if (!NOTICE_KINDS.includes(kind)) throw new Error(`Unknown notice kind ${kind}.`);
    const at = this.now();
    const t = clip(title, 140);
    const dup = this.items.find((n) => eventId ? n.eventId === eventId : n.kind === kind && n.title === t && at - Date.parse(n.at) < 60_000);
    if (dup) return dup;
    const rec = { id: randomBytes(6).toString('hex'), at: new Date(at).toISOString(), kind, title: t, body: clip(body, 240), projectId, url: /^#\/[\w/.-]*$/.test(url) ? url : '#/', read: false, ...(eventId ? { eventId, engine, conversationId, runId } : {}) };
    this.items = [rec, ...this.items].slice(0, MAX);
    this.#save();
    for (const f of this.listeners) { try { f(rec); } catch { /* a bad listener must not stop the others */ } }
    return rec;
  }

  list(limit = MAX) {
    return { notices: this.items.slice(0, Math.max(1, Math.min(MAX, limit))), unread: this.items.filter((n) => !n.read).length };
  }

  /** Mark some (ids) or all of them read. Returns how many changed. */
  markRead(ids = null) {
    let n = 0;
    for (const x of this.items) if (!x.read && (!ids || ids.includes(x.id))) { x.read = true; n++; }
    if (n) this.#save();
    return n;
  }

  clear() { const n = this.items.length; this.items = []; this.#save(); return n; }

  subscribe(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
}
