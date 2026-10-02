// GitHub Copilot CLI as an engine, over ACP (Agent Client Protocol): JSON-RPC 2.0 lines on stdio.
// Approvals are proven live (docs/research/engines.md); how questions surface is not, so they are labelled unverified.
import { startChild, killTree, copilotLoader, versionOf } from './proc.mjs';
import { RpcPeer } from './rpc.mjs';
import { redact } from '../secrets.mjs';

const CAPABILITIES = { chat: true, shell: 'approvals', approvals: 'relay', questions: 'unverified', resume: true, skillsDirs: ['.agents/skills', '.github/skills', '.claude/skills'], instructionsFile: 'AGENTS.md', liveVerified: true };
const PROMPT_TIMEOUT_MS = 30 * 60_000;

/** Translate an ACP tool call into the tool names the policy knows. */
export function acpTool(toolCall = {}) {
  const raw = toolCall.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {};
  const where = toolCall.locations?.[0]?.path ?? raw.path ?? raw.file_path ?? raw.filePath;
  switch (toolCall.kind) {
    case 'execute': return { tool: 'Bash', input: { command: raw.command ?? (Array.isArray(raw.commands) ? raw.commands.join(' && ') : '') } };
    case 'edit': case 'delete': case 'move': return { tool: 'Edit', input: { file_path: where, old_string: '', new_string: typeof raw.content === 'string' ? raw.content : '', ...(where ? {} : { unknownPath: true }) } };
    case 'read': return where ? { tool: 'Read', input: { file_path: where } } : { tool: 'Copilot:read', input: raw };
    case 'search': return { tool: 'Copilot:search', input: raw };
    default: return { tool: `Copilot:${toolCall.kind || 'tool'}`, input: { title: toolCall.title ?? '', ...raw } };
  }
}

export function createCopilotAdapter({ loader: given, nodeBin = process.execPath, prefixArgs = [] } = {}) {
  // looked up each time, so Copilot installed while Circle Studio runs is found (a test gives its own)
  const loaderNow = () => (given !== undefined ? given : copilotLoader());
  const start = (args, cwd, extraEnv) => startChild(nodeBin, [loaderNow(), ...prefixArgs, ...args], { cwd, extraEnv });
  return {
    id: 'copilot',
    label: 'GitHub Copilot',
    models: [],
    capabilities: CAPABILITIES,
    notes: ['Questions the agent asks are not proven to reach the app yet.', 'Every turn costs a premium request.'],

    async detect() {
      const loader = loaderNow();
      if (!loader) return { installed: false, version: null, loggedIn: false, loginHint: 'Install it with `npm i -g @github/copilot`, then run `copilot login`.' };
      const v = await versionOf(nodeBin, [loader, ...prefixArgs, '--version']);
      let loggedIn = null;
      const child = start(['--acp'], process.cwd());
      const rpc = new RpcPeer(child, {});
      let timer;
      try {
        await Promise.race([
          (async () => {
            await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
            await rpc.request('session/new', { cwd: process.cwd(), mcpServers: [] });
            loggedIn = true;
          })(),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 20_000); }),
        ]);
      } catch (e) { loggedIn = /auth|login|sign/i.test(String(e?.message)) ? false : null; } finally { clearTimeout(timer); }
      rpc.close();
      killTree(child);
      return { installed: true, version: v.version, loggedIn, loginHint: 'Run `copilot login` in a terminal.' };
    },

    async runTurn({ cwd, prompt, model, systemPrompt, sessionId, signal, emit, onRequest, runId = '', extraEnv }) {
      let child;
      try { child = start(['--acp', ...(model ? ['--model', model] : [])], cwd, extraEnv); } catch (e) {
        emit('error', { code: 'not_ready', message: `Could not start Copilot (${e.code || e.message}).` });
        return { status: 'error', sessionId };
      }
      let stopped = false;
      const tools = new Map();
      let sid = null;
      let timer = null;
      const onAbort = () => { stopped = true; killTree(child); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const rpc = new RpcPeer(child, {
        onRequest: async (method, params) => {
          if (method !== 'session/request_permission') throw new Error('Not supported here.');
          const { tool, input } = acpTool(params.toolCall);
          const d = await onRequest({ tool, input, toolUseId: params.toolCall?.toolCallId });
          const want = d.decision === 'allow' ? 'allow_once' : 'reject_once';
          const opt = (params.options || []).find((o) => o.kind === want);
          return { outcome: opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' } };
        },
        onNotification: (method, params) => {
          if (method !== 'session/update') return;
          const u = params.update || {};
          if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') emit('text', { delta: u.content.text });
          else if (u.sessionUpdate === 'tool_call') {
            tools.set(u.toolCallId, u.title || u.kind);
            emit('tool', { id: u.toolCallId, name: u.kind || 'tool', summary: redact(String(u.title || u.kind || 'tool')).slice(0, 120), status: 'start' });
          } else if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) emit('tool', { id: u.toolCallId, status: 'end', ok: u.status === 'completed' });
          else if (u.sessionUpdate === 'usage_update') emit('usage', { inputTokens: 0, outputTokens: 0, contextTokens: u.used ?? null, contextWindow: u.size ?? null, costUsd: null });
        },
      });
      try {
        await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
        if (sessionId) {
          try { await rpc.request('session/load', { sessionId, cwd, mcpServers: [] }); sid = sessionId; } catch { emit('notice', { message: 'The earlier Copilot conversation could not be resumed, so this answer starts without it.' }); }
        }
        if (!sid) sid = (await rpc.request('session/new', { cwd, mcpServers: [] })).sessionId;
        emit('session', { sessionId: sid, model: model || 'auto', engine: 'copilot', runId });
        const started = Date.now();
        timer = setTimeout(() => { stopped = true; killTree(child); }, PROMPT_TIMEOUT_MS);
        const res = await rpc.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: `${systemPrompt}\n\n${prompt}` }] });
        const u = res.usage || {};
        emit('usage', { inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, contextTokens: null, contextWindow: null, costUsd: null });
        emit('done', { runId, sessionId: sid, ms: Date.now() - started, costUsd: null, stopReason: res.stopReason ?? null, models: [model || 'auto'], denials: 0, result: '' });
        return { status: 'done', sessionId: sid };
      } catch (e) {
        if (stopped) { emit('stopped', { runId }); return { status: 'stopped', sessionId: sid || sessionId }; }
        emit('error', { code: 'upstream', message: redact(String(e.message)).slice(0, 400) });
        return { status: 'error', sessionId: sid || sessionId };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        rpc.close();
        killTree(child);
      }
    },
  };
}
