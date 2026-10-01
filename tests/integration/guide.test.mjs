// Ask Circle: built-in help with no engine, and a read-only answer from an engine run in the app's own empty folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { TRACE, runsOf } from '../helpers/trace.mjs';
import { searchHelp } from '../../backend/lib/guide.mjs';

test('guide: help search finds the right topics', () => {
  assert.equal(searchHelp('how do I remove a link between agents')[0].id, 'workflow');
  assert.equal(searchHelp('why is it so expensive, which model is cheaper')[0].id, 'cost');
  assert.equal(searchHelp('pin a widget on my desktop')[0].id, 'widget');
  assert.deepEqual(searchHelp('xyzzy'), []);
});

test('guide: built-in help only, and an engine answer run read-only outside every project', async () => {
  const log = TRACE();
  process.env.FAKE_CLAUDE_LOG = log;
  const s = await startServer();
  try {
    const none = (await s.call('POST', '/api/guide', { message: 'where do I answer my agents', engine: 'none' })).json;
    assert.equal(none.reply, null);
    assert.equal(none.topics[0].id, 'inbox');
    assert.equal(runsOf(log).filter((r) => r.prompt !== undefined).length, 0, 'no engine was asked');

    const r = (await s.call('POST', '/api/guide', { message: 'where do I answer my agents' })).json;
    assert.equal(r.engine.id, 'claude');
    assert.ok(r.reply && r.reply.length > 0);
    const run = runsOf(log).find((x) => x.prompt !== undefined);
    assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(path.join(s.dataDir, 'guide')), 'runs in the app\'s empty guide folder');
    assert.match(run.prompt, /Ask Circle/);
    assert.equal((await s.call('POST', '/api/guide', {})).status, 400);
  } finally {
    delete process.env.FAKE_CLAUDE_LOG;
    await s.close();
  }
});
