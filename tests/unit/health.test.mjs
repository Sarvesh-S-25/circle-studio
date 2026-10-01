import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { computeHealth } from '../../backend/lib/health.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';

const JARGON = /\b(freeze\.json|lane|tier|ADR is|roster|\$\{VAR)/;

test('health says what needs you first, in plain words, with the technical facts kept for Details', async () => {
  const root = makeMiniProject();
  try {
    fs.writeFileSync(path.join(root, '.claude/state/freeze.json'), '{"frozen": ["backend"], "request_id": "CH-4", "paths": ["x"]}\n');
    const h = await computeHealth(root, { projectId: 'p1' });
    const now = h.items.filter((i) => i.group === 'now').map((i) => i.id);
    assert.deepEqual(now.sort(), ['adr', 'freeze', 'secrets']);
    assert.equal(h.summary, '3 things need you now');
    const freeze = h.items.find((i) => i.id === 'freeze');
    assert.equal(freeze.title, 'Backend work is paused');
    assert.match(freeze.detail, /Change CH-4 paused it\. be-builder, migrator cannot change anything/);
    assert.match(freeze.tech, /paths/, 'the jargon moved to Details, it did not disappear');
    assert.equal(freeze.fix.ops[0].op, 'freeze-set');
    assert.match(h.items.find((i) => i.id === 'adr').title, /^1 decision waits for your OK$/);
    for (const i of h.items) assert.ok(!JARGON.test(i.title), `plain title: ${i.title}`);
    assert.ok(!JSON.stringify(h).includes('abcdefghijklmnop1234'), 'no secret');
    const order = h.items.map((i) => i.group);
    assert.deepEqual(order, [...order].sort((a, b) => ['now', 'look', 'fine'].indexOf(a) - ['now', 'look', 'fine'].indexOf(b)), 'needs-you-now first, all-good last');
    assert.equal(h.items.find((i) => i.id === 'brief').link.href, '#/projects/p1/workflow');
  } finally { rmDir(root); }
});

test('a healthy project says so in one line', async () => {
  const root = makeMiniProject();
  try {
    fs.writeFileSync(path.join(root, '.mcp.json'), '{"mcpServers": {}}\n');
    fs.writeFileSync(path.join(root, 'docs/adr/001-stack.md'), '# ADR 001\n\n- **Status:** accepted\n');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/brief.md'), '# Brief\n');
    const h = await computeHealth(root);
    assert.equal(h.counts.now, 0);
    assert.match(h.summary, /^Nothing is blocked\. \d+ things? worth a look\.$|^All good\. Nothing needs you\.$/);
  } finally { rmDir(root); }
});
