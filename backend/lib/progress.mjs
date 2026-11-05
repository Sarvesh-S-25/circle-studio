import { randomUUID } from 'node:crypto';
import { badRequest, conflict, notFound } from './errors.mjs';
import { redact } from './secrets.mjs';

export const TASK_STATES = ['planned', 'working', 'needs-you', 'blocked', 'review', 'done', 'cancelled', 'superseded'];
const text = (v, max) => redact(String(v || '').trim()).slice(0, max);
const verified = (t) => t.status === 'done' && t.reviewed === true && t.evidence?.length > 0;

export class Progress {
  constructor(store) { this.store = store; }
  recordHandoff(projectId, input) {
    return this.store.serial(`progress:${projectId}`, () => {
      if (input.reviewed !== true || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 12000) throw badRequest('Review a handoff summary of at most 12,000 characters.');
      const record = this.read(projectId);
      const event = { id: randomUUID(), type: 'handoff-prepared', ruleVersion: 1, at: new Date().toISOString(), sourceEngine: input.sourceEngine, targetEngine: input.targetEngine, conversationId: input.conversationId, nodeId: input.nodeId || null, summary: text(input.summary, 12000), sourceMessages: input.sourceMessages, reviewed: true };
      record.events.push(event);
      this.store.writeJson(`progress/${projectId}.json`, { version: 1, tasks: record.tasks, events: record.events });
      return event;
    });
  }
  read(projectId, { achievements = false } = {}) {
    const record = this.store.readJson(`progress/${projectId}.json`, { version: 1, tasks: [], events: [] });
    const done = record.tasks.filter(verified);
    const required = record.tasks.filter((t) => !t.optional && !['cancelled', 'superseded'].includes(t.status));
    const awards = [];
    const resetAt = record.events.findLastIndex((e) => e.type === 'achievement-reset');
    const accepted = record.events.slice(resetAt + 1).filter((e) => e.type === 'accepted');
    if (achievements && accepted.length) awards.push({ id: 'first-verified-task', title: 'First verified task', ruleVersion: 1, reason: 'A task was accepted with a human review and evidence.' });
    if (achievements && accepted.some((e) => e.engine === 'codex')) awards.push({ id: 'first-codex-workflow', title: 'First accepted Codex task', ruleVersion: 1, reason: 'A Codex task was accepted with review evidence.' });
    if (achievements && accepted.length >= 5) awards.push({ id: 'five-verified-tasks', title: 'Five verified tasks', ruleVersion: 1, reason: 'Five distinct tasks were accepted. Reopening and replaying a task cannot add another acceptance.' });
    const stages = [...new Set(record.tasks.map((t) => t.stageId).filter(Boolean))].map((id) => {
      const tasks = required.filter((t) => t.stageId === id);
      return { id, total: tasks.length, done: tasks.filter(verified).length, complete: tasks.length > 0 && tasks.every(verified) };
    });
    if (achievements && stages.some((s) => s.complete && required.filter((t) => t.stageId === s.id).every((t) => accepted.some((e) => e.taskId === t.id)))) awards.push({ id: 'verified-stage', title: 'A stage fully accepted', ruleVersion: 1, reason: 'Every required task in a stage has review evidence; cancelled and optional tasks do not count as completion.' });
    return { ...record, summary: { total: required.length, done: required.filter(verified).length, accepted: done.length, cancelled: record.tasks.filter((t) => ['cancelled', 'superseded'].includes(t.status)).length }, stages, achievements: awards, achievementsEnabled: achievements };
  }
  resetAchievements(projectId) {
    return this.store.serial(`progress:${projectId}`, () => {
      const record = this.read(projectId);
      record.events.push({ id: randomUUID(), type: 'achievement-reset', ruleVersion: 1, at: new Date().toISOString() });
      this.store.writeJson(`progress/${projectId}.json`, { version: 1, tasks: record.tasks, events: record.events });
      return this.read(projectId, { achievements: true });
    });
  }
  async save(projectId, input, workflow) {
    return this.store.serial(`progress:${projectId}`, () => {
      const record = this.read(projectId);
      if (record.tasks.length >= 2000 && !input.id) throw badRequest('This project already has 2,000 tasks.');
      const old = input.id ? record.tasks.find((t) => t.id === input.id) : null;
      if (input.id && !old) throw notFound('No such task.');
      const task = { ...(old || {}), id: old?.id || randomUUID(), title: text(input.title ?? old?.title, 200), detail: text(input.detail ?? old?.detail, 4000), owner: text(input.owner ?? old?.owner, 100), engine: input.engine ?? old?.engine ?? null, stageId: input.stageId ?? old?.stageId ?? null, status: input.status ?? old?.status ?? 'planned', optional: input.optional ?? old?.optional ?? false, reviewed: input.reviewed === true, updatedAt: new Date().toISOString() };
      if (!task.title) throw badRequest('Give the task a title.');
      if (input.importedFrom || old?.importedFrom) task.importedFrom = text(input.importedFrom || old.importedFrom, 120);
      if (!TASK_STATES.includes(task.status)) throw badRequest('Unknown task status.');
      if (task.engine && !['claude', 'codex', 'gemini', 'copilot'].includes(task.engine)) throw badRequest('Unknown task engine.');
      if (task.stageId && !workflow.nodes.some((n) => n.kind === 'stage' && n.id === task.stageId)) throw badRequest('Choose a stage in this workflow.');
      task.dependencies = [...new Set(Array.isArray(input.dependencies) ? input.dependencies : old?.dependencies || [])];
      if (task.dependencies.length > 100) throw badRequest('A task can have at most 100 direct dependencies.');
      if (task.dependencies.some((id) => id === task.id || !record.tasks.some((t) => t.id === id))) throw badRequest('Dependencies must name other existing tasks.');
      task.evidence = (Array.isArray(input.evidence) ? input.evidence : old?.evidence || []).slice(0, 20).map((e) => ({ kind: ['test', 'review', 'file', 'manual'].includes(e.kind) ? e.kind : 'manual', detail: text(e.detail, 1000), reference: text(e.reference, 500) })).filter((e) => e.detail);
      if (task.status === 'done' && (!task.reviewed || !task.evidence.length)) throw badRequest('Accepting a task requires a human review and at least one evidence note.');
      if (task.status === 'done' && task.dependencies.some((id) => !verified(record.tasks.find((t) => t.id === id)))) throw conflict('Finish and accept this task’s dependencies first.');
      if (task.status !== 'done') task.reviewed = false;
      const graph = new Map(record.tasks.filter((t) => t.id !== task.id).map((t) => [t.id, t.dependencies || []])); graph.set(task.id, task.dependencies);
      const visited = new Set();
      const visit = (id, stack = new Set()) => { if (stack.has(id)) throw badRequest('Task dependencies form a cycle.'); if (visited.has(id)) return; const next = new Set(stack).add(id); for (const dep of graph.get(id) || []) visit(dep, next); visited.add(id); };
      visit(task.id);
      record.tasks = [...record.tasks.filter((t) => t.id !== task.id), task];
      // Acceptance depends on the current evidence of prerequisites, including transitive ones.
      // Keep the historical acceptance events, but require a fresh review of dependent work.
      for (let pass = 0; pass < record.tasks.length; pass++) {
        let changed = false;
        for (const dependent of record.tasks) {
          if (!verified(dependent) || !(dependent.dependencies || []).some((id) => !verified(record.tasks.find((t) => t.id === id)))) continue;
          dependent.status = 'review'; dependent.reviewed = false;
          dependent.dependencyNotice = 'A dependency was reopened or is no longer accepted. Review this task again after its dependencies are accepted.';
          dependent.updatedAt = task.updatedAt; changed = true;
        }
        if (!changed) break;
      }
      if (verified(task)) delete task.dependencyNotice;
      if (verified(task) && !record.events.some((e) => e.type === 'accepted' && e.taskId === task.id)) record.events.push({ id: randomUUID(), type: 'accepted', ruleVersion: 1, taskId: task.id, engine: task.engine, at: task.updatedAt, evidence: task.evidence });
      this.store.writeJson(`progress/${projectId}.json`, { version: 1, tasks: record.tasks, events: record.events });
      return task;
    });
  }
}
