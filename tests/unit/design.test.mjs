// docs/design-rules.md, enforced: tokens only, icons that exist, inline styles that carry custom properties only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_ROOT } from '../../backend/config.mjs';
import { icons } from '../../frontend/js/icons.js';

const FE = path.join(APP_ROOT, 'frontend');
const walk = (d, ext, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, ext, out); else if (p.endsWith(ext)) out.push(p);
  }
  return out;
};
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

test('rule 1 and 2: no raw colours, sizes or durations outside tokens.css', () => {
  const bad = [];
  for (const f of walk(path.join(FE, 'css'), '.css').filter((x) => !x.endsWith('tokens.css'))) {
    const css = stripComments(fs.readFileSync(f, 'utf8'));
    // media conditions are the documented exception
    const scrubbed = css.replace(/@media[^{]*\{/g, '@media {');
    for (const m of scrubbed.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|color-mix\(|-?\d*\.?\d+(px|rem|em|ch|pt|cm|mm|in|ms|s)\b/g)) bad.push(`${path.basename(f)}: ${m[0]}`);
    for (const m of scrubbed.matchAll(/:\s*(red|blue|green|black|white|gray|grey|orange|yellow|purple|pink)\b/g)) bad.push(`${path.basename(f)}: named colour ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test('rule 3: JS sets inline styles through custom properties only', () => {
  const bad = [];
  for (const f of walk(path.join(FE, 'js'), '.js').filter((x) => !x.endsWith('icons.js'))) {
    const js = fs.readFileSync(f, 'utf8');
    for (const m of js.matchAll(/\.style\.(?!setProperty)\w+\s*=/g)) bad.push(`${path.basename(f)}: ${m[0]}`);
    for (const m of js.matchAll(/\.style\.setProperty\(\s*['"`](?!--)/g)) bad.push(`${path.basename(f)}: ${m[0]}`);
    for (const m of js.matchAll(/setAttribute\(\s*['"]style['"]/g)) bad.push(`${path.basename(f)}: ${m[0]}`);
    for (const m of js.matchAll(/\bstyle="/g)) bad.push(`${path.basename(f)}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
  assert.ok(!/\bstyle=/.test(fs.readFileSync(path.join(FE, 'index.html'), 'utf8')));
});

test('rule 4: classes use the cs- prefix', () => {
  const bad = new Set();
  for (const f of walk(path.join(FE, 'css'), '.css').filter((x) => !x.endsWith('tokens.css'))) {
    for (const m of stripComments(fs.readFileSync(f, 'utf8')).matchAll(/\.([a-zA-Z][\w-]*)/g)) {
      if (/^\d/.test(m[1])) continue;
      if (!m[1].startsWith('cs-')) bad.add(`${path.basename(f)}: .${m[1]}`);
    }
  }
  assert.deepEqual([...bad], []);
});

test('rule 5: every icon the UI names exists in icons.js', () => {
  const names = new Set();
  for (const f of walk(path.join(FE, 'js'), '.js').filter((x) => !x.endsWith('icons.js'))) {
    const js = fs.readFileSync(f, 'utf8');
    // literals inside icon(...) calls: the first argument and either side of a ternary
    for (const call of js.matchAll(/\bicon\(/g)) {
      let depth = 1;
      let i = call.index + call[0].length;
      const from = i;
      while (i < js.length && depth) { if (js[i] === '(') depth++; else if (js[i] === ')') depth--; i++; }
      for (const m of js.slice(from, i).matchAll(/(?:^|\?\s*|:\s*)'([a-z][a-z-]*)'/g)) names.add(m[1]);
    }
    // [route, 'Label', 'icon'] tuples used by nav, tabs and mode switches
    for (const m of js.matchAll(/\['[^']*',\s*'[A-Z][^']*',\s*'([a-z-]+)'\]/g)) names.add(m[1]);
  }
  const missing = [...names].filter((n) => !(n in icons) && !['s', 'm', 'l'].includes(n));
  assert.deepEqual(missing, []);
  for (const t of ['tier-haiku', 'tier-sonnet', 'tier-opus']) assert.ok(t in icons);
});

test('rule 8 and 9: both dark blocks identical and every text pair passes AA', () => {
  const r = spawnSync(process.execPath, [path.join(APP_ROOT, 'scripts', 'check-contrast.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('rule 10: no external assets', () => {
  for (const f of [...walk(path.join(FE, 'css'), '.css'), path.join(FE, 'index.html')]) {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/https?:\/\//.test(stripComments(t).replace(/xmlns="[^"]*"/g, '')), `${path.basename(f)} references an external URL`);
  }
  for (const f of walk(path.join(FE, 'js'), '.js').filter((x) => !x.endsWith('icons.js'))) {
    const t = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/(?:src|href|url)\s*[=(:]\s*['"`]https?:/.test(t), `${path.basename(f)} loads an external resource`);
  }
});
