import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir, rmDir } from '../helpers/project.mjs';

const LAUNCH = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'launch.mjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const health = (port) => new Promise((resolve) => {
  http.get(`http://127.0.0.1:${port}/api/health`, { agent: false, timeout: 1500 }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve(null); } });
  }).on('error', () => resolve(null));
});

test('launcher: starts one hidden server, reuses it, refuses a foreign port, stops it', async () => {
  const dataDir = tempDir('circle-launch-data-');
  const port = await freePort();
  const env = { ...process.env, CIRCLE_PORT: String(port), CIRCLE_DATA: dataDir, CIRCLE_NO_OPEN: '1' };
  const run = (...args) => spawnSync(process.execPath, [LAUNCH, ...args], { env, encoding: 'utf8', timeout: 30_000 });
  try {
    assert.equal(run('--stop').status, 0, 'stopping when nothing runs is not an error');

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const h1 = await health(port);
    assert.equal(h1?.ok, true);
    assert.equal(h1.port, port);
    assert.equal(h1.dataDir, dataDir, 'the launcher passes the data folder through');
    assert.ok(fs.existsSync(path.join(dataDir, 'server.log')), 'server output goes to data/server.log');

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal((await health(port)).ok, true, 'a second launch leaves the same server running');

    const stop = run('--stop');
    assert.equal(stop.status, 0, stop.stderr);
    assert.match(stop.stdout, /stopped/i);
    assert.equal(await health(port), null, 'the server is gone after --stop');

    const other = http.createServer((q, s) => s.end('not circle studio'));
    await new Promise((r) => other.listen(port, '127.0.0.1', r));
    try {
      const clash = run();
      assert.equal(clash.status, 1, 'another program on the port is refused, not killed or shadowed');
      assert.match(clash.stderr, /used by another program/);
      assert.equal(run('--stop').status, 0, '--stop never kills a program that is not Circle Studio');
    } finally { await new Promise((r) => other.close(r)); }
  } finally {
    run('--stop');
    rmDir(dataDir);
  }
});

test('launcher: a running server older than the code on disk is restarted, a current one is reused', async () => {
  const dataDir = tempDir('circle-launch-data-');
  const port = await freePort();
  const env = { ...process.env, CIRCLE_PORT: String(port), CIRCLE_DATA: dataDir, CIRCLE_NO_OPEN: '1' };
  const run = (extra = {}, ...args) => spawnSync(process.execPath, [LAUNCH, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 40_000 });
  try {
    assert.equal(run().status, 0);
    const h1 = await health(port);
    assert.match(h1.code, /^[0-9a-f]{16}$/, 'the server reports the code it runs');
    assert.equal(h1.stale, false);
    const same = run();
    assert.doesNotMatch(same.stdout, /restarted/, 'current code: reused, not restarted');
    const updated = run({ CIRCLE_TEST_CODE: 'different0000000' });
    assert.equal(updated.status, 0, updated.stderr);
    assert.match(updated.stdout, /updated: restarted the server/);
    assert.equal((await health(port))?.ok, true, 'a fresh server answers after the restart');
    assert.match(fs.readFileSync(path.join(dataDir, 'server.log'), 'utf8'), /launcher: restarting: the running server is older/);
  } finally {
    run({}, '--stop');
    rmDir(dataDir);
  }
});
