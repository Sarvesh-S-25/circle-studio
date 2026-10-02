// A project's tools and skills, through the real routes on a fake home: servers a plugin brings are seen (and never
// changed), a hand-made copy of one is flagged, adding a tool the project already has is refused unless forced, a tool
// is added with a saved key (config names it, the environment holds it, the test proves it starts), .mcp.json gets and
// loses a server only through the review, and skills are found on a stubbed GitHub for the workflow's agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';

const FAKE_MCP = path.resolve(import.meta.dirname, '..', 'helpers', 'fake-mcp.mjs');
const ALL = { write: true, run: true, claude: true };
const key = (p) => p.split(path.sep).join('/');

/** `claude mcp add-json/remove` on the fake ~/.claude.json, the way the real CLI does it. */
function fakeClaudeMcp(claudeJson, calls) {
  return async (args, cwd) => {
    calls.push({ args, cwd });
    const j = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
    const [, verb, name] = args;
    const scope = args[args.indexOf('-s') + 1];
    const bucket = scope === 'user' ? (j.mcpServers ||= {}) : (((j.projects ||= {})[key(cwd)] ||= {}).mcpServers ||= {});
    if (verb === 'remove') delete bucket[name];
    if (verb === 'add-json') bucket[name] = JSON.parse(args[3]);
    fs.writeFileSync(claudeJson, JSON.stringify(j, null, 2));
    return { code: 0, stdout: `${verb} ${name} done`, stderr: '' };
  };
}

function writePlugin(home) {
  const plugins = path.join(home, '.claude', 'plugins');
  const pw = path.join(plugins, 'cache', 'market', 'pw', '1.0.0');
  fs.mkdirSync(path.join(pw, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pw, 'skills', 'frontend-design'), { recursive: true });
  fs.writeFileSync(path.join(pw, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'pw', description: 'Browser automation' }));
  fs.writeFileSync(path.join(pw, '.mcp.json'), JSON.stringify({ playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } }));
  fs.writeFileSync(path.join(pw, 'skills', 'frontend-design', 'SKILL.md'), '---\nname: frontend-design\ndescription: x\n---\n');
  const outside = path.join(home, 'elsewhere');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, '.mcp.json'), JSON.stringify({ sneaky: { command: 'node' } }));
  fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'pw@market': [{ scope: 'user', installPath: pw }], 'bad@market': [{ scope: 'user', installPath: outside }], 'off@market': [{ scope: 'user', installPath: pw }] } }));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'pw@market': true, 'bad@market': true, 'off@market': false } }));
}

test('tools: plugins are seen, duplicates refused, a tool added with a saved key, .mcp.json through the review', async () => {
  const s = await startServer();
  const home = s.app.config.userHome;
  const root = makeMiniProject();
  try {
    fs.mkdirSync(home, { recursive: true });
    writePlugin(home);
    const claudeJson = path.join(home, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { 'pw-copy': { command: 'npx', args: ['-y', '@playwright/mcp'] } }, projects: {} }, null, 2));
    const calls = [];
    const envSet = [];
    s.app.overrides.runClaude = fakeClaudeMcp(claudeJson, calls);
    s.app.overrides.setUserEnv = (n, v) => { envSet.push([n, v]); process.env[n] = v; };
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;

    // a plugin's server is listed for the project; one outside ~/.claude/plugins and a turned-off one are not
    const servers = (await s.call('GET', `/api/connections?projectId=${id}`)).json.servers;
    const ids = servers.map((x) => x.id);
    assert.ok(ids.includes('claude:plugin: pw:playwright'), ids.join(', '));
    assert.ok(!ids.some((x) => /sneaky/.test(x)), 'never reads a plugin folder outside ~/.claude/plugins');
    assert.equal(ids.filter((x) => x.includes('playwright')).length, 1, 'a turned-off plugin brings nothing');

    // the manager: the hand-made copy is "already comes with the plugin"; the plugin copy itself is never changed
    const groups = (await s.call('GET', '/api/connections/manage')).json.groups;
    const covered = groups.find((g) => g.name === 'pw-copy').findings.find((f) => f.kind === 'covered');
    assert.match(covered.title, /plugin "pw"/);
    assert.deepEqual(covered.action.ids, ['claude:user:pw-copy']);
    const refuse = await s.call('POST', '/api/connections/plan', { action: { kind: 'remove', ids: ['claude:plugin: pw:playwright'] } });
    assert.equal(refuse.status, 400);
    assert.match(refuse.json.error.message, /comes with/);

    // adding the same server again (other name, same command) is refused with what already provides it
    const dup = await s.call('POST', '/api/connections/plan', { projectId: id, action: { kind: 'add', name: 'browser', setup: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] } } });
    assert.equal(dup.status, 400);
    assert.deepEqual(dup.json.error.detail.duplicates.map((d) => d.id).sort(), ['claude:plugin: pw:playwright', 'claude:user:pw-copy']);
    assert.equal((await s.call('POST', '/api/connections/plan', { projectId: id, action: { kind: 'add', name: 'browser', setup: { command: 'npx', args: ['@playwright/mcp'] }, force: true } })).status, 200, 'unless the human insists');

    if (process.platform === 'win32') {
      // a new tool with a saved key: the config names it, the environment gets it, and it starts
      await s.call('PUT', '/api/vault/FAKE_MCP_KEY', { value: 'k-saved-424242', projects: 'all' });
      const plan = await s.call('POST', '/api/connections/plan', { projectId: id, action: { kind: 'add', name: 'tools', setup: { command: process.execPath, args: [FAKE_MCP, 'needkey'] }, key: { name: 'FAKE_MCP_KEY', slot: 'FAKE_MCP_KEY' } } });
      assert.equal(plan.status, 200, JSON.stringify(plan.json));
      assert.ok(!JSON.stringify(plan.json).includes('k-saved-424242'));
      const done = (await s.call('POST', '/api/connections/apply', { id: plan.json.id })).json;
      assert.equal(done.ok, true, JSON.stringify(done.results));
      assert.deepEqual(envSet, [['FAKE_MCP_KEY', 'k-saved-424242']], 'the saved key went to the environment');
      assert.equal(JSON.parse(fs.readFileSync(claudeJson, 'utf8')).projects[key(root)].mcpServers.tools.env.FAKE_MCP_KEY, '${FAKE_MCP_KEY}');
      assert.equal(done.tests[0].result.ok, true, 'and the new tool starts and answers');
      assert.ok(!JSON.stringify(done).includes('k-saved-424242'));
      assert.equal((await s.call('POST', '/api/connections/plan', { projectId: id, action: { kind: 'add', name: 'x', setup: { command: 'node' }, key: { name: 'NOT_SAVED' } } })).status, 400, 'a saved key that does not exist');
    }

    // .mcp.json: added (a key only by name) and removed, each through the review
    const p2 = (await s.call('POST', '/api/connections/plan', { projectId: id, action: { kind: 'add', name: 'shared', scope: 'project', setup: { url: 'https://mcp.example.test/mcp' }, key: { name: 'SHARED_TOKEN', value: 'tok-123456789', slot: 'Authorization' } } })).json;
    assert.deepEqual(p2.ops, [{ op: 'mcp-server-add', server: 'shared', config: { url: 'https://mcp.example.test/mcp', headers: { Authorization: 'Bearer ${SHARED_TOKEN}' }, type: 'http' } }]);
    const prev = (await s.call('POST', '/api/changes/preview', { projectId: id, ops: p2.ops })).json;
    await s.call('POST', '/api/changes/apply', { id: prev.id });
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.shared.headers.Authorization, 'Bearer ${SHARED_TOKEN}');
    const literal = await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'mcp-server-add', server: 'leak', config: { command: 'node', env: { API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz012345' } } }] });
    assert.equal(literal.status, 400, 'never a literal key in .mcp.json');
    const rm = (await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'mcp-server-remove', server: 'shared' }] })).json;
    await s.call('POST', '/api/changes/apply', { id: rm.id });
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.shared, undefined);

    // nothing Circle Studio wrote (its data folder, the backups, the logs, the project) holds a key in plain text
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of [...walk(s.dataDir), ...walk(root), claudeJson]) {
      const text = fs.readFileSync(f, 'utf8');
      for (const secret of ['k-saved-424242', 'tok-123456789']) assert.ok(!text.includes(secret), `${path.basename(f)} holds a key in plain text`);
    }
  } finally {
    delete process.env.FAKE_MCP_KEY;
    delete process.env.SHARED_TOKEN;
    await s.close();
    rmDir(root);
  }
});

test('manager: a project copy identical to the shared server is extra; one with its own key is not', async () => {
  const { analyze } = await import('../../backend/lib/mcpmanage.mjs');
  const base = { engine: 'claude', transport: 'stdio', command: process.execPath, argsText: 'srv.js', plainSecrets: [], headerNames: [], file: '~/.claude.json' };
  const servers = [
    { ...base, id: 'claude:user:s', name: 's', scope: 'user', envNames: [] },
    { ...base, id: 'claude:local: a:s', name: 's', scope: 'local: a', folder: process.cwd(), envNames: [] },
    { ...base, id: 'claude:local: b:s', name: 's', scope: 'local: b', folder: process.cwd(), envNames: ['OWN_KEY'] },
  ];
  const f = analyze(servers, { exists: () => true })[0].findings.find((x) => x.kind === 'redundant');
  assert.deepEqual(f.action.ids, ['claude:local: a:s']);
});

test("let's begin: each engine says how to get it going; Do it for me runs only the fixed command", async () => {
  const s = await startServer();
  try {
    const engines = (await s.call('GET', '/api/engines')).json.engines;
    const claude = engines.find((e) => e.id === 'claude');
    assert.equal(claude.setup.install, 'npm install -g @anthropic-ai/claude-code');
    assert.equal(claude.setup.login, 'claude auth login');
    const spawned = [];
    s.app.overrides.spawnTerminal = (file, args) => { spawned.push({ file, args }); return { on() {}, unref() {} }; };
    assert.equal((await s.call('POST', '/api/engines/terminal', { engine: 'codex', step: 'login' })).json.command, 'codex login');
    const script = Buffer.from(spawned[0].args[1], 'base64').toString('utf16le');
    assert.match(spawned[0].file, /wscript\.exe$/i);
    assert.match(spawned[0].args[0], /open-terminal\.vbs$/);
    assert.match(script, /; codex login;/, 'the fixed command, nothing else');
    assert.match(spawned[0].args[1], /^[A-Za-z0-9+/=]+$/, 'what the launcher accepts');
    assert.equal((await s.call('POST', '/api/engines/terminal', { engine: 'codex', step: 'rm -rf' })).status, 400);
    assert.equal((await s.call('POST', '/api/engines/terminal', { engine: 'openclaw', step: 'install' })).status, 400);
    assert.equal((await s.call('POST', '/api/engines/terminal', { engine: 'gemini', step: 'install' })).status, 400, 'Antigravity is installed from its page, not a command');
    assert.equal(spawned.length, 1);
  } finally {
    await s.close();
  }
});

/** A tiny GitHub: two collections, one search answer. Records what was asked. */
function fakeGithub(seen, { searchFails = false } = {}) {
  const fm = (name, d) => `---\nname: ${name}\ndescription: ${d}\n---\n# ${name}\n`;
  const trees = {
    'anthropics/skills': ['skills/pdf/SKILL.md', 'skills/webapp-testing/SKILL.md'],
    'acme/react-skills': ['react-testing/SKILL.md', 'react-testing/examples.md', 'design/SKILL.md'],
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '50' } });
  return async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.startsWith('https://api.github.com/search/repositories')) {
      if (searchFails) return new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
      return json({ items: [{ full_name: 'acme/react-skills', html_url: 'https://github.com/acme/react-skills', stargazers_count: 1200, pushed_at: '2026-09-30T00:00:00Z', description: 'React skills', archived: false, fork: false }] });
    }
    for (const [repo, files] of Object.entries(trees)) {
      if (u === `https://api.github.com/repos/${repo}`) return json({ default_branch: 'main', archived: false });
      if (u.startsWith(`https://api.github.com/repos/${repo}/git/trees/main`)) return json({ truncated: false, tree: files.map((p) => ({ path: p, type: 'blob', mode: '100644', size: 40 })) });
      if (u.startsWith(`https://raw.githubusercontent.com/${repo}/main/`)) {
        const p = decodeURIComponent(u.slice(`https://raw.githubusercontent.com/${repo}/main/`.length));
        const name = path.posix.basename(path.posix.dirname(p));
        return new Response(p.endsWith('SKILL.md') ? fm(name, `Use ${name} for the team`) : 'example', { status: 200 });
      }
    }
    return new Response('not found', { status: 404 });
  };
}

test('skills: found on GitHub for the agents, explained, nothing imported until picked; or read from a pasted link', async () => {
  const seen = [];
  let failSearch = false;
  const github = fakeGithub(seen);
  const s = await startServer({ fetch: (url, opts) => (failSearch && String(url).includes('/search/') ? fakeGithub([], { searchFails: true })(url, opts) : github(url, opts)) });
  const root = makeMiniProject();
  try {
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'design'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'design', 'SKILL.md'), '---\nname: design\ndescription: ours\n---\n');
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    const wf = { nodes: [{ id: 'you', kind: 'human', title: 'You' }, { id: 'build', kind: 'stage', title: 'Build' }, { id: 'coder', kind: 'agent', title: 'Coder', parent: 'build', engine: 'claude', does: 'Writes the React app' }], edges: [{ from: 'you', to: 'build' }] };

    const r = await s.call('POST', `/api/projects/${id}/skills/discover`, { workflow: wf });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json.needs, [{ need: 'Testing React components', search: 'react testing', agents: ['coder'] }], 'agents that do not exist are dropped');
    assert.deepEqual(r.json.searched.sort(), ['acme/react-skills', 'anthropics/skills']);
    assert.deepEqual(r.json.suggestions.map((x) => x.key).sort(), ['react-testing', 'webapp-testing'], 'only real candidates, never an invented id');
    const rt = r.json.suggestions.find((x) => x.key === 'react-testing');
    assert.deepEqual([rt.plain, rt.why, rt.agents, rt.repo.fullName, rt.repo.stars, rt.dir], ['Helps an agent write tests.', 'The team writes React code.', ['coder'], 'acme/react-skills', 1200, 'react-testing']);
    assert.ok(r.json.alreadyHave.includes('design'), 'a skill the project already has is not suggested');
    assert.ok(!seen.some((u) => /\/pdf\/SKILL\.md/.test(u)), 'only promising skills are read');
    assert.deepEqual((await s.call('GET', '/api/skills')).json.skills.map((x) => x.name), [], 'nothing imported yet');

    // the human picks one: the normal import brings it into the library
    const imp = (await s.call('POST', '/api/skills/fetch', { url: rt.repo.url, ref: rt.ref, picks: [rt.dir] })).json;
    assert.deepEqual(imp.imported, ['react-testing']);

    // a pasted link: no search, that collection is read and explained
    seen.length = 0;
    const l = (await s.call('POST', `/api/projects/${id}/skills/discover`, { workflow: wf, message: 'what is in https://github.com/acme/react-skills?' })).json;
    assert.deepEqual(l.needs, []);
    assert.deepEqual(l.searched, ['acme/react-skills']);
    assert.ok(!seen.some((u) => u.includes('/search/')), 'no search when a link is given');
    assert.ok(l.alreadyHave.includes('react-testing') && l.alreadyHave.includes('design'), 'what is already in the library or the project is left out');

    // GitHub search refused (rate limit): still the official collection, and the reason is said
    failSearch = true;
    s.app.skillFinder = null; // a fresh finder (no cached search)
    const f = (await s.call('POST', `/api/projects/${id}/skills/discover`, { workflow: wf })).json;
    assert.deepEqual(f.searched, ['anthropics/skills']);
    assert.ok(f.skipped.some((x) => /rate limit|refused/i.test(x.reason)), JSON.stringify(f.skipped));
    assert.deepEqual(f.suggestions.map((x) => x.key), ['webapp-testing']);
  } finally {
    await s.close();
    rmDir(root);
  }
});
