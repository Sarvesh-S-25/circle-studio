import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAlerts, answerAlertText, raisedAt, isOpenStatus } from '../../backend/lib/alerts.mjs';

// texter's own template (.claude/agents/texter.md): bold field names, the colon inside the asterisks, newest first.
const TEXTER = `# Alerts

## A-002 — Which database?

- **Status:** open
- **Raised:** 2026-09-30 by texter, from ADR 003
- **Question for the human:** Postgres or SQLite for the store?
- **Options:** Postgres (hosted, costs money); SQLite (local file, no server)
- **Blocks:** be-builder, TX-004

## A-001 — Port clash

- **Status:** answered
- **Raised:** 2026-09-29 by texter, from trail.md
- **Question for the human:** Keep port 3000?
- **Options:** keep; move to 3100
- **Blocks:** none
- **Answer:** move to 3100
`;

test('parseAlerts reads texter\'s template: fields, open/closed, dates', () => {
  const [a, b] = parseAlerts(TEXTER);
  assert.equal(a.id, 'A-002');
  assert.equal(a.title, 'Which database?');
  assert.equal(a.open, true);
  assert.equal(a.question, 'Postgres or SQLite for the store?');
  assert.match(a.options, /^Postgres \(hosted/);
  assert.equal(a.blocks, 'be-builder, TX-004');
  assert.equal(a.at, new Date('2026-09-30').toISOString());
  assert.equal(a.answer, null);
  assert.equal(b.id, 'A-001');
  assert.equal(b.open, false);
  assert.equal(b.answer, 'move to 3100');
});

test('parseAlerts tolerates plain fields, other separators, no title, CRLF, and junk', () => {
  const text = '## A-7: plain colon\r\nStatus: open\r\nQuestion for the human: ok?\r\n\r\n## A-8 - hyphen\r\n- Status: Answered by the lead\r\n\r\n## A-9\r\n- **Status:** open\r\n';
  const list = parseAlerts(text);
  assert.deepEqual(list.map((a) => [a.id, a.title, a.open]), [['A-7', 'plain colon', true], ['A-8', 'hyphen', false], ['A-9', '', true]]);
  assert.equal(list[0].question, 'ok?');
  assert.deepEqual(parseAlerts('# Alerts\n\nNone yet.\n'), []);
  assert.deepEqual(parseAlerts(null), []);
  assert.equal(isOpenStatus(undefined), true, 'no status means open, as the tracker treats it');
  assert.equal(raisedAt('no date here'), null);
});

test('answerAlertText answers one entry and changes nothing else', () => {
  const out = answerAlertText(TEXTER, 'A-002', 'SQLite', '2026-10-01');
  const expected = TEXTER
    .replace('- **Status:** open', '- **Status:** answered')
    .replace('- **Blocks:** be-builder, TX-004\n', '- **Blocks:** be-builder, TX-004\n- **Answer:** SQLite (human, via Circle Studio, 2026-10-01)\n');
  assert.equal(out, expected, 'only that entry\'s Status changes and one Answer line is added at its end');
  const [a, b] = parseAlerts(out);
  assert.equal(a.open, false);
  assert.equal(a.answer, 'SQLite (human, via Circle Studio, 2026-10-01)');
  assert.equal(a.question, 'Postgres or SQLite for the store?', 'the question survives');
  assert.equal(b.answer, 'move to 3100', 'the other entry is untouched');
  assert.ok(out.endsWith('\n'), 'the final newline is kept');
});

test('answerAlertText keeps CRLF, plain-field style, and an empty Answer line', () => {
  const crlf = TEXTER.replace(/\n/g, '\r\n');
  const out = answerAlertText(crlf, 'A-002', 'Postgres', '2026-10-01');
  assert.ok(!/[^\r]\n/.test(out), 'every line ending is still CRLF');
  assert.equal(parseAlerts(out)[0].answer, 'Postgres (human, via Circle Studio, 2026-10-01)');

  const plain = '## A-1 - t\nStatus: open\nQuestion for the human: q?\n';
  const p = answerAlertText(plain, 'A-1', 'yes', '2026-10-01');
  assert.equal(p, '## A-1 - t\nStatus: answered\nQuestion for the human: q?\n- Answer: yes (human, via Circle Studio, 2026-10-01)\n');

  const empty = '## A-1 - t\n\n- **Status:** open\n- **Answer:**\n';
  assert.match(answerAlertText(empty, 'A-1', 'go', '2026-10-01'), /- \*\*Answer:\*\* go \(human, via Circle Studio, 2026-10-01\)\n$/);
});

test('answerAlertText collapses line breaks in the answer', () => {
  const out = answerAlertText(TEXTER, 'A-002', 'SQLite\n\n  because local\r\nonly', '2026-10-01');
  assert.match(out, /- \*\*Answer:\*\* SQLite because local only \(human/);
});

test('answerAlertText refuses what it should, and says why', () => {
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(code(() => answerAlertText(TEXTER, 'A-999', 'x', 'd')), 'not_found');
  assert.equal(code(() => answerAlertText(TEXTER, 'A-001', 'x', 'd')), 'conflict', 'already answered');
  assert.equal(code(() => answerAlertText(TEXTER, 'nope', 'x', 'd')), 'bad_request');
  assert.equal(code(() => answerAlertText(TEXTER, 'A-002', '   ', 'd')), 'bad_request');
  assert.equal(code(() => answerAlertText(TEXTER, 'A-002', 'x'.repeat(601), 'd')), 'bad_request');
  assert.equal(code(() => answerAlertText(TEXTER, 'A-002', 'use key sk-ant-abcdefghijklmnop1234567890', 'd')), 'bad_request', 'a secret is never written');
  assert.equal(code(() => answerAlertText('## A-3 - t\n- **Raised:** 2026-01-01\n', 'A-3', 'x', 'd')), 'conflict', 'no Status line');
});
