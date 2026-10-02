// Newcomer setup and the guards around it: an engine installed with npm (a .cmd launcher) is found and run without a
// shell; GitHub goes through the gh CLI when it is signed in (its token never reaches Circle Studio); and the routes
// that open terminals, change connections or search GitHub refuse other websites and requests without the header.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveCli } from '../../backend/lib/engines/proc.mjs';
import { ghStatus, ghAwareFetch, parseGhInclude } from '../../backend/lib/ghcli.mjs';
import { startServer } from '../helpers/server.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

const SHIM = (target) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;

test('an engine installed with npm (a .cmd launcher) is found and run as node <script>; an .exe wins; nothing escapes', { skip: process.platform !== 'win32' }, () => {
  const npm = tempDir('cs-npm-');
  const exeDir = tempDir('cs-exe-');
  try {
    fs.mkdirSync(path.join(npm, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'console.log("codex-cli 9.9.9")');
    fs.writeFileSync(path.join(npm, 'codex.cmd'), SHIM('node_modules\\@openai\\codex\\bin\\codex.js'));
    fs.writeFileSync(path.join(npm, 'evil.cmd'), SHIM('..\\..\\outside.js'));
    const env = { PATH: npm, APPDATA: '' };
    const r = resolveCli('codex', env);
    assert.deepEqual(r, { bin: process.execPath, prefix: [path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] });
    assert.equal(resolveCli('evil', env), null, 'a launcher pointing outside its folder is not followed');
    assert.equal(resolveCli('../codex', env), null, 'only plain names');
    assert.equal(resolveCli('openclaw', env), null);
    fs.writeFileSync(path.join(exeDir, 'codex.exe'), '');
    assert.equal(resolveCli('codex', { PATH: `${npm};${exeDir}`, APPDATA: '' }).bin, path.join(exeDir, 'codex.exe'), 'a real program first');
  } finally {
    rmDir(npm);
    rmDir(exeDir);
  }
});

test('GitHub through gh: signed in, API reads go through gh (no token here); otherwise straight to GitHub', async () => {
  const calls = [];
  const fakeGh = (signedIn) => async (bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'auth') return signedIn ? { code: 0, stdout: '', stderr: 'github.com\n  ✓ Logged in to github.com account octo-cat (keyring)\n  - Token: gho_************************************' } : { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.' };
    return { code: 0, stdout: 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\nX-Ratelimit-Remaining: 4999\r\n\r\n{"items":[]}', stderr: '' };
  };
  const find = () => ({ bin: 'gh.exe', prefix: [] });
  assert.deepEqual(await ghStatus({ run: fakeGh(true), find }), { installed: true, signedIn: true, account: 'octo-cat' }, 'only the account name, never the token line');
  const base = [];
  const baseFetch = async (url) => { base.push(String(url)); return new Response('{}', { status: 200 }); };
  const f = ghAwareFetch(baseFetch, { run: fakeGh(true), find });
  const res = await f('https://api.github.com/search/repositories?q=react%20testing');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-ratelimit-remaining'), '4999');
  assert.deepEqual(await res.json(), { items: [] });
  assert.ok(calls.includes('api -i --method GET search/repositories?q=react%20testing'));
  await f('https://raw.githubusercontent.com/a/b/main/SKILL.md');
  assert.deepEqual(base, ['https://raw.githubusercontent.com/a/b/main/SKILL.md'], 'raw files are not API calls');
  await ghAwareFetch(baseFetch, { run: fakeGh(false), find })('https://api.github.com/repos/a/b');
  assert.equal(base.at(-1), 'https://api.github.com/repos/a/b', 'not signed in: anonymous, as before');
  await ghAwareFetch(baseFetch, { run: fakeGh(true), find })('https://api.github.com/repos/a/b', { method: 'POST' });
  assert.equal(base.at(-1), 'https://api.github.com/repos/a/b', 'only reads go through gh');
  assert.equal(parseGhInclude('not http'), null);
});

test('backups of ~/.claude.json do not pile up: the newest three, a day at most', async () => {
  const { pruneBackups } = await import('../../backend/lib/mcpmanage.mjs');
  const dir = tempDir('cs-bak-');
  try {
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
      const f = path.join(dir, `claude.json.${i}.bak`);
      fs.writeFileSync(f, '{}');
      const t = new Date(now - (i === 5 ? 2 * 86_400_000 : i * 60_000));
      fs.utimesSync(f, t, t);
    }
    fs.writeFileSync(path.join(dir, 'other.txt'), 'kept');
    assert.equal(pruneBackups(dir, { now }), 3);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['claude.json.0.bak', 'claude.json.1.bak', 'claude.json.2.bak', 'other.txt']);
  } finally {
    rmDir(dir);
  }
});

test('routes that open terminals, change connections, read keys or search GitHub refuse other sites and plain requests', async () => {
  const s = await startServer();
  const spawned = [];
  s.app.overrides.spawnTerminal = (...a) => { spawned.push(a); return { on() {}, unref() {} }; };
  try {
    const host = `127.0.0.1:${s.port}`;
    const posts = [['/api/engines/terminal', { engine: 'claude', step: 'login' }], ['/api/connections/plan', { action: { kind: 'remove', ids: [] } }], ['/api/connections/apply', { id: 'x' }], ['/api/desktop/open', { kind: 'app' }], ['/api/skills/fetch', { url: 'https://github.com/a/b', picks: ['x'] }]];
    for (const [url, body] of posts) {
      const json = JSON.stringify(body);
      const evil = await s.raw('POST', url, { Host: host, Origin: 'https://evil.example', 'X-Circle': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }, json);
      assert.equal(evil.status, 403, `${url}: another website is refused`);
      const plain = await s.raw('POST', url, { Host: host, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }, json);
      assert.equal(plain.status, 403, `${url}: a form post without the header is refused`);
      const rebound = await s.raw('POST', url, { Host: 'attacker.example', 'X-Circle': '1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }, json);
      assert.equal(rebound.status, 403, `${url}: DNS rebinding (another Host) is refused`);
    }
    assert.equal(spawned.length, 0, 'no terminal was opened by any of them');
    const vault = await s.raw('GET', '/api/vault', { Host: host, Origin: 'https://evil.example' });
    assert.equal(vault.status, 403, 'another website cannot even list key names');
  } finally {
    await s.close();
  }
});
