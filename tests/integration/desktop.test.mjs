// Settings, the widget's pulse, git state, shortcut validation, and the alert rule: Windows is notified only while no
// Circle Studio window is open (an open window shows its own popup).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';
import { parseStatus, parseGithubUrl } from '../../backend/lib/gitstatus.mjs';

const ALL = { write: true, run: true, claude: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('git parsing: branch, upstream, ahead and behind; GitHub remotes', () => {
  assert.deepEqual(parseStatus('## main...origin/main [ahead 2, behind 1]\n M a.js\n?? b.md\n'), { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, changed: 2, untracked: 1, detached: false });
  assert.equal(parseStatus('## No commits yet on master\n').branch, 'master');
  assert.equal(parseStatus('## HEAD (no branch)\n').detached, true);
  assert.equal(parseStatus('## feat/x.y\n').branch, 'feat/x.y');
  assert.deepEqual(parseGithubUrl('https://github.com/acme/tool.git'), { owner: 'acme', repo: 'tool' });
  assert.deepEqual(parseGithubUrl('git@github.com:acme/tool.git'), { owner: 'acme', repo: 'tool' });
  assert.equal(parseGithubUrl('https://gitlab.com/acme/tool'), null);
});

test('desktop: settings, pulse, git, shortcut validation, and toasts only while no window is open', async () => {
  const toasts = [];
  const s = await startServer({ toast: (t) => { toasts.push(t); return true; } });
  const root = makeMiniProject();
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: ALL })).json.project.id;

    const st = (await s.call('GET', '/api/settings')).json;
    assert.equal(st.settings.desktopAlerts, true, 'alerts are on by default');
    assert.equal((await s.call('PUT', '/api/settings', { desktopAlerts: false })).json.settings.desktopAlerts, false);
    assert.equal((await s.call('PUT', '/api/settings', { updates: { check: 'hourly' } })).status, 400);
    await s.call('PUT', '/api/settings', { desktopAlerts: true });

    const pulse = (await s.call('GET', `/api/projects/${id}/pulse`)).json;
    assert.equal(pulse.project.id, id);
    assert.deepEqual(pulse.pending, []);
    assert.equal(pulse.repo.isRepo, false, 'a temp folder is not a repository');
    assert.ok(pulse.workflow?.stages.length >= 1, 'the discovered workflow has a stage');
    assert.equal(pulse.lastConversation, null);

    const git = (await s.call('GET', `/api/projects/${id}/git`)).json;
    assert.deepEqual(git, { ok: true, repo: { isRepo: false }, githubEnabled: false, github: null });
    assert.equal((await s.call('PUT', `/api/projects/${id}/git/github`, { on: true })).json.githubEnabled, true);
    assert.equal((await s.call('GET', '/api/settings')).json.settings.github[id], true);

    // shortcuts: bad input is refused before anything is written
    assert.equal((await s.call('POST', '/api/desktop/shortcut', { where: 'taskbar' })).status, process.platform === 'win32' ? 400 : 503);
    if (process.platform === 'win32') assert.equal((await s.call('POST', '/api/desktop/shortcut', { where: 'startup', projectId: id })).status, 400);
    if (process.platform === 'win32') assert.equal((await s.call('POST', '/api/desktop/shortcut', { where: 'startup', overview: true })).status, 400);

    // an agent asks while no window is open: Windows is told
    process.env.FAKE_CLAUDE = 'bash';
    const run = s.sse('/api/chat', { projectId: id, message: 'run it' });
    for (let i = 0; i < 100 && !toasts.length; i++) await sleep(50);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].title, /asks to go ahead/);
    assert.match(toasts[0].url, /#\/inbox$/);
    const pending = (await s.call('GET', `/api/requests?status=pending&projectId=${id}`)).json.requests[0];
    assert.equal((await s.call('GET', `/api/projects/${id}/pulse`)).json.pending[0].id, pending.id, 'the widget sees what waits');
    await s.call('POST', `/api/requests/${pending.id}/respond`, { decision: 'deny' });
    await run;

    // with a window open (an event stream), the window shows it: no Windows toast
    const ctl = new AbortController();
    const stream = fetch(`${s.base}/api/events`, { signal: ctl.signal }).then((r) => r.body.getReader().read()).catch(() => {});
    for (let i = 0; i < 40 && s.app.viewers.count === 0; i++) await sleep(25);
    assert.equal(s.app.viewers.count, 1);
    const run2 = s.sse('/api/chat', { projectId: id, message: 'again' });
    let p2;
    for (let i = 0; i < 100 && !p2; i++) { p2 = (await s.call('GET', `/api/requests?status=pending&projectId=${id}`)).json.requests[0]; if (!p2) await sleep(50); }
    assert.ok(p2);
    assert.equal(toasts.length, 1, 'no toast while a window is open');
    await s.call('POST', `/api/requests/${p2.id}/respond`, { decision: 'deny' });
    await run2;
    ctl.abort();
    await stream;
    for (let i = 0; i < 40 && s.app.viewers.count > 0; i++) await sleep(25);
    assert.equal(s.app.viewers.count, 0);

    // a team question appears in ALERTS.md while nobody looks: the poller tells Windows
    fs.mkdirSync(path.join(root, 'docs', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'tasks', 'ALERTS.md'), '# Alerts\n\n## A-002 — Which database?\n\n- **Status:** open\n- **Question for the human:** Postgres or SQLite?\n');
    s.app.pollAlerts();
    assert.equal((await s.call('GET', '/api/alerts')).json.alerts.length, 1);
    assert.ok(toasts.some((t) => /team has a question/.test(t.title)), 'an open team question is announced');
  } finally {
    delete process.env.FAKE_CLAUDE;
    s.app.stopDesktop();
    await s.close();
    rmDir(root);
  }
});
