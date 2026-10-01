// The installer and its commands, with every shortcut folder redirected to a temp folder (CIRCLE_SHORTCUT_DIR) and the
// engine checks skipped, so the real Desktop, Start menu and CLIs are never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir, rmDir } from '../helpers/project.mjs';

const CLI = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'circle.mjs');

test('installer: help, install makes the shortcuts, uninstall removes them and keeps the data', { skip: process.platform !== 'win32' }, () => {
  const shortcuts = tempDir('circle-sc-');
  const data = tempDir('circle-inst-data-');
  const env = { ...process.env, CIRCLE_SHORTCUT_DIR: shortcuts, CIRCLE_DATA: data, CIRCLE_SKIP_CHECKS: '1', CIRCLE_PORT: '4397', NO_COLOR: '1' };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  try {
    const help = run('help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /npm run setup/);
    assert.equal(run('nope').status, 1);

    const inst = run('install', '--yes', '--no-open', '--startup');
    assert.equal(inst.status, 0, inst.stderr);
    assert.match(inst.stdout, /Installed\./);
    for (const rel of ['Desktop/Circle Studio.lnk', 'Programs/Circle Studio.lnk', 'Startup/Circle Studio.lnk']) assert.ok(fs.existsSync(path.join(shortcuts, rel)), rel);
    assert.ok(fs.existsSync(path.join(data, 'circle-studio.ico')), 'the icon is drawn into the data folder');
    fs.writeFileSync(path.join(shortcuts, 'Desktop', 'mine - Circle Studio.lnk'), ''); // a project widget pinned from the app
    fs.writeFileSync(path.join(shortcuts, 'Desktop', 'Something else.lnk'), '');

    const un = run('uninstall', '--yes');
    assert.equal(un.status, 0, un.stderr);
    assert.deepEqual(fs.readdirSync(path.join(shortcuts, 'Desktop')), ['Something else.lnk'], 'only Circle Studio shortcuts go');
    assert.ok(!fs.existsSync(path.join(shortcuts, 'Startup', 'Circle Studio.lnk')));
    assert.ok(fs.existsSync(path.join(data, 'circle-studio.ico')), 'the data folder stays');

    assert.match(run('status').stdout, /Not running/);
    assert.equal(run('widget').status, 1, 'a widget needs a project id');
  } finally {
    rmDir(shortcuts);
    rmDir(data);
  }
});
