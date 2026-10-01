// Per-project records kept in the app's data folder: the plan and the chat transcript.
import { normalizePlan, defaultPlan, lintPlan } from './plan.mjs';

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
  constructor(store) { this.store = store; }

  get(projectId) {
    const c = this.store.readJson(`chats/${projectId}.json`, null);
    if (!c || !Array.isArray(c.messages)) return { version: 1, sessionId: null, messages: [] };
    return c;
  }

  append(projectId, messages, sessionId) {
    return this.store.serial(`chat:${projectId}`, () => {
      const c = this.get(projectId);
      c.messages.push(...messages);
      if (c.messages.length > MAX_MESSAGES) c.messages = c.messages.slice(-MAX_MESSAGES);
      if (sessionId !== undefined) {
        if (c.fork && sessionId && sessionId !== c.sessionId) delete c.fork; // the first turn made its own copy
        c.sessionId = sessionId;
      }
      this.store.writeJson(`chats/${projectId}.json`, c);
    });
  }

  /** Continue a Claude Code conversation from the terminal here. The first turn forks it, so the original stays as it was. */
  link(projectId, linked) {
    return this.store.serial(`chat:${projectId}`, () => this.store.writeJson(`chats/${projectId}.json`, { version: 1, sessionId: linked.id, fork: true, linked, messages: [] }));
  }

  reset(projectId) {
    return this.store.serial(`chat:${projectId}`, () => this.store.writeJson(`chats/${projectId}.json`, { version: 1, sessionId: null, messages: [] }));
  }
}
