import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';
import { createCodexAdapter } from '../../backend/lib/engines/codex.mjs';
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));

test('the notification test awaits asynchronous OS submission and never reports a failed helper as submitted', async () => {
  let delivered = false;
  const s = await startServer({ toast: async () => { await pause(); return delivered; } });
  try {
    const failed = await s.call('POST', '/api/system/notifications/test', { engine: 'claude' });
    assert.equal(failed.json.requested, false, 'a Promise is not proof of OS submission');
    delivered = true;
    const succeeded = await s.call('POST', '/api/system/notifications/test', { engine: 'claude' });
    assert.equal(succeeded.json.requested, true);
    assert.equal(s.app.sessions.runs.size, 0, 'notification tests start no model turn');
  } finally { await s.close(); }
});

test('Codex short turns notify, browser-denied windows get native fallback, and completion controls preserve audit', async () => {
  const toasts = [];
  const s = await startServer({ toast: (n) => toasts.push(n), adapters: () => [createCodexAdapter({ bin: process.execPath, prefixArgs: [path.resolve('tests/helpers/fake-engines.mjs'), 'codex'] })] });
  const root = makeMiniProject(); const ctl = new AbortController(); let stream;
  try {
    const id = (await s.call('POST', '/api/projects', { path: root, permissions: { engine: true, run: true } })).json.project.id;
    stream = fetch(`${s.base}/api/events?notifications=denied`, { signal: ctl.signal }).then(async (r) => { const reader = r.body.getReader(); while (!(await reader.read()).done) {} }).catch(() => {});
    for (let i = 0; i < 100 && !s.app.viewers.count; i++) await pause();
    assert.equal(s.app.viewers.notifiers, 0);
    async function turn() {
      const running = s.sse('/api/chat', { projectId: id, engine: 'codex', message: 'Dummy notification check' });
      let request;
      for (let i = 0; i < 150 && !request; i++) { request = s.app.inbox.list({ status: 'pending', projectId: id })[0]; if (!request) await pause(); }
      assert.ok(request, 'Codex approval reached the shared Inbox');
      await s.call('POST', `/api/requests/${request.id}/respond`, { decision: 'deny' });
      await running;
    }
    await turn();
    const completed = s.app.notices.list().notices.find((n) => n.kind === 'done');
    assert.equal(completed.engine, 'codex'); assert.match(completed.title, /Codex finished/);
    assert.match(completed.url, new RegExp(`/codex/${completed.conversationId}$`));
    assert.ok(toasts.some((n) => /Codex finished/.test(n.title)), 'a browser without notification permission cannot suppress the native completion fallback');
    assert.ok(toasts.some((n) => /Codex asks/.test(n.title)));
    assert.equal(s.app.chats.read(s.app.sessions.chatKey(id, null, 'codex'), completed.conversationId).totalMessages, 2);
    const before = toasts.length;
    await s.call('PUT', '/api/settings', { desktopNotifications: { done: false } });
    await turn();
    assert.ok(toasts.slice(before).every((n) => !/finished/.test(n.title)), 'completion preference suppresses delivery');
    assert.equal(s.app.notices.list().notices.filter((n) => n.kind === 'done').length, 2, 'separate quick runs do not collapse into one notice');
  } finally { ctl.abort(); await stream; await s.close(); rmDir(root); }
});
