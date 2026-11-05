import { badRequest } from './lib/errors.mjs';
import { readBoard } from './lib/health.mjs';
import { engineChildren } from './lib/engines/proc.mjs';
import { measureOwnedProcesses } from './lib/diagnostics.mjs';
import { desktopWidgets } from './lib/deskhost.mjs';

export function buildProductHandlers(app) {
  let measurement = null;
  return {
    'system.notifications.test': ({ body }) => {
      const engine = body?.engine || 'codex';
      if (!app.engines.adapter(engine)) throw badRequest('Choose an installed notification test engine.');
      return app.testNotification(engine);
    },
    'projects.chat.select': ({ params, body }) => { app.projects.get(params.id); if (!app.engines.adapter(body?.engine)) throw badRequest('Unknown engine.'); return app.chats.selectTarget(params.id, body.nodeId || null, body.engine, body.model, body.reasoning); },
    'chat.queue.get': ({ query }) => { const projectId = query.get('projectId'); app.projects.get(projectId); return { entries: app.queue.list(projectId, query.get('nodeId') || null) }; },
    'chat.queue.save': async ({ body }) => {
      if (body?.id) return { entry: app.queue.change(body.id, body.action, body.message) };
      return { entry: await app.queue.enqueue({ projectId: body?.projectId, nodeId: body?.nodeId || null, engineId: body?.engine, model: body?.model, reasoning: body?.reasoning, conversationId: body?.conversationId, message: body?.message, clientId: body?.clientId }) };
    },
    'system.diagnostics': async ({ query }) => {
      let owned = null;
      if (query?.get('processes') === '1') { measurement ||= measureOwnedProcesses([process.pid, desktopWidgets(app.config).status().pid, ...engineChildren().map((c) => c.pid)]).finally(() => { measurement = null; }); owned = await measurement; }
      return { at: new Date().toISOString(), node: process.version, platform: process.platform, uptimeSeconds: process.uptime(), memory: process.memoryUsage(), cpuMicroseconds: process.cpuUsage(), historyCache: app.chats.cacheStats(), subscriptions: { viewers: app.viewers.count, browserNotifiers: app.viewers.notifiers, sessionListeners: app.sessions.listeners.size }, engineChildren: engineChildren(), owned, engineRuns: app.sessions.runs.size, adviceRuns: app.advice.active.size, pendingRequests: app.inbox.list({ status: 'pending' }).length, rpcNote: 'Memory is for the Node server only. Use Measure owned processes for an explicit Windows sample. Desktop/browser/provider processes are separate; shared browser memory cannot be attributed exactly.' };
    },
    'storage.get': () => app.storage.inspect(),
    'storage.reindex': () => { if (app.sessions.runs.size || app.inbox.list({ status: 'pending' }).length) throw badRequest('Finish active runs and requests before rebuilding history indexes.'); return app.chats.rebuildIndexes(); },
    'storage.cleanup': ({ body }) => body?.id ? app.storage.cleanup(body.id) : app.storage.cleanupPreview(),
    'storage.backup': ({ body }) => body?.download === true ? app.storage.prepareDownload() : ({ backup: app.storage.backup() }),
    'storage.download': ({ params, attachment }) => attachment(app.storage.readDownload(params.token)),
    'storage.restore': ({ body }) => body?.id ? app.storage.restore(body.id) : app.storage.preview(body?.backup),
    'projects.progress.get': ({ params }) => { const p = app.projects.get(params.id); const board = readBoard(p.path, { limit: 2000 }); return { ...app.progress.read(params.id, { achievements: app.settings.get().achievements === true }), board: { rows: board.rows, dropped: board.dropped || [], total: board.total || 0 } }; },
    'projects.progress.save': async ({ params, body }) => {
      const p = app.projects.get(params.id);
      if (!body || typeof body !== 'object') throw badRequest('Send a task.');
      if (body.action === 'record-handoff') {
        if (!app.engines.adapter(body.sourceEngine) || !app.engines.adapter(body.targetEngine)) throw badRequest('Choose supported handoff engines.');
        const key = app.sessions.chatKey(params.id, body.nodeId || null, body.sourceEngine);
        const source = app.chats.read(key, body.conversationId, { limit: 1 });
        return { handoff: await app.progress.recordHandoff(params.id, { ...body, sourceMessages: source.totalMessages }) };
      }
      if (body.action === 'reset-achievements') return app.progress.resetAchievements(params.id);
      if (body.action === 'import-board') {
        const board = readBoard(p.path, { limit: 2000 });
        const existing = new Set(app.progress.read(params.id).tasks.map((t) => t.importedFrom));
        let imported = 0;
        for (const row of board.rows) if (!existing.has(row.id)) {
          await app.progress.save(params.id, { title: row.summary || row.id, owner: row.owner, importedFrom: row.id, detail: `Imported from docs/tasks/BOARD.md (${row.id}); original status: ${row.status}.`, status: /^(cancelled|superseded)/i.test(row.status) ? 'cancelled' : /^(done|closed)/i.test(row.status) ? 'review' : /blocked/i.test(row.status) ? 'blocked' : 'planned' }, app.workflows.head(p)); imported++;
        }
        return { imported, ...app.progress.read(params.id, { achievements: app.settings.get().achievements === true }) };
      }
      const task = await app.progress.save(params.id, body, app.workflows.head(p));
      return { task, ...app.progress.read(params.id, { achievements: app.settings.get().achievements === true }) };
    },
  };
}
