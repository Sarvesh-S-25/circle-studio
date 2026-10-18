// Mods (lib/mods.mjs, routes.mods.mjs, op mod-set): Claude Code mods and plugins sorted into "for every project",
// "only this project" and "off", with what each changes. A fake ~/.claude in a temp folder; never the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scanModule, inspectPlugin, projectMods, allMods } from '../../backend/lib/mods.mjs';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, tempDir, rmDir } from '../helpers/project.mjs';

const ALL = { write: true, run: true, claude: true };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`); };

/** A mod (hooks module), a plain plugin with skills and an MCP server, and a skills-dir mod, under a fake ~/.claude. */
function fakeClaudeHome(home, { projectRoot } = {}) {
  const cache = path.join(home, 'plugins', 'cache', 'market');
  const ctx = path.join(cache, 'context-colours', '1.0.0');
  write(path.join(ctx, '.claude-plugin', 'plugin.json'), { name: 'context-colours', version: '1.0.0', description: 'Colours the context bar.' });
  write(path.join(ctx, 'hooks', 'hooks.json'), { modules: ['./register.tsx'] });
  write(path.join(ctx, 'hooks', 'register.tsx'), "export const register = (on) => {\n  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => next(e));\n  on('prompt.compose', ($, e, next) => next(e));\n  on('tool.call', { tool: 'Bash' }, ($, e, next) => next(e));\n};\n");
  const sk = path.join(cache, 'helpers', '2.0.0');
  write(path.join(sk, '.claude-plugin', 'plugin.json'), { name: 'helpers', version: '2.0.0' });
  write(path.join(sk, 'skills', 'one', 'SKILL.md'), '---\nname: one\n---\n');
  write(path.join(sk, '.mcp.json'), { mcpServers: { thing: { command: 'npx', args: ['thing'] } } });
  const plugins = { 'context-colours@market': [{ scope: 'user', installPath: ctx }], 'helpers@market': [{ scope: 'user', installPath: sk }] };
  if (projectRoot) {
    const pr = path.join(cache, 'only-here', '0.1.0');
    write(path.join(pr, '.claude-plugin', 'plugin.json'), { name: 'only-here' });
    write(path.join(pr, 'commands', 'hi.md'), 'Say hi');
    plugins['only-here@market'] = [{ scope: 'project', installPath: pr, projectPath: projectRoot }];
  }
  write(path.join(home, 'plugins', 'installed_plugins.json'), { version: 2, plugins });
  write(path.join(home, 'settings.json'), { enabledPlugins: { 'context-colours@market': true, 'helpers@market': false } });
  const dev = path.join(home, 'skills', 'band');
  write(path.join(dev, '.claude-plugin', 'plugin.json'), { name: 'band' });
  write(path.join(dev, 'hooks', 'hooks.json'), { modules: ['./register.ts'] });
  write(path.join(dev, 'hooks', 'register.ts'), "export const register = (on) => { on('session.start', ($) => { $.ui.status('hi'); $.command.register({ name: 'x' }); }); };\n");
}

test('scanModule and inspectPlugin say what a mod changes', () => {
  const s = scanModule("on('ui.render', h); on('prompt.submit', h); on('tool.call', h); $.audio.play({}); $.tool.register({});");
  assert.deepEqual([...s.cats].sort(), ['checks', 'context', 'look', 'sound', 'tools']);
  assert.deepEqual(s.events, ['prompt.submit', 'tool.call', 'ui.render']);
  const home = tempDir('cs-mods-home-');
  try {
    fakeClaudeHome(home);
    const mod = inspectPlugin(path.join(home, 'plugins', 'cache', 'market', 'context-colours', '1.0.0'));
    assert.equal(mod.isMod, true);
    assert.deepEqual(mod.categories, ['look', 'context', 'checks']);
    const plain = inspectPlugin(path.join(home, 'plugins', 'cache', 'market', 'helpers', '2.0.0'));
    assert.equal(plain.isMod, false);
    assert.deepEqual(plain.categories, ['skills', 'tools']);
    assert.deepEqual([plain.counts.skills, plain.counts.tools], [1, 1]);
  } finally { rmDir(home); }
});

test('projectMods sorts into general, this project only and off; allMods names the projects', () => {
  const home = tempDir('cs-mods-home-');
  const root = makeMiniProject();
  try {
    fakeClaudeHome(home, { projectRoot: root });
    const byId = (list) => Object.fromEntries(list.map((m) => [m.id, m]));
    let mods = byId(projectMods({ claudeHome: home, root }));
    assert.equal(mods['context-colours@market'].group, 'general');
    assert.equal(mods['band@skills-dir'].group, 'general', 'a plugin in ~/.claude/skills loads by itself');
    assert.deepEqual(mods['band@skills-dir'].categories, ['look', 'commands']);
    assert.equal(mods['helpers@market'].group, 'off');
    assert.equal(mods['only-here@market'].group, 'off', 'installed for this project, not turned on yet');
    write(path.join(root, '.claude', 'settings.json'), { enabledPlugins: { 'helpers@market': true, 'context-colours@market': false, 'only-here@market': true } });
    write(path.join(root, '.claude', 'skills', 'mine', '.claude-plugin', 'plugin.json'), { name: 'mine' });
    mods = byId(projectMods({ claudeHome: home, root }));
    assert.deepEqual(['helpers@market', 'context-colours@market', 'only-here@market', 'mine@skills-dir'].map((id) => mods[id].group), ['project', 'off', 'project', 'project']);
    write(path.join(root, '.claude', 'settings.local.json'), { enabledPlugins: { 'helpers@market': false } });
    assert.equal(byId(projectMods({ claudeHome: home, root }))['helpers@market'].group, 'off', 'settings.local.json wins');
    const other = makeMiniProject();
    try {
      const all = byId(allMods({ claudeHome: home, projects: [{ id: 'a', name: 'A', path: root }, { id: 'b', name: 'B', path: other }] }));
      assert.equal(all['context-colours@market'].group, 'general');
      assert.deepEqual(all['context-colours@market'].offIn.map((p) => p.name), ['A']);
      assert.equal(all['only-here@market'].group, 'project');
      assert.deepEqual(all['only-here@market'].onIn.map((p) => p.name), ['A']);
      assert.equal(all['helpers@market'].group, 'off', 'A turns it on, but its local file turns it off again');
      assert.deepEqual(all['mine@skills-dir'].onIn.map((p) => p.name), ['A'], 'a project\'s own plugin folder belongs to that project');
    } finally { rmDir(other); }
  } finally { rmDir(home); rmDir(root); }
});

test('the app: list, turn a mod on here as a reviewed diff, and the general switch runs the claude CLI', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  try {
    fakeClaudeHome(s.claudeHome);
    write(path.join(root, '.claude', 'settings.json'), { permissions: { allow: ['Bash(npm test)'] } });
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    const list = (await s.call('GET', `/api/mods?projectId=${id}`)).json;
    assert.equal(list.scope, 'project');
    assert.ok(list.categories.look.label);
    assert.equal(list.mods.find((m) => m.id === 'helpers@market').group, 'off');

    const p = (await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'mod-set', plugin: 'helpers@market', value: true }] })).json;
    assert.deepEqual(p.files.map((f) => f.path), ['.claude/settings.json']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')).enabledPlugins, undefined, 'nothing written before apply');
    assert.equal((await s.call('POST', '/api/changes/apply', { id: p.id })).status, 200);
    const after = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(after, { permissions: { allow: ['Bash(npm test)'] }, enabledPlugins: { 'helpers@market': true } }, 'the project\'s own settings stay');
    assert.equal((await s.call('GET', `/api/mods?projectId=${id}`)).json.mods.find((m) => m.id === 'helpers@market').group, 'project');

    const back = (await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'mod-set', plugin: 'helpers@market', value: null }] })).json;
    await s.call('POST', '/api/changes/apply', { id: back.id });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')).enabledPlugins, {});
    assert.equal((await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'mod-set', plugin: 'not a plugin', value: true }] })).status, 400);

    const calls = [];
    s.app.overrides.runClaude = async (args) => { calls.push(args); return { code: 0, stdout: 'Enabled', stderr: '' }; };
    const g = (await s.call('POST', '/api/mods/general', { plugin: 'helpers@market', on: true })).json;
    assert.equal(g.ok, true);
    assert.deepEqual(calls[0], ['plugin', 'enable', 'helpers@market', '--scope', 'user']);
    assert.equal(g.command, 'claude plugin enable helpers@market --scope user');
    assert.equal((await s.call('POST', '/api/mods/general', { plugin: 'x@y; rm -rf', on: true })).status, 400);
    const d = (await s.call('POST', '/api/mods/details', { plugin: 'helpers@market' })).json;
    assert.deepEqual(calls[1], ['plugin', 'details', 'helpers@market']);
    assert.equal(d.output, 'Enabled');
    const everywhere = (await s.call('GET', '/api/mods')).json;
    assert.equal(everywhere.scope, 'all');
  } finally { await s.close(); rmDir(root); }
});
