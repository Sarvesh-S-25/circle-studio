// The engine registry: one adapter per engine, and a cached, no-model-call view of what each can do right now.
import { createClaudeAdapter } from './claude.mjs';
import { createCopilotAdapter } from './copilot.mjs';
import { createCodexAdapter } from './codex.mjs';
import { createAgyAdapter } from './agy.mjs';

export const ENGINE_IDS = ['claude', 'codex', 'gemini', 'copilot'];
const TTL_MS = 60_000;

export function defaultAdapters({ claudeService }) {
  return [createClaudeAdapter({ service: claudeService }), createCodexAdapter(), createAgyAdapter(), createCopilotAdapter()];
}

export class Engines {
  constructor(adapters) {
    this.adapters = new Map(adapters.map((a) => [a.id, a]));
    this.cache = new Map();
    this.catalogCache = new Map();
    this.detecting = new Map();
  }

  adapter(id) { return this.adapters.get(id) || null; }

  /** What one engine can do now (detected at most once a minute). Never contains an e-mail, organisation or token. */
  async #detect(a, force) {
    const hit = this.cache.get(a.id);
    if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.info;
    if (this.detecting.has(a.id)) return this.detecting.get(a.id);
    const pending = this.#detectFresh(a).finally(() => this.detecting.delete(a.id));
    this.detecting.set(a.id, pending);
    return pending;
  }

  async #detectFresh(a) {
    let d;
    try { d = await a.detect(); } catch { d = { installed: false, version: null, loggedIn: null, loginHint: '' }; }
    let catalog = [];
    if (d.installed && d.loggedIn === true && a.catalog) { try { catalog = await a.catalog(); this.catalogCache.set(a.id, catalog); } catch { /* detection stays useful on older protocols */ } }
    const capabilities = { ...a.capabilities, ...(a.capabilities?.liveEvidence ? { liveVerified: d.version === a.capabilities.liveEvidence.version } : {}) };
    const info = { id: a.id, label: a.label, installed: d.installed === true, version: d.version ?? null, loggedIn: d.loggedIn ?? null, loginHint: d.loginHint || '', detail: d.detail || '', usable: d.installed === true && d.loggedIn !== false, capabilities, models: catalog.length ? catalog.map((m) => m.id) : a.models, modelCatalog: catalog, notes: a.notes };
    this.cache.set(a.id, { at: Date.now(), info });
    return info;
  }

  list({ force = false } = {}) { return Promise.all([...this.adapters.values()].map((a) => this.#detect(a, force))); }

  /**
   * What is already known, without asking any engine: the last detection of every engine, or null when any has
   * never been detected. Pages that only want a hint (lint warnings) use this so they never wait on the CLIs.
   */
  known() {
    const all = [...this.adapters.values()].map((a) => this.cache.get(a.id)?.info);
    return all.every(Boolean) ? all : null;
  }

  info(id, { force = false } = {}) { const a = this.adapters.get(id); return a ? this.#detect(a, force) : Promise.resolve(null); }
}
