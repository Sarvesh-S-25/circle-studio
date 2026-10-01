import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter, setFrontMatterField, fieldString, yamlScalar } from '../../backend/lib/frontmatter.mjs';

const v = (raw, key) => fieldString(parseFrontMatter(raw), key);

test('plain, quoted and multi-line descriptions', () => {
  assert.equal(v('---\nname: a\ndescription: plain text here\n---\nbody', 'description'), 'plain text here');
  assert.equal(v('---\ndescription: "double \\"q\\" text"\n---\n', 'description'), 'double "q" text');
  assert.equal(v("---\ndescription: 'it''s single'\n---\n", 'description'), "it's single");
  assert.equal(v('---\ndescription: "spans\n  two lines"\n---\n', 'description'), 'spans two lines');
});

test('block scalars', () => {
  assert.equal(v('---\ndescription: >\n  folded one\n  folded two\nname: x\n---\n', 'description'), 'folded one folded two');
  assert.equal(v('---\ndescription: >-\n  a\n  b\n---\n', 'description'), 'a b');
  assert.equal(v('---\ndescription: |\n  line1\n  line2\n---\n', 'description'), 'line1\nline2');
  assert.equal(v('---\ndescription: |-\n  keep\n---\n', 'description'), 'keep');
});

test('nested keys are skipped and lists are read', () => {
  const raw = '---\nname: x\nmetadata:\n  author: me\n  version: 2\nrequires:\n  - a\n  - b\ndescription: after nested\n---\n';
  assert.equal(v(raw, 'name'), 'x');
  assert.equal(v(raw, 'description'), 'after nested');
  assert.deepEqual(parseFrontMatter(raw).fields.get('requires').value, ['a', 'b']);
  assert.equal(parseFrontMatter(raw).fields.get('metadata').nested, true);
});

test('CRLF, BOM and missing front matter', () => {
  assert.equal(v('---\r\nname: a\r\ndescription: crlf\r\n---\r\n', 'description'), 'crlf');
  assert.equal(v('﻿---\nname: a\n---\n', 'name'), 'a');
  assert.equal(parseFrontMatter('# just a heading\n').ok, false);
  assert.equal(parseFrontMatter('---\nname: a\n').ok, false);
});

test('setFrontMatterField changes exactly one line and keeps CRLF', () => {
  const raw = '---\r\nname: a\r\ndescription: d\r\nmodel: opus\r\ntools: Read\r\n---\r\n\r\nBody\r\n';
  const out = setFrontMatterField(raw, 'model', 'haiku');
  assert.equal(out, raw.replace('model: opus', 'model: haiku'));
});

test('setFrontMatterField replaces a block scalar with one line, and adds a missing key', () => {
  const raw = '---\nname: a\ndescription: >\n  long\n  text\nmodel: opus\n---\nBody\n';
  const out = setFrontMatterField(raw, 'description', 'short: with colon');
  assert.equal(out, '---\nname: a\ndescription: "short: with colon"\nmodel: opus\n---\nBody\n');
  const added = setFrontMatterField('---\nname: a\n---\nB\n', 'model', 'sonnet');
  assert.equal(added, '---\nname: a\nmodel: sonnet\n---\nB\n');
});

test('yamlScalar quotes what needs quoting', () => {
  assert.equal(yamlScalar('haiku'), 'haiku');
  assert.equal(yamlScalar('Read, Grep, Glob'), 'Read, Grep, Glob');
  assert.equal(yamlScalar('a: b'), '"a: b"');
  assert.equal(yamlScalar('true'), '"true"');
  assert.equal(yamlScalar('# nope'), '"# nope"');
  assert.equal(yamlScalar(''), '""');
});
