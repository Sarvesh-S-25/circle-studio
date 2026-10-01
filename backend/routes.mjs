// One handler per route id in contracts/api.json. A handler gets { app, params, query, body, sse, signal }
// and returns the data for `{ ok: true, ...data }` (or takes over the response through sse()).
import { badRequest, forbidden, tooLarge } from './lib/errors.mjs';
import { isSensitiveName, resolveInside, toPosix } from './lib/paths.mjs';
import { redact } from './lib/secrets.mjs';
import { inspectTeam } from './lib/team.mjs';
import { computeHealth, quickAttention } from './lib/health.mjs';
import { str, readTextFile } from './lib/route-helpers.mjs';
import { buildEngineHandlers } from './routes.engines.mjs';
import { buildWorkflowHandlers } from './routes.workflow.mjs';
import { buildDesktopHandlers } from './routes.desktop.mjs';
import { buildConnectionHandlers } from './routes.connections.mjs';
import { buildCatalogHandlers } from './routes.catalog.mjs';
import { LIMITS } from './lib/skills.mjs';
import { computeStats } from './lib/stats.mjs';
import { codeFingerprint } from './lib/codeversion.mjs';
import { listConversations, readConversation, agentRuns, SESSION_RE, AGENT_RUN_RE } from './lib/cchistory.mjs';
import { notFound } from './lib/errors.mjs';

function decodeFiles(list) {
  if (!Array.isArray(list) || !list.length || list.length > 400) throw badRequest('Send between 1 and 400 files.');
  let total = 0;
  return list.map((f) => {
    if (!f || typeof f.path !== 'string' || typeof f.data !== 'string') throw badRequest('Each file needs a path and data.');
    const buffer = f.encoding === 'base64' ? Buffer.from(f.data, 'base64') : Buffer.from(f.data, 'utf8');
    total += buffer.length;
    if (total > LIMITS.requestBytes) throw tooLarge('More than 40 MB in one import.');
    return { path: f.path, buffer };
  });
}

export function buildHandlers(app) {
  const { projects, library, chats, claude, github, changes, config } = app;

  return {
    ...buildEngineHandlers(app),
    ...buildWorkflowHandlers(app),
    ...buildDesktopHandlers(app),
    ...buildConnectionHandlers(app),
    ...buildCatalogHandlers(app),

    'app.health': async () => {
      const auth = await claude.authStatus();
      return {
        node: process.version,
        port: config.port,
        dataDir: config.dataDir,
        claude: { ...auth, version: auth.installed ? await claude.version() : null },
        projectsRoot: config.projectsRoot,
        github: { token: Boolean(config.githubToken) },
        // the code this server runs, and whether newer code is on disk (then it needs a restart)
        code: app.codeAtStart,
        stale: app.codeAtStart !== codeFingerprint(config.appRoot),
      };
    },

    'app.state': () => {
      const recent = projects.list().slice(0, 6);
      return {
        recent,
        mostUsed: library.mostUsed(6),
        skillCount: library.list().length,
        attention: recent.filter((p) => p.exists && p.isTeamProject).slice(0, 4).map((p) => ({ projectId: p.id, name: p.name, items: quickAttention(p.path) })).filter((a) => a.items.length),
      };
    },

    // Questions a project's texter raised for the human (docs/tasks/ALERTS.md), across every registered project.
    // Answering goes through changes.preview / changes.apply with the alert-answer op, like every other write.
    'alerts.list': ({ query }) => {
      const status = query.get('status') || 'open';
      if (status !== 'open' && status !== 'all') throw badRequest('status must be open or all.');
      return { alerts: app.listAlerts(status) };
    },

    /* ---- skills ---------------------------------------------------------------------------- */
    'skills.list': () => ({ skills: library.list() }),
    'skills.get': ({ params }) => ({ skill: library.get(params.name) }),
    'skills.save': ({ params, body }) => library.save(params.name, body?.skillMd, { partition: body?.partition, engines: body?.engines }),
    'skills.remove': ({ params }) => { library.remove(params.name); return {}; },
    'skills.use': ({ params }) => { library.use(params.name); return {}; },
    'skills.scan': async ({ body }) => github.scan(str(body?.url, 'url', 2048)),
    'skills.fetch': async ({ body }) => {
      const result = await github.fetch({
        url: str(body?.url, 'url', 2048),
        ref: typeof body?.ref === 'string' ? body.ref : undefined,
        picks: body?.picks,
        overwrite: body?.overwrite === true,
        rename: body?.rename && typeof body.rename === 'object' ? body.rename : {},
        library,
      });
      return result;
    },
    'import.files': ({ body }) => library.importDropped(decodeFiles(body?.files), {
      overwrite: body?.overwrite === true,
      rename: body?.rename && typeof body.rename === 'object' ? body.rename : {},
      partition: body?.partition,
      engines: body?.engines,
    }),

    /* ---- projects -------------------------------------------------------------------------- */
    'projects.list': () => ({ projects: projects.list() }),
    'projects.add': async ({ body }) => ({ project: await projects.add(body?.path, body?.permissions) }),
    'projects.permissions': async ({ params, body }) => ({ project: await projects.setPermissions(params.id, body?.permissions) }),
    'stats.get': () => computeStats(app),
    'system.pickFolder': async () => app.pickFolder(),
    'projects.get': async ({ params, query }) => {
      const project = projects.get(params.id);
      if (!project.exists) return { project, team: null };
      if (query.get('open') === '1') await projects.touch(params.id);
      return { project: projects.get(params.id), team: inspectTeam(project.path) };
    },
    'projects.remove': async ({ params }) => { await projects.remove(params.id); return {}; },
    'projects.health': async ({ params }) => {
      const { root, id } = projects.resolve(params.id);
      return computeHealth(root, { projectId: id });
    },
    'projects.file': ({ params, query }) => {
      const { root } = projects.resolve(params.id);
      const rel = toPosix(query.get('path') || '');
      const abs = resolveInside(root, rel);
      if (isSensitiveName(rel)) throw forbidden('That file may hold secrets and is not shown.');
      const text = readTextFile(abs, 512 * 1024);
      return { path: rel, bytes: Buffer.byteLength(text), text: redact(text) };
    },
    'projects.chat.get': ({ params, query }) => {
      projects.get(params.id);
      const c = chats.get(app.sessions.chatKey(params.id, query.get('nodeId') || null, query.get('engine') || 'claude'));
      return { messages: c.messages, sessionId: c.sessionId, linked: c.linked || null };
    },
    'projects.history.list': ({ params, query }) => {
      const p = projects.resolve(params.id);
      const nodeId = query.get('nodeId') || null;
      const node = nodeId ? app.sessions.getNode(params.id, nodeId) : null;
      const h = listConversations(config.claudeHome, p.root);
      return {
        folder: toPosix(h.dir.replace(config.claudeHome, '~/.claude')),
        conversations: h.conversations,
        agentRuns: node?.kind === 'agent' ? agentRuns(h.conversations, [node.id, node.title]) : [],
      };
    },
    'projects.history.get': async ({ params, query }) => {
      const p = projects.resolve(params.id);
      const run = query.get('run') || null;
      if (!SESSION_RE.test(params.sid) || (run && !AGENT_RUN_RE.test(run))) throw badRequest('That conversation id is not valid.');
      const c = await readConversation(config.claudeHome, p.root, params.sid, { run, limit: Math.min(400, Number(query.get('limit')) || 150) });
      if (!c) throw notFound('That conversation is no longer in the Claude Code folder.');
      return c;
    },
    'projects.chat.link': async ({ params, body }) => {
      const p = projects.resolve(params.id, { need: 'claude' });
      const nodeId = body?.nodeId == null ? null : String(body.nodeId);
      if (nodeId && !app.sessions.getNode(params.id, nodeId)) throw notFound(`This project's workflow has no node "${nodeId}".`);
      const sessionId = str(body?.sessionId, 'sessionId', 60);
      if (!SESSION_RE.test(sessionId)) throw badRequest('That conversation id is not valid.');
      const found = listConversations(config.claudeHome, p.root, { limit: 500 }).conversations.find((c) => c.id === sessionId);
      if (!found) throw notFound('That conversation is no longer in the Claude Code folder.');
      if (app.sessions.isBusy(params.id, nodeId)) throw badRequest('An agent is answering here. Wait for it or stop it first.');
      const linked = { id: found.id, title: found.title, lastAt: found.lastAt, at: new Date().toISOString() };
      await chats.link(app.sessions.chatKey(params.id, nodeId, 'claude'), linked);
      return { linked };
    },
    'projects.chat.reset': async ({ params, query }) => { projects.get(params.id); await chats.reset(app.sessions.chatKey(params.id, query.get('nodeId') || null, query.get('engine') || 'claude')); return {}; },

    /* ---- diff-first changes ------------------------------------------------------------------ */
    'changes.preview': ({ body }) => changes.preview(str(body?.projectId, 'projectId', 60), body?.ops),
    'changes.apply': async ({ body }) => changes.apply(str(body?.id, 'id', 60)),

  };
}
