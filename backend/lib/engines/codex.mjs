// Codex as an engine, over `codex app-server` (JSON-RPC lines on stdio). Built from the generated schema and the
// documentation, then checked against the schema `codex app-server generate-json-schema` writes (codex-cli 0.154.0).
// Not live-tested: Codex is not signed in on this PC (capabilities.liveVerified: false).
import { startChild, killTree, runCommand, versionOf, resolveCli } from './proc.mjs';
import { RpcPeer } from './rpc.mjs';
import { redact } from '../secrets.mjs';

const CAPABILITIES = { chat: true, shell: 'approvals', approvals: 'relay', questions: 'relay', resume: true, skillsDirs: ['.agents/skills'], instructionsFile: 'AGENTS.md', liveVerified: false };

export function createCodexAdapter({ bin, prefixArgs = [] } = {}) {
  // the real program each time (an .exe, or the script behind an npm launcher), unless a test gives one
  const cli = () => (bin !== undefined ? { bin, prefix: prefixArgs } : resolveCli('codex') || { bin: 'codex', prefix: [] });
  return {
    id: 'codex',
    label: 'Codex',
    models: [],
    capabilities: CAPABILITIES,
    notes: ["Not live-tested yet: checked against Codex's own protocol schema, but no real turn has run.", 'Runs in the workspace-write sandbox and asks before acting.'],

    async detect() {
      const v = await versionOf(cli().bin, [...cli().prefix, '--version']);
      if (!v.installed) return { installed: false, version: null, loggedIn: false, loginHint: 'Install Codex, then run `codex login`.' };
      const r = await runCommand(cli().bin, [...cli().prefix, 'login', 'status'], { timeoutMs: 10_000 });
      const out = `${r.stdout}\n${r.stderr}`;
      const loggedIn = /not logged in/i.test(out) ? false : r.code === 0 ? true : null;
      return { installed: true, version: v.version, loggedIn, loginHint: 'Run `codex login` in a terminal.' };
    },

    async runTurn({ cwd, prompt, model, systemPrompt, sessionId, signal, emit, onRequest, runId = '', extraEnv }) {
      let child;
      try { child = startChild(cli().bin, [...cli().prefix, 'app-server'], { cwd, extraEnv }); } catch (e) {
        emit('error', { code: 'not_ready', message: `Could not start Codex (${e.code || e.message}).` });
        return { status: 'error', sessionId };
      }
      let stopped = false;
      let finish;
      const finished = new Promise((r) => { finish = r; });
      let threadId = sessionId || null;
      const onAbort = () => { stopped = true; killTree(child); finish({ aborted: true }); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const started = Date.now();
      // A file-change approval names no file: the paths and the diff come before it, in that item's item/started.
      const changes = new Map();
      let retrying = false;
      const rpc = new RpcPeer(child, {
        jsonrpc: false,
        onRequest: async (method, p) => {
          if (method === 'item/commandExecution/requestApproval') {
            // the folder it runs in is checked like a path the command reaches
            const d = await onRequest({ tool: 'Bash', input: { command: p.command ?? '' }, ...(p.cwd ? { blockedPath: p.cwd } : {}), toolUseId: p.itemId });
            return { decision: d.decision === 'allow' ? 'accept' : 'decline' };
          }
          if (method === 'item/fileChange/requestApproval') {
            const list = changes.get(p.itemId) || [];
            const files = list.flatMap((c) => [c.path, c.kind?.move_path]).filter((f) => typeof f === 'string' && f);
            const input = files.length
              ? { file_path: files[0], files, diff: list.map((c) => c.diff ?? '').join('\n') }
              : { file_path: p.grantRoot, old_string: '', new_string: '', unknownPath: true };
            const d = await onRequest({ tool: 'Edit', input, toolUseId: p.itemId });
            return { decision: d.decision === 'allow' ? 'accept' : 'decline' };
          }
          if (method === 'item/tool/requestUserInput') {
            const qs = Array.isArray(p.questions) ? p.questions : [];
            // a secret typed into the Inbox would be stored and shown again: never relayed
            if (qs.some((q) => q.isSecret)) { emit('notice', { message: 'Codex asked for a secret. Circle Studio does not take secrets in chat; put it in Keys.' }); return { answers: {} }; }
            const d = await onRequest({ tool: 'AskUserQuestion', input: { questions: qs.map((q) => ({ question: q.question, header: q.header, options: q.options ?? [], multiSelect: false })) }, toolUseId: p.itemId });
            if (d.decision !== 'allow' || !d.answers) return { answers: {} };
            // the app answers by question text; Codex wants { [question id]: { answers: [text] } }
            return { answers: Object.fromEntries(qs.filter((q) => d.answers[q.question] !== undefined).map((q) => [q.id, { answers: [String(d.answers[q.question])] }])) };
          }
          throw new Error('Not supported here.');
        },
        onNotification: (method, p) => {
          if (method === 'item/started' && p.item?.type === 'fileChange') changes.set(p.item.id, Array.isArray(p.item.changes) ? p.item.changes : []);
          // Signed out or expired, Codex retries 10 times over a minute or more before failing: stop at the first 401.
          if (method === 'error') {
            const info = p.error?.codexErrorInfo || {};
            const status = Object.values(info).find((v) => v && typeof v === 'object' && 'httpStatusCode' in v)?.httpStatusCode;
            if (status === 401) finish({ signedOut: true });
            else if (p.willRetry && !retrying) { retrying = true; emit('notice', { message: redact(`Codex is retrying: ${String(p.error?.message ?? 'connection lost')}`).slice(0, 300) }); }
          }
          if (method === 'item/agentMessage/delta') emit('text', { delta: p.delta ?? '' });
          else if (method === 'item/started' && p.item?.type === 'commandExecution') emit('tool', { id: p.item.id, name: 'Bash', summary: redact(`Run ${String(p.item.command ?? '').slice(0, 80)}`), status: 'start' });
          else if (method === 'item/completed' && p.item?.type === 'commandExecution') emit('tool', { id: p.item.id, status: 'end', ok: p.item.status === 'completed' });
          else if (method === 'thread/tokenUsage/updated') {
            const t = p.tokenUsage || {};
            emit('usage', { inputTokens: t.total?.inputTokens || 0, outputTokens: t.total?.outputTokens || 0, contextTokens: t.last?.totalTokens ?? null, contextWindow: t.modelContextWindow ?? null, costUsd: null });
          } else if (method === 'turn/completed') finish({ turn: p.turn ?? p });
        },
      });
      try {
        await rpc.request('initialize', { clientInfo: { name: 'circle-studio', title: 'Circle Studio', version: '2' } });
        rpc.notify('initialized');
        const base = { cwd, ...(model ? { model } : {}) };
        const t = threadId
          ? await rpc.request('thread/resume', { threadId, ...base })
          : await rpc.request('thread/start', { ...base, approvalPolicy: 'untrusted', sandbox: 'workspace-write', developerInstructions: systemPrompt });
        threadId = t.thread?.id ?? t.threadId ?? threadId;
        emit('session', { sessionId: threadId, model: model || 'default', engine: 'codex', runId });
        await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] });
        const end = await finished;
        if (end.aborted) { emit('stopped', { runId }); return { status: 'stopped', sessionId: threadId }; }
        if (end.signedOut) { emit('error', { code: 'not_ready', message: 'Codex is not signed in, or its sign-in has expired. Run `codex login` in a terminal, then try again.' }); return { status: 'error', sessionId: threadId }; }
        const failed = end.turn?.status === 'failed';
        if (failed) { emit('error', { code: 'upstream', message: redact(String(end.turn?.error?.message ?? 'Codex reported a failed turn.')).slice(0, 400) }); return { status: 'error', sessionId: threadId }; }
        emit('done', { runId, sessionId: threadId, ms: Date.now() - started, costUsd: null, stopReason: end.turn?.status ?? null, models: [model || 'default'], denials: 0, result: '' });
        return { status: 'done', sessionId: threadId };
      } catch (e) {
        if (stopped) { emit('stopped', { runId }); return { status: 'stopped', sessionId: threadId }; }
        emit('error', { code: 'upstream', message: redact(String(e.message)).slice(0, 400) });
        return { status: 'error', sessionId: threadId };
      } finally {
        signal?.removeEventListener('abort', onAbort);
        rpc.close();
        killTree(child);
      }
    },
  };
}
