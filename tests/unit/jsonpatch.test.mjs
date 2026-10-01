import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setPath, removePath, parseSpans, getNode, valueOf } from '../../backend/lib/jsonpatch.mjs';
import { REFERENCE, hasReference } from '../helpers/project.mjs';
import { diffText } from '../../backend/lib/diff.mjs';

const lines = (s) => s.split('\n');
const changedLines = (a, b) => { const d = diffText(a, b); return Math.max(d.added, d.removed); };

test('setPath replaces one string value and touches one line', () => {
  const src = '{\n  "roles": {\n    "a": {\n      "model": "opus",\n      "note": "n"\n    }\n  }\n}\n';
  const out = setPath(src, ['roles', 'a', 'model'], 'haiku');
  assert.equal(out, src.replace('"opus"', '"haiku"'));
});

test('setPath inserts a member with the file indentation and adds the comma', () => {
  const src = '{\n  "roles": {\n    "a": {\n      "model": "opus"\n    }\n  }\n}\n';
  const out = setPath(src, ['roles', 'a', 'note'], 'why "quoted" \\ back');
  assert.deepEqual(JSON.parse(out).roles.a, { model: 'opus', note: 'why "quoted" \\ back' });
  assert.match(out, /\n {6}"model": "opus",\n {6}"note": /);
});

test('setPath inserts a nested object and keeps CRLF when asked', () => {
  const src = '{\r\n  "roles": {\r\n    "a": "x"\r\n  }\r\n}';
  const out = setPath(src, ['roles', 'b'], { engine: 'copilot', failover: ['gemini', 'self'] }, { eol: '\r\n' });
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF introduced');
  assert.deepEqual(JSON.parse(out).roles.b, { engine: 'copilot', failover: ['gemini', 'self'] });
  assert.ok(out.endsWith('}'), 'no trailing newline added');
});

test('setPath keeps an inline array inline', () => {
  const src = '{"frozen": [], "request_id": null, "paths": []}\n';
  const out = setPath(src, ['frozen'], ['frontend', 'backend']);
  assert.equal(out, '{"frozen": ["frontend", "backend"], "request_id": null, "paths": []}\n');
});

test('setPath fills an empty object', () => {
  const src = '{\n  "roles": {}\n}\n';
  const out = setPath(src, ['roles', 'x'], 'haiku');
  assert.deepEqual(JSON.parse(out), { roles: { x: 'haiku' } });
});

test('removePath removes middle and last members', () => {
  const src = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n';
  assert.deepEqual(JSON.parse(removePath(src, ['b'])), { a: 1, c: 3 });
  assert.deepEqual(JSON.parse(removePath(src, ['c'])), { a: 1, b: 2 });
  assert.equal(removePath(src, ['c']), '{\n  "a": 1,\n  "b": 2\n}\n');
  assert.equal(removePath('{"a":1}', ['a']), '{}');
});

test('parseSpans rejects malformed JSON', () => {
  assert.throws(() => parseSpans('{"a": }'));
  assert.throws(() => parseSpans('{"a": 1,}'));
  assert.throws(() => parseSpans('{"a": 1} x'));
});

test('getNode/valueOf read values back', () => {
  const src = '{"a": {"b": [1, {"c": "d"}]}}';
  const root = parseSpans(src);
  assert.equal(valueOf(src, getNode(root, ['a', 'b', 1, 'c'])), 'd');
});

test('real models.json: a tier change is exactly one line; a new role is four', { skip: !hasReference }, () => {
  const src = fs.readFileSync(path.join(REFERENCE, 'models.json'), 'utf8');
  const one = setPath(src, ['roles', 'researcher', 'model'], 'sonnet');
  assert.equal(changedLines(src, one), 1);
  assert.equal(JSON.parse(one).roles.researcher.model, 'sonnet');
  const note = setPath(src, ['roles', 'qa', 'note'], 'It says "hi" \\ `tick` é');
  assert.equal(changedLines(src, note), 1);
  assert.equal(JSON.parse(note).roles.qa.note, 'It says "hi" \\ `tick` é');
  const add = setPath(src, ['roles', 'newrole'], { model: 'haiku', note: 'x' });
  const parsed = JSON.parse(add);
  assert.deepEqual(parsed.roles.newrole, { model: 'haiku', note: 'x' });
  const d = diffText(src, add);
  assert.ok(d.removed <= 1 && d.added <= 5, JSON.stringify([d.removed, d.added]));
  // untouched: the inline _allowed array survives byte for byte
  assert.ok(add.includes('"_allowed": ["opus", "sonnet", "haiku"],'));
});

test('real consult.config.json: replacing one role touches only that role', { skip: !hasReference }, () => {
  const src = fs.readFileSync(path.join(REFERENCE, '.claude', 'consult.config.json'), 'utf8');
  const next = { engine: 'codex', failover: ['gemini', 'self'] };
  const out = setPath(src, ['roles', 'qa'], next);
  assert.deepEqual(JSON.parse(out).roles.qa, next);
  const before = JSON.parse(src);
  const after = JSON.parse(out);
  after.roles.qa = before.roles.qa;
  assert.deepEqual(after, before);
  assert.equal(out, JSON.stringify(JSON.parse(out), null, 2) + '\n', 'still exactly stringify(x, null, 2)');
});
