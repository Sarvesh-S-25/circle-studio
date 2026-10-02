// Codex as an engine, over `codex app-server` (JSON-RPC lines on stdio). Built from the generated schema and the
// documentation only: this PC has no Codex login, so nothing here is live-tested (capabilities.liveVerified: false).
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
    notes: ['Not live-tested: there is no Codex sign-in on this PC. Built from its documented protocol.', 'Runs in the workspace-write sandbox and asks before acting.'],

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
      const rpc = new RpcPeer(child, {
        jsonrpc: false,
        onRequest: async (method, p) => {
          if (method === 'item/commandExecution/requestApproval') {
            const d = await onRequest({ tool: 'Bash', input: { command: p.command ?? '' }, toolUseId: p.itemId });
            return { decision: d.decision === 'allow' ? 'accept' : 'decline' };
          }
          if (method === 'item/fileChange/requestApproval') {
            const d = await onRequest({ tool: 'Edit', input: { file_path: p.path ?? p.grantRoot, old_string: '', new_string: '', ...(p.path ? {} : { unknownPath: true }) }, toolUseId: p.itemId });
            return { decision: d.decision === 'allow' ? 'accept' : 'decline' };
          }
          if (method === 'item/tool/requestUserInput') {
            const d = await onRequest({ tool: 'AskUserQuestion', input: { questions: p.questions ?? [] }, toolUseId: p.itemId });
            return d.decision === 'allow' ? { answers: d.answers ?? {} } : { answers: {} };
          }
          throw new Error('Not supported here.');
        },
        onNotification: (method, p) => {
          if (method === 'item/agentMessage/delta') emit('text', { delta: p.delta ?? '' });
          else if (method === 'item/started' && p.item?.type === 'commandExecution') emit('tool', { id: p.item.id, name: 'Bash', summary: redact(`Run ${String(p.item.command ?? '').slice(0, 80)}`), status: 'start' });
          else if (method === 'item/completed' && p.item?.type === 'commandExecution') emit('tool', { id: p.item.id, status: 'end', ok: p.item.status !== 'failed' });
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
