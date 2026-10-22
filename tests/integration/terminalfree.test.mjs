// Things that used to need a terminal, done from the app: signing out of GitHub (gh keeps the token; tests never run
// the real gh), and old backups of ~/.claude.json, which may hold keys, removed after a day even when no fix runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';
import { pruneBackups } from '../../backend/lib/mcpmanage.mjs';

test('Sign out of GitHub is a button: the route answers with the new state', async () => {
  const s = await startServer();
  try {
    const r = await s.call('POST', '/api/github/signout', {});
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.github.signedIn, false);
    assert.ok(r.json.github.setup, 'the sign-in steps come back, to sign in again');
  } finally {
    await s.close();
  }
});

test('old backups that may hold keys go after a day; the newest recent ones stay', () => {
  const dir = tempDir('circle-bak-');
  try {
    const now = Date.now();
    const put = (name, ageH) => { const f = path.join(dir, name); fs.writeFileSync(f, '{}'); const t = new Date(now - ageH * 3600_000); fs.utimesSync(f, t, t); };
    put('claude.json.old-1.bak', 400);
    put('claude.json.old-2.bak', 300);
    put('claude.json.new.bak', 1);
    put('notes.txt', 400); // not a backup: left alone
    assert.equal(pruneBackups(dir, { now }), 2);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['claude.json.new.bak', 'notes.txt']);
  } finally {
    rmDir(dir);
  }
});
