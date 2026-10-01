// The frontend runs only in a browser, so nothing else executes it: parse every module here so a syntax error
// (a stray newline in a string, a missing brace) fails the suite instead of a blank page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_ROOT } from '../../backend/config.mjs';

const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p);
  }
  return out;
};

test('every frontend module parses', () => {
  const bad = [];
  for (const f of walk(path.join(APP_ROOT, 'frontend', 'js'))) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${path.relative(APP_ROOT, f)}: ${r.stderr.split('\n').find((l) => /Error/.test(l)) || 'does not parse'}`);
  }
  assert.deepEqual(bad, []);
});

test('every import in the frontend points at a file that exists', () => {
  const missing = [];
  for (const f of walk(path.join(APP_ROOT, 'frontend', 'js'))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:import|export)\s[^'"`]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const rel = m[1] || m[2];
      if (!fs.existsSync(path.resolve(path.dirname(f), rel))) missing.push(`${path.relative(APP_ROOT, f)} -> ${rel}`);
    }
  }
  assert.deepEqual(missing, []);
});
