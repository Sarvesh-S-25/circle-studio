// Per-project records kept in the app's data folder: the plan and the chat transcript.
import { normalizePlan, defaultPlan, lintPlan } from './plan.mjs';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { badRequest, notFound } from './errors.mjs';
import { redactDeep } from './inbox.mjs';
import { BoundedCache } from './cache.mjs';
import { indexTranscript, readTranscriptPage } from './transcript-pages.mjs';

function conversationMeta(key, c) {
  const first = c.messages.find((m) => m.role === 'user');
  const engine = c.messages.find((m) => m.engine)?.engine || (key.includes('__') ? key.split('__').at(-1) : 'claude');
  const dailyUsage = {};
  for (const m of c.messages) if (m.role === 'assistant' && /^\d{4}-\d{2}-\d{2}/.test(m.at || '')) {
    const day = m.at.slice(0, 10); const id = `${day}:${m.engine || engine}`;
    dailyUsage[id] ||= { day, engine: m.engine || engine, turns: 0, usd: 0 };
    dailyUsage[id].turns++; dailyUsage[id].usd += typeof m.costUsd === 'number' ? m.costUsd : 0;
  }
  return { id: c.conversationId, sessionId: c.sessionId || null, title: String((c.title !== 'New conversation' ? c.title : null) || c.linked?.title || first?.text || 'New conversation').replace(/\s+/g, ' ').slice(0, 160), startedAt: c.startedAt || c.messages[0]?.at || new Date().toISOString(), lastAt: c.messages.at(-1)?.at || c.startedAt || new Date().toISOString(), engine, messages: c.messages.length, archived: c.archived === true, costUsd: c.messages.reduce((n, m) => n + (typeof m.costUsd === 'number' ? m.costUsd : 0), 0), dailyUsage: Object.values(dailyUsage) };
}

export class Plans {
  constructor(store) { this.store = store; }

  get(project) {
    const saved = this.store.readJson(`plans/${project.id}.json`, null);
    if (!saved) return defaultPlan(project.id, project.name);
    try { return normalizePlan(saved, project.id, defaultPlan(project.id, project.name)); } catch { return defaultPlan(project.id, project.name); }
  }

  save(project, input) {
    const plan = normalizePlan(input, project.id, this.get(project));
    this.store.writeJson(`plans/${project.id}.json`, plan);
    return plan;
  }

  withLint(plan) { return { plan, warnings: lintPlan(plan) }; }
}

const MAX_MESSAGES = 200;

export class Chats {
  constructor(store) {
    this.store = store;
    this.pages = new BoundedCache({ entries: 64, bytes: 2 * 1024 * 1024 });
    this.indexes = new BoundedCache({ entries: 32, bytes: 1024 * 1024 });
    this.offsets = new BoundedCache({ entries: 16, bytes: 1024 * 1024 });
    // A turn whose server vanished is recovered as interrupted, never silently retried.
    let files = []; try { files = fs.readdirSync(store.abs('inflight')); } catch { /* first start */ }
    for (const name of files) {
      if (!/^[A-Za-z0-9_-]{1,200}\.json$/.test(name)) continue;
      const key = name.slice(0, -5);
      const pending = store.readJson(`inflight/${name}`, null);
      if (!pending?.runId || !Array.isArray(pending.messages)) continue;
      const current = this.#full(key);
      if (!current.messages.some((m) => m.role === 'assistant' && m.runId === pending.runId)) {
        const recovered = redactDeep(pending.messages).map((m) => m.role === 'assistant' ? { ...m, stopped: true, error: 'Interrupted when Circle Studio stopped. The partial answer was recovered; review it before continuing.' } : m);
        current.messages.push(...recovered);
        current.sessionId = pending.sessionId || current.sessionId;
        this.#save(key, current);
      }
      this.clearCheckpoint(key);
    }
  }

  #key(key) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(String(key))) throw badRequest('Invalid chat key.');
    return key;
  }

  #file(key, id) {
    this.#key(key);
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw badRequest('Invalid conversation id.');
    return `conversations/${key}/${id}.json`;
  }

  #signature(file) {
    try { const s = fs.statSync(this.store.abs(file), { bigint: true }); return `${s.size}:${s.mtimeNs}:${s.ctimeNs}`; } catch { return 'missing'; }
  }

  #index(key) {
    const file = `conversations/${this.#key(key)}/index.json`;
    const signature = this.#signature(file);
    const cached = this.indexes.get(key);
    if (cached?.signature === signature) return cached.value;
    const value = this.store.readJson(file, { conversations: [] });
    this.indexes.set(key, { signature, value });
    return value;
  }

  cacheStats() { return Object.fromEntries(['pages', 'indexes', 'offsets'].map((name) => [name, { entries: this[name].size, bytes: this[name].bytes, budget: this[name].byteLimit }])); }

  #save(key, record) {
    const c = { ...record, version: 2, conversationId: record.conversationId || randomUUID() };
    const indexFile = `conversations/${this.#key(key)}/index.json`;
    const index = this.store.readJson(indexFile, { version: 1, conversations: [] });
    const meta = conversationMeta(key, c);
    Object.assign(c, { title: meta.title, startedAt: meta.startedAt, lastAt: meta.lastAt });
    this.store.writeJson(this.#file(key, c.conversationId), c);
    index.conversations = [meta, ...index.conversations.filter((x) => x.id !== c.conversationId)];
    this.store.writeJson(indexFile, index);
    // Keep the legacy active path as a bounded compatibility view, not as the only copy of the transcript.
    this.store.writeJson(`chats/${key}.json`, { ...c, totalMessages: c.messages.length, messages: c.messages.slice(-MAX_MESSAGES) });
    return c;
  }

  #full(key) {
    const active = this.get(key);
    return active.conversationId ? this.store.readJson(this.#file(key, active.conversationId), active) : active;
  }

  get(projectId) {
    this.#key(projectId);
    const c = this.store.readJson(`chats/${projectId}.json`, null);
    if (!c || !Array.isArray(c.messages)) return { version: 1, sessionId: null, messages: [] };
    return c;
  }

  selected(projectId, nodeId = null) { return this.store.readJson('chat-selections.json', {})[`${this.#key(projectId)}:${nodeId || 'main'}`] || null; }
  selectTarget(projectId, nodeId, engine, model = null, reasoning = null) {
    this.#key(projectId); if (nodeId) this.#key(nodeId);
    if (!['claude', 'codex', 'gemini', 'copilot'].includes(engine) || (model && !/^[A-Za-z0-9._:-]{1,100}$/.test(model))) throw badRequest('Invalid conversation target.');
    if (reasoning && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(reasoning)) throw badRequest('Invalid reasoning setting.');
    const selections = this.store.readJson('chat-selections.json', {});
    selections[`${projectId}:${nodeId || 'main'}`] = { engine, model: model || null, reasoning: reasoning || null };
    this.store.writeJson('chat-selections.json', selections);
    return selections[`${projectId}:${nodeId || 'main'}`];
  }

  append(projectId, messages, sessionId) {
    return this.store.serial(`chat:${projectId}`, () => {
      const c = this.#full(projectId);
      c.messages.push(...redactDeep(messages));
      if (sessionId !== undefined) {
        if (c.fork && sessionId && sessionId !== c.sessionId) delete c.fork; // the first turn made its own copy
        c.sessionId = sessionId;
      }
      return this.#save(projectId, c);
    });
  }

  checkpoint(key, runId, messages, sessionId) {
    this.store.writeJson(`inflight/${this.#key(key)}.json`, redactDeep({ runId, messages, sessionId }));
  }
  clearCheckpoint(key) { try { fs.unlinkSync(this.store.abs(`inflight/${this.#key(key)}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }

  /** Continue a Claude Code conversation from the terminal here. The first turn forks it, so the original stays as it was. */
  link(projectId, linked) {
    return this.store.serial(`chat:${projectId}`, () => {
      const old = this.#full(projectId);
      if (old.messages.length || old.linked) this.#save(projectId, old);
      return this.#save(projectId, { sessionId: linked.id, fork: linked.fork !== false, linked, messages: [], startedAt: new Date().toISOString() });
    });
  }

  /** A new chat: nothing said yet. `startedAt` lets the chat window show it instead of an older conversation. */
  reset(projectId) {
    return this.store.serial(`chat:${projectId}`, () => {
      const old = this.#full(projectId);
      if (old.messages.length || old.linked) this.#save(projectId, old);
      return this.#save(projectId, { sessionId: null, messages: [], startedAt: new Date().toISOString() });
    });
  }

  keys(projectId) {
    let names = [];
    try { names = fs.readdirSync(this.store.abs('chats')); } catch { return []; }
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((k) => !projectId || k === projectId || k.startsWith(`${projectId}__`));
  }

  summary(projectId) {
    const result = { messages: 0, costUsd: 0, lastAt: null };
    for (const key of this.keys(projectId)) {
      const index = this.#index(key);
      const active = this.get(key);
      const records = [...index.conversations];
      if (!records.some((c) => c.id === active.conversationId)) records.push({ messages: active.totalMessages ?? active.messages.length, costUsd: active.messages.reduce((n, m) => n + (m.costUsd || 0), 0), lastAt: active.messages.at(-1)?.at });
      for (const c of records) {
        result.messages += c.messages || 0;
        result.costUsd += c.costUsd || 0;
        if (c.lastAt && (!result.lastAt || c.lastAt > result.lastAt)) result.lastAt = c.lastAt;
      }
    }
    return result;
  }
  usageRecords() {
    const messages = [];
    for (const key of this.keys()) {
      const index = this.#index(key);
      const active = this.get(key);
      const records = index.conversations.length ? index.conversations : [conversationMeta(key, active)];
      for (const meta of records) {
        const daily = meta.dailyUsage || conversationMeta(key, this.store.readJson(this.#file(key, meta.id), { ...active, messages: [] })).dailyUsage;
        for (const day of daily) messages.push({ role: 'assistant', at: `${day.day}T00:00:00Z`, engine: day.engine, turns: day.turns, costUsd: day.usd });
      }
    }
    return [{ messages }];
  }
  rebuildIndexes() {
    let folders = []; const skipped = []; let conversations = 0;
    try { folders = fs.readdirSync(this.store.abs('conversations'), { withFileTypes: true }); } catch { return { conversations, skipped }; }
    for (const folder of folders) {
      if (!folder.isDirectory() || !/^[A-Za-z0-9_-]{1,200}$/.test(folder.name)) continue;
      const records = [];
      for (const entry of fs.readdirSync(this.store.abs(`conversations/${folder.name}`), { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const file = entry.name;
        if (!/^[0-9a-f-]{36}\.json$/i.test(file)) continue;
        const record = this.store.readJson(`conversations/${folder.name}/${file}`, null);
        if (!record || record.conversationId !== file.slice(0, -5) || !Array.isArray(record.messages)) { skipped.push(`${folder.name}/${file}`); continue; }
        records.push(conversationMeta(folder.name, record)); conversations++;
      }
      this.store.writeJson(`conversations/${folder.name}/index.json`, { version: 1, conversations: records });
    }
    return { conversations, skipped, note: 'Rebuilt only derived indexes. Full transcripts and selected conversations were not modified.' };
  }

  list(key, { archived = false, limit = 40, offset = 0 } = {}) {
    const index = this.#index(key);
    const all = index.conversations.filter((c) => (c.messages > 0 || c.sessionId) && Boolean(c.archived) === archived).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    const page = all.slice(offset, offset + Math.min(100, limit));
    return { conversations: page, total: all.length, nextOffset: offset + page.length < all.length ? offset + page.length : null };
  }

  read(key, id, { offset = 0, limit = 150 } = {}) {
    const file = this.#file(key, id);
    const start = Math.max(0, Math.trunc(Number(offset) || 0)); const end = start + Math.min(400, Math.max(1, Math.trunc(Number(limit) || 150)));
    const signature = this.#signature(file);
    const pageKey = `${key}:${id}:${start}:${end}`;
    const hit = this.pages.get(pageKey);
    if (hit?.signature === signature) return structuredClone(hit.value);
    if (signature === 'missing') throw notFound('That conversation is no longer available.');
    let indexed = this.offsets.get(file);
    if (indexed?.signature !== signature) {
      indexed = { signature, ...indexTranscript(this.store.abs(file)) };
      this.offsets.set(file, indexed);
    }
    const value = { ...indexed.metadata, messages: readTranscriptPage(this.store.abs(file), indexed, start, end), totalMessages: indexed.total, nextOffset: end < indexed.total ? end : null };
    if (signature === this.#signature(file)) this.pages.set(pageKey, { signature, value });
    return structuredClone(value);
  }

  select(key, id) {
    return this.store.serial(`chat:${key}`, () => {
      const c = this.store.readJson(this.#file(key, id), null);
      if (!c) throw notFound('That conversation is no longer available.');
      const old = this.#full(key);
      if (old.messages.length || old.linked) this.#save(key, old);
      return this.#save(key, { ...c, archived: false });
    });
  }

  /** Record a provider fork without switching an unrelated selected Circle conversation. */
  providerSession(key, id, sessionId) {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) throw badRequest('Invalid provider conversation id.');
    return this.store.serial(`chat:${key}`, () => {
      const c = this.store.readJson(this.#file(key, id), null);
      if (!c) throw notFound('That conversation is no longer available.');
      const active = this.get(key);
      const updated = this.#save(key, { ...c, sessionId, fork: false });
      if (active.conversationId !== id) this.store.writeJson(`chats/${key}.json`, active);
      return updated;
    });
  }

  archive(key, id, archived = true) {
    return this.store.serial(`chat:${key}`, () => {
      const c = this.store.readJson(this.#file(key, id), null);
      if (!c) throw notFound('That conversation is no longer available.');
      const active = this.get(key);
      const result = this.#save(key, { ...c, archived });
      if (active.conversationId !== id) this.store.writeJson(`chats/${key}.json`, active);
      else if (archived) this.#save(key, { sessionId: null, messages: [], startedAt: new Date().toISOString() });
      return result;
    });
  }
}
