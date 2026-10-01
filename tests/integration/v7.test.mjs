// Connection repair with a fake MCP server (a real process, real handshake), the desktop widgets' feed, and the
// desktop host's start command. Temp folders and fake homes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';
import { buildFeed } from '../../backend/lib/feed.mjs';
import { readPalette } from '../../backend/lib/palette.mjs';
import { desktopWidgets, hostCommand } from '../../backend/lib/deskhost.mjs';
import { diagnose, recreateCommands, expand } from '../../backend/lib/mcpprobe.mjs';

const ALL = { write: true, run: true, claude: true };
const FAKE_MCP = path.resolve(import.meta.dirname, '..', 'helpers', 'fake-mcp.mjs');

test('connections: test for real, diagnose, Claude fixes the config through the review, test again', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  try {
    fs.copyFileSync(FAKE_MCP, path.join(root, 'fake-mcp.mjs'));
    const cfg = (mode) => `${JSON.stringify({ mcpServers: { tools: { command: 'node', args: ['fake-mcp.mjs', mode], env: { FAKE_MCP_KEY: '${FAKE_MCP_KEY}' } } } }, null, 2)}\n`;
    fs.writeFileSync(path.join(root, '.mcp.json'), cfg('crash'));
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;

    // the key it reads is missing, and it crashes on a missing module
    let t = (await s.call('POST', '/api/connections/test', { id: 'claude:project:tools', projectId: id })).json;
    assert.equal(t.result.ok, false);
    assert.equal(t.result.error, 'exited');
    const causes = t.diagnosis.map((d) => d.cause).join(' ');
    assert.match(causes, /FAKE_MCP_KEY is not set/);
    assert.match(causes, /cannot find the module "fastapi"/);
    assert.match(t.output, /ModuleNotFoundError/);

    // Claude proposes a config fix; it goes through the usual diff and the test passes afterwards
    const f = (await s.call('POST', '/api/connections/fix', { id: 'claude:project:tools', projectId: id })).json;
    assert.match(f.summary, /missing its Python package/);
    assert.deepEqual(f.codebase, [{ file: 'pyproject.toml', advice: 'List fastapi under dependencies.' }]);
    assert.deepEqual(f.op, { op: 'mcp-server-set', server: 'tools', command: 'node', args: ['fake-mcp.mjs', 'ok'] });
    const prev = (await s.call('POST', '/api/changes/preview', { projectId: id, ops: [f.op] })).json;
    await s.call('POST', '/api/changes/apply', { id: prev.id });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.tools.args, ['fake-mcp.mjs', 'ok']);
    assert.equal((await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'mcp-server-set', server: 'tools', command: 'node & calc' }] })).status, 400, 'no shell symbols');

    // with the key in the vault it starts, answers the handshake, lists its tools, and the key reached it
    await s.call('PUT', '/api/vault/FAKE_MCP_KEY', { value: 'k-123', projects: [id] });
    t = (await s.call('POST', '/api/connections/test', { id: 'claude:project:tools', projectId: id })).json;
    assert.equal(t.result.ok, true, JSON.stringify(t.diagnosis));
    assert.deepEqual(t.result.tools, ['search', 'open_app']);
    assert.equal(t.result.serverInfo.version, 'with-key');
    assert.ok(!JSON.stringify(t).includes('k-123'));
  } finally {
    await s.close();
    for (let i = 0; i < 20; i++) { try { rmDir(root); break; } catch { await new Promise((r) => setTimeout(r, 250)); } } // the probed server may still be closing
  }
});

test('diagnosis: a working twin elsewhere gives the exact commands, never a key', () => {
  const server = { id: 'claude:local: a:stitch', name: 'stitch', engine: 'claude', scope: 'local: a', folder: 'C:/work/a', transport: 'stdio' };
  const twin = { id: 'claude:local: b:stitch', transport: 'stdio' };
  const cmds = recreateCommands(server, twin, { command: 'npx', args: ['-y', '@acme/stitch', 'proxy', 'sk-abcdefghijklmnopqrstuvwxyz123456'], env: { STITCH_API_KEY: 'secret-value' } });
  assert.deepEqual(cmds.slice(0, 2), ['cd "C:/work/a"', 'claude mcp remove stitch -s local']);
  assert.match(cmds[2], /^claude mcp add stitch -s local -e STITCH_API_KEY=\$env:STITCH_API_KEY -- npx -y @acme\/stitch proxy <secret>$/);
  assert.ok(!cmds.join(' ').includes('secret-value'));
  const d = diagnose({ server, raw: { command: '\\' }, probe: null, launch: { error: 'empty' }, twins: [{ where: 'in b', cmds }] });
  assert.match(d[0].cause, /set up correctly in b/);
  const missing = new Set();
  assert.equal(expand('Bearer ${TOKEN}', {}, missing), 'Bearer ');
  assert.deepEqual([...missing], ['TOKEN']);
  assert.equal(expand('${A:-fallback}', {}, new Set()), 'fallback');
});

test('desktop widgets: the feed draws every tile from tokens.css colours, and the host starts through wscript', () => {
  const pulse = { project: { id: 'p', name: 'Shop', exists: true }, agents: [{ id: null, title: 'Main session', state: 'working', contextPct: 40 }, { id: 'rev', title: 'code-reviewer', state: 'waiting' }], workflow: { version: '1.0.0', agents: 2, stages: [{ title: 'Plan', state: 'done' }, { title: 'Build', state: 'working' }] }, repo: { isRepo: true, branch: 'main', ahead: 2, changed: 0 }, stats: { attention: [] }, lastConversation: null };
  const usage = { providers: [{ id: 'claude', label: 'Claude', measured: 'usd', usd: 1234.5, tokensIn: 100, tokensOut: 10, byDay: [{ usd: 1 }, { usd: 3 }] }, { id: 'codex', label: 'Codex', measured: 'tokens', tokensIn: 50, tokensOut: 5 }, { id: 'gemini', label: 'Gemini', measured: 'turns', turns: 2 }], claudeFolders: [{ name: 'shop', usd: 1000 }] };
  const feed = buildFeed({
    tiles: [{ kind: 'status', size: 'm', projectId: 'p' }, { kind: 'spend', size: 'l' }, { kind: 'workflow', size: 'm', projectId: 'p' }, { kind: 'inbox', size: 's' }, { kind: 'overview', size: 'm', desktop: false }],
    pulseOf: () => pulse, usage, stats: null, pending: [{ title: 'Run npm test?', projectId: 'p', kind: 'approval' }], alerts: [], nameOf: () => 'Shop', palette: readPalette(path.resolve(import.meta.dirname, '..', '..'), 'dark'), defaultProject: 'p',
  });
  assert.deepEqual(feed.tiles.map((t) => t.key), ['status:m:p:1', 'spend:l:-:1', 'workflow:m:p:1', 'inbox:s:-:1'], 'tiles kept off the desktop are left out');
  assert.equal(feed.tiles[0].rings[0].state, 'waiting', 'what waits for you comes first');
  assert.equal(feed.tiles[0].rings[1].label, 'MS');
  assert.equal(feed.tiles[1].big, '$1.2k');
  assert.deepEqual(feed.tiles[1].bars, [33, 100]);
  assert.equal(feed.tiles[2].sub, 'Build: working');
  assert.equal(feed.tiles[3].big, '1');
  assert.match(feed.palette.ok, /^#[0-9a-f]{6}$/i);
  const cmd = hostCommand({ appRoot: 'C:/app', port: 4380, dataDir: 'C:/app/data' });
  assert.match(cmd.file, /wscript\.exe$/i);
  assert.deepEqual(cmd.args.slice(1), ['4380', 'C:/app/data']);
  const calls = [];
  const host = desktopWidgets({ appRoot: 'C:/app', port: 4380, dataDir: fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'cs-dw-')) }, { spawnImpl: (f, a) => { calls.push([f, a]); return { on() {}, unref() {} }; } });
  const r = host.start();
  if (process.platform === 'win32') { assert.equal(r.started, true); assert.equal(calls.length, 1); } else assert.match(r.error, /Windows/);
  assert.equal(host.status().running, false, 'nothing really started in the test');
});
