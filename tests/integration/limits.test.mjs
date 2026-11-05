// Your plan's limits: read from Claude's own stream (every chat) and from the status line (the tap), shown in a tile,
// a window that has reset shown as started again; the tap set up and removed on a temp Claude home, your own status
// line kept and run without a shell.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir, tempDir } from '../helpers/project.mjs';
import { fromStream, fromStatusLine, splitCommand, tapState, setTap } from '../../backend/lib/limits.mjs';
import { limitsView } from '../../backend/lib/feed.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = path.resolve(import.meta.dirname, '..', '..');

test('the two readings and the tile', () => {
  const s = fromStream({ unifiedWindows: { five_hour: { utilization: 0.98, resetsAt: 1792407000 }, seven_day: { utilization: 0.38, resetsAt: 1792879200 } } });
  assert.deepEqual([s.fiveHour.pct, s.week.pct], [98, 38]);
  assert.equal(s.fiveHour.resetsAt, new Date(1792407000 * 1000).toISOString());
  assert.equal(fromStream({}), null);
  const l = fromStatusLine({ five_hour: { used_percentage: 31.4, resets_at: '2030-01-01T10:00:00Z' }, seven_day: { used_percentage: 12 } });
  assert.deepEqual([l.fiveHour.pct, l.week.pct, l.week.resetsAt], [31, 12, null]);
  const now = Date.parse('2030-01-01T09:00:00Z');
  const v = limitsView({ at: '2030-01-01T08:55:00Z', source: 'terminal', ...l }, now);
  assert.deepEqual(v.rows.map((r) => [r.label, r.value, r.color]), [['5 hours', '31%', 'ok'], ['Week', '12%', 'ok']]);
  const later = limitsView({ at: '2030-01-01T08:00:00Z', fiveHour: { pct: 95, resetsAt: '2030-01-01T10:00:00Z' } }, Date.parse('2030-01-01T11:00:00Z'));
  assert.deepEqual([later.rows[0].value, later.rows[0].pct], ['Refresh needed', null], 'a reset time is not proof of a fresh zero reading');
  assert.equal(limitsView({ fiveHour: { pct: 92, resetsAt: '2030-01-01T10:00:00Z' } }, now).rows[0].color, 'danger');
  assert.equal(limitsView(null), null);
});

test('a status line command is run without a shell, or not tapped', () => {
  assert.deepEqual(splitCommand('"C:\\Py\\python.exe" "C:\\x y\\statusline.py"'), ['C:\\Py\\python.exe', 'C:\\x y\\statusline.py']);
  assert.deepEqual(splitCommand('node line.js --short'), ['node', 'line.js', '--short']);
  for (const c of ['a | b', 'x && y', 'echo $HOME', 'echo %USERPROFILE%', 'a > b', '']) assert.equal(splitCommand(c), null, c);
});

test('the tap: on keeps your line and runs it; the reading lands in the data folder; off puts it back', () => {
  const home = tempDir('circle-limhome-');
  const data = tempDir('circle-limdata-');
  try {
    // "your" status line: a node script that prints what it got
    const mine = path.join(home, 'mine.mjs');
    fs.writeFileSync(mine, "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>process.stdout.write('MINE:'+JSON.parse(s).model.id));");
    const own = { type: 'command', command: `"${process.execPath}" "${mine}"`, padding: 0 };
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ theme: 'dark', statusLine: own }, null, 2));
    const ctx = { claudeHome: home, dataDir: data, appRoot: APP };
    const before = tapState(ctx);
    assert.deepEqual([before.on, before.canTap], [false, true]);
    const on = setTap(true, ctx);
    assert.equal(on.on, true);
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
    assert.equal(settings.theme, 'dark', 'the rest of your settings stay');
    assert.match(settings.statusLine.command, /statusline-tap\.mjs/);
    assert.equal(settings.statusLine.padding, 0);
    assert.ok(fs.readdirSync(path.join(data, 'backups')).some((f) => f.startsWith('claude-settings-')), 'backed up first');

    // Claude Code runs the tap the way it runs any status line: JSON on stdin
    const input = JSON.stringify({ model: { id: 'opus' }, rate_limits: { five_hour: { used_percentage: 44, resets_at: '2030-01-01T10:00:00Z' }, seven_day: { used_percentage: 9 } } });
    const r = spawnSync(process.execPath, [path.join(APP, 'scripts', 'statusline-tap.mjs')], { input, env: { ...process.env, CIRCLE_DATA: data }, encoding: 'utf8' });
    assert.equal(r.stdout, 'MINE:opus', 'your own status line, unchanged');
    const kept = JSON.parse(fs.readFileSync(path.join(data, 'limits.json'), 'utf8'));
    assert.deepEqual([kept.source, kept.fiveHour.pct, kept.week.pct], ['terminal', 44, 9]);

    const off = setTap(false, ctx);
    assert.equal(off.on, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).statusLine, own, 'your line is back as it was');

    // a line that needs a shell is not tapped
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'cat x | head -1' } }));
    assert.equal(tapState(ctx).canTap, false);
    assert.throws(() => setTap(true, ctx), /shell/);
  } finally {
    rmDir(home);
    rmDir(data);
  }
});

test('a chat records the limits Claude reports; the routes and the tile show them', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { write: true, run: true, claude: true } })).json.project.id;
    assert.equal((await s.call('GET', '/api/limits')).json.limits, null);
    process.env.FAKE_CLAUDE = 'tools';
    process.env.FAKE_CLAUDE_TOOLS = '[]';
    process.env.FAKE_CLAUDE_LIMITS = '31,38';
    assert.equal((await s.call('POST', '/api/overlay/say', { projectId: id, text: 'hi' })).json.sent, true);
    let l = null;
    for (let i = 0; i < 100 && !l; i++) { await sleep(50); l = (await s.call('GET', '/api/limits')).json.limits; }
    assert.deepEqual([l.source, l.fiveHour.pct, l.week.pct], ['chat', 31, 38]);
    assert.equal((await s.call('GET', '/api/limits')).json.tap.on, false);
    await s.call('PUT', '/api/settings', { widgets: [{ kind: 'limits', size: 'm' }] });
    const tile = (await s.call('GET', '/api/widgets/feed')).json.tiles[0];
    assert.deepEqual(tile.rows.map((r) => r.value), ['31%', '38%']);
    assert.equal((await s.call('POST', '/api/limits/tap', {})).status, 400);
    // /usage in the chat, as in Claude Code: the plan's limits first
    const usage = (await s.call('POST', '/api/overlay/command', { projectId: id, text: '/usage', from: 'chat' })).json.say;
    assert.match(usage.title, /5 hours 31%/);
    // the overlay's Plan limits panel (and the bar's line)
    const feed = (await s.call('GET', `/api/overlay?projectId=${id}`)).json;
    assert.deepEqual(feed.limits.rows.map((r) => [r.label, r.value]), [['5 hours', '31%'], ['Week', '38%']]);
    assert.equal(feed.limits.from, 'a chat here');
    assert.ok(usage.lines.some((l) => /^Week: 38% used/.test(l)));
  } finally {
    delete process.env.FAKE_CLAUDE;
    delete process.env.FAKE_CLAUDE_TOOLS;
    delete process.env.FAKE_CLAUDE_LIMITS;
    await s.close();
    rmDir(root);
  }
});
