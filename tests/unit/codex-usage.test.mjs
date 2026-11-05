import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { codexUsage } from '../../backend/lib/usage.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

test('Codex counters account by event day across resumed old sessions, model changes, resets and partial UTF-8 writes', async () => {
  const dir = tempDir();
  try {
    const folder = path.join(dir, 'sessions', '2020', '01', '01'); fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'session.jsonl');
    const meta = (cwd) => ({ type: 'session_meta', payload: { cwd, timestamp: '2020-01-01T00:00:00Z' } });
    const context = (model) => ({ type: 'turn_context', payload: { model } });
    const count = (date, input, output) => ({ type: 'event_msg', timestamp: date, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, output_tokens: output, reasoning_output_tokens: output } } } });
    const rows = [meta(path.join(dir, 'one', 'same')), context('model-a'), count('2026-10-21T23:59:00Z', 100, 10), context('model-b'), count('2026-10-22T00:01:00Z', 150, 30), count('2026-10-22T00:02:00Z', 10, 5)];
    fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
    const opts = { days: 3, now: Date.parse('2026-10-22T12:00:00Z') };
    let usage = await codexUsage(dir, opts);
    assert.equal(usage.tokensIn, 160); assert.equal(usage.tokensOut, 35, 'reasoning is already part of output');
    assert.equal(usage.byDay.find((d) => d.date === '2026-10-22').tokens, 85);
    assert.deepEqual(await codexUsage(dir, opts), usage, 'unchanged files retain their totals');
    const partial = Buffer.from(JSON.stringify({ type: 'turn_context', payload: { model: '模型' } }) + '\n');
    const split = partial.indexOf(Buffer.from('模型')) + 1;
    fs.appendFileSync(file, partial.subarray(0, split)); await codexUsage(dir, opts);
    fs.appendFileSync(file, Buffer.concat([partial.subarray(split), Buffer.from(JSON.stringify(count('2026-10-22T01:00:00Z', 20, 7)) + '\n')]));
    usage = await codexUsage(dir, opts); assert.equal(usage.tokensIn, 170); assert.equal(usage.tokensOut, 37);
    fs.writeFileSync(path.join(folder, 'other.jsonl'), [meta(path.join(dir, 'two', 'same')), count('2026-10-22T01:00:00Z', 9, 1)].map(JSON.stringify).join('\n'));
    usage = await codexUsage(dir, opts); assert.equal(usage.byFolder.length, 2, 'same basenames remain separate folders');
    fs.writeFileSync(file, [meta(path.join(dir, 'one', 'same')), count('2026-10-22T02:00:00Z', 2, 1)].map(JSON.stringify).join('\n'));
    usage = await codexUsage(dir, opts); assert.equal(usage.tokensIn, 11, 'truncation rebuilds counters');
  } finally { rmDir(dir); }
});
