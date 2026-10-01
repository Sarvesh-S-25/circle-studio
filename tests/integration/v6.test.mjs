// Through the real HTTP routes: connections and the security check, a key moved from .mcp.json into the vault (and
// handed to the engine run), the catalog (describe with the fake Haiku, index a page), the helper reading the folder,
// the widget board settings, agent states in the pulse, and use per provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';
import { TRACE, runsOf } from '../helpers/trace.mjs';

const ALL = { write: true, run: true, claude: true };
const SECRET = 'mcp-literal-secret-0123456789';

test('connections, vault, catalog, helper digest, widgets, usage', async () => {
  const log = TRACE();
  process.env.FAKE_CLAUDE_LOG = log;
  const page = `<html><head><title>Payments guide</title></head><body><p>Intro</p><p>Refunds must be issued within 14 days through the refunds endpoint.</p></body></html>`;
  const fetchStub = async (url) => (String(url).startsWith('https://docs.example.test/') ? new Response(page, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('no', { status: 404 }));
  const s = await startServer({ fetch: fetchStub });
  const root = makeMiniProject();
  try {
    fs.writeFileSync(path.join(root, '.mcp.json'), `${JSON.stringify({ mcpServers: { pay: { command: 'node', args: ['pay.js'], env: { PAY_API_KEY: SECRET } } } }, null, 2)}\n`);
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;

    // connections: the server, its plain-text key found, never the value
    const cx = (await s.call('GET', `/api/connections?projectId=${id}`)).json;
    assert.deepEqual(cx.servers.map((x) => x.id), ['claude:project:pay']);
    assert.ok(!JSON.stringify(cx).includes(SECRET));
    const f = cx.findings.find((x) => x.id === 'plain:claude:project:pay');
    assert.equal(f.fix, 'vault');
    assert.equal((await s.call('POST', '/api/connections/check', { id: 'claude:project:pay', projectId: id })).json.health.status, 'ok', 'node is on PATH');
    assert.ok((await s.call('GET', '/api/security')).json.findings.some((x) => x.projectId === id));

    // move it into the vault, then .mcp.json reads ${PAY_API_KEY} after the reviewed change
    const imp = (await s.call('POST', '/api/vault/import', { projectId: id, server: 'pay', field: 'env', key: 'PAY_API_KEY', name: 'TEST_VAULT_KEY' })).json;
    assert.deepEqual(imp.op, { op: 'mcp-env-ref', server: 'pay', field: 'env', key: 'PAY_API_KEY', ref: 'TEST_VAULT_KEY' });
    assert.deepEqual((await s.call('GET', '/api/vault')).json.keys.map((k) => k.name), ['TEST_VAULT_KEY']);
    assert.ok(!fs.readFileSync(path.join(s.dataDir, 'vault.json'), 'utf8').includes(SECRET), 'encrypted at rest');
    const prev = (await s.call('POST', '/api/changes/preview', { projectId: id, ops: [imp.op] })).json;
    assert.ok(!JSON.stringify(prev).includes(SECRET), 'the diff hides the key');
    await s.call('POST', '/api/changes/apply', { id: prev.id });
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.pay.env.PAY_API_KEY, '${TEST_VAULT_KEY}');
    assert.equal((await s.call('GET', `/api/connections?projectId=${id}`)).json.findings.filter((x) => x.id.startsWith('plain:')).length, 0);
    assert.equal((await s.call('PUT', '/api/vault/ANTHROPIC_API_KEY', { value: 'x', projects: 'all' })).status, process.platform === 'win32' ? 400 : 400);

    // an engine run in this project gets the key as an environment variable
    if (process.platform === 'win32') {
      await s.sse('/api/chat', { projectId: id, message: 'hi' });
      const run = runsOf(log).find((r) => r.prompt === 'hi');
      assert.equal(run.env.vault, SECRET, 'the vault key reaches the engine run');
      assert.equal(run.env.key, null, 'and an API key still never does');
    }

    // catalog: built from the project's agents, described by the (fake) Haiku, a page indexed and retrieved
    const cat = (await s.call('GET', '/api/catalog')).json;
    assert.ok(cat.counts.agent >= 2, "the project and template agents");
    const d = (await s.call('POST', '/api/catalog/describe', {})).json;
    assert.ok(d.described >= 1);
    const ix = (await s.call('POST', '/api/catalog/index', { url: 'https://docs.example.test/payments' })).json;
    assert.equal(ix.entry.name, 'Payments guide');
    assert.equal((await s.call('POST', '/api/catalog/index', { url: 'http://docs.example.test/x' })).status, 400, 'https only');
    assert.equal((await s.call('POST', '/api/catalog/index', { url: 'https://127.0.0.1/x' })).status, 400, 'never the local network');
    assert.equal((await s.call('GET', '/api/catalog?q=planner')).json.entries[0].name, 'planner');

    // the helper reads the folder, the building blocks and the matching passages
    await s.call('POST', `/api/projects/${id}/workflow/suggest`, { message: 'How long do we have to issue refunds? plan it' });
    const helper = runsOf(log).find((r) => String(r.prompt || '').startsWith('CIRCLE-WORKFLOW-HELPER'));
    assert.match(helper.prompt, /The project folder \(read just now\)/);
    assert.match(helper.prompt, /Building blocks the human already has/);
    assert.match(helper.prompt, /within 14 days/, 'the indexed passage is retrieved');

    // widget board: saved, validated
    assert.equal((await s.call('PUT', '/api/settings', { widgets: [{ kind: 'status', size: 's', projectId: id }, { kind: 'spend', size: 'l' }] })).json.settings.widgets.length, 2);
    assert.equal((await s.call('PUT', '/api/settings', { widgets: [{ kind: 'clock', size: 's' }] })).status, 400);
    assert.equal((await s.call('PUT', '/api/settings', { widgets: [{ kind: 'spend', size: 'xl' }] })).status, 400);
    const pulse = (await s.call('GET', `/api/projects/${id}/pulse`)).json;
    assert.equal(pulse.agents[0].title, 'Main session');
    assert.ok(pulse.agents.every((a) => ['working', 'waiting', 'done', 'idle'].includes(a.state)));
    assert.ok(pulse.workflow.stages.every((x) => typeof x.state === 'string'));
    const u = (await s.call('GET', '/api/usage?days=7')).json;
    assert.deepEqual(u.providers.map((p) => p.id), ['claude', 'codex', 'gemini', 'copilot']);
    assert.equal(u.providers.find((p) => p.id === 'claude').measured, 'usd');
    assert.equal((await s.call('POST', '/api/desktop/open', { kind: 'tile', tile: { kind: 'clock', size: 's' } })).status, 400);
  } finally {
    delete process.env.FAKE_CLAUDE_LOG;
    await s.close();
    rmDir(root);
  }
});
