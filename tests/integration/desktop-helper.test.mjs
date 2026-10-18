// v16: the desktop as the place to work. Asking on the desktop (a card instead of a Windows toast, never both), the
// feed the host draws (no tiles when it runs only to ask), the chat feed's whole messages, ready-made mods added to a
// project (diff first) and checked with Claude Code's own validator and test runner (a fake claude here).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';
import { plain } from '../../backend/lib/chatfeed.mjs';
import { listStarters, starterFiles, readValidate, readTests, hasTests } from '../../backend/lib/modstarters.mjs';

const ALL = { write: true, run: true, claude: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('chat feed: Markdown becomes plain words for the small tiles and the native widget', () => {
  assert.equal(plain('Done. I added **3 tests**: `npm test` passes.'), 'Done. I added 3 tests: npm test passes.');
  assert.equal(plain('## Plan\n- one\n- [the docs](https://x.y)'), 'Plan\n• one\n• the docs');
  assert.equal(plain('```\n3 passed\n```'), '3 passed\n');
});

test('ready-made mods: listed with what they do, their files without the types Claude Code writes', () => {
  const names = listStarters().map((s) => s.name);
  assert.ok(names.includes('waiting-game') && names.includes('turn-check'), names.join(', '));
  const game = listStarters().find((s) => s.name === 'waiting-game');
  assert.equal(game.isMod, true);
  assert.ok(game.categories.includes('look') && game.categories.includes('commands'));
  assert.equal(game.tests, 1);
  const files = starterFiles('waiting-game').map((f) => f.path);
  assert.ok(files.includes('.claude-plugin/plugin.json') && files.includes('hooks/register.tsx') && files.includes('hooks/hooks.json'));
  assert.ok(!files.some((f) => f.startsWith('.claude-plugin/types/')));
  assert.equal(starterFiles('../etc'), null);
  assert.equal(starterFiles('no-such-mod'), null);
});

test('checking a mod: what claude plugin validate and claude plugin test said, in plain words', () => {
  const passed = 'Validating plugin manifest: C:\\m\\.claude-plugin\\plugin.json\n\n⚠ Found 1 warning:\n\n  ❯ author: No author information provided.\n\nValidating hooks: C:\\m\\hooks\\hooks.json\n\n  ❯ ./register.tsx hooks: session.start, turn.start, ui.render{component=Pane}\n  ❯ ./register.tsx calls: $.clock.every\n\n✔ Validation passed with warnings';
  const v = readValidate(passed, 0);
  assert.equal(v.ok, true);
  assert.deepEqual(v.problems, []);
  assert.equal(v.warnings.length, 1);
  assert.equal(v.hooks, 'session.start, turn.start, ui.render{component=Pane}');
  const failed = 'Validating hooks: C:\\m\\hooks\\hooks.json\n\n✘ Found 1 error:\n\n  ❯ modules../register.tsx: $ is passed to "open", which is not a function declared at the top of this file\n\n✘ Validation failed';
  const f = readValidate(failed, 1);
  assert.equal(f.ok, false);
  assert.match(f.problems[0], /not a function declared at the top/);
  const t = readTests('hooks\\game.test.ts:\n(pass) walks [4.17ms]\n(fail) scores [1.2ms]\n\n 1 pass\n 1 fail\nRan 2 tests across 1 file.', 1);
  assert.deepEqual([t.ok, t.pass, t.fail, t.failed], [false, 1, 1, ['scores']]);
  assert.equal(readTests('\x1b[32m 3 pass\x1b[0m\n 0 fail', 0).ok, true);
});

test('mods: a ready-made mod goes into .claude/skills after you review the diff; Check runs validate and test', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    const starters = (await s.call('GET', '/api/mods/starters')).json.starters;
    assert.ok(starters.some((x) => x.name === 'turn-check'));
    // diff first: nothing is written by the preview
    const pre = await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'mod-add', starter: 'waiting-game' }] });
    assert.equal(pre.status, 200, JSON.stringify(pre.json));
    const files = pre.json.files.map((x) => x.path);
    assert.ok(files.includes('.claude/skills/waiting-game/hooks/register.tsx'), files.join(', '));
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'skills', 'waiting-game')));
    const ap = await s.call('POST', '/api/changes/apply', { id: pre.json.id });
    assert.equal(ap.status, 200, JSON.stringify(ap.json));
    assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'waiting-game', 'hooks', 'register.tsx')));
    // it is now this project's own mod
    const mods = (await s.call('GET', `/api/mods?projectId=${id}`)).json.mods;
    const game = mods.find((m) => m.id === 'waiting-game@skills-dir');
    assert.ok(game && game.isMod && game.group === 'project' && game.installScope === 'project-skills');
    // a folder of that name with other content is not overwritten unless asked
    fs.writeFileSync(path.join(root, '.claude', 'skills', 'waiting-game', 'hooks', 'register.tsx'), '// mine\n');
    const again = await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'mod-add', starter: 'waiting-game' }] });
    assert.equal(again.status, 409);
    assert.equal((await s.call('POST', '/api/changes/preview', { projectId: id, ops: [{ op: 'mod-add', starter: '../x' }] })).status, 400);
    // Check: claude plugin validate, then claude plugin test because it has tests
    assert.equal(hasTests(path.join(root, '.claude', 'skills', 'waiting-game')), true);
    const calls = [];
    s.app.overrides.runClaude = async (args) => {
      calls.push(args);
      return args[1] === 'validate' ? { code: 0, stdout: '  ❯ ./register.tsx hooks: turn.start\n\n✔ Validation passed', stderr: '' } : { code: 0, stdout: ' 3 pass\n 0 fail', stderr: '' };
    };
    const r = (await s.call('POST', '/api/mods/check', { plugin: 'waiting-game@skills-dir' })).json;
    assert.deepEqual(calls.map((a) => a.slice(0, 2)), [['plugin', 'validate'], ['plugin', 'test']]);
    assert.ok(path.resolve(calls[0][2]).toLowerCase().endsWith(path.join('.claude', 'skills', 'waiting-game').toLowerCase()));
    assert.deepEqual([r.ok, r.validate.ok, r.tests.pass, r.validate.hooks], [true, true, 3, 'turn.start']);
    assert.equal((await s.call('POST', '/api/mods/check', { plugin: 'nope@nowhere' })).status, 400);
  } finally { await s.close(); rmDir(root); }
});

test('asking on the desktop: the setting saves, the host draws no tiles when it only asks, and Windows is not told twice', async () => {
  const toasts = [];
  const s = await startServer({ toast: (t) => { toasts.push(t); return true; } });
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    assert.equal((await s.call('GET', '/api/settings')).json.settings.desktopAsks, true, 'on unless turned off');
    // tiles off the desktop, asks on: the host asks for its feed with asks=1 and gets no tiles
    await s.call('PUT', '/api/settings', { desktopWidgets: false, widgets: [{ kind: 'pulse', size: 's' }, { kind: 'mods', size: 'm' }] });
    const host = (await s.call('GET', '/api/widgets/feed?asks=1')).json;
    assert.deepEqual([host.tiles.length, host.asks], [0, true]);
    assert.equal((await s.call('GET', '/api/widgets/feed')).json.tiles.length, 2, 'the board in the app still shows them');
    await s.call('PUT', '/api/settings', { desktopAsks: false });
    assert.equal((await s.call('GET', '/api/widgets/feed')).json.asks, false);
    await s.call('PUT', '/api/settings', { desktopAsks: true, desktopWidgets: true });
    assert.equal((await s.call('GET', '/api/widgets/feed?asks=1')).json.tiles.length, 2);
    // no window open, and the desktop shows the request as a card: no Windows toast as well
    s.app.overrides.asksOnDesktop = () => true;
    process.env.FAKE_CLAUDE = 'bash';
    const run = s.sse('/api/chat', { projectId: id, message: 'run it' });
    let pending = [];
    for (let i = 0; i < 100 && !pending.length; i++) { pending = (await s.call('GET', '/api/requests?status=pending')).json.requests; if (!pending.length) await sleep(50); }
    assert.equal(pending.length, 1, 'the card polls this list');
    assert.equal(toasts.length, 0, 'the card is the notification');
    assert.equal((await s.call('POST', `/api/requests/${pending[0].id}/respond`, { decision: 'allow' })).status, 200);
    await run;
    delete process.env.FAKE_CLAUDE;
    // with the desktop not asking, the toast comes back
    s.app.overrides.asksOnDesktop = () => false;
    process.env.FAKE_CLAUDE = 'bash';
    const run2 = s.sse('/api/chat', { projectId: id, message: 'run it again' });
    for (let i = 0; i < 100 && !toasts.length; i++) await sleep(50);
    assert.equal(toasts.length, 1);
    const p2 = (await s.call('GET', '/api/requests?status=pending')).json.requests[0];
    await s.call('POST', `/api/requests/${p2.id}/respond`, { decision: 'deny' });
    await run2;
    // the widget status says whether the tiles are on the desktop and whether it asks there
    const st = (await s.call('POST', '/api/desktop/widgets', { action: 'status' })).json;
    assert.equal(typeof st.asking, 'boolean');
    assert.equal(st.hotkey, null, 'no host runs in tests, so no hotkey');
    assert.equal((await s.call('POST', '/api/desktop/widgets', { action: 'nonsense' })).status, 400);
  } finally { delete process.env.FAKE_CLAUDE; await s.close(); rmDir(root); }
});
