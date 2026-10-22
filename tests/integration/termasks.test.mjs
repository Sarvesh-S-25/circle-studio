// Claude Code in a terminal asks on the desktop cards: its PermissionRequest hook (scripts/permission-hook.mjs) sends
// the request, it waits as a card, your answer goes back as Claude Code's own decision; "In the terminal" hands it
// back; with Circle Studio stopped the hook steps aside. The switch adds and removes the hook in a temp Claude folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir, tempDir } from '../helpers/project.mjs';
import { permHookState, setPermHook } from '../../backend/lib/permhook.mjs';

const HOOK = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'permission-hook.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// runs the hook as Claude Code does: the request on stdin, the decision (or nothing) on stdout
function runHook(port, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env: { ...process.env, CIRCLE_PORT: String(port) }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ code, out: out ? JSON.parse(out) : null }));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: '52936fcf-c835-4ac8-b1ec-c349860422d3', ...input }));
  });
}
const pendingOne = async (s) => { for (let i = 0; i < 100; i++) { const r = (await s.call('GET', '/api/requests?status=pending')).json.requests; if (r.length) return r[0]; await sleep(50); } return null; };

test('a terminal asks on the cards: allow, deny, an answer, or back to the terminal', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  const elsewhere = tempDir('circle-elsewhere-');
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true, run: true, claude: true } })).json.project.id;

    // allow: the hook tells Claude Code to go ahead
    let hook = runHook(s.port, { tool_name: 'Bash', tool_input: { command: 'mkdir build' }, cwd: root });
    let r = await pendingOne(s);
    assert.deepEqual([r.source, r.projectId, r.kind, r.detail], ['terminal', id, 'approval', 'mkdir build']);
    await s.call('POST', `/api/requests/${r.id}/respond`, { decision: 'allow' });
    let res = await hook;
    assert.deepEqual(res.out, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.equal((await s.call('GET', '/api/requests?status=all')).json.requests.find((x) => x.id === r.id).status, 'allowed', 'kept in the Inbox');

    // deny: Claude Code is told why
    hook = runHook(s.port, { tool_name: 'Write', tool_input: { file_path: path.join(root, 'a.txt'), content: 'x' }, cwd: root });
    r = await pendingOne(s);
    await s.call('POST', `/api/requests/${r.id}/respond`, { decision: 'deny' });
    res = await hook;
    assert.deepEqual(res.out.hookSpecificOutput.decision, { behavior: 'deny', message: 'Refused on the Circle Studio card.' });

    // a question: the answer goes back in the tool's input
    const questions = [{ question: 'Which database?', header: 'Data', options: [{ label: 'SQLite' }, { label: 'Postgres' }], multiSelect: false }];
    hook = runHook(s.port, { tool_name: 'AskUserQuestion', tool_input: { questions }, cwd: root });
    r = await pendingOne(s);
    assert.equal(r.kind, 'question');
    await s.call('POST', `/api/requests/${r.id}/respond`, { decision: 'answer', answers: { 'Which database?': 'SQLite' } });
    res = await hook;
    assert.deepEqual(res.out.hookSpecificOutput.decision, { behavior: 'allow', updatedInput: { questions, answers: { 'Which database?': 'SQLite' } } });

    // "In the terminal": the card goes, the hook prints nothing and Claude Code asks there
    hook = runHook(s.port, { tool_name: 'Bash', tool_input: { command: 'npm publish' }, cwd: root });
    r = await pendingOne(s);
    assert.equal((await s.call('POST', `/api/hooks/permission/${r.id}/release`)).json.released, true);
    res = await hook;
    assert.deepEqual([res.code, res.out], [0, null]);
    assert.equal((await s.call('GET', '/api/requests?status=pending')).json.requests.length, 0);

    // a folder that is not one of your projects: kept apart, under its own name
    hook = runHook(s.port, { tool_name: 'Bash', tool_input: { command: 'mkdir out' }, cwd: elsewhere });
    r = await pendingOne(s);
    assert.deepEqual([r.projectId, r.folderName], ['_terminal', path.basename(elsewhere)]);
    assert.equal((await s.call('POST', '/api/desktop/folder', { folder: elsewhere })).json.folder, path.resolve(elsewhere));
    await s.call('POST', `/api/requests/${r.id}/respond`, { decision: 'allow' });
    assert.equal((await hook).out.hookSpecificOutput.decision.behavior, 'allow');

    // a request that Circle Studio would refuse in its own chat is still yours to answer, marked
    hook = runHook(s.port, { tool_name: 'Bash', tool_input: { command: 'cat .env' }, cwd: root });
    r = await pendingOne(s);
    assert.equal(r.risk, 'dangerous');
    await s.call('POST', `/api/requests/${r.id}/respond`, { decision: 'deny' });
    await hook;
    assert.equal((await s.call('POST', '/api/hooks/permission', { tool_name: 'Bash', cwd: 'relative/path' })).status, 400);
  } finally {
    await s.close();
    rmDir(root);
    rmDir(elsewhere);
  }
  // Circle Studio stopped: the hook steps aside at once (Claude Code asks in the terminal)
  const t0 = Date.now();
  const res = await runHook(s.port, { tool_name: 'Bash', tool_input: { command: 'mkdir x' }, cwd: 'C:\\x' });
  assert.deepEqual([res.code, res.out], [0, null]);
  assert.ok(Date.now() - t0 < 5000);
});

test('the switch: the hook added to Claude Code settings (other hooks kept), and taken out again', () => {
  const home = tempDir('circle-hookhome-');
  const data = tempDir('circle-hookdata-');
  try {
    const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-check' }] };
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { PermissionRequest: [mine], Stop: [{ hooks: [{ type: 'command', command: 'beep' }] }] } }));
    const ctx = { claudeHome: home, dataDir: data, appRoot: 'C:\\app' };
    assert.equal(permHookState(ctx).on, false);
    assert.equal(setPermHook(true, ctx).on, true);
    let saved = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    assert.equal(saved.model, 'opus');
    assert.equal(saved.hooks.PermissionRequest.length, 2);
    assert.deepEqual(saved.hooks.PermissionRequest[0], mine, 'your own hook stays first');
    assert.match(saved.hooks.PermissionRequest[1].hooks[0].command, /permission-hook\.mjs"$/);
    assert.equal(saved.hooks.PermissionRequest[1].hooks[0].timeout, 600);
    assert.ok(saved.hooks.Stop, 'other hooks stay');
    assert.ok(fs.readdirSync(path.join(data, 'backups')).some((f) => f.startsWith('claude-settings-')), 'backed up first');
    assert.equal(setPermHook(false, ctx).on, false);
    saved = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    assert.deepEqual(saved.hooks.PermissionRequest, [mine]);
    // a private port is passed on
    assert.match(permHookState({ ...ctx, port: 4399 }).after.at(-1).hooks[0].command, /--port 4399$/);
  } finally {
    rmDir(home);
    rmDir(data);
  }
});
