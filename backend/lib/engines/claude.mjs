// Claude Code as an engine: one bidirectional stream-json process per turn (docs/research/engines.md).
// The CLI asks for permission and asks its questions as `control_request` lines; the answer goes back as a
// `control_response` line with the same request_id while the process keeps running.
import { StreamParser, credentialRisk, NO_SECRET_READS, MODELS } from '../claude.mjs';
import { redact } from '../secrets.mjs';
import { startChild, lineReader, parseLine, killTree } from './proc.mjs';

const TOOLS = 'Read,Grep,Glob,Edit,Write,Bash,AskUserQuestion';
// Hooks off (a project's own hooks must not run here). An "ask" rule for Bash and edits makes the CLI send every one to
// the app, including the read-only commands it would otherwise run on its own (verified live: `echo` and `cat` ran unasked).
const SETTINGS = JSON.stringify({ disableAllHooks: true, permissions: { ask: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] } });

export function turnArgs({ model, resume, fork = false, systemPrompt, guarded }) {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'default', '--permission-prompt-tool', 'stdio',
    '--tools', TOOLS, '--disallowedTools', ...NO_SECRET_READS,
    '--settings', SETTINGS, '--strict-mcp-config',
    ...(guarded ? ['--setting-sources', 'user'] : []),
    ...(resume ? ['--resume', resume, ...(fork ? ['--fork-session'] : [])] : []),
    ...(MODELS.includes(model) ? ['--model', model] : []),
    '--append-system-prompt', systemPrompt,
  ];
}

const usageOf = (u = {}) => (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);

export function createClaudeAdapter({ service, bin, prefixArgs }) {
  // the service finds the real program each time (see ClaudeService); a test may give its own
  const cli = () => (bin !== undefined ? { bin, prefix: prefixArgs || [] } : { bin: service.bin, prefix: service.prefix });
  return {
    id: 'claude',
    label: 'Claude Code',
    models: MODELS,
    capabilities: { chat: true, shell: 'approvals', approvals: 'relay', questions: 'relay', resume: true, skillsDirs: ['.claude/skills'], instructionsFile: 'CLAUDE.md', liveVerified: true },
    notes: ['Bash is not sandboxed on Windows: every command asks you first, and the app refuses dangerous ones.'],

    async detect() {
      const a = await service.authStatus();
      const version = a.installed ? await service.version() : null;
      return { installed: a.installed, version, loggedIn: a.installed ? a.loggedIn : false, loginHint: 'Run `claude auth login` in a terminal.', detail: a.loggedIn ? [a.method, a.subscription].filter(Boolean).join(', ') : '' };
    },

    /** Resolves { status: 'done' | 'stopped' | 'error', sessionId }. Never rejects for CLI failures (they become `error` events). */
    runTurn({ cwd, prompt, model, systemPrompt, sessionId, fork = false, signal, emit, onRequest, runId = '', extraEnv }) {
      return new Promise((resolve) => {
        const risk = credentialRisk(cwd);
        if (risk.length) emit('notice', { message: "This project's settings could redirect Claude's credentials, so they were ignored for this run.", reasons: risk });
        let resume = sessionId || null;
        let attempt = 0;
        const start = () => {
          attempt++;
          let child;
          try {
            child = startChild(cli().bin, [...cli().prefix, ...turnArgs({ model, resume, fork: fork && Boolean(resume), systemPrompt, guarded: risk.length > 0 })], { cwd, extraEnv });
          } catch (e) {
            emit('error', { code: 'not_ready', message: e.code === 'ENOENT' ? 'Claude CLI not found.' : `Could not start Claude (${e.code || e.message}).` });
            resolve({ status: 'error', sessionId: resume });
            return;
          }
          let stopped = false;
          let settled = false;
          let badSession = false;
          let lastError = null;
          let stderr = '';
          let lastCtx = 0;
          const sink = (name, data) => {
            if (name === 'error') {
              if (resume && data.subtype === 'error_during_execution' && !parser.textEmitted) badSession = true;
              lastError = data;
              if (badSession) return;
            }
            emit(name, data);
          };
          const parser = new StreamParser(sink, { root: cwd, runId });
          const write = (obj) => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(`${JSON.stringify(obj)}\n`); };
          const answer = async (o) => {
            const req = o.request;
            if (req?.subtype !== 'can_use_tool') { write({ type: 'control_response', response: { subtype: 'error', request_id: o.request_id, error: 'Not supported here.' } }); return; }
            let d;
            try { d = await onRequest({ tool: req.tool_name, input: req.input ?? {}, blockedPath: req.blocked_path, toolUseId: req.tool_use_id, requestId: o.request_id }); } catch { d = { decision: 'deny', message: 'The app could not ask you.' }; }
            const response = d.decision === 'allow'
              ? { behavior: 'allow', updatedInput: d.answers ? { ...(req.input ?? {}), answers: d.answers } : (req.input ?? {}) }
              : { behavior: 'deny', message: String(d.message || 'Denied by the human.').slice(0, 500) };
            write({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response } });
          };
          const onLine = (line) => {
            const o = parseLine(line);
            if (!o) return;
            if (o.type === 'control_request') { answer(o); return; }
            if (o.type === 'assistant' && o.message?.usage && !o.parent_tool_use_id) lastCtx = usageOf(o.message.usage) + (o.message.usage.output_tokens || 0);
            if (o.type === 'result' && !o.is_error) {
              const u = o.usage || {};
              const mu = o.modelUsage && typeof o.modelUsage === 'object' ? Object.values(o.modelUsage)[0] : null;
              emit('usage', { inputTokens: usageOf(u), outputTokens: u.output_tokens || 0, contextTokens: lastCtx || usageOf(u), contextWindow: mu?.contextWindow ?? null, costUsd: o.total_cost_usd ?? null });
            }
            parser.write(`${line}\n`);
            if (o.type === 'result') { try { child.stdin.end(); } catch { /* gone */ } }
          };
          const flush = lineReader(child.stdout, onLine);
          child.stderr.on('data', (d) => { if (stderr.length < 8000) stderr += d; });
          child.stdin.on('error', () => {});
          const onAbort = () => { stopped = true; killTree(child); };
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
          child.on('error', (e) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            emit('error', { code: e.code === 'ENOENT' ? 'not_ready' : 'upstream', message: e.code === 'ENOENT' ? 'Claude CLI not found.' : `Claude could not start (${e.code || e.message}).` });
            resolve({ status: 'error', sessionId: resume });
          });
          child.on('close', (code) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            flush();
            parser.end();
            if (stopped) { emit('stopped', { runId }); resolve({ status: 'stopped', sessionId: parser.sessionId || resume }); return; }
            if (badSession && attempt === 1) {
              emit('notice', { message: 'The earlier conversation could not be resumed, so this answer starts without it.' });
              resume = null;
              start();
              return;
            }
            if (!parser.finished && !lastError) emit('error', { code: 'upstream', message: `Claude exited (code ${code}) before finishing.`, detail: redact(stderr.slice(-2000)) });
            resolve({ status: parser.finished && !lastError ? 'done' : 'error', sessionId: parser.sessionId || resume });
          });
          write({ type: 'user', message: { role: 'user', content: prompt } });
        };
        start();
      });
    },
  };
}
