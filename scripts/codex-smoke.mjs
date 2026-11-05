// Explicit opt-in real-account acceptance probe. Never points at registered projects or Circle's real data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexAdapter } from '../backend/lib/engines/codex.mjs';
import { evaluate } from '../backend/lib/policy.mjs';
import { redact } from '../backend/lib/secrets.mjs';

if (!process.argv.includes('--real')) {
  console.log('Use --real only with permission: four small Codex turns in a new temporary fixture, using the current CLI sign-in and plan allowance. No real projects or Circle data are used.');
  process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-codex-live-'));
const project = path.join(root, 'project'); fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'README.md'), '# Circle smoke fixture\n\nInside marker: CIRCLE_INSIDE_OK\n');
fs.writeFileSync(path.join(root, 'outside-probe.txt'), 'CIRCLE_OWNED_OUTSIDE_FIXTURE\n');
const adapter = createCodexAdapter();
const detection = await adapter.detect();
const report = { at: new Date().toISOString(), cliVersion: detection.version, temporaryRoot: root, phaseResults: [], note: 'Real signed-in Codex fixture. An operation without a request is not evidence of interception. Missing scenarios remain unverified.' };
if (!detection.installed || detection.loggedIn !== true) throw new Error('Codex must be installed and signed in. No model turn was started.');
let sessionId = null;
async function phase(name, prompt, { deny = false, stopAfterMs = null, write = true } = {}) {
  const row = { name, requests: [], notices: [], text: '', startedAt: new Date().toISOString() };
  const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), 120000);
  let stopTimer = null;
  try {
    const result = await adapter.runTurn({ cwd: project, prompt, sessionId, permissions: { write, shell: true }, signal: controller.signal, runId: name,
      systemPrompt: `This is a small acceptance test in ${project}. Keep answers below 80 words. Do not use MCP, skills, network, subagents, or any real project. Only read/edit this fixture. The outside-read phase may read only the owned fixture ${path.join(root, 'outside-probe.txt')}. Never access any other outside path. Never print credentials.`,
      emit: (kind, data) => {
        if (kind === 'session') { sessionId = data.sessionId; if (stopAfterMs != null) stopTimer = setTimeout(() => controller.abort(), stopAfterMs); }
        if (kind === 'text') row.text = redact(row.text + (data.delta || '')).slice(-4000);
        if (kind === 'error') row.error = redact(String(data.message)).slice(0, 500);
        if (kind === 'notice') row.notices.push(redact(String(data.message)).slice(0, 300));
      },
      onRequest: async (request) => {
        const decision = evaluate(request, { root: project, permissions: { write, shell: true } });
        const allow = !deny && row.requests.length < 10 && decision.verdict !== 'deny' && decision.risk === 'normal';
        row.requests.push({ tool: request.tool, providerRequestId: request.providerRequestId || null, summary: redact(String(decision.title || request.tool)).slice(0, 200), command: redact(String(request.input?.command || '')).slice(0, 1500), path: redact(String(request.input?.file_path || '')).slice(0, 500), decision: allow ? 'allow' : 'deny', risk: decision.risk });
        if (row.requests.length >= 10) controller.abort();
        return { decision: allow ? 'allow' : 'deny', message: allow ? 'Allowed only for this temporary acceptance fixture.' : 'Denied by this acceptance test. Report the denial and do not try another route.' };
      },
    });
    row.status = result.status; sessionId = result.sessionId || sessionId;
    row.sessionId = sessionId; row.interruptRequested = controller.signal.aborted;
  } catch (error) { row.status = 'error'; row.error = redact(String(error.message)).slice(0, 500); }
  finally { clearTimeout(deadline); clearTimeout(stopTimer); row.finishedAt = new Date().toISOString(); report.phaseResults.push(row); }
  console.log(JSON.stringify({ phase: name, status: row.status, requests: row.requests.length, interruptRequested: row.interruptRequested, error: row.error || null }));
  return row.status === 'done';
}
await phase('read-edit-command', 'Read README.md. Use the native apply_patch file-change tool, not a shell write command, to create result.txt containing exactly CIRCLE_RESULT_OK. Then run one harmless command to read result.txt. If the native file-change tool is unavailable, report that and stop. Do nothing else.');
if (sessionId && !process.argv.includes('--edit-only')) {
  await phase('resume-deny', 'Continue this same thread. Try one command that writes denied.txt containing DENIED_PROBE. If approval is denied, stop that operation and report the denial; do not use another tool or method.', { deny: true });
  await phase('outside-read', `Try to read only this owned acceptance fixture: ${path.join(root, 'outside-probe.txt')}. If unavailable or denied, report that and stop. Do not access any other outside file.`, { deny: true, write: false });
  await phase('interrupt', 'Explain briefly how to verify a stable sorting algorithm. Do not use tools or modify files.', { stopAfterMs: 500, write: false });
}
report.observedFiles = { resultExists: fs.existsSync(path.join(project, 'result.txt')), resultMatches: fs.existsSync(path.join(project, 'result.txt')) && fs.readFileSync(path.join(project, 'result.txt'), 'utf8').trim() === 'CIRCLE_RESULT_OK', deniedFileExists: fs.existsSync(path.join(project, 'denied.txt')) };
for (const [name, run] of Object.entries({ models: () => adapter.catalog(), history: () => adapter.listHistory({ cwd: project }), transcript: () => adapter.readHistory({ cwd: project, id: sessionId }), connections: () => adapter.effectiveConnections({ cwd: project }), limits: () => adapter.readLimits() })) {
  try { const value = await run(); report[name] = { status: 'read', count: Array.isArray(value) ? value.length : (value.conversations || value.messages || value.servers || []).length, includesThisThread: name === 'history' ? value.conversations.some((c) => c.id === sessionId) : undefined, available: name === 'limits' ? value.available !== false : undefined }; }
  catch (error) { report[name] = { status: 'error', error: redact(String(error.message)).slice(0, 500) }; }
}
const output = path.resolve(process.argv.includes('--edit-only') ? 'tests/e2e/shots/codex-live-edit.json' : 'tests/e2e/shots/codex-live-smoke.json'); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: output, observedFiles: report.observedFiles }));
if (report.phaseResults.some((r) => r.status === 'error')) process.exitCode = 1;
