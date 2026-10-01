// The broker between engines and the human. It owns every run, turns an agent's permission requests and questions
// into Inbox records plus popups, waits for the human's answer, and tells the engine what was decided.
import crypto from 'node:crypto';
import { badRequest, busy, notFound, notReady, conflict } from './errors.mjs';
import { evaluate, rememberRule, ruleCovers } from './policy.mjs';
import { redact } from './secrets.mjs';
import { redactDeep } from './inbox.mjs';

const newId = (prefix) => `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}...` : s);

export function systemPrompt({ projectName, node, brief }) {
  const rules = 'Work only inside this project folder. Every command and edit is shown to the human, who may refuse it: if a request is refused, do not try to get around it, say what you could not do. Never print secrets, keys or tokens; say that one exists and where. Be brief and concrete, and refer to files by their path.';
  if (node) {
    return [`You are "${node.title}" (${node.id}), one agent in the workflow of the project "${projectName}".`, node.does ? `Your job: ${node.does}` : '', node.prompt ? node.prompt : '', node.notes ? `Notes from the human: ${node.notes}` : '', brief ? `Project brief: ${brief}` : '', rules].filter(Boolean).join(' ');
  }
  return [`You are Circle Studio's assistant for the project "${projectName}".`, 'Explain what is going on from the real files (AGENTS.md, CLAUDE.md, workflow.json, docs/), and help the human by running commands and editing files when asked.', brief ? `Project brief: ${brief}` : '', rules].filter(Boolean).join(' ');
}

const answerText = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));

export class Sessions {
  constructor({ projects, chats, inbox, engines, config, getNode, getBrief }) {
    Object.assign(this, { projects, chats, inbox, engines, config });
    this.getNode = getNode || (() => null);
    this.getBrief = getBrief || (() => '');
    this.vaultEnv = () => ({}); // set by the app: keys from the vault allowed for a project
    this.runs = new Map();
    this.waiters = new Map();
    this.listeners = new Set();
    this.handoff = new Map();
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  #publish(name, data) { for (const f of this.listeners) { try { f(name, data); } catch { /* a bad listener must not stop a run */ } } }

  chatKey(projectId, nodeId, engineId) { return engineId === 'claude' && !nodeId ? projectId : `${projectId}__${nodeId || 'main'}__${engineId}`; }

  active() { return [...this.runs.values()].map((r) => ({ kind: 'chat', projectId: r.projectId, runId: r.runId, startedAt: r.startedAt })); }

  isBusy(projectId, nodeId) { return this.runs.has(`${projectId}:${nodeId || 'project'}`); }

  pending(projectId) { return this.inbox.list({ status: 'pending', projectId }); }

  live(projectId) {
    const runs = [...this.runs.values()].filter((r) => r.projectId === projectId).map((r) => ({
      runId: r.runId, nodeId: r.nodeId, engine: r.engine, model: r.model, status: r.status, startedAt: r.startedAt,
      tokens: r.tokens, contextPct: r.contextPct, costUsd: r.costUsd, lastEventAt: r.lastEventAt,
    }));
    return { runs, pending: this.inbox.pendingCount(projectId), lastHandoff: this.handoff.get(projectId) || null };
  }

  #setStatus(run, status) {
    if (run.status === status) return;
    run.status = status;
    this.#publish('run', { projectId: run.projectId, nodeId: run.nodeId, runId: run.runId, engine: run.engine, model: run.model, status });
  }

  /** Everything that can be refused before a turn starts (so the HTTP answer can still be an error, not a stream). */
  async preflight({ projectId, nodeId = null, engineId = 'claude' }) {
    const project = this.projects.resolve(projectId, { need: 'claude' });
    const adapter = this.engines.adapter(engineId);
    if (!adapter) throw badRequest(`Unknown engine "${engineId}".`);
    const info = await this.engines.info(engineId);
    if (!info?.installed) throw notReady(`${adapter.label} is not installed. ${info?.loginHint || ''}`.trim());
    if (info.loggedIn === false) throw notReady(`${adapter.label} is not signed in. ${info.loginHint || ''}`.trim());
    if (this.runs.has(`${projectId}:${nodeId || 'project'}`)) throw busy('An agent is already answering here. Wait for it or stop it.');
    const node = nodeId ? this.getNode(projectId, nodeId) : null;
    if (nodeId && !node) throw notFound(`This project's workflow has no node "${nodeId}".`);
    return { project, adapter, node };
  }

  /** Run one turn. Resolves when it is over. `emit(name, data)` is the caller's stream (server-sent events). */
  async runTurn({ projectId, nodeId = null, engineId = 'claude', model, message, newSession = false, emit, signal }) {
    const { project, adapter, node } = await this.preflight({ projectId, nodeId, engineId });
    const key = `${projectId}:${nodeId || 'project'}`;

    const ck = this.chatKey(projectId, nodeId, engineId);
    if (newSession) await this.chats.reset(ck);
    const saved = this.chats.get(ck);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const run = { runId: newId('run'), key, projectId, nodeId, engine: engineId, model: model || node?.model || null, status: 'active', startedAt: new Date().toISOString(), tokens: { input: 0, output: 0 }, contextPct: null, costUsd: null, lastEventAt: new Date().toISOString(), controller, rules: [], emit, pendingIds: new Set() };
    this.runs.set(key, run);
    this.#publish('run', { projectId, nodeId, runId: run.runId, engine: engineId, model: run.model, status: 'active' });

    const at = new Date().toISOString();
    const reply = { role: 'assistant', text: '', tools: [], at, engine: engineId };
    let sessionId = saved.sessionId;
    const sink = (name, data) => {
      run.lastEventAt = new Date().toISOString();
      if (name === 'text') reply.text += data.delta;
      else if (name === 'tool') {
        const t = reply.tools.find((x) => x.id === data.id);
        if (!t) reply.tools.push({ id: data.id, name: data.name, summary: data.summary || data.name, ok: null });
        else { if (data.summary) t.summary = data.summary; if (data.status === 'end') t.ok = data.ok; }
      } else if (name === 'session') { sessionId = data.sessionId || sessionId; reply.model = data.model; run.model = data.model || run.model; }
      else if (name === 'usage') {
        run.tokens = { input: data.inputTokens || 0, output: data.outputTokens || 0 };
        run.costUsd = data.costUsd ?? run.costUsd;
        if (data.contextTokens && data.contextWindow) run.contextPct = Math.min(100, Math.round((data.contextTokens / data.contextWindow) * 100));
        this.#publish('usage', { projectId, nodeId, runId: run.runId, ...data, contextPct: run.contextPct });
      } else if (name === 'done') { sessionId = data.sessionId || sessionId; Object.assign(reply, { costUsd: data.costUsd, ms: data.ms, models: data.models }); }
      else if (name === 'error') reply.error = data.message;
      else if (name === 'stopped') reply.stopped = true;
      emit(name, data);
    };

    const perms = { shell: project.permissions.run === true, write: project.permissions.write === true };
    const onRequest = (req) => this.#handleRequest(run, project, perms, req);
    let outcome = { status: 'error', sessionId };
    try {
      outcome = await adapter.runTurn({
        cwd: project.root, prompt: message, model, sessionId: saved.sessionId, fork: saved.fork === true, extraEnv: this.vaultEnv(projectId), runId: run.runId, signal: controller.signal, emit: sink, onRequest,
        systemPrompt: systemPrompt({ projectName: project.name, node, brief: clip(redact(this.getBrief(projectId) || ''), 1500) }),
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#expirePending(run, 'The run ended before you answered.');
      this.runs.delete(key);
      this.#setStatus(run, outcome.status === 'done' ? 'done' : outcome.status === 'stopped' ? 'idle' : 'error');
      this.handoff.set(projectId, { from: 'you', to: nodeId || 'project', at: new Date().toISOString(), ms: reply.ms ?? null });
      await this.chats.append(ck, [{ role: 'user', text: message, at, engine: engineId }, reply], outcome.sessionId || sessionId);
    }
    return outcome;
  }

  async #handleRequest(run, project, perms, req) {
    const ev = evaluate({ tool: req.tool, input: req.input, blockedPath: req.blockedPath }, { root: project.root, protect: [this.config.dataDir], permissions: perms });
    if (ev.verdict === 'allow') return { decision: 'allow' };
    const base = {
      projectId: run.projectId, nodeId: run.nodeId, runId: run.runId, engine: run.engine, kind: ev.kind, risk: ev.risk, tool: req.tool,
      title: ev.title || `Use ${req.tool}`, detail: ev.detail || '', input: req.input, reasons: ev.reasons, at: new Date().toISOString(),
      ...(ev.questions ? { questions: ev.questions } : {}),
    };
    if (ev.verdict === 'deny') {
      const rec = this.inbox.add({ id: newId('r'), ...base, status: 'auto-denied', resolvedAt: new Date().toISOString(), note: ev.reasons.join(' ') });
      this.#publish('request-resolved', rec);
      run.emit('request-resolved', rec);
      return { decision: 'deny', message: `Refused by Circle Studio: ${ev.reasons.join(' ') || 'not allowed here.'}` };
    }
    if (ev.risk === 'normal' && ev.kind === 'approval' && run.rules.some((r) => ruleCovers(r, req.tool, req.input))) return { decision: 'allow' };
    const rec = this.inbox.add({ id: newId('r'), ...base, status: 'pending', resolvedAt: null });
    this.#publish('request', rec);
    run.emit('request', rec);
    run.pendingIds.add(rec.id);
    this.#setStatus(run, 'waiting');
    return new Promise((resolve) => { this.waiters.set(rec.id, { resolve, run, req, ev }); });
  }

  /** The human's answer to a pending request. */
  respond(id, body = {}) {
    const rec = this.inbox.get(id);
    if (!rec) throw notFound('No such request.');
    const w = this.waiters.get(id);
    if (rec.status !== 'pending' || !w) throw conflict(`This request is already ${rec.status === 'pending' ? 'expired' : rec.status}.`);
    const decision = body.decision;
    if (!['allow', 'deny', 'answer'].includes(decision)) throw badRequest('decision must be allow, deny or answer.');
    if (rec.kind === 'question' && decision === 'allow') throw badRequest('Answer a question with decision "answer".');
    if (rec.kind === 'approval' && decision === 'answer') throw badRequest('An approval is answered with allow or deny.');
    let answers;
    if (decision === 'answer') {
      const given = body.answers && typeof body.answers === 'object' ? body.answers : null;
      if (!given) throw badRequest('Send answers: an object from each question to your answer.');
      answers = {};
      for (const q of rec.questions || []) {
        const a = answerText(given[q.question]).trim();
        if (!a) throw badRequest(`Answer the question: ${q.question}`);
        answers[q.question] = a.slice(0, 2000);
      }
    }
    const note = typeof body.note === 'string' ? body.note.slice(0, 500) : undefined;
    if (decision === 'allow' && body.remember === 'run' && rec.risk === 'normal') {
      const rule = rememberRule(w.req.tool, w.req.input);
      if (rule) w.run.rules.push(rule);
    }
    const status = decision === 'allow' ? 'allowed' : decision === 'deny' ? 'denied' : 'answered';
    const done = this.inbox.update(id, { status, resolvedAt: new Date().toISOString(), ...(answers ? { answer: answers } : {}), ...(note ? { note } : {}) });
    this.waiters.delete(id);
    w.run.pendingIds.delete(id);
    if (!w.run.pendingIds.size) this.#setStatus(w.run, 'active');
    this.#publish('request-resolved', done);
    w.run.emit('request-resolved', done);
    w.resolve(decision === 'deny' ? { decision: 'deny', message: note || 'The human said no.' } : { decision: 'allow', ...(answers ? { answers } : {}) });
    return done;
  }

  #expirePending(run, why) {
    for (const id of [...run.pendingIds]) {
      const w = this.waiters.get(id);
      this.waiters.delete(id);
      const done = this.inbox.update(id, { status: 'expired', resolvedAt: new Date().toISOString(), note: why });
      if (done) this.#publish('request-resolved', done);
      w?.resolve({ decision: 'deny', message: why });
    }
    run.pendingIds.clear();
  }

  /** Stop the run for a project (and node). Returns true when something was stopped. */
  stop(projectId, nodeId) {
    const run = this.runs.get(`${projectId}:${nodeId || 'project'}`) || [...this.runs.values()].find((r) => r.runId === projectId);
    if (!run) return false;
    this.#expirePending(run, 'You stopped the run.');
    run.controller.abort();
    return true;
  }

  async stopAll() {
    for (const run of [...this.runs.values()]) { this.#expirePending(run, 'The app is shutting down.'); run.controller.abort(); }
    for (let i = 0; i < 20 && this.runs.size; i++) await new Promise((r) => setTimeout(r, 100));
  }
}
