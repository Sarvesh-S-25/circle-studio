// The two caches that keep the server light: a conversation file is summarised again only when it changes, and a
// folder's git state is reused for a short while (each look runs up to four git commands).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listConversations, folderKey } from '../../backend/lib/cchistory.mjs';
import { repoState } from '../../backend/lib/gitstatus.mjs';
import { writeConversation } from '../helpers/fake-history.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

const ID = '4b5da320-50f4-46c7-82d1-9f24bcb77564';

test('a conversation file is read again when it changes, not before', () => {
  const home = tempDir('circle-cache-home-');
  const root = tempDir('circle-cache-root-');
  try {
    writeConversation(home, root, { id: ID, title: 'First title', turns: [['First title', 'ok']] });
    const file = path.join(home, 'projects', folderKey(root), `${ID}.jsonl`);
    const t = new Date('2026-09-01T10:00:00Z');
    fs.utimesSync(file, t, t);
    assert.equal(listConversations(home, root).conversations[0].title, 'First title');
    // same size and time: the kept summary is used (the file is not read again)
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replaceAll('First title', 'Other title')); // same length, so the same size
    fs.utimesSync(file, t, t);
    assert.equal(listConversations(home, root).conversations[0].title, 'First title');
    // a real change (a later time): read again
    const t2 = new Date('2026-09-02T10:00:00Z');
    fs.utimesSync(file, t2, t2);
    assert.equal(listConversations(home, root).conversations[0].title, 'Other title');
  } finally {
    rmDir(home);
    rmDir(root);
  }
});

test('git state is kept for a moment and read again after', () => {
  const dir = tempDir('circle-cache-git-');
  try {
    const now = 1_000_000;
    assert.equal(repoState(dir, { maxAgeMs: 10_000, now }).isRepo, false);
    fs.mkdirSync(path.join(dir, '.git')); // not a real repository either: still read as "not git" when asked again
    assert.equal(repoState(dir, { maxAgeMs: 10_000, now: now + 5_000 }).isRepo, false);
    assert.equal(repoState(dir, { maxAgeMs: 0 }).isRepo, false);
  } finally {
    rmDir(dir);
  }
});
