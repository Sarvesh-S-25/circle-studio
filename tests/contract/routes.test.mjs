// The contract in both directions: every route in contracts/api.json has a backend handler, and every
// request the frontend can build targets a route in the contract. Fails closed on paths it cannot read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, APP_ROOT } from '../../backend/config.mjs';
import { createApp } from '../../backend/app.mjs';
import { buildHandlers } from '../../backend/routes.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

const contract = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'contracts', 'api.json'), 'utf8'));
// a trailing optional query part (`${open ? '?open=1' : ''}`) is not a path segment
const norm = (p) => p.replace(/(\$\{[^}]*\})\$\{[^}]*\}/g, '$1').replace(/:[a-z]+/g, ':p').replace(/\$\{[^}]*\}/g, ':p').split('?')[0];

test('contract routes are unique and well formed', () => {
  const ids = new Set();
  const keys = new Set();
  for (const r of contract.routes) {
    assert.ok(!ids.has(r.id), `duplicate id ${r.id}`);
    ids.add(r.id);
    const k = `${r.method} ${norm(r.path)}`;
    assert.ok(!keys.has(k), `duplicate route ${k}`);
    keys.add(k);
    assert.match(r.path, /^\/api\/[a-z:/-]+$/);
    assert.ok(['GET', 'POST', 'PUT', 'DELETE'].includes(r.method));
  }
});

test('backend: every contract route has a handler and every handler is in the contract', () => {
  const dir = tempDir();
  try {
    const app = createApp({ ...loadConfig({ CIRCLE_DATA: dir }) });
    const handlers = buildHandlers(app);
    assert.deepEqual(Object.keys(handlers).sort(), contract.routes.map((r) => r.id).sort());
  } finally { rmDir(dir); }
});

test('frontend: api.js only builds requests that the contract lists, and uses every route', () => {
  const src = fs.readFileSync(path.join(APP_ROOT, 'frontend', 'js', 'api.js'), 'utf8');
  const calls = [];
  for (const m of src.matchAll(/request\(\s*'(GET|POST|PUT|DELETE)'\s*,\s*(?:'([^']*)'|`([^`]*)`)/g)) calls.push({ method: m[1], path: m[2] ?? m[3] });
  for (const m of src.matchAll(/fetch\(\s*([`'])(\/api\/[^`']*)\1\s*,\s*\{\s*method:\s*'(GET|POST|PUT|DELETE)'/g)) calls.push({ method: m[3], path: m[2] });
  // fail closed: every request( or fetch( occurrence must have been read as a literal
  const occurrences = (src.match(/\brequest\(\s*'/g) || []).length + (src.match(/\bfetch\(\s*['`]\/api/g) || []).length;
  const allRequestCalls = (src.match(/\brequest\(/g) || []).length - 1; // minus the definition
  assert.equal(calls.filter((c) => !c.path.startsWith('/api/chat') || true).length, occurrences, 'a call was not read as a literal');
  assert.ok(allRequestCalls === (src.match(/\brequest\(\s*'/g) || []).length, 'a request() call has a non-literal method');
  const table = new Set(contract.routes.map((r) => `${r.method} ${norm(r.path)}`));
  const used = new Set();
  for (const c of calls) {
    assert.ok(c.path.startsWith('/api/'), `not an /api path: ${c.path}`);
    const k = `${c.method} ${norm(c.path)}`;
    assert.ok(table.has(k), `frontend calls ${k}, which is not in contracts/api.json`);
    used.add(k);
  }
  for (const k of table) assert.ok(used.has(k), `contract route ${k} is never used by the frontend`);
});

test('the frontend calls fetch in api.js only', () => {
  const root = path.join(APP_ROOT, 'frontend', 'js');
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && e.name !== 'api.js' && /\bfetch\(|XMLHttpRequest|new EventSource/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
