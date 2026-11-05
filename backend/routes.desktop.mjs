// Settings, desktop integration (shortcuts, app and widget windows) and a project's git / GitHub state.
// Handlers for settings.*, desktop.* and projects.git*. Shapes are in docs/spec.md.
import fs from 'node:fs';
import path from 'node:path';
import { badRequest, notReady } from './lib/errors.mjs';
import { shortcutPath, writeShortcut, removeShortcut } from './lib/desktop.mjs';
import { repoState, githubState } from './lib/gitstatus.mjs';
import { projectStats } from './lib/stats.mjs';
import { listConversations } from './lib/cchistory.mjs';
import { projectCost } from './lib/cost.mjs';
import { agentStates } from './lib/agentstate.mjs';
import { buildFeed } from './lib/feed.mjs';
import { readPalette } from './lib/palette.mjs';
import { computeStats } from './lib/stats.mjs';
import { desktopWidgets } from './lib/deskhost.mjs';
import { providerUsage } from './lib/usage.mjs';
import { folderKey } from './lib/cchistory.mjs';
import os from 'node:os';
import { applyUpdate, appVersion } from './lib/updater.mjs';
import { uiFingerprint } from './lib/codeversion.mjs';
import { createChatFeed } from './lib/chatfeed.mjs';
import { allMods } from './lib/mods.mjs';
import { tapState, setTap } from './lib/limits.mjs';
import { permHookState, setPermHook } from './lib/permhook.mjs';
import { redact } from './lib/secrets.mjs';
import { tileWindowKey } from '../frontend/js/window-key.js';
import { projectChoices, OVERLAY_EXTRAS } from './lib/overlay.mjs';

const WHERE = ['desktop', 'startmenu', 'startup'];
export const WIDGET_SIZE = { width: 400, height: 660 };
export const BOARD_SIZE = { width: 800, height: 700 };
export const WIDGET_KINDS = ['limits', 'pulse', 'status', 'spend', 'workflow', 'inbox', 'project', 'overview', 'chat', 'notices', 'running', 'mods'];
// the tiles that show one project (switchable on the tile) and the sizes each kind comes in
export const PROJECT_KINDS = ['status', 'workflow', 'project', 'chat'];
// every kind comes small, medium and large; a kind limited to some sizes is listed here
const KIND_SIZES = {};
const NODE_RE = /^(main|node:[A-Za-z0-9_-]{1,60}|run:[A-Za-z0-9 _.-]{1,80})$/;
// a popped-out tile's window: the tile plus the window frame
const TILE_WINDOW = { s: { width: 230, height: 270 }, m: { width: 420, height: 270 }, l: { width: 420, height: 460 } };

export function buildDesktopHandlers(app) {
  const { projects, settings, config } = app;
  const ghCache = new Map(); // projectId -> { at, data }
  const usageCache = new Map(); // days -> { at, data }
  const usagePending = new Map();
  const icon = () => path.join(config.dataDir, 'circle-studio.ico');
  const base = () => `http://127.0.0.1:${config.port}`;
  const exists = (where, project) => { const p = shortcutPath(where, project); return Boolean(p && fs.existsSync(p)); };

  function shortcuts(project = null) {
    if (process.platform !== 'win32') return null;
    return Object.fromEntries(WHERE.filter((w) => !project || w !== 'startup').map((w) => [w, exists(w, project)]));
  }

  function pulseOf(id) {
    const params = { id };
    const project = projects.get(params.id);
    const stats = projectStats(project, { summary: app.chats.summary(params.id) });
    const live = app.sessions.live(params.id);
    const pending = app.inbox.list({ status: 'pending', projectId: params.id }).map((r) => ({ id: r.id, kind: r.kind, title: r.title, nodeId: r.nodeId, engine: r.engine, risk: r.risk, at: r.at }));
    const alerts = project.exists ? app.listAlerts('open').filter((a) => a.projectId === params.id).map((a) => ({ id: a.id, title: a.title })) : [];
    let workflow = null;
    let wf = null;
    try { wf = app.workflows.head(project); } catch { /* no workflow yet */ }
    const agents = project.exists ? agentStates({ root: project.path, workflow: wf, live, pending, claudeHome: config.claudeHome }) : [];
    if (wf) {
      const stages = wf.nodes.filter((n) => n.kind === 'stage');
      const stateOf = (ids) => { const st = agents.filter((a) => ids.includes(a.id)).map((a) => a.state); return st.includes('waiting') ? 'waiting' : st.includes('working') ? 'working' : st.length && st.every((x) => x === 'done') ? 'done' : 'idle'; };
      workflow = {
        version: wf.version,
        stages: stages.map((s) => {
          const kids = wf.nodes.filter((n) => n.kind === 'agent' && n.parent === s.id);
          const who = kids.map((n) => { const a = agents.find((x) => x.id === n.id); return { title: n.title || n.id, state: a?.state || 'idle', detail: a?.detail || '' }; });
          const activity = stateOf(kids.map((n) => n.id));
          const evidence = app.progress?.read(params.id).stages.find((st) => st.id === s.id);
          const state = ['working', 'waiting'].includes(activity) ? activity : evidence?.complete ? 'done' : 'idle';
          return { id: s.id, title: s.title, agents: kids.length, who, checkpoint: s.gate?.on ? (s.gate.by || 'you') : null, state, verified: evidence?.complete === true, completedTasks: evidence?.done || 0, taskTotal: evidence?.total || 0 };
        }),
        agents: wf.nodes.filter((n) => n.kind === 'agent').length,
      };
    }
    const repo = project.exists ? repoState(project.path) : { isRepo: false };
    let lastConversation = null;
    if (project.exists) {
      const c = listConversations(config.claudeHome, project.path, { limit: 1 }).conversations[0];
      if (c) lastConversation = { id: c.id, title: c.title, lastAt: c.lastAt };
    }
    return { project: { id: project.id, name: project.name, path: project.path, exists: project.exists }, stats, live, pending, alerts, workflow, agents, repo, lastConversation, github: ghCache.get(params.id)?.data || null };
  }

    // Spending and use per provider across the whole PC (the spending widget). Cached for five minutes.
  async function usageOf(daysIn, fresh = false) {
    const query = new URLSearchParams({ days: String(daysIn), fresh: fresh ? '1' : '0' });
    const days = [7, 30, 90].includes(Number(query.get('days'))) ? Number(query.get('days')) : 30;
    const key = `${days}`;
    if (!usageCache.has(key) || Date.now() - usageCache.get(key).at > 5 * 60_000 || query.get('fresh') === '1') {
      if (usagePending.has(key)) { await usagePending.get(key); return { ...usageCache.get(key).data, at: new Date(usageCache.get(key).at).toISOString() }; }
      const job = (async () => {
      const chats = app.chats.usageRecords();
      const data = await providerUsage({ claudeHome: config.claudeHome, codexHome: config.codexHome, chats, days });
      const home = folderKey(os.homedir());
      const nice = (k) => k.startsWith(home) ? k.slice(home.length).replace(/^-+(Desktop-+)?/, '') || '~' : k;
      data.claudeFolders = data.claudeFolders.map((f) => ({ ...f, name: nice(f.key) }));
      usageCache.set(key, { at: Date.now(), data });
      })();
      usagePending.set(key, job);
      try { await job; } finally { usagePending.delete(key); }
    }
    return { ...usageCache.get(key).data, at: new Date(usageCache.get(key).at).toISOString() };
  }

  const chatFeed = createChatFeed({ claudeHome: config.claudeHome, chats: app.chats, chatKey: (...a) => app.sessions.chatKey(...a), workflowOf: (p) => app.workflows.head(p) });
  const chatOf = (projectId, nodeId, size, pinnedEngine = null, conversationId = null) => {
    let p;
    try { p = projects.get(projectId); } catch { return { threads: [], selected: null, messages: [], empty: 'No project yet.' }; }
    const selected = app.chats.selected(p.id, nodeId === 'main' ? null : String(nodeId || '').replace(/^node:/, ''));
    const engine = pinnedEngine || selected?.engine || settings.get().overlayBar?.engine || settings.get().preferredEngine || null;
    return chatFeed.chatOf(p, { nodeId, size, engine, conversationId }).then((c) => ({ ...c, model: selected?.engine === engine ? selected.model : null, reasoning: selected?.engine === engine ? selected.reasoning : null, project: { id: p.id, name: p.name } }));
  };
  const defaultProject = () => projects.list().find((p) => p.exists)?.id || null;

  // the status line tap works on your Claude Code settings; the test runner's Claude home is a temp folder
  const tapCtx = () => ({ claudeHome: config.claudeHome, dataDir: config.dataDir, appRoot: config.appRoot });
  const hookEngine = (engine = 'claude') => { if (!['claude', 'codex'].includes(engine)) throw badRequest('Choose claude or codex.'); return engine; };
  const permHookNow = (engine = 'claude') => {
    const t = permHookState({ ...tapCtx(), codexHome: config.codexHome, port: config.port, engine: hookEngine(engine) });
    return { on: t.on, canSet: t.canSet, why: t.why || null, engine, trustRequired: Boolean(t.trustRequired), instructions: t.instructions || null, before: t.before ? redact(JSON.stringify(t.before, null, 2)) : null, after: t.after ? redact(JSON.stringify(t.after, null, 2)) : null };
  };
  const limitsNow = (engine = settings.get().overlayBar?.engine || settings.get().preferredEngine || 'claude') => {
    const t = tapState(tapCtx());
    return { engine, limits: app.limits?.get(engine) || null, tap: { on: t.on, canTap: engine === 'claude' && t.canTap, why: engine === 'claude' ? t.why || null : 'The status-line tap is for Claude only.', own: t.own ? redact(t.own) : null, before: t.before ? redact(JSON.stringify(t.before, null, 2)) : null, after: t.after ? redact(JSON.stringify(t.after, null, 2)) : null } };
  };

  return {
    // The Chat widget: the main chat and the agents' chats of one project; one shown at a time.
    'widgets.chat': async ({ query }) => {
      const projectId = query.get('projectId') || defaultProject();
      if (!projectId) return { threads: [], selected: null, messages: [], empty: 'No project yet. Add a folder on Home.' };
      const pinned = query.get('engine') || null;
      if (pinned && !app.engines.adapter(pinned)) throw badRequest('Unknown widget engine.');
      return chatOf(projectId, query.get('nodeId') || 'main', query.get('size') === 'l' ? 'l' : 'm', pinned, query.get('conversationId') || null);
    },
    // Switch what one tile shows (its project, or which chat), from the board or a desktop widget.
    'widgets.pick': async ({ body }) => {
      const tiles = settings.get().widgets || [];
      const i = Number(body?.index);
      if (!Number.isInteger(i) || i < 0 || i >= tiles.length) throw badRequest('No such widget.');
      const t = { ...tiles[i] };
      if (body?.projectId !== undefined) {
        if (!PROJECT_KINDS.includes(t.kind)) throw badRequest('This widget does not show a project.');
        const id = String(body.projectId);
        if (!projects.list().some((p) => p.id === id && p.exists)) throw badRequest('No such project.');
        t.projectId = id;
        if (t.kind === 'chat') delete t.nodeId; // another project: start from its main chat
        delete t.conversationId;
      }
      if (body?.nodeId !== undefined) {
        if (t.kind !== 'chat') throw badRequest('Only the chat widget switches chats.');
        if (!NODE_RE.test(String(body.nodeId))) throw badRequest('No such chat.');
        t.nodeId = String(body.nodeId);
        delete t.conversationId;
      }
      if (body?.engine !== undefined) { if (t.kind !== 'chat' || (body.engine && !app.engines.adapter(body.engine))) throw badRequest('Choose an available chat engine.'); if (body.engine) t.engine = body.engine; else delete t.engine; delete t.conversationId; }
      if (body?.conversationId !== undefined) {
        if (t.kind !== 'chat') throw badRequest('Only chat widgets can pin conversations.');
        if (body.conversationId) { const engine = body.engine || t.engine; if (!engine) throw badRequest('Choose an engine before pinning.'); app.chats.read(app.sessions.chatKey(t.projectId || defaultProject(), t.nodeId?.startsWith('node:') ? t.nodeId.slice(5) : null, engine), body.conversationId, { limit: 1 }); t.conversationId = body.conversationId; }
        else delete t.conversationId;
      }
      const next = tiles.slice();
      next[i] = t;
      await settings.set({ widgets: next });
      return { widget: t, index: i };
    },
    'settings.get': () => {
      const ov = (where) => { const p = shortcutPath(where, null, { overview: true }); return Boolean(p && fs.existsSync(p)); };
      return { settings: settings.get(), desktop: { platform: process.platform, shortcuts: shortcuts(), overview: process.platform === 'win32' ? { desktop: ov('desktop'), startmenu: ov('startmenu') } : null } };
    },
    'settings.save': async ({ body }) => {
      const patch = {};
      if (body?.retention !== undefined) {
        const r = body.retention;
        if (!r || !Number.isInteger(r.generatedDays) || r.generatedDays < 1 || r.generatedDays > 365 || !Number.isInteger(r.generatedMaxMiB) || r.generatedMaxMiB < 1 || r.generatedMaxMiB > 5000) throw badRequest('Choose 1–365 days and 1–5,000 MiB for generated files.');
        patch.retention = { generatedDays: r.generatedDays, generatedMaxMiB: r.generatedMaxMiB };
      }
      if (body?.achievements !== undefined) patch.achievements = body.achievements === true;
      if (body?.preferredEngine !== undefined) {
        if (!['claude', 'codex', 'gemini', 'copilot'].includes(body.preferredEngine)) throw badRequest('Unknown preferred engine.');
        patch.preferredEngine = body.preferredEngine;
      }
      if (body?.desktopAlerts !== undefined) patch.desktopAlerts = body.desktopAlerts === true;
      if (body?.desktopNotifications !== undefined) {
        const v = body.desktopNotifications;
        if (!v || typeof v !== 'object') throw badRequest('Send notification preferences.');
        const next = { ...(settings.get().desktopNotifications || {}) };
        for (const key of ['done', 'update', 'quietHours']) if (v[key] !== undefined) next[key] = v[key] === true;
        for (const key of ['start', 'end']) if (v[key] !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v[key])) throw badRequest('Quiet hours use HH:MM.'); next[key] = v[key]; }
        patch.desktopNotifications = next;
      }
      if (body?.desktopWidgets !== undefined) patch.desktopWidgets = body.desktopWidgets === true;
      if (body?.desktopAsks !== undefined) patch.desktopAsks = body.desktopAsks === true; // approvals and questions as cards on the desktop
      if (body?.widgetsLocked !== undefined) patch.widgetsLocked = body.widgetsLocked === true; // tiles cannot be dragged
      if (body?.updates?.check !== undefined) {
        if (!['daily', 'off'].includes(body.updates.check)) throw badRequest('updates.check must be daily or off.');
        patch.updates = { ...settings.get().updates, check: body.updates.check };
      }
      if (body?.updates?.autoRestart !== undefined) patch.updates = { ...settings.get().updates, ...patch.updates, autoRestart: body.updates.autoRestart === true };
      if (body?.widgets !== undefined) {
        if (!Array.isArray(body.widgets) || body.widgets.length > 16) throw badRequest('widgets must be a list of at most 16.');
        patch.widgets = body.widgets.map((w) => {
          if (!WIDGET_KINDS.includes(w?.kind)) throw badRequest(`Unknown widget "${w?.kind}".`);
          if (!['s', 'm', 'l'].includes(w.size)) throw badRequest('size must be s, m or l.');
          if (KIND_SIZES[w.kind] && !KIND_SIZES[w.kind].includes(w.size)) throw badRequest(`A ${w.kind} widget comes in ${KIND_SIZES[w.kind].join(' or ')}.`);
          const projectId = typeof w.projectId === 'string' && /^[a-z0-9_-]{1,60}$/.test(w.projectId) ? w.projectId : null;
          const nodeId = w.kind === 'chat' && typeof w.nodeId === 'string' && NODE_RE.test(w.nodeId) ? w.nodeId : null;
          const engine = w.kind === 'chat' && app.engines.adapter(w.engine) ? w.engine : null;
          return { kind: w.kind, size: w.size, projectId, ...(nodeId ? { nodeId } : {}), ...(engine ? { engine } : {}), ...(w.kind === 'chat' && /^[0-9a-f-]{36}$/i.test(w.conversationId || '') ? { conversationId: w.conversationId } : {}), desktop: w.desktop !== false };
        });
      }
      return { settings: await settings.set(patch) };
    },

    'desktop.shortcut': async ({ body }) => {
      if (process.platform !== 'win32') throw notReady('Shortcuts are made on Windows only.');
      const where = body?.where;
      if (!WHERE.includes(where)) throw badRequest('where must be desktop, startmenu or startup.');
      const project = body?.projectId ? projects.get(String(body.projectId)) : null;
      if (project && where === 'startup') throw badRequest('Only the app itself starts at login.');
      const overview = !project && body?.overview === true;
      if (overview && where === 'startup') throw badRequest('Only the app itself starts at login.');
      const lnk = shortcutPath(where, project, { overview });
      if (!lnk) throw notReady('Windows did not say where that folder is.');
      if (body?.remove === true) { removeShortcut(lnk); return { removed: true, path: lnk, shortcuts: shortcuts(project) }; }
      const args = project ? ['--widget', project.id] : overview ? ['--overview'] : where === 'startup' ? ['--background', ...(settings.get().desktopWidgets ? ['--widgets'] : [])] : [];
      writeShortcut({ lnk, appRoot: config.appRoot, args, icon: icon(), description: project ? `${project.name}: Circle Studio widget` : where === 'startup' ? 'Start Circle Studio in the background' : 'Open Circle Studio' });
      return { path: lnk, shortcuts: shortcuts(project) };
    },
    // Which code this server runs and which screens are on disk: open windows ask every minute, cheaply, to offer a
    // restart (newer server code) or a reload (newer screens), or to reload after the server restarted by itself.
    'app.code': () => ({ code: app.codeAtStart, stale: app.isStale(), ui: uiFingerprint(config.appRoot), restarting: app.restart.pending, busy: app.busyCount(), autoRestart: settings.get().updates?.autoRestart !== false }),
    // Restart now into the newer code (the banner's button). A chat that is running stops.
    'app.restart': () => {
      if (!app.isStale()) return { restarting: false, reason: 'Circle Studio already runs the newest code.' };
      return { restarting: app.restartIntoNewCode() };
    },
    'app.update.get': async ({ query }) => ({ version: appVersion(config.appRoot), update: query.get('check') === '1' ? await app.updates.check({ force: true }) : app.updates.last, check: settings.get().updates.check, autoRestart: settings.get().updates.autoRestart !== false }),
    'app.update.apply': async () => {
      if (app.busyCount()) throw badRequest('Finish running work and pending requests before updating.');
      const r = await (app.overrides?.applyUpdate || applyUpdate)(config.appRoot, { dataDir: config.dataDir, busy: () => app.busyCount() > 0, fetchImpl: app.fetchImpl });
      if (!r.ok) throw badRequest(r.message);
      app.updates.last = null;
      // The launcher sees that the code on disk is newer than this server, stops it and starts the new one.
      return { ...r, restarting: app.restartIntoNewCode(r.nextRoot) };
    },
    'desktop.status': ({ query }) => {
      const id = query.get('projectId');
      return { shortcuts: shortcuts(id ? projects.get(id) : null) };
    },
    // Shows a window: the one already open for the same thing is brought to the front (one Circle Studio, one board,
    // one widget per project), a new one is opened only when none is.
    'desktop.open': async ({ body }) => {
      const project = body?.projectId ? projects.get(String(body.projectId)) : null;
      const kind = ['widget', 'tile'].includes(body?.kind) ? body.kind : 'app';
      const settle = body?.settle === true; // the launcher has just restarted the server: open windows are reconnecting
      if (kind === 'tile') {
        const t = body?.tile || {};
        if (!WIDGET_KINDS.includes(t.kind) || !['s', 'm', 'l'].includes(t.size)) throw badRequest('Say which tile (kind and size s, m or l).');
        const url = `${base()}/widget.html?w=${t.kind}&size=${t.size}${project ? `&p=${encodeURIComponent(project.id)}` : ''}${t.engine && app.engines.adapter(t.engine) ? `&engine=${encodeURIComponent(t.engine)}` : ''}${typeof t.nodeId === 'string' && NODE_RE.test(t.nodeId) ? `&n=${encodeURIComponent(t.nodeId)}` : ''}${/^[0-9a-f-]{36}$/i.test(t.conversationId || '') ? `&conversation=${t.conversationId}` : ''}`;
        return { opened: true, ...(await app.showWindow(tileWindowKey({ ...t, projectId: project?.id }), url, { size: TILE_WINDOW[t.size] })) };
      }
      const hash = typeof body?.hash === 'string' && /^#\/[A-Za-z0-9_/-]{0,240}$/.test(body.hash) ? body.hash : project ? `#/projects/${encodeURIComponent(project.id)}/workflow` : '';
      if (kind === 'widget') {
        const url = `${base()}/widget.html${project ? `?p=${encodeURIComponent(project.id)}` : ''}`;
        return { opened: true, ...(await app.showWindow(project ? `widget:${project.id}` : 'board', url, { size: project ? WIDGET_SIZE : BOARD_SIZE, settle })) };
      }
      return { opened: true, ...(await app.showWindow('app', `${base()}/${hash}`, { hash, settle })) };
    },

    // Everything a project's widget shows, in one answer: what runs, what waits for the human, the workflow's stages,
    // git, the team's numbers and the last Claude Code conversation in the folder.
    // What the native desktop widgets draw (scripts/widgets/desktop-widgets.ps1 asks every 15 seconds).
    'widgets.feed': async ({ query }) => {
      // the overlay asks for extra widgets by kind (extra=pulse,mods), drawn for the project it shows, instead of the board
      const extra = query.get('extra') !== null ? String(query.get('extra')).split(',').filter((k) => OVERLAY_EXTRAS.some((x) => x.kind === k)).slice(0, 8) : null;
      // the host also runs only to ask on the desktop: then it draws no tiles
      const tiles = extra ? extra.map((kind) => ({ kind, size: 'm', projectId: query.get('projectId') || null })) : settings.get().desktopWidgets === false && query.get('asks') === '1' ? [] : settings.get().widgets || [];
      const shown = (kind) => tiles.some((t) => t.kind === kind && t.desktop !== false);
      const usage = tiles.some((t) => t.kind === 'spend' && t.desktop !== false) ? await usageOf(30).catch(() => null) : null;
      const recent = projects.list().filter((p) => p.exists);
      // the chat tiles' messages are read first (Claude Code conversations are files on this PC)
      const chats = new Map();
      for (const [i, t] of tiles.entries()) {
        if (t.kind === 'chat' && t.desktop !== false) chats.set(i, await chatOf(t.projectId || recent[0]?.id, t.nodeId || 'main', t.size, t.engine, t.conversationId).catch((e) => ({ threads: [], messages: [], empty: `Could not read the chats: ${e.message}` })));
      }
      const stats = shown('overview') || shown('running') || shown('pulse') || tiles.some((t) => PROJECT_KINDS.includes(t.kind)) ? computeStats(app) : null;
      const pending = app.inbox.list({ status: 'pending' });
      return buildFeed({
        tiles, usage, chats,
        // with what each is doing, for the project picker on a tile
        projects: projectChoices(recent.map((p) => ({ id: p.id, name: p.name })), stats?.running || [], pending),
        locked: settings.get().widgetsLocked === true,
        pulseOf: (id) => { try { return id ? pulseOf(id) : null; } catch { return null; } },
        stats,
        mods: shown('mods') ? (() => { try { return allMods({ claudeHome: config.claudeHome, projects: projects.list() }); } catch { return []; } })() : null,
        asks: settings.get().desktopAsks !== false,
        limits: app.limits?.get(settings.get().overlayBar?.engine || settings.get().preferredEngine || 'claude') || null,
        pending,
        alerts: app.listAlerts('open'),
        notices: app.notices.list(20),
        nameOf: (id) => { try { return projects.get(id).name; } catch { return id; } },
        palette: readPalette(config.appRoot, query.get('theme') === 'light' ? 'light' : 'dark'),
        defaultProject: recent[0]?.id || null,
      });
    },
    'notices.list': ({ query }) => app.notices.list(Number(query.get('limit')) || 60),
    'notices.read': ({ body }) => {
      const ids = body?.ids === undefined ? null : Array.isArray(body.ids) && body.ids.every((x) => typeof x === 'string' && /^[a-f0-9]{12}$/.test(x)) ? body.ids : null;
      if (body?.ids !== undefined && !ids) throw badRequest('ids must be a list of notice ids, or left out for all.');
      return { changed: app.notices.markRead(ids), ...app.notices.list(60) };
    },
    // Your plan's 5-hour and weekly use (as Claude Code last said it), and whether your terminal's status line feeds it.
    'limits.get': async ({ query }) => {
      const engine = query?.get('engine') || settings.get().overlayBar?.engine || settings.get().preferredEngine || 'claude';
      if (query?.get('fresh') === '1') await app.limits.refresh(engine, app.engines.adapter(engine));
      return limitsNow(engine);
    },
    // Answering Claude Code's terminal requests on the desktop: the hook in your Claude Code settings, and its preview.
    'permhook.get': ({ query }) => permHookNow(query.get('engine') || 'claude'),
    'permhook.set': ({ body }) => {
      if (typeof body?.on !== 'boolean') throw badRequest('Say on: true or false.');
      const engine = hookEngine(body.engine || 'claude');
      try { setPermHook(body.on, { ...tapCtx(), codexHome: config.codexHome, port: config.port, engine }); } catch (e) { throw e.status === 400 ? badRequest(e.message) : e; }
      return permHookNow(engine);
    },
    // Turn the status line tap on or off: ~/.claude/settings.json is backed up first, your own command is kept and run.
    'limits.tap': ({ body }) => {
      if (typeof body?.on !== 'boolean') throw badRequest('Say on: true or false.');
      try { setTap(body.on, tapCtx()); } catch (e) { throw e.status === 400 ? badRequest(e.message) : e; }
      return limitsNow();
    },
    'desktop.widgets': async ({ body }) => {
      const host = desktopWidgets(config);
      const action = body?.action;
      // one host draws both the tiles and the cards that ask: `running` is "the tiles are on the desktop",
      // `asking` is "an agent's question would pop up on the desktop"
      // the hotkey that brings every tile to the front, as the host registered it (another app may hold the first choice)
      const hotkey = () => { try { return fs.readFileSync(path.join(config.dataDir, 'desktop-widgets.hotkey'), 'utf8').trim().slice(0, 40) || null; } catch { return null; } };
      const say = (st) => ({ ...st, host: st.running, running: st.running && settings.get().desktopWidgets === true, asking: st.running && settings.get().desktopAsks !== false, hotkey: st.running ? hotkey() : null });
      if (action === 'start') { await settings.set({ desktopWidgets: true }); return say(host.start()); }
      if (action === 'stop') {
        await settings.set({ desktopWidgets: false });
        // the cards that ask stay: the host keeps running with no tiles (they go at its next refresh)
        if (settings.get().desktopAsks !== false && host.status().running) return say(host.status());
        return say(host.stop());
      }
      // asks on the desktop turned on or off in Settings: start the host for them, or stop it when no tiles need it
      if (action === 'asks') {
        await settings.set({ desktopAsks: body?.on === true });
        if (body?.on === true) return say(host.start());
        if (!settings.get().desktopWidgets) return say(host.stop());
        return say(host.status());
      }
      if (action === 'status' || action === undefined) return say(host.status());
      throw badRequest('action must be start, stop, asks or status.');
    },
    'projects.pulse': ({ params }) => pulseOf(params.id),
    'usage.providers': ({ query }) => usageOf(Number(query.get('days')) || 30, query.get('fresh') === '1'),

    'projects.cost': async ({ params }) => {
      const p = projects.resolve(params.id);
      let workflow = null;
      try { workflow = app.workflows.head(projects.get(params.id)); } catch { /* no workflow */ }
      return projectCost(p.root, { claudeHome: config.claudeHome, workflow, chats: app.chats.get(params.id).messages });
    },

    'projects.git': async ({ params, query }) => {
      const p = projects.resolve(params.id);
      const repo = repoState(p.root);
      const enabled = settings.get().github[params.id] === true;
      let github = null;
      if (enabled && repo.remote?.github) {
        const hit = ghCache.get(params.id);
        if (hit && Date.now() - hit.at < 60_000 && query.get('fresh') !== '1') github = hit.data;
        else {
          github = await githubState(repo.remote.github, { fetchImpl: app.fetchImpl || globalThis.fetch, token: config.githubToken });
          ghCache.set(params.id, { at: Date.now(), data: github });
        }
      }
      return { repo, githubEnabled: enabled, github };
    },
    'projects.git.github': async ({ params, body }) => {
      projects.get(params.id);
      const on = body?.on === true;
      const gh = { ...settings.get().github, [params.id]: on };
      if (!on) delete gh[params.id];
      ghCache.delete(params.id);
      await settings.set({ github: gh });
      return { githubEnabled: on };
    },
  };
}
