import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';

const ALL = { write: true, run: true, claude: true };
const ALERTS = `# Alerts

## A-002 — Which database?

- **Status:** open
- **Raised:** 2026-09-30 by texter, from ADR 003
- **Question for the human:** Postgres or SQLite?
- **Options:** Postgres; SQLite
- **Blocks:** be-builder

## A-001 — Port clash

- **Status:** answered
- **Raised:** 2026-09-29 by texter, from trail.md
- **Question for the human:** Keep port 3000?
`;

test('alerts over HTTP: list, answer through the diff-first path, tracker-visible result', async () => {
  const s = await startServer();
  const root = makeMiniProject();
  const file = path.join(root, 'docs', 'tasks', 'ALERTS.md');
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;
    assert.deepEqual((await s.call('GET', '/api/alerts')).json.alerts, [], 'no ALERTS.md, no alerts');
    fs.writeFileSync(file, ALERTS);

    const open = (await s.call('GET', '/api/alerts')).json.alerts;
    assert.deepEqual(open.map((a) => a.id), ['A-002']);
    assert.equal(open[0].projectId, id);
    assert.equal(open[0].question, 'Postgres or SQLite?');
    assert.deepEqual((await s.call('GET', '/api/alerts?status=all')).json.alerts.map((a) => a.id), ['A-002', 'A-001']);
    assert.equal((await s.call('GET', '/api/alerts?status=nope')).status, 400);

    const attn = (await s.call('GET', '/api/state')).json.attention.find((x) => x.projectId === id);
    assert.ok(attn?.items.some((i) => i.title === '1 team question' && i.severity === 'warn'), 'Home and the taskbar count the open question');
    const attentionBefore = (await s.call('GET', '/api/stats')).json.totals.attention;

    const ops = [{ op: 'alert-answer', id: 'A-002', answer: 'SQLite, local only' }];
    const pv = await s.call('POST', '/api/changes/preview', { projectId: id, ops });
    assert.equal(pv.status, 200);
    assert.deepEqual(pv.json.files.map((f) => [f.path, f.diff.added, f.diff.removed]), [['docs/tasks/ALERTS.md', 2, 1]]);
    assert.equal(fs.readFileSync(file, 'utf8'), ALERTS, 'the preview wrote nothing');

    fs.appendFileSync(file, '\n');
    const stale = await s.call('POST', '/api/changes/apply', { id: pv.json.id });
    assert.equal(stale.status, 409, 'a file that changed since the preview is not overwritten');

    const pv2 = await s.call('POST', '/api/changes/preview', { projectId: id, ops });
    const ap = await s.call('POST', '/api/changes/apply', { id: pv2.json.id });
    assert.equal(ap.status, 200);
    assert.deepEqual(ap.json.applied, ['docs/tasks/ALERTS.md']);
    assert.ok(ap.json.backup, 'the old version was backed up');

    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /- \*\*Status:\*\* answered\n- \*\*Raised:\*\* 2026-09-30/);
    assert.match(text, /- \*\*Answer:\*\* SQLite, local only \(human, via Circle Studio, \d{4}-\d{2}-\d{2}\)/);
    assert.deepEqual((await s.call('GET', '/api/alerts')).json.alerts, [], 'nothing is left open');
    assert.equal((await s.call('GET', '/api/stats')).json.totals.attention, attentionBefore - 1, 'answering clears the Home count by exactly one');

    const again = await s.call('POST', '/api/changes/preview', { projectId: id, ops });
    assert.equal(again.status, 409, 'answering twice is refused');
    const noWrite = await s.call('PUT', `/api/projects/${id}/permissions`, { permissions: { write: false, run: false, claude: true } });
    assert.equal(noWrite.status, 200);
    fs.writeFileSync(file, ALERTS);
    assert.notEqual((await s.call('POST', '/api/changes/preview', { projectId: id, ops })).status, 200, 'a project without write permission cannot be written');
  } finally { await s.close(); rmDir(root); }
});
