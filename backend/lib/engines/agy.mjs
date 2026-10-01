// Google Antigravity (`agy`, the "gemini" engine) as an engine. Headless mode cannot relay approvals: it auto-denies
// commands and edits, so this engine is chat only (docs/research/engines.md). The human is told when it denied something.
import { startChild, killTree, lineReader, parseLine, runCommand, versionOf } from './proc.mjs';
import { redact } from '../secrets.mjs';

const CAPABILITIES = { chat: true, shell: 'none', approvals: 'none', questions: 'none', resume: true, skillsDirs: [], instructionsFile: '', liveVerified: true };

export function createAgyAdapter({ bin = 'agy', prefixArgs = [] } = {}) {
  return {
    id: 'gemini',
    label: 'Gemini (agy)',
    models: [],
    capabilities: CAPABILITIES,
    notes: ['Headless agy cannot ask you: commands and edits are refused, so it answers and reads only.', 'Skill and instruction folders are not known for agy.'],

    async detect() {
      const v = await versionOf(bin, [...prefixArgs, '--version']);
      if (!v.installed) return { installed: false, version: null, loggedIn: false, loginHint: 'Install the Antigravity CLI, then run `agy`.' };
      const r = await runCommand(bin, [...prefixArgs, 'models'], { timeoutMs: 15_000 });
      return { installed: true, version: v.version, loggedIn: r.code === 0 ? true : null, loginHint: 'Run `agy` once in a terminal and sign in with Google.' };
    },

    runTurn({ cwd, prompt, model, systemPrompt, sessionId, signal, emit, runId = '', extraEnv }) {
      return new Promise((resolve) => {
        let child;
        try {
          child = startChild(bin, [...prefixArgs, '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '10m', ...(model ? ['--model', model] : []), ...(sessionId ? ['--conversation', sessionId] : [])], { cwd, extraEnv });
        } catch (e) {
          emit('error', { code: 'not_ready', message: `Could not start agy (${e.code || e.message}).` });
          resolve({ status: 'error', sessionId });
          return;
        }
        let stopped = false;
        let settled = false;
        let conv = sessionId || null;
        let sawResult = false;
        let sawText = false;
        let stderr = '';
        const started = Date.now();
        const onAbort = () => { stopped = true; killTree(child); };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        const flush = lineReader(child.stdout, (line) => {
          const o = parseLine(line);
          if (!o) return;
          if (o.event === 'init') {
            conv = o.conversation_id || conv;
            emit('session', { sessionId: conv, model: o.init?.model || model || 'default', engine: 'gemini', runId });
          } else if (o.event === 'step_update' && o.step_update?.step_type === 'agent_response') {
            const s = o.step_update;
            if (s.text_delta) { sawText = true; emit('text', { delta: s.text_delta }); }
            if (s.usage) emit('usage', { inputTokens: s.usage.input_tokens || 0, outputTokens: s.usage.output_tokens || 0, contextTokens: null, contextWindow: null, costUsd: null });
          } else if (o.event === 'result') {
            sawResult = true;
            const denied = Array.isArray(o.denied_actions) ? o.denied_actions.length : 0;
            if (denied) emit('notice', { message: `agy cannot ask you for permission when run from here, so it refused ${denied} action${denied === 1 ? '' : 's'} (commands or edits). Use Claude or Copilot for work that needs them.` });
            emit('done', { runId, sessionId: conv, ms: Date.now() - started, costUsd: null, stopReason: null, models: [model || 'default'], denials: denied, result: '' });
          }
        });
        child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
        child.stdin.on('error', () => {});
        child.on('error', (e) => {
          if (settled) return;
          settled = true;
          emit('error', { code: e.code === 'ENOENT' ? 'not_ready' : 'upstream', message: e.code === 'ENOENT' ? 'agy was not found.' : `agy could not start (${e.code || e.message}).` });
          resolve({ status: 'error', sessionId: conv });
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          flush();
          if (stopped) { emit('stopped', { runId }); resolve({ status: 'stopped', sessionId: conv }); return; }
          if (!sawResult) {
            emit('error', { code: 'upstream', message: sawText ? `agy ended (code ${code}) before it finished.` : `agy gave no answer (code ${code}).`, detail: redact(stderr.slice(-800)) });
            resolve({ status: 'error', sessionId: conv });
            return;
          }
          resolve({ status: 'done', sessionId: conv });
        });
        child.stdin.end(`${JSON.stringify({ event: 'user', message: { content: `${systemPrompt}\n\n${prompt}` } })}\n`);
      });
    },
  };
}
