// The app updater on throwaway repositories in the temp folder (never this folder or a project): it sees a newer
// remote read only, refuses while the copy has changes or commits of its own, and only ever fast-forwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkUpdate, applyUpdate } from '../../backend/lib/updater.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';
import { startServer } from '../helpers/server.mjs';

const ID = ['-c', 'user.name=Circle Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false'];
function git(cwd, ...args) {
  const r = spawnSync('git', [...ID, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

test('updater: zip copies, a newer remote, dirty and ahead copies are refused, fast-forward only', async () => {
  const base = tempDir('circle-upd-');
  try {
    const zip = path.join(base, 'zip');
    write(zip, 'package.json', '{"version":"1.0.0"}');
    const z = await checkUpdate(zip);
    assert.equal(z.mode, 'zip');
    assert.equal(z.canUpdate, false);
    assert.match(z.reason, /not cloned with git/);

    const origin = path.join(base, 'origin.git');
    fs.mkdirSync(origin);
    git(origin, 'init', '--bare', '-q');
    const dev = path.join(base, 'dev');
    fs.mkdirSync(dev);
    git(dev, 'init', '-q');
    write(dev, 'package.json', '{"version":"1.0.0"}');
    git(dev, 'add', '.');
    git(dev, 'commit', '-q', '-m', 'First');
    git(dev, 'remote', 'add', 'origin', origin);
    git(dev, 'push', '-q', '-u', 'origin', 'main');
    const app = path.join(base, 'app');
    git(base, 'clone', '-q', origin, app);

    let c = await checkUpdate(app);
    assert.equal(c.mode, 'git');
    assert.equal(c.available, false, 'up to date');

    write(dev, 'package.json', '{"version":"1.1.0"}');
    git(dev, 'commit', '-q', '-am', 'Add the widget');
    git(dev, 'push', '-q');
    c = await checkUpdate(app);
    assert.equal(c.available, true);
    assert.equal(c.canUpdate, true);
    assert.equal(c.version, '1.0.0');

    write(app, 'package.json', '{"version":"local edit"}');
    c = await checkUpdate(app);
    assert.equal(c.canUpdate, false);
    assert.match(c.reason, /changed in the app's folder/);
    assert.equal((await applyUpdate(app)).ok, false, 'never overwrites local changes');
    assert.equal(fs.readFileSync(path.join(app, 'package.json'), 'utf8'), '{"version":"local edit"}');
    git(app, 'checkout', '--', 'package.json');

    const r = await applyUpdate(app);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.version, '1.1.0');
    assert.deepEqual(r.changes, ['Add the widget']);
    assert.equal((await checkUpdate(app)).available, false);

    // a copy with its own commits is not moved
    write(app, 'notes.md', 'mine');
    git(app, 'add', '.');
    git(app, 'commit', '-q', '-m', 'Mine');
    write(dev, 'more.md', 'x');
    git(dev, 'add', '.');
    git(dev, 'commit', '-q', '-m', 'More');
    git(dev, 'push', '-q');
    c = await checkUpdate(app);
    assert.equal(c.available, true);
    assert.equal(c.canUpdate, false);
    assert.match(c.reason, /commits that are not on the remote/);
  } finally {
    rmDir(base);
  }
});

test('updater routes: the check and the update, with the restart handed to the launcher', async () => {
  let restarted = 0;
  const s = await startServer();
  try {
    s.app.overrides.checkUpdate = async () => ({ at: new Date().toISOString(), version: '1.0.0', mode: 'git', available: true, canUpdate: true, reason: null });
    s.app.overrides.applyUpdate = async () => ({ ok: true, from: 'a', to: 'b', changes: ['Add the widget'], version: '1.1.0' });
    s.app.overrides.restart = () => { restarted++; };
    const g = (await s.call('GET', '/api/update?check=1')).json;
    assert.equal(g.update.available, true);
    assert.equal((await s.call('GET', '/api/settings')).json.settings.updates.available, true);
    const a = (await s.call('POST', '/api/update', {})).json;
    assert.equal(a.ok, true);
    assert.equal(a.restarting, true);
    assert.equal(restarted, 1);
    s.app.overrides.applyUpdate = async () => ({ ok: false, message: '2 files are changed' });
    const bad = await s.call('POST', '/api/update', {});
    assert.equal(bad.status, 400);
    assert.match(bad.json.error.message, /changed/);
  } finally {
    await s.close();
  }
});
