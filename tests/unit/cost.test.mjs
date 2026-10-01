// The Cost tab's numbers: prices, what loads before you type, usage measured from Claude Code transcripts (one
// answer counted once even when written over several lines), and the problems that cost money.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { priceOf, costOf } from '../../backend/lib/pricing.mjs';
import { contextWeight, measuredUsage, projectCost } from '../../backend/lib/cost.mjs';
import { writeConversation } from '../helpers/fake-history.mjs';
import { tempDir, rmDir } from '../helpers/project.mjs';

test('prices: aliases, dated ids, cache rates', () => {
  assert.equal(priceOf('sonnet').id, 'claude-sonnet-5-5');
  assert.equal(priceOf('claude-haiku-4-5-20251001').id, 'claude-haiku-4-5');
  assert.equal(priceOf('gpt-5'), null);
  // 1M in, 1M out, 1M 1h cache write, 1M cache read at Sonnet 5.5: 2 + 10 + 4 + 0.2
  assert.equal(costOf('claude-sonnet-5-5', { input: 1e6, output: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6 }).toFixed(2), '16.20');
  assert.equal(costOf('claude-opus-5', { cacheRead: 1e6 }).toFixed(2), '0.50', 'no listed cache price: a tenth of input');
});

test('cost: context weight, measured usage, issues and suggestions', async () => {
  const root = tempDir('circle-cost-');
  const home = tempDir('circle-cost-home-');
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  try {
    w('CLAUDE.md', `# Rules\n\nRead @docs/guide.md first.\n\n${'Keep it short. '.repeat(1400)}`);
    w('docs/guide.md', 'x'.repeat(4000));
    w('.claude/agents/doc-updater.md', '---\nname: doc-updater\ndescription: Updates the docs and the changelog.\nmodel: opus\n---\n\nUpdate docs.\n');
    w('.claude/agents/architect.md', '---\nname: architect\ndescription: Designs the system.\nmodel: opus\n---\n\nDesign.\n');
    w('.claude/agents/helper.md', '---\nname: helper\ndescription: Helps.\n---\n\nHelp.\n');
    w('.claude/skills/deploy/SKILL.md', `---\nname: deploy\ndescription: ${'when deploying '.repeat(80)}\n---\n\nSteps.\n`);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'CLAUDE.md'), 'My global rules.');

    const weight = contextWeight(root, { claudeHome: home });
    const paths = weight.always.map((x) => x.path);
    assert.ok(paths.includes('CLAUDE.md') && paths.includes('docs/guide.md'), 'CLAUDE.md and its @import');
    assert.ok(paths.includes('~/.claude/CLAUDE.md'), 'your own instructions count in every project');
    assert.equal(weight.always.find((x) => x.path === 'docs/guide.md').tokens, 1000);
    assert.ok(weight.onUse.some((x) => x.kind === 'agent'));

    const now = Date.parse('2026-09-20T12:00:00Z');
    writeConversation(home, root, { id: '0b5da320-50f4-46c7-82d1-9f24bcb77565', title: 'Build', turns: [['a', 'b'], ['c', 'd']], at: '2026-09-20T10:00:00.000Z', agents: [] });
    const u = await measuredUsage(root, { claudeHome: home, now });
    assert.equal(u.found, true);
    assert.equal(u.total.answers, 2, 'an answer written over two lines counts once');
    assert.equal(u.total.cacheRead, 2000);
    assert.equal(u.total.cacheWrite1h, 400);
    assert.equal(u.byModel[0].name, 'Sonnet 5.5');
    assert.ok(u.total.usd > 0);
    assert.equal(u.byDay.length, 30);

    const wf = { nodes: [{ id: 'doc-updater', kind: 'agent', title: 'doc-updater', engine: 'claude', model: 'opus', does: 'Updates the docs' }, { id: 'architect', kind: 'agent', title: 'architect', engine: 'claude', model: 'opus' }, { id: 'helper', kind: 'agent', title: 'helper', engine: 'claude' }, { id: 'g', kind: 'agent', title: 'g', engine: 'gemini' }] };
    const c = await projectCost(root, { claudeHome: home, workflow: wf, chats: [{ role: 'assistant', costUsd: 0.25 }] });
    const ids = c.issues.map((i) => i.id);
    assert.ok(ids.includes('overkill:doc-updater'), 'a routine agent on Opus is flagged');
    assert.ok(!ids.includes('overkill:architect'), 'design work may stay on Opus');
    assert.ok(ids.includes('inherit:helper'), 'an agent with no model is flagged');
    assert.ok(ids.includes('claude-md-long'));
    assert.ok(ids.some((i) => i.startsWith('skill-desc:')));
    assert.deepEqual(c.issues.find((i) => i.id === 'overkill:doc-updater').fix, { agent: 'doc-updater', model: 'sonnet' });
    assert.equal(c.agents.find((a) => a.id === 'g').price, null, 'other engines are not priced here');
    assert.equal(c.circle.usd, 0.25);
  } finally {
    rmDir(root);
    rmDir(home);
  }
});
