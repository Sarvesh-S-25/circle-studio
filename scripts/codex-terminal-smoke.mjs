// Explicit real-account check: Circle adapter -> CLI resume -> Circle adapter, in one new dummy folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexAdapter } from '../backend/lib/engines/codex.mjs';
import { resolveCli } from '../backend/lib/engines/proc.mjs';
import { runCommand } from '../backend/lib/run.mjs';
import { redact } from '../backend/lib/secrets.mjs';
if (!process.argv.includes('--real')) throw new Error('Pass --real only with permission to use three short signed-in Codex turns.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-codex-terminal-'));
const adapter = createCodexAdapter();
const info = await adapter.detect();
if (!info.loggedIn) throw new Error('Codex is not signed in; no turn started.');
const report = { at: new Date().toISOString(), version: info.version, root, phases: [] };
let sessionId;
async function phase(name, prompt) {
  const record = { name, text: '', errors: [] };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const result = await adapter.runTurn({ cwd: root, prompt, sessionId, permissions: { write: false }, signal: controller.signal, runId: name,
      systemPrompt: 'Temporary acceptance fixture. Respond only with the requested marker. Do not use tools, skills, MCP, network, subagents, or access files.',
      onRequest: async () => ({ decision: 'deny', message: 'No tools allowed in this fixture.' }),
      emit: (kind, value) => { if (kind === 'session') sessionId = value.sessionId; if (kind === 'text') record.text += value.delta; if (kind === 'error') record.errors.push(redact(value.message)); },
    });
    record.status = result.status; sessionId = result.sessionId || sessionId;
  } finally { clearTimeout(timer); }
  report.phases.push(record); console.log(JSON.stringify(record));
  return record.status === 'done';
}
if (await phase('circle-before-terminal', 'Reply exactly CIRCLE_BEFORE_OK.')) {
  const cli = resolveCli('codex');
  const result = await runCommand(cli.bin, [...cli.prefix, 'exec', 'resume', '--json', '--skip-git-repo-check', sessionId, 'Acceptance fixture: reply exactly CIRCLE_TERMINAL_OK. Do not use tools or access any files.'], { cwd: root, timeoutMs: 120000 });
  const events = result.stdout.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const record = { name: 'cli-resume', code: result.code, timedOut: result.timedOut, text: events.filter((e) => e.item?.type === 'agent_message').map((e) => e.item.text).join('\n'), errors: events.filter((e) => e.type === 'error' || e.type === 'turn.failed').map((e) => redact(e.message || e.error?.message || 'Failed CLI turn')) };
  report.phases.push(record); console.log(JSON.stringify(record));
  if (result.code === 0) await phase('circle-after-terminal', 'Reply exactly CIRCLE_RETURN_OK.');
}
report.sessionId = sessionId;
report.passed = report.phases.length === 3 && report.phases.every((p) => p.errors.length === 0 && (p.status === 'done' || p.code === 0)) && report.phases[2].text.includes('CIRCLE_RETURN_OK');
if (report.passed) {
  try { const fork = await adapter.forkHistory({ cwd: root, id: sessionId }); const transcript = await adapter.readHistory({ cwd: root, id: fork.id }); report.fork = { passed: fork.id !== sessionId, id: fork.id, readable: transcript.messages.length > 0 }; report.passed &&= report.fork.passed && report.fork.readable; }
  catch (error) { report.fork = { passed: false, error: redact(String(error.message)) }; report.passed = false; }
}
fs.mkdirSync('tests/e2e/shots', { recursive: true }); fs.writeFileSync('tests/e2e/shots/codex-terminal-roundtrip.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: report.passed, report: 'tests/e2e/shots/codex-terminal-roundtrip.json' }));
if (!report.passed) process.exitCode = 1;
