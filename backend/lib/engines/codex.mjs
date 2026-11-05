// Codex as an engine, over `codex app-server` (JSON-RPC lines on stdio). Built from the generated schema and the
// documentation and codex-cli 0.163.0 schemas. Version-scoped live evidence: docs/research/codex-2026-10-22.md.
import { startChild, killTree, runCommand, versionOf, resolveCli } from './proc.mjs';
import { RpcPeer } from './rpc.mjs';
import { redact } from '../secrets.mjs';
import { createHash } from 'node:crypto';

const CAPABILITIES = { chat: true, shell: 'approvals', approvals: 'relay', approvalCoverage: 'engine', questions: 'relay', resume: true, history: true, fork: true, limits: true, modelDiscovery: true, structuredOutput: true, skillsDirs: ['.agents/skills'], instructionsFile: 'AGENTS.md', liveVerified: false, liveEvidence: { version: 'codex-cli 0.164.0', date: '2026-10-24', scenarios: ['resume', 'terminal-return', 'fork', 'history'] } };

export function createCodexAdapter({ bin, prefixArgs = [] } = {}) {
  // the real program each time (an .exe, or the script behind an npm launcher), unless a test gives one
  const cli = () => (bin !== undefined ? { bin, prefix: prefixArgs } : resolveCli('codex') || { bin: 'codex', prefix: [] });
  const queryJobs = new Map();
  async function query(method, params = {}, cwd) {
    const key = JSON.stringify([method, params, cwd]);
    if (queryJobs.has(key)) return queryJobs.get(key);
    const job = queryOnce(method, params, cwd);
    queryJobs.set(key, job);
    try { return await job; } finally { queryJobs.delete(key); }
  }
  async function queryOnce(method, params = {}, cwd) {
    const child = startChild(cli().bin, [...cli().prefix, 'app-server'], { cwd });
    const rpc = new RpcPeer(child, { jsonrpc: false, timeoutMs: 15_000, onRequest: async () => { throw new Error('This is a read-only query; interactive requests are not accepted.'); } });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'circle-studio', version: '2' } });
      rpc.notify('initialized');
      return await rpc.request(method, params);
    } finally { rpc.close(); await killTree(child); }
  }
  return {
    id: 'codex',
    label: 'Codex',
    models: [],
    capabilities: CAPABILITIES,
    notes: ['CLI 0.164.0: temporary-folder resume, sequential terminal return and fork/history checks passed. Approval/edit checks were recorded separately on 0.163.0; unlisted scenarios require verification.', 'Circle relays the approval requests Codex raises. Operations allowed by Codex policies can run without a card.'],

    async catalog() {
      const r = await query('model/list', { limit: 100, includeHidden: false });
      return (r.data || []).map((m) => ({ id: m.model || m.id, name: m.displayName || m.model || m.id, reasoning: (m.supportedReasoningEfforts || []).map((x) => x.reasoningEffort), defaultReasoning: m.defaultReasoningEffort || null, isDefault: Boolean(m.isDefault) })).filter((m) => typeof m.id === 'string');
    },
    async forkHistory({ cwd, id }) {
      const { thread } = await query('thread/read', { threadId: id, includeTurns: false }, cwd);
      if (!thread || (thread.cwd && thread.cwd.toLowerCase().replace(/\\/g, '/') !== cwd.toLowerCase().replace(/\\/g, '/'))) throw new Error('That Codex thread does not belong to this folder.');
      const result = await queryOnce('thread/fork', { threadId: id, cwd, excludeTurns: true }, cwd);
      if (!result.thread?.id || result.thread.id === id) throw new Error('Codex did not create an independent conversation copy.');
      return { id: result.thread.id };
    },
    async effectiveConnections({ cwd } = {}) {
      const response = await query('config/read', { cwd, includeLayers: false }, cwd);
      return { engine: 'codex', source: 'Codex config/read', servers: Object.entries(response.config?.mcp_servers || {}).map(([name, c]) => ({ name: redact(name), configured: true, enabled: c?.enabled !== false, authenticated: null, availableInRun: null })), note: 'Effective configuration reported by this CLI for this folder. Authentication and loading in a particular chat remain unverified. No raw configuration or credential values are returned.' };
    },
    async readLimits() {
      const auth = await query('account/read');
      if (!auth.account) return { provider: 'codex', profileId: null, available: false };
      const identity = auth.account.id || auth.account.email;
      const profileId = identity ? createHash('sha256').update(String(identity)).digest('hex').slice(0, 24) : null;
      const reading = await query('account/rateLimits/read');
      return { provider: 'codex', profileId, ...reading };
    },
    async listHistory({ cwd, cursor, limit = 40, archived = false } = {}) {
      const r = await query('thread/list', { cwd, limit, ...(cursor ? { cursor } : {}), archived, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'appServer', 'exec'] }, cwd);
      return { conversations: (r.data || []).map((t) => ({ id: t.id, title: redact(t.name || t.preview || 'Codex conversation').slice(0, 160), lastAt: new Date(t.updatedAt * 1000).toISOString(), startedAt: new Date(t.createdAt * 1000).toISOString(), engine: 'codex', source: 'codex', status: t.status?.type || 'unknown' })), nextCursor: r.nextCursor || null };
    },
    async readHistory({ cwd, id, cursor = null }) {
      const { thread } = await query('thread/read', { threadId: id, includeTurns: false }, cwd);
      if (!thread || (thread.cwd && thread.cwd.toLowerCase().replace(/\\/g, '/') !== cwd.toLowerCase().replace(/\\/g, '/'))) throw new Error('That Codex thread does not belong to this folder.');
      let page;
      try { page = await query('thread/turns/list', { threadId: id, limit: 40, sortDirection: 'asc', ...(cursor ? { cursor } : {}) }, cwd); }
      catch (error) {
        if (error.rpc?.code !== -32601 || cursor) throw error;
        const legacy = await query('thread/read', { threadId: id, includeTurns: true }, cwd);
        page = { data: legacy.thread?.turns || [], nextCursor: null };
      }
      const messages = (page.data || []).flatMap((turn) => (turn.items || []).flatMap((item) => {
        if (item.type === 'userMessage') return [{ role: 'user', text: redact((item.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')), engine: 'codex' }];
        if (item.type === 'agentMessage') return [{ role: 'assistant', text: redact(item.text || ''), engine: 'codex', tools: [] }];
        return [];
      }));
      return { id, title: redact(thread.name || thread.preview || 'Codex conversation'), messages, nextCursor: page.nextCursor || null, engine: 'codex', lastAt: new Date(thread.updatedAt * 1000).toISOString() };
    },

    async detect() {
      const v = await versionOf(cli().bin, [...cli().prefix, '--version']);
      if (!v.installed) return { installed: false, version: null, loggedIn: false, loginHint: 'Install Codex, then run `codex login`.' };
      const r = await runCommand(cli().bin, [...cli().prefix, 'login', 'status'], { timeoutMs: 10_000 });
      const out = `${r.stdout}\n${r.stderr}`;
      const loggedIn = /not logged in/i.test(out) ? false : r.code === 0 ? true : null;
      return { installed: true, version: v.version, loggedIn, loginHint: 'Run `codex login` in a terminal.' };
    },

    async runTurn({ cwd, prompt, model, systemPrompt, sessionId, fork = false, permissions, signal, emit, onRequest, runId = '', extraEnv, schema, reasoning }) {
      let child;
      try { child = startChild(cli().bin, [...cli().prefix, 'app-server'], { cwd, extraEnv }); } catch (e) {
        emit('error', { code: 'not_ready', message: `Could not start Codex (${e.code || e.message}).` });
        return { status: 'error', sessionId };
      }
      let stopped = false;
      let finish;
      const finished = new Promise((r) => { finish = r; });
      let threadId = sessionId || null;
      let actualModel = model || null;
      let rpc; let turnId = null;
      let killing = null;
      const stopProcess = () => killing ||= killTree(child);
      const onAbort = () => {
        stopped = true;
        if (rpc && threadId && turnId) void rpc.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 1000 }).catch(() => {}).finally(async () => { await stopProcess(); finish({ aborted: true }); });
        else void stopProcess().finally(() => finish({ aborted: true }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const started = Date.now();
      // A file-change approval names no file: the paths and the diff come before it, in that item's item/started.
      const changes = new Map();
      let retrying = false;
      rpc = new RpcPeer(child, {
        jsonrpc: false,
        onClose: (error) => finish({ error }),
        onRequest: async (method, p, requestId) => {
          if (method === 'item/commandExecution/requestApproval') {
            // the folder it runs in is checked like a path the command reaches
            const d = await onRequest({ providerRequestId: String(requestId), tool: 'Bash', input: { command: p.command ?? '' }, ...(p.cwd ? { blockedPath: p.cwd } : {}), toolUseId: p.itemId });
            return { decision: d.decision === 'allow' ? 'accept' : 'decline' };
          }
          if (method === 'item/fileChange/requestApproval') {
            const list = changes.get(p.itemId) || [];
            const files = list.flatMap((c) => [c.path, c.kind?.move_path]).filter((f) => typeof f === 'string' && f);
            const input = files.length
              ? { file_path: files[0], files, diff: list.map((c) => c.diff ?? '').join('\n') }
              : { file_path: p.grantRoot, old_string: '', new_string: '', unknownPath: true };
            const d = await onRequest({ providerRequestId: String(requestId), tool: 'Edit', input, toolUseId: p.itemId });
            return { decision: d.decision === 'allow' ? 'accept' : 'decline' };
          }
          if (method === 'item/tool/requestUserInput') {
            const qs = Array.isArray(p.questions) ? p.questions : [];
            // a secret typed into the Inbox would be stored and shown again: never relayed
            if (qs.some((q) => q.isSecret)) { emit('notice', { message: 'Codex asked for a secret. Circle Studio does not take secrets in chat; put it in Keys.' }); return { answers: {} }; }
            const d = await onRequest({ providerRequestId: String(requestId), tool: 'AskUserQuestion', input: { questions: qs.map((q) => ({ id: q.id, question: q.question, header: q.header, options: q.options ?? [], multiSelect: false })) }, toolUseId: p.itemId });
            if (d.decision !== 'allow' || !d.answers) return { answers: {} };
            // the app answers by question text; Codex wants { [question id]: { answers: [text] } }
            return { answers: Object.fromEntries(qs.filter((q) => (d.answers[q.id] ?? d.answers[q.question]) !== undefined).map((q) => [q.id, { answers: [String(d.answers[q.id] ?? d.answers[q.question])] }])) };
          }
          emit('notice', { message: `Codex requested an unsupported approval category (${redact(String(method)).slice(0, 100)}). It was not approved.` });
          throw new Error('This request category is not supported or approved by Circle Studio.');
        },
        onNotification: (method, p) => {
          if (method === 'serverRequest/resolved') emit('provider-request-resolved', { providerRequestId: String(p.requestId) });
          if (method === 'turn/started') turnId = p.turn?.id || p.turnId || turnId;
          if (method === 'item/started' && p.item?.type === 'fileChange') changes.set(p.item.id, Array.isArray(p.item.changes) ? p.item.changes : []);
          // Signed out or expired, Codex retries 10 times over a minute or more before failing: stop at the first 401.
          if (method === 'error') {
            const info = p.error?.codexErrorInfo || {};
            const status = info.httpStatusCode ?? Object.values(info).find((v) => v && typeof v === 'object' && 'httpStatusCode' in v)?.httpStatusCode;
            if (status === 401) finish({ signedOut: true });
            else if (p.willRetry && !retrying) { retrying = true; emit('notice', { message: redact(`Codex is retrying: ${String(p.error?.message ?? 'connection lost')}`).slice(0, 300) }); }
          }
          if (method === 'item/agentMessage/delta') emit('text', { delta: p.delta ?? '' });
          else if (method === 'item/started' && p.item?.type === 'commandExecution') emit('tool', { id: p.item.id, name: 'Bash', summary: redact(`Run ${String(p.item.command ?? '').slice(0, 80)}`), status: 'start' });
          else if (method === 'item/completed' && p.item?.type === 'commandExecution') emit('tool', { id: p.item.id, status: 'end', ok: p.item.status === 'completed' });
          else if (method === 'item/started' && p.item?.type === 'fileChange') emit('tool', { id: p.item.id, name: 'Edit', summary: redact(`Change ${(p.item.changes || []).map((c) => c.path).join(', ')}`).slice(0, 300), status: 'start' });
          else if (method === 'item/completed' && p.item?.type === 'fileChange') emit('tool', { id: p.item.id, name: 'Edit', status: 'end', ok: p.item.status === 'completed' });
          else if (method === 'account/rateLimits/updated') emit('limits', { provider: 'codex', ...p });
          else if (method === 'item/commandExecution/outputDelta') emit('output', { id: p.itemId, delta: redact(String(p.delta || '')).slice(-8192) });
          else if (method === 'thread/tokenUsage/updated') {
            const t = p.tokenUsage || {};
            emit('usage', { inputTokens: t.total?.inputTokens || 0, outputTokens: t.total?.outputTokens || 0, contextTokens: t.last?.totalTokens ?? null, contextWindow: t.modelContextWindow ?? null, costUsd: null });
          } else if (method === 'turn/completed') finish({ turn: p.turn ?? p });
        },
      });
      try {
        await rpc.request('initialize', { clientInfo: { name: 'circle-studio', title: 'Circle Studio', version: '2' } });
        rpc.notify('initialized');
        // The installed 0.163 schema still accepts untrusted. Never weaken to on-request automatically when a
        // future server rejects it: show a compatibility error. Reapply policies on resume/fork as well.
        const base = { cwd, ...(model ? { model } : {}), approvalPolicy: 'untrusted', sandbox: permissions?.write === false ? 'read-only' : 'workspace-write', developerInstructions: systemPrompt || null };
        const t = threadId
          ? await rpc.request(fork ? 'thread/fork' : 'thread/resume', { threadId, excludeTurns: true, ...base })
          : await rpc.request('thread/start', base);
        threadId = t.thread?.id ?? t.threadId ?? threadId;
        actualModel = t.model || actualModel;
        emit('session', { sessionId: threadId, model: actualModel, engine: 'codex', runId });
        const start = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }], ...(schema ? { outputSchema: schema } : {}), ...(reasoning ? { effort: reasoning } : {}) });
        turnId = start.turn?.id || turnId;
        const end = await finished;
        if (end.aborted || stopped) { emit('stopped', { runId }); return { status: 'stopped', sessionId: threadId }; }
        if (end.signedOut) { emit('error', { code: 'not_ready', message: 'Codex is not signed in, or its sign-in has expired. Run `codex login` in a terminal, then try again.' }); return { status: 'error', sessionId: threadId }; }
        if (end.error) { emit('error', { code: 'upstream', message: redact(end.error.message).slice(0, 400) }); return { status: 'error', sessionId: threadId }; }
        const failed = end.turn?.status === 'failed';
        if (failed) { emit('error', { code: 'upstream', message: redact(String(end.turn?.error?.message ?? 'Codex reported a failed turn.')).slice(0, 400) }); return { status: 'error', sessionId: threadId }; }
        emit('done', { runId, sessionId: threadId, ms: Date.now() - started, costUsd: null, stopReason: end.turn?.status ?? null, models: actualModel ? [actualModel] : [], denials: 0, result: '' });
        return { status: 'done', sessionId: threadId };
      } catch (e) {
        if (stopped) { emit('stopped', { runId }); return { status: 'stopped', sessionId: threadId }; }
        emit('error', { code: 'upstream', message: redact(String(e.message)).slice(0, 400) });
        return { status: 'error', sessionId: threadId };
      } finally {
        signal?.removeEventListener('abort', onAbort);
        rpc.close();
        await stopProcess();
      }
    },
  };
}
