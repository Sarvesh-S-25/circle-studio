// When Claude asks: every kind of question reaches you (one, several, pick one, pick several), your answer (an
// option, several, or your own words) reaches Claude as you gave it, and the chat says in words what was asked and
// what you answered, or that you did not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, tries = 100) => { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(50); } return null; };

const ONE = [{ question: 'Which test runner?', header: 'Tests', options: [{ label: 'node:test', description: 'built in' }, { label: 'Vitest', description: 'fast, watch mode' }], multiSelect: false }];
const TWO = [
  { question: 'Which pages?', header: 'Pages', options: [{ label: 'Home' }, { label: 'Settings' }, { label: 'About' }], multiSelect: true },
  { question: 'Which colour theme?', header: 'Theme', options: [{ label: 'Light' }, { label: 'Dark' }], multiSelect: false },
];

async function ask(s, id, questions) {
  process.env.FAKE_CLAUDE = 'question';
  process.env.FAKE_CLAUDE_QUESTIONS = JSON.stringify(questions);
  assert.equal((await s.call('POST', '/api/overlay/say', { projectId: id, text: 'set it up' })).json.sent, true);
  return until(async () => (await s.call('GET', '/api/requests?status=pending')).json.requests[0]);
}
const done = (s, id) => until(async () => (await s.call('GET', `/api/projects/${id}/chat/live`)).json.turn === null);
const last = async (s, id) => (await s.call('GET', `/api/projects/${id}/chat`)).json.messages.at(-1);

test('questions: every kind is asked, answered as given, and said in words in the chat', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true, run: true, claude: true } })).json.project.id;

    // one question, pick one: what the card sends with one click
    let r = await ask(s, id, ONE);
    assert.equal(r.kind, 'question');
    assert.deepEqual(r.questions[0].options.map((o) => o.label), ['node:test', 'Vitest']);
    assert.equal(r.questions[0].options[1].description, 'fast, watch mode', 'the descriptions reach the card');
    // while it waits, the live chat line says what is asked
    assert.match((await s.call('GET', `/api/projects/${id}/chat/live`)).json.turn.tools[0].summary, /^Asked you: Which test runner\?/);
    assert.equal((await s.call('POST', `/api/requests/${r.id}/respond`, { decision: 'answer', answers: { 'Which test runner?': 'Vitest' } })).status, 200);
    assert.ok(await done(s, id));
    let m = await last(s, id);
    assert.equal(m.tools[0].summary, 'Which test runner? You answered: Vitest');
    assert.equal(m.tools[0].ok, true, 'answered: a tick, not a spinner');
    assert.equal(m.text, 'Got it. Which test runner? Vitest.');

    // two questions, one of them pick several: what the card's Send answers sends
    r = await ask(s, id, TWO);
    assert.deepEqual(r.questions.map((q) => q.multiSelect), [true, false]);
    // a question left out is refused, so nothing half-answered reaches Claude
    assert.equal((await s.call('POST', `/api/requests/${r.id}/respond`, { decision: 'answer', answers: { 'Which pages?': 'Home' } })).status, 400);
    assert.equal((await s.call('POST', `/api/requests/${r.id}/respond`, { decision: 'answer', answers: { 'Which pages?': ['Home', 'About'], 'Which colour theme?': 'Dark' } })).status, 200);
    assert.ok(await done(s, id));
    m = await last(s, id);
    assert.equal(m.tools[0].summary, 'Which pages? You answered: Home, About · Which colour theme? You answered: Dark');
    assert.equal(m.text, 'Got it. Which pages? Home, About. Which colour theme? Dark.');

    // your own words instead of an option
    r = await ask(s, id, ONE);
    await s.call('POST', `/api/requests/${r.id}/respond`, { decision: 'answer', answers: { 'Which test runner?': 'whatever the repo already uses' } });
    assert.ok(await done(s, id));
    assert.equal((await last(s, id)).tools[0].summary, 'Which test runner? You answered: whatever the repo already uses');

    // not answered (Deny on the card, or the run stopped): said so, and Claude is told
    r = await ask(s, id, ONE);
    await s.call('POST', `/api/requests/${r.id}/respond`, { decision: 'deny' });
    assert.ok(await done(s, id));
    m = await last(s, id);
    assert.equal(m.tools[0].summary, 'Which test runner? You did not answer.');
    assert.equal(m.tools[0].ok, false);
    assert.equal(m.text, 'No answer, so I will not go on with that.');
  } finally {
    delete process.env.FAKE_CLAUDE;
    delete process.env.FAKE_CLAUDE_QUESTIONS;
    await s.close();
    rmDir(root);
  }
});
