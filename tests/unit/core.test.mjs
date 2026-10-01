import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { diffText } from '../../backend/lib/diff.mjs';
import { detectEol } from '../../backend/lib/textfile.mjs';
import { resolveInside, safeRelPath, isWritable, isSensitiveName } from '../../backend/lib/paths.mjs';
import { scanSecrets, redact, StreamRedactor } from '../../backend/lib/secrets.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

test('diffText: identical, single change, hunks with context', () => {
  assert.deepEqual(diffText('a\nb\n', 'a\nb\n'), { added: 0, removed: 0, hunks: [] });
  const d = diffText('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'a\nb\nc\nd\nE\nf\ng\nh\ni\nj\n');
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.hunks.length, 1);
  assert.equal(d.hunks[0].oldStart, 2);
  assert.equal(d.hunks[0].lines.filter((l) => l.t === '+')[0].text, 'E');
  const far = diffText(Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n'), Array.from({ length: 40 }, (_, i) => (i === 1 || i === 38 ? `X${i}` : `l${i}`)).join('\n'));
  assert.equal(far.hunks.length, 2);
  assert.equal(diffText('', 'x\n').added, 1);
  assert.equal(diffText('x\n', '').removed, 1);
});

test('detectEol is per file and dominant', () => {
  assert.equal(detectEol('a\r\nb\r\n'), '\r\n');
  assert.equal(detectEol('a\nb\n'), '\n');
  assert.equal(detectEol('a\r\nb'), '\r\n');
  assert.equal(detectEol('no newline'), '\n');
});

test('resolveInside blocks traversal, absolute paths and symlink escapes', () => {
  const root = tempDir();
  const outside = tempDir();
  try {
    assert.ok(resolveInside(root, 'a/b.txt').startsWith(root));
    assert.throws(() => resolveInside(root, '../x'), /escapes/);
    assert.throws(() => resolveInside(root, 'a/../../x'), /escapes/);
    assert.throws(() => resolveInside(root, 'C:\\Windows\\win.ini'));
    assert.throws(() => resolveInside(root, '/etc/passwd'));
    assert.throws(() => resolveInside(root, 'a\0b'));
    assert.throws(() => resolveInside(root, ''));
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
      assert.throws(() => resolveInside(root, 'link/secret.txt'), /outside/);
    } catch (e) {
      if (e.code !== 'EPERM') throw e;
    }
  } finally {
    rmDir(root);
    rmDir(outside);
  }
});

test('isWritable is an allowlist and refuses the lead control plane', () => {
  for (const ok of ['models.json', '.claude/consult.config.json', '.claude/state/roster.json', '.claude/agents/qa.md', '.claude/skills/x/SKILL.md', 'docs/tasks/BOARD.md', 'docs/adr/001-stack.md', '.mcp.json', 'push.md', '.gitignore', 'docs/brief.md', 'workflow.json', 'AGENTS.md', '.agents/skills/x/SKILL.md', '.gemini/skills/x/refs/a.md']) {
    assert.ok(isWritable(ok), ok);
  }
  for (const bad of ['CLAUDE.md', '.agents/skills/Bad Name/SKILL.md', '.agents/other/x.md', '.gemini/settings.json', 'sub/workflow.json', 'sub/AGENTS.md', 'agents.md.bak','.claude/hooks/guard.py', 'scripts/apply-models.mjs', '.git/config', '.claude/settings.local.json', 'src/app.js', '.claude/agents/../hooks/x.py', 'docs/adr/x.md', '.claude/agents/Bad Name.md']) {
    assert.ok(!isWritable(bad), bad);
  }
});

test('isSensitiveName', () => {
  for (const s of ['.env', '.env.local', 'a/b/server.pem', 'k/id_rsa', 'k/id_rsa.pub', '.npmrc', 'cfg/credentials.json', '.git/config', 'node_modules/x/y.js']) assert.ok(isSensitiveName(s), s);
  for (const s of ['README.md', 'src/env.js', 'docs/brief.md']) assert.ok(!isSensitiveName(s), s);
});

test('safeRelPath rejects what GitHub repos really contain', () => {
  assert.equal(safeRelPath('scripts/run.py', 60).path, 'scripts/run.py');
  for (const bad of ['', '/abs', 'a/../b', 'a//b', 'a/./b', 'a\\b', 'a/b:c', 'a/<Name>App.swift', 'a/CON.txt', 'a/nul', 'a/COM1.md', 'a/trail.', 'a/trail ', 'PROGRA~1/x', 'a/b\u202e.txt', 'a/x\u0007']) {
    assert.equal(safeRelPath(bad, 0).ok, false, JSON.stringify(bad));
  }
  assert.equal(safeRelPath('x'.repeat(200), 60).ok, false);
  assert.equal(safeRelPath('caf\u0065\u0301/a.md', 0).path, 'caf\u00e9/a.md');
});

test('secrets: found, masked, never echoed', () => {
  const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
  const text = `{"env": {"TOKEN": "\${TOKEN:-${key}}", "OK": "\${OK:-}", "X": "\${X}"}, "api_key": "supersecretvalue123"}`;
  const found = scanSecrets(text);
  assert.ok(found.some((f) => f.kind === 'default-value'));
  assert.ok(found.some((f) => f.kind === 'literal-assignment'));
  assert.ok(!JSON.stringify(found).includes('supersecretvalue123'));
  assert.ok(!JSON.stringify(found).includes(key));
  const red = redact(text);
  assert.ok(!red.includes('supersecretvalue123'));
  assert.ok(!red.includes(key));
  assert.ok(red.includes('sk-a\u2026'));
  assert.equal(scanSecrets('Authorization": "Bearer ${TOKEN}"').length, 0);
});

test('StreamRedactor catches a secret split across chunks', () => {
  const key = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const r = new StreamRedactor();
  let out = '';
  for (const part of [`token is ${key.slice(0, 10)}`, key.slice(10), ' and done']) out += r.push(part);
  out += r.flush();
  assert.ok(!out.includes(key.slice(10)));
  assert.ok(out.includes('ghp_\u2026'));
});
