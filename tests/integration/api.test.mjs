import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, tempDir, rmDir } from '../helpers/project.mjs';
import { TRACE, runsOf, has, after } from '../helpers/trace.mjs';

const ALL = { write: true, run: true, claude: true };

async function withServer(fn, opts) {
  const s = await startServer(opts);
  try { await fn(s); } finally { await s.close(); delete process.env.FAKE_CLAUDE; delete process.env.FAKE_CLAUDE_LOG; }
}

test('security envelope: host, origin, csrf header, content type, size, headers', () => withServer(async (s) => {
  const ok = await s.call('GET', '/api/health');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.match(ok.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(ok.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(ok.json).includes('someone@example.test'), 'no e-mail leaks from auth status');
  assert.ok(!JSON.stringify(ok.json).includes('org-secret'));

  assert.equal((await s.raw('GET', '/api/health', { Host: 'evil.test' })).status, 403);
  assert.equal((await s.raw('GET', '/api/health', { Host: `attacker.test:${s.port}` })).status, 403);
  assert.equal((await s.raw('GET', '/api/health', { Host: `localhost:${s.port}` })).status, 200);
  assert.equal((await s.raw('GET', '/api/health', { Host: `127.0.0.1:${s.port}`, Origin: 'http://evil.test' })).status, 403);
  assert.equal((await s.raw('GET', '/api/health', { Host: `127.0.0.1:${s.port}`, Origin: `http://127.0.0.1:${s.port}` })).status, 200);

  const noHeader = await s.raw('POST', '/api/projects', { Host: `127.0.0.1:${s.port}`, 'Content-Type': 'application/json' }, '{}');
  assert.equal(noHeader.status, 403);
  const wrongType = await s.raw('POST', '/api/projects', { Host: `127.0.0.1:${s.port}`, 'X-Circle': '1', 'Content-Type': 'text/plain' }, '{"path":"x"}');
  assert.equal(wrongType.status, 400);
  const badJson = await s.raw('POST', '/api/projects', { Host: `127.0.0.1:${s.port}`, 'X-Circle': '1', 'Content-Type': 'application/json' }, '{nope');
  assert.equal(badJson.status, 400);
  const big = await s.raw('POST', '/api/changes/preview', { Host: `127.0.0.1:${s.port}`, 'X-Circle': '1', 'Content-Type': 'application/json' }, JSON.stringify({ x: 'a'.repeat(1.2 * 1024 * 1024) }));
  assert.equal(big.status, 413);

  assert.equal((await s.call('GET', '/api/nothing')).status, 404);
  assert.equal((await s.call('DELETE', '/api/health')).status, 405);
  assert.equal((await s.call('GET', '/api/skills/Bad_Name')).status, 400);
  assert.equal((await s.call('GET', '/api/projects/BAD!')).status, 400);
  const err = await s.call('GET', '/api/projects/nope');
  assert.equal(err.status, 404);
  assert.deepEqual(Object.keys(err.json.error).sort(), ['code', 'message']);
  assert.ok(!/at .*\.mjs/.test(JSON.stringify(err.json)), 'no stack traces');
}));

test('static files: served from frontend/ only, no traversal', () => withServer(async (s) => {
  assert.equal((await s.raw('GET', '/', { Host: `127.0.0.1:${s.port}` })).status, 200);
  for (const p of ['/%2e%2e/backend/server.mjs', '/..%5cbackend%5cserver.mjs', '/../package.json', '/css/../../package.json', '/%00', '/nope.txt', '/js']) {
    const r = await s.raw('GET', p, { Host: `127.0.0.1:${s.port}` });
    assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!r.text.includes('"name": "circle-studio"'));
  }
  assert.equal((await s.raw('POST', '/', { Host: `127.0.0.1:${s.port}` })).status, 405);
}));

test('projects over HTTP: add, inspect, health, plan, file, diff-first edit, remove', () => withServer(async (s) => {
  const root = makeMiniProject();
  try {
    assert.equal((await s.call('POST', '/api/projects', { path: 'relative/dir' })).status, 400);
    assert.equal((await s.call('POST', '/api/projects', { path: path.join(root, 'nope') })).status, 400);
    const added = await s.call('POST', '/api/projects', { path: root, permissions: ALL });
    assert.equal(added.status, 200);
    const id = added.json.project.id;
    assert.equal(added.json.project.isTeamProject, true);
    assert.equal((await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id, id, 'adding twice is idempotent');

    const got = await s.call('GET', `/api/projects/${id}?open=1`);
    assert.deepEqual(got.json.team.roles.map((r) => r.role), ['planner', 'researcher']);
    assert.equal(got.json.team.roles[1].engine.web, true);
    assert.equal(got.json.team.roster.humanDoesGit, false);
    assert.deepEqual(got.json.team.allowedModels, ['opus', 'sonnet', 'haiku']);

    const h = (await s.call('GET', `/api/projects/${id}/health`)).json;
    const byId = Object.fromEntries(h.items.map((i) => [i.id, i]));
    assert.equal(byId.adr.severity, 'warn');
    assert.equal(byId.secrets.severity, 'danger');
    assert.ok(!JSON.stringify(h).includes('abcdefghijklmnop1234'), 'health never echoes the secret');
    assert.equal(byId.secrets.fix.ops[0].op, 'secrets-fix');
    assert.equal(byId.freeze.severity, 'ok');
    assert.equal(byId.git.severity, 'info');

    const plan = (await s.call('GET', `/api/projects/${id}/plan`)).json;
    assert.equal(plan.plan.phases, undefined, 'the stages belong to the workflow, not the plan');
    const pinned = structuredClone(plan.plan);
    pinned.pins = [{ kind: 'issue', title: 'Check the secrets', detail: 'x' }];
    const saved = (await s.call('PUT', `/api/projects/${id}/plan`, { plan: pinned })).json;
    assert.equal(saved.plan.pins.length, 1);
    assert.deepEqual(saved.warnings.map((w) => w.id), ['pins-open-high']);
    assert.equal((await s.call('PUT', `/api/projects/${id}/plan`, { plan: 'nope' })).status, 400);

    const file = await s.call('GET', `/api/projects/${id}/file?path=.mcp.json`);
    assert.equal(file.status, 200);
    assert.ok(!file.json.text.includes('abcdefghijklmnop1234'), 'file view is redacted');
    fs.writeFileSync(path.join(root, '.env'), 'X=1');
    assert.equal((await s.call('GET', `/api/projects/${id}/file?path=.env`)).status, 403);
    assert.equal((await s.call('GET', `/api/projects/${id}/file?path=..%2F..%2Fx`)).status, 403);
    assert.equal((await s.call('GET', `/api/projects/${id}/file?path=C:%5CWindows%5Cwin.ini`)).status, 403);

    const pv = await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'model', role: 'planner', model: 'opus' }] });
    assert.equal(pv.status, 200);
    assert.equal(pv.json.files.length, 2);
    assert.ok(fs.readFileSync(path.join(root, 'models.json'), 'utf8').includes('"sonnet"'), 'preview wrote nothing');
    const ap = await s.call('POST', '/api/changes/apply', { id: pv.json.id });
    assert.equal(ap.status, 200);
    assert.ok(fs.readFileSync(path.join(root, 'models.json'), 'utf8').includes('"opus"'));
    assert.equal((await s.call('POST', '/api/changes/apply', { id: pv.json.id })).status, 404);
    assert.equal((await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'model', role: 'planner', model: 'gpt' }] })).status, 400);
    assert.equal((await s.call('POST', '/api/changes/preview', { projectId: 'template', ops: [{ op: 'model', role: 'planner', model: 'opus' }] })).status, 404, 'there is no reserved template project any more');

    assert.equal((await s.call('DELETE', `/api/projects/${id}`)).status, 200);
    assert.ok(fs.existsSync(path.join(root, 'models.json')), 'forgetting a project keeps its files');
  } finally { rmDir(root); }
}));

test('skills over HTTP: create, edit, list, use, import a dropped folder, delete', () => withServer(async (s) => {
  const md = '---\nname: my-skill\ndescription: Mine.\n---\nHi\n';
  const created = await s.call('PUT', '/api/skills/my-skill', { skillMd: md });
  assert.equal(created.status, 200);
  assert.equal(created.json.created, true);
  assert.equal((await s.call('PUT', '/api/skills/my-skill', { skillMd: md + 'more' })).json.created, false);
  assert.equal((await s.call('PUT', '/api/skills/Bad', { skillMd: md })).status, 400);
  assert.equal((await s.call('PUT', '/api/skills/x', { skillMd: 5 })).status, 400);
  await s.call('POST', '/api/skills/my-skill/use');
  const state = (await s.call('GET', '/api/state')).json;
  assert.equal(state.mostUsed[0].name, 'my-skill');
  const imp = await s.call('POST', '/api/import', { files: [
    { path: 'pack/dropped/SKILL.md', encoding: 'utf8', data: '---\nname: dropped\ndescription: d\n---\n' },
    { path: 'pack/dropped/img.bin', encoding: 'base64', data: Buffer.from([0, 1, 2]).toString('base64') },
  ] });
  assert.deepEqual(imp.json.imported, ['dropped']);
  assert.equal((await s.call('GET', '/api/skills/dropped')).json.skill.files.length, 2);
  assert.equal((await s.call('POST', '/api/import', { files: [] })).status, 400);
  assert.equal((await s.call('POST', '/api/skills/scan', { url: 'https://evil.test/a/b' })).status, 400);
  assert.equal((await s.call('DELETE', '/api/skills/my-skill')).status, 200);
  assert.equal((await s.call('GET', '/api/skills/my-skill')).status, 404);
}));

test('skills.scan and skills.fetch use only GitHub hosts (offline via injected fetch)', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (url === 'https://api.github.com/repos/o/r') return new Response(JSON.stringify({ default_branch: 'main' }));
    if (String(url).startsWith('https://api.github.com/repos/o/r/git/trees/')) return new Response(JSON.stringify({ truncated: false, tree: [{ path: 'skills/a/SKILL.md', type: 'blob', mode: '100644', size: 40 }] }));
    if (String(url).startsWith('https://raw.githubusercontent.com/')) return new Response('---\nname: a\ndescription: Alpha\n---\n');
    return new Response('no', { status: 404 });
  };
  await withServer(async (s) => {
    const scan = await s.call('POST', '/api/skills/scan', { url: 'https://github.com/o/r' });
    assert.equal(scan.status, 200);
    assert.equal(scan.json.skills[0].description, 'Alpha');
    const got = await s.call('POST', '/api/skills/fetch', { url: 'https://github.com/o/r', ref: 'main', picks: ['skills/a'] });
    assert.deepEqual(got.json.imported, ['a']);
    assert.ok(seen.every((u) => /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(u)));
  }, { fetch: fetchImpl });
});

test('not signed in: chat and advisor answer not_ready, the rest keeps working', () => withServer(async (s) => {
  process.env.FAKE_CLAUDE = 'loggedout';
  const health = await s.call('GET', '/api/health');
  assert.equal(health.json.claude.loggedIn, false);
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    const c = await s.call('POST', '/api/chat', { projectId: id, message: 'hi' });
    assert.equal(c.status, 503);
    assert.match(c.json.error.message, /claude auth login/);
    const a = await s.call('POST', '/api/advisor', { source: { type: 'text', name: 'x.md', text: 'hello' } });
    assert.equal(a.status, 503);
    assert.equal((await s.call('GET', `/api/projects/${id}`)).status, 200);
  } finally { rmDir(root); }
}));

test('advisor: ids assigned, pins-ready shape, sensitive files and secrets refused, masked on request', () => withServer(async (s) => {
  const dir = tempDir('circle-adv-');
  const log = TRACE();
  process.env.FAKE_CLAUDE_LOG = log;
  try {
    const good = path.join(dir, 'plan.md');
    fs.writeFileSync(good, '# A plan\n\nBuild a thing.\n');
    const r = await s.call('POST', '/api/advisor', { source: { type: 'path', path: good } });
    assert.equal(r.status, 200);
    assert.ok(r.json.summary.length > 10);
    assert.ok(r.json.keep.length && r.json.build.length && r.json.issues.length);
    assert.match(r.json.keep[0].id, /^k1$/);
    assert.match(r.json.issues[0].id, /^i1$/);
    assert.ok(['high', 'medium', 'low'].includes(r.json.issues[0].severity));
    const run = runsOf(log).find((x) => has(x.args, '--json-schema'));
    assert.equal(after(run.args, '--tools'), '');
    assert.ok(has(run.args, '--no-session-persistence') && has(run.args, '--strict-mcp-config'));
    assert.equal(run.env.key, null);

    fs.writeFileSync(path.join(dir, '.env'), 'A=1');
    assert.equal((await s.call('POST', '/api/advisor', { source: { type: 'path', path: path.join(dir, '.env') } })).status, 403);
    assert.equal((await s.call('POST', '/api/advisor', { source: { type: 'path', path: 'relative.md' } })).status, 400);
    assert.equal((await s.call('POST', '/api/advisor', { source: { type: 'path', path: path.join(dir, 'missing.md') } })).status, 404);
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    assert.equal((await s.call('POST', '/api/advisor', { source: { type: 'path', path: path.join(dir, 'bin.dat') } })).status, 400);
    fs.writeFileSync(path.join(dir, 'big.md'), 'x'.repeat(401 * 1024));
    assert.equal((await s.call('POST', '/api/advisor', { source: { type: 'path', path: path.join(dir, 'big.md') } })).status, 413);

    const secretText = 'My key is sk-ant-abcdefghijklmnopqrstuvwxyz0123 done';
    const blocked = await s.call('POST', '/api/advisor', { source: { type: 'text', name: 'n.md', text: secretText } });
    assert.equal(blocked.status, 400);
    assert.ok(blocked.json.error.detail.secrets.length >= 1);
    assert.ok(!JSON.stringify(blocked.json).includes('abcdefghijklmnopqrstuvwxyz0123'));
    process.env.FAKE_CLAUDE = 'echo-input';
    const masked = await s.call('POST', '/api/advisor', { source: { type: 'text', name: 'n.md', text: secretText }, redact: true });
    assert.equal(masked.status, 200);
    assert.ok(!masked.json.summary.includes('abcdefghijklmnopqrstuvwxyz0123'), 'the secret never reached the CLI');
    assert.ok(masked.json.summary.includes('sk-a…'));
  } finally { rmDir(dir); }
}));

test('permissions: read-only by default; each permission gates exactly what it names', () => withServer(async (s) => {
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root })).json.project.id;
    const got = (await s.call('GET', `/api/projects/${id}`)).json;
    assert.deepEqual(got.project.permissions, { write: false, run: false, claude: false });
    assert.ok(got.team.roles.length, 'reading works without any permission');
    const ops = [{ op: 'model', role: 'planner', model: 'opus' }];
    const noWrite = await s.call('POST', '/api/changes/preview', { projectId: id, ops });
    assert.equal(noWrite.status, 403);
    assert.equal(noWrite.json.error.detail.permission, 'write');
    const noClaude = await s.call('POST', '/api/chat', { projectId: id, message: 'hi' });
    assert.equal(noClaude.status, 403);
    assert.equal((await s.call('POST', '/api/advisor', { source: { type: 'project', projectId: id, path: 'models.json' } })).status, 403);

    assert.equal((await s.call('PUT', `/api/projects/${id}/permissions`, { permissions: { write: true } })).json.project.permissions.write, true);
    const pv = await s.call('POST', '/api/changes/preview', { projectId: id, ops });
    assert.equal(pv.status, 200);
    assert.equal(pv.json.commands.length, 0);
    assert.equal((await s.call('POST', '/api/chat', { projectId: id, message: 'hi' })).status, 403, 'write does not imply claude');
    assert.equal((await s.call('PUT', '/api/projects/template/permissions', { permissions: ALL })).status, 404);
  } finally { rmDir(root); }
}));

test('running scripts is its own permission: without it the agent line is edited directly', () => withServer(async (s) => {
  const root = makeMiniProject();
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'apply-models.mjs'), 'process.exit(0)');
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true } })).json.project.id;
    const pv = await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'model', role: 'planner', model: 'opus' }] });
    assert.equal(pv.json.commands.length, 0);
    assert.ok(pv.json.warnings.some((w) => /Running project scripts is off/.test(w)));
    assert.equal(pv.json.files.find((f) => f.path.endsWith('planner.md')).via, 'app');
  } finally { rmDir(root); }
}));

test('stats: per-project numbers, activity days, live session, running list', () => withServer(async (s) => {
  const root = makeMiniProject();
  const now = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00.000+00:00`;
  const yesterday = new Date(now.getTime() - 86400000);
  fs.writeFileSync(path.join(root, '.claude/state/activity.jsonl'), [
    { ts: iso(yesterday), event: 'PreToolUse', agent: 'fe-builder', summary: 'Edit a.ts' },
    { ts: iso(now), event: 'PreToolUse', agent: 'be-builder', summary: 'Bash: node x sk-ant-abcdefghijklmnopqrstuvwxyz0123' },
    { ts: iso(now), event: 'PostToolUse', agent: 'be-builder', summary: 'done' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    process.env.FAKE_CLAUDE = 'slow';
    const chat = s.sse('/api/chat', { projectId: id, message: 'wait' });
    for (let i = 0; i < 100 && !s.app.sessions.isBusy(id); i++) await new Promise((r) => setTimeout(r, 50));
    const st = (await s.call('GET', '/api/stats')).json;
    const p = st.projects[0];
    assert.equal(p.roles, 2);
    assert.deepEqual([p.tiers.opus, p.tiers.sonnet, p.tiers.haiku], [0, 1, 1]);
    assert.equal(p.adr.proposed, 1);
    assert.equal(p.adr.accepted, 1);
    assert.equal(p.activity.days.length, 14);
    assert.equal(p.activity.total, 3);
    assert.equal(p.activity.live, true);
    assert.equal(p.activity.byAgent[0].agent, 'be-builder');
    assert.ok(!JSON.stringify(st).includes('abcdefghijklmnopqrstuvwxyz0123'));
    assert.ok(st.running.some((r) => r.source === 'circle' && r.kind === 'chat' && r.projectId === id));
    assert.ok(st.running.some((r) => r.source === 'team' && r.agent === 'be-builder'));
    assert.equal(st.totals.projects, 1);
    await s.call('POST', '/api/chat/stop', { projectId: id });
    await chat;
  } finally { rmDir(root); }
}));

test('folder picker answers with a path or null; nothing is registered by picking', () => withServer(async (s) => {
  const r = await s.call('POST', '/api/system/pick-folder', {});
  assert.equal(r.status, 200);
  assert.ok(r.json.path === null || typeof r.json.path === 'string');
  assert.equal((await s.call('GET', '/api/projects')).json.projects.length, 0);
}, { pickFolder: async () => ({ path: null }) }));
