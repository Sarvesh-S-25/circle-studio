// A running Circle Studio with newer code on disk: /api/code says so, Restart now goes through the launcher, and the
// server restarts by itself once nothing runs or waits and the code has stopped changing (services.desktop.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../backend/lib/store.mjs';
import { createDesktopServices } from '../../backend/services.desktop.mjs';
import { startServer } from '../helpers/server.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

test('/api/code and Restart now: nothing to do while the code is current', async () => {
  const s = await startServer();
  try {
    const c = (await s.call('GET', '/api/code')).json;
    assert.equal(c.stale, false);
    assert.match(c.code, /^[0-9a-f]{16}$/);
    assert.match(c.ui, /^[0-9a-f]{16}$/);
    assert.equal(c.autoRestart, true, 'on unless turned off');
    assert.equal(c.busy, 0);
    let restarted = 0;
    s.app.overrides.restart = () => { restarted++; };
    const r = (await s.call('POST', '/api/restart', {})).json;
    assert.equal(r.restarting, false);
    assert.equal(restarted, 0, 'no restart when it already runs the newest code');
    await s.call('PUT', '/api/settings', { updates: { autoRestart: false } });
    assert.equal((await s.call('GET', '/api/code')).json.autoRestart, false);
    assert.equal((await s.call('GET', '/api/update')).json.autoRestart, false);
  } finally { await s.close(); }
});

test('it restarts by itself only when the newer code has settled and nothing runs or waits', async () => {
  const appRoot = tempDir('cs-fresh-root-');
  const dataDir = tempDir('cs-fresh-data-');
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(appRoot, rel)), { recursive: true }); fs.writeFileSync(path.join(appRoot, rel), text); };
  write('backend/a.mjs', 'export const a = 1;\n');
  write('contracts/api.json', '{}');
  let restarts = 0;
  const pending = [];
  const sessions = { runs: new Map(), inbox: { list: () => pending }, subscribe: () => () => {} };
  const d = createDesktopServices({ config: { appRoot, port: 0, userHome: dataDir, codexHome: dataDir }, store: new Store(dataDir), projects: { list: () => [] }, sessions, overrides: { restart: () => { restarts++; }, toast: () => false } });
  try {
    assert.equal(d.isStale(), false);
    assert.equal(d.autoRestart(), false);
    write('backend/a.mjs', 'export const a = 2; // an update\n');
    assert.equal(d.isStale(), true);
    assert.equal(d.autoRestart(), false, 'first sight of the new code: wait a minute in case it is still being written');
    sessions.runs.set('p:project', {});
    assert.equal(d.autoRestart(), false, 'a chat is running');
    sessions.runs.clear();
    pending.push({ id: 'r1' });
    assert.equal(d.autoRestart(), false, 'a question waits for an answer');
    pending.length = 0;
    await d.settings.set({ updates: { ...d.settings.get().updates, autoRestart: false } });
    assert.equal(d.autoRestart(), false, 'turned off in Settings');
    await d.settings.set({ updates: { ...d.settings.get().updates, autoRestart: true } });
    d.autoRestart();
    assert.equal(d.autoRestart(), true);
    assert.equal(restarts, 1);
    assert.equal(d.restartIntoNewCode(), true);
    assert.equal(restarts, 1, 'once');
  } finally { d.stopDesktop(); rmDir(appRoot); rmDir(dataDir); }
});
