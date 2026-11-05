import { randomUUID } from 'node:crypto';
import { badRequest, conflict, notFound } from './errors.mjs';
import { redact } from './secrets.mjs';

const slot = (e) => `${e.projectId}:${e.nodeId || 'main'}`;
const PENDING = new Set(['queued', 'running', 'paused']);
export class ChatQueue {
  constructor({ store, sessions, projects }) {
    Object.assign(this, { store, sessions, projects });
    this.draining = new Set(); this.stopping = false;
    this.entries = store.readJson('queue.json', { entries: [] }).entries || [];
    for (const e of this.entries) { if (e.status === 'queued') e.status = 'paused'; else if (e.status === 'running') { e.status = 'interrupted'; e.error = 'The app stopped during this message. Check its conversation before sending again.'; } }
    if (this.entries.length) this.#save();
    sessions.onSettled = (projectId, nodeId) => { void this.drain(projectId, nodeId); };
  }
  #save() { this.store.writeJson('queue.json', { version: 1, entries: this.entries }); }
  list(projectId, nodeId = null) { return this.entries.filter((e) => e.projectId === projectId && (e.nodeId || null) === nodeId); }
  async enqueue(input) {
    this.projects.resolve(input.projectId, { need: 'engine' });
    if (!this.sessions.engines.adapter(input.engineId)) throw badRequest('Unknown queue engine.');
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 20000) throw badRequest('Give a message of at most 20,000 characters.');
    if (input.model && !/^[A-Za-z0-9._:-]{1,100}$/.test(input.model)) throw badRequest('Invalid queued model.');
    if (input.reasoning && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(input.reasoning)) throw badRequest('Invalid queued reasoning setting.');
    const clientId = input.clientId || randomUUID();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(clientId)) throw badRequest('Invalid message id.');
    const duplicate = this.entries.find((e) => e.clientId === clientId);
    if (duplicate) {
      if (duplicate.projectId !== input.projectId || duplicate.engineId !== input.engineId || duplicate.nodeId !== (input.nodeId || null) || duplicate.model !== (input.model || null) || (duplicate.reasoning || null) !== (input.reasoning || null) || (input.conversationId && input.conversationId !== duplicate.conversationId) || duplicate.message !== redact(input.message)) throw conflict('That message id belongs to another message or target.');
      return duplicate;
    }
    if (this.entries.filter((e) => PENDING.has(e.status)).length >= 100) throw badRequest('There are already 100 queued messages.');
    const key = this.sessions.chatKey(input.projectId, input.nodeId || null, input.engineId);
    const current = this.sessions.chats.get(key);
    if (input.conversationId) this.sessions.chats.read(key, input.conversationId, { limit: 1 });
    const entry = { id: randomUUID(), clientId, projectId: input.projectId, nodeId: input.nodeId || null, engineId: input.engineId, model: input.model || null, reasoning: input.reasoning || null, conversationId: input.conversationId || current.conversationId || null, message: redact(input.message), at: new Date().toISOString(), status: 'queued' };
    this.entries.push(entry);
    const complete = this.entries.filter((e) => !PENDING.has(e.status)).slice(-200);
    this.entries = [...complete, ...this.entries.filter((e) => PENDING.has(e.status))];
    this.#save();
    void this.drain(entry.projectId, entry.nodeId);
    return entry;
  }
  change(id, action, message) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw notFound('No such queued message.');
    if (!['queued', 'paused'].includes(entry.status)) throw conflict('This message has already started or finished.');
    if (action === 'cancel') entry.status = 'cancelled';
    else if (action === 'edit') {
      if (typeof message !== 'string' || !message.trim() || message.length > 20000) throw badRequest('Give a message of at most 20,000 characters.');
      entry.message = redact(message);
    } else if (action === 'up' || action === 'down') {
      const current = this.entries.indexOf(entry); const direction = action === 'up' ? -1 : 1;
      let other = current + direction;
      while (other >= 0 && other < this.entries.length && !(slot(this.entries[other]) === slot(entry) && ['queued', 'paused'].includes(this.entries[other].status))) other += direction;
      if (other >= 0 && other < this.entries.length) [this.entries[current], this.entries[other]] = [this.entries[other], this.entries[current]];
    } else if (action === 'resume') entry.status = 'queued';
    else throw badRequest('Unknown queue action.');
    this.#save();
    if (entry.status === 'queued') void this.drain(entry.projectId, entry.nodeId);
    return entry;
  }
  async drain(projectId, nodeId = null) {
    const key = slot({ projectId, nodeId });
    if (this.stopping || this.draining.has(key) || this.sessions.isBusy(projectId, nodeId)) return;
    this.draining.add(key);
    try {
      for (;;) {
        if (this.stopping || this.sessions.isBusy(projectId, nodeId)) return;
        const entry = this.entries.find((e) => slot(e) === key && e.status === 'queued');
        if (!entry) return;
        const current = this.sessions.chats.get(this.sessions.chatKey(projectId, nodeId, entry.engineId));
        if (entry.conversationId && current.conversationId !== entry.conversationId) { entry.status = 'paused'; entry.error = 'The selected conversation changed. Reopen the original conversation before resuming this message.'; this.#save(); return; }
        entry.status = 'running'; entry.error = null; this.#save();
        try {
          const result = await this.sessions.runTurn({ projectId, nodeId, engineId: entry.engineId, model: entry.model || undefined, reasoning: entry.reasoning || undefined, message: entry.message, emit: () => {} });
          entry.status = result.status === 'done' ? 'done' : result.status === 'stopped' ? 'interrupted' : 'error';
          entry.conversationId = this.sessions.chats.get(this.sessions.chatKey(projectId, nodeId, entry.engineId)).conversationId;
        } catch (error) { entry.status = 'error'; entry.error = redact(String(error.message)).slice(0, 400); }
        this.#save();
        if (entry.status !== 'done') return;
      }
    } finally { this.draining.delete(key); }
  }
  stop() { this.stopping = true; }
}
