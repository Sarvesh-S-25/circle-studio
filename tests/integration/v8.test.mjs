// The connection manager on a fake home: redundant copies, a broken copy repaired from its working twin (the key moved
// to the environment and the vault, the config reading ${NAME}), one shared server, a pasted key, and a failed step
// that puts ~/.claude.json back. `claude mcp` is simulated on the fake ~/.claude.json; nothing real is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';
import { analyze, makePlan, secretsOf, withRefs } from '../../backend/lib/mcpmanage.mjs';

const FAKE_MCP = path.resolve(import.meta.dirname, '..', 'helpers', 'fake-mcp.mjs');

/** A stand-in for `claude mcp add-json/remove` that edits the fake ~/.claude.json the way the real CLI does. */
function fakeClaudeMcp(claudeJson, calls, { failOn } = {}) {
  return async (args, cwd) => {
    calls.push({ args, cwd });
    if (failOn && args[1] === failOn) return { code: 1, stdout: '', stderr: 'simulated failure' };
    const j = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    const [, verb, name] = args;
    const scope = args[args.indexOf('-s') + 1];
    const bucket = scope === 'user' ? (j.mcpServers ||= {}) : ((j.projects[cwd.split(path.sep).join('/')] ||= {}).mcpServers ||= {});
    if (verb === 'remove') delete bucket[name];
    if (verb === 'add-json') bucket[name] = JSON.parse(args[3]);
    fs.writeFileSync(claudeJson, JSON.stringify(j, null, 2));
    return { code: 0, stdout: `${verb} ${name} done`, stderr: '' };
  };
}

test('manager: secrets become ${NAME}; plans name keys, never values', () => {
  const raw = { command: 'npx', args: ['x'], env: { STITCH_API_KEY: 'sv-1234567890', MODE: 'fast' } };
  assert.deepEqual(secretsOf(raw).map((s) => [s.name, s.literal]), [['STITCH_API_KEY', 'sv-1234567890']]);
  assert.deepEqual(withRefs(raw), { type: 'stdio', command: 'npx', args: ['x'], env: { STITCH_API_KEY: '${STITCH_API_KEY}', MODE: 'fast' } });
  assert.deepEqual(withRefs({ url: 'https://x.test/mcp', headers: { Authorization: 'Bearer abc' } }).headers, { Authorization: 'Bearer ${AUTHORIZATION}' });
  const servers = [
    { id: 'claude:local: a:s', name: 's', engine: 'claude', scope: 'local: a', folder: 'C:/gone', transport: 'stdio', command: 'node', argsText: '', plainSecrets: [], envNames: [], headerNames: [], file: '~/.claude.json' },
  ];
  const g = analyze(servers, { exists: () => false });
  assert.equal(g[0].findings[0].kind, 'stale');
  const plan = makePlan(g[0].findings[0].action, { servers, rawOf: () => ({}), projectIdFor: () => null });
  assert.equal(plan.steps[0].run.kind, 'drop-local', 'a folder that is gone is cleaned in the file');
});

test('manager: repair from a twin, share copies, paste a key, and roll back a failed step', async () => {
  const s = await startServer();
  const home = s.app.config.userHome;
  const a = tempDir('cs-a-');
  const b = tempDir('cs-b-');
  const c = tempDir('cs-c-');
  const key = (p) => p.split(path.sep).join('/');
  try {
    const claudeJson = path.join(home, '.claude.json');
    fs.mkdirSync(home, { recursive: true });
    const good = { type: 'stdio', command: process.execPath, args: [FAKE_MCP, 'needkey'], env: { FAKE_MCP_KEY: 'k-live-123456' } };
    fs.writeFileSync(claudeJson, JSON.stringify({ projects: { [key(a)]: { mcpServers: { tools: { command: '\\' } } }, [key(b)]: { mcpServers: { tools: good } }, [key(c)]: { mcpServers: { tools: good } }, 'C:/no/such/folder': { mcpServers: { tools: good } } } }, null, 2));
    const calls = [];
    const envSet = [];
    s.app.overrides.runClaude = fakeClaudeMcp(claudeJson, calls);
    s.app.overrides.setUserEnv = (n, v) => { envSet.push([n, v]); process.env[n] = v; };

    const groups = (await s.call('GET', '/api/connections/manage')).json.groups;
    const kinds = groups[0].findings.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ['broken', 'duplicate', 'plain', 'stale']);
    assert.ok(!JSON.stringify(groups).includes('k-live-123456'));

    // the background watch announces a newly broken connection once, not on every check
    assert.equal((await s.app.watchConnections()).length, 1);
    assert.equal((await s.app.watchConnections()).length, 0);

    // repair the broken copy in a from its twin
    const broken = groups[0].findings.find((f) => f.kind === 'broken');
    const plan = (await s.call('POST', '/api/connections/plan', { action: broken.action })).json;
    assert.ok(!JSON.stringify(plan).includes('k-live-123456'), 'the preview names the key, never shows it');
    assert.match(plan.steps.map((x) => x.text).join(" "), /Save the key already used in .* as FAKE_MCP_KEY/);
    const done = (await s.call('POST', '/api/connections/apply', { id: plan.id })).json;
    assert.equal(done.ok, true, JSON.stringify(done.results));
    assert.deepEqual(envSet, [['FAKE_MCP_KEY', 'k-live-123456']], 'the key went to the user environment');
    assert.deepEqual((await s.call('GET', '/api/vault')).json.keys.map((k) => k.name), ['FAKE_MCP_KEY'], 'and to the vault');
    const after = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    assert.equal(after.projects[key(a)].mcpServers.tools.env.FAKE_MCP_KEY, '${FAKE_MCP_KEY}', 'the config reads it by name');
    assert.equal(done.tests[0].result.ok, true, 'and the repaired server starts and answers');
    assert.ok(fs.readdirSync(path.join(s.dataDir, 'backups')).some((f) => f.startsWith('claude.json.')), 'backed up first');
    assert.equal((await s.call('POST', '/api/connections/apply', { id: plan.id })).status, 404, 'a plan runs once');

    // a failed step puts the file back
    const before = fs.readFileSync(claudeJson, 'utf8');
    s.app.overrides.runClaude = fakeClaudeMcp(claudeJson, calls, { failOn: 'add-json' });
    const share = (await s.call('GET', '/api/connections/manage')).json.groups[0].findings.find((f) => f.kind === 'duplicate');
    const p2 = (await s.call('POST', '/api/connections/plan', { action: share.action })).json;
    const r2 = (await s.call('POST', '/api/connections/apply', { id: p2.id })).json;
    assert.equal(r2.ok, false);
    assert.match(r2.results.at(-1).text, /back as it was/);
    assert.equal(fs.readFileSync(claudeJson, 'utf8'), before, 'nothing left half changed');

    // a pasted key goes to the environment and the config names it
    s.app.overrides.runClaude = fakeClaudeMcp(claudeJson, calls);
    const p3 = (await s.call('POST', '/api/connections/plan', { action: { kind: 'key', id: `claude:local: ${path.basename(b)}:tools`, field: 'env', key: 'FAKE_MCP_KEY', value: 'k-new-999999', target: 'env' } })).json;
    assert.ok(!JSON.stringify(p3).includes('k-new-999999'));
    assert.equal((await s.call('POST', '/api/connections/apply', { id: p3.id })).json.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[key(b)].mcpServers.tools.env.FAKE_MCP_KEY, '${FAKE_MCP_KEY}');
    assert.equal((await s.call('POST', '/api/connections/plan', { action: { kind: 'key', id: `claude:local: ${path.basename(b)}:tools`, field: 'env', key: 'X', value: 'sk-ant-api03-abcdefghij', target: 'env' } })).status, 400, 'never an Anthropic key');
  } finally {
    delete process.env.FAKE_MCP_KEY;
    await s.close();
    for (const d of [a, b, c]) rmDir(d);
  }
});
