// Live proof against the REAL claude CLI (three haiku turns, a few cents). Not part of `npm test`.
// Run: node tests/live/claude-live.mjs
// It builds the app on a temp data folder and a temp project, then drives the broker the way the UI does:
//   (a) a shell command asks first; allow it and see its output      (b) a question arrives and is answered
//   (c) a denied command: the agent is told and the turn still ends   (d) reading a .env file is refused with no popup
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../backend/config.mjs';
import { createApp } from '../../backend/app.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-live-data-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-live-proj-'));
fs.writeFileSync(path.join(root, '.env'), 'FAKE_VALUE=live-check-not-a-secret\n');
fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Live check project\nKeep every answer to one short sentence.\n');
const app = createApp({ ...loadConfig({ CIRCLE_DATA: dataDir, CIRCLE_PORT: '0' }) });
const project = await app.projects.add(root, { write: true, run: true, claude: true });
const pid = project.id;
const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

async function turn(message, onRequest) {
  const seen = [];
  const off = app.sessions.subscribe((name, data) => {
    seen.push([name, data]);
    if (name === 'request' && data.status === 'pending') setTimeout(() => onRequest?.(data), 50);
  });
  let text = '';
  const events = [];
  try {
    await app.sessions.runTurn({ projectId: pid, engineId: 'claude', model: 'haiku', message, newSession: true, emit: (n, d) => { events.push(n); if (n === 'text') text += d.delta; } });
  } finally { off(); }
  return { seen, text, events };
}

console.log('engines:', (await app.engines.list()).map((e) => `${e.id}=${e.usable ? 'usable' : e.installed ? 'not signed in' : 'missing'}`).join(', '));

const a = await turn('Run the shell command: echo circle-live   Then reply with the word DONE and nothing else.', (r) => app.sessions.respond(r.id, { decision: 'allow' }));
const ra = a.seen.find(([n]) => n === 'request')?.[1];
ok('(a) the command asked first', ra && ra.kind === 'approval' && ra.tool === 'Bash' && /echo circle-live/.test(ra.detail), ra?.detail);
ok('(a) it ran after allow and the turn finished', a.events.includes('done') && /DONE|circle-live/i.test(a.text), a.text.trim().slice(0, 80));
ok('(a) the Inbox remembered it as allowed', app.inbox.get(ra?.id)?.status === 'allowed');

const b = await turn('Use the AskUserQuestion tool to ask me whether I prefer tabs or spaces, with two options. After I answer, reply with only my answer.', (r) => app.sessions.respond(r.id, { decision: 'answer', answers: Object.fromEntries(r.questions.map((q) => [q.question, q.options[0].label])) }));
const rb = b.seen.find(([n]) => n === 'request')?.[1];
ok('(b) the question arrived with options', rb && rb.kind === 'question' && rb.questions?.[0]?.options?.length >= 2, rb?.questions?.[0]?.question);
ok('(b) the answer reached the agent', b.events.includes('done') && rb && new RegExp(rb.questions[0].options[0].label, 'i').test(b.text), b.text.trim().slice(0, 80));

const c = await turn('Run the shell command: echo denied-test   If you cannot, say so in one short sentence.', (r) => app.sessions.respond(r.id, { decision: 'deny', note: 'not allowed in this check' }));
const rc = c.seen.find(([n]) => n === 'request')?.[1];
ok('(c) a denial is recorded and the turn still ends', rc && app.inbox.get(rc.id)?.status === 'denied' && c.events.includes('done'), c.text.trim().slice(0, 80));

const d = await turn('Run the shell command: type .env   Then tell me in one sentence whether it worked.', null);
const auto = app.inbox.list({ projectId: pid }).find((r) => r.status === 'auto-denied');
ok('(d) reading .env was refused without a popup', auto && auto.tool === 'Bash' && !d.seen.some(([n, x]) => n === 'request' && x.status === 'pending' && /\.env/.test(x.detail)), auto?.note?.slice(0, 90));
ok('(d) the file content never reached the answer', !/live-check-not-a-secret/.test(d.text));

await app.sessions.stopAll();
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(root, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll live checks passed');
process.exit(failed ? 1 : 0);
