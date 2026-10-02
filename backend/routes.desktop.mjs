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
import { spawn } from 'node:child_process';

const WHERE = ['desktop', 'startmenu', 'startup'];
export const WIDGET_SIZE = { width: 400, height: 660 };
export const BOARD_SIZE = { width: 800, height: 700 };
export const WIDGET_KINDS = ['status', 'spend', 'workflow', 'inbox', 'project', 'overview'];
// a popped-out tile's window: the tile plus the window frame
const TILE_WINDOW = { s: { width: 230, height: 270 }, m: { width: 420, height: 270 }, l: { width: 420, height: 460 } };

export function buildDesktopHandlers(app) {
  const { projects, settings, config } = app;
  const ghCache = new Map(); // projectId -> { at, data }
  const usageCache = new Map(); // days -> { at, data }
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
    const stats = projectStats(project, app.chats.get(params.id));
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
        stages: stages.map((s) => { const kids = wf.nodes.filter((n) => n.kind === 'agent' && n.parent === s.id).map((n) => n.id); return { id: s.id, title: s.title, agents: kids.length, checkpoint: s.gate?.on ? (s.gate.by || 'you') : null, state: stateOf(kids) }; }),
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
      const chats = projects.list().map((p) => app.chats.get(p.id));
      const data = await providerUsage({ claudeHome: config.claudeHome, codexHome: config.codexHome, chats, days });
      const home = folderKey(os.homedir());
      const nice = (k) => k.startsWith(home) ? k.slice(home.length).replace(/^-+(Desktop-+)?/, '') || '~' : k;
      data.claudeFolders = data.claudeFolders.map((f) => ({ ...f, name: nice(f.key) }));
      usageCache.set(key, { at: Date.now(), data });
    }
    return { ...usageCache.get(key).data, at: new Date(usageCache.get(key).at).toISOString() };
  }

  return {
    'settings.get': () => {
      const ov = (where) => { const p = shortcutPath(where, null, { overview: true }); return Boolean(p && fs.existsSync(p)); };
      return { settings: settings.get(), desktop: { platform: process.platform, shortcuts: shortcuts(), overview: process.platform === 'win32' ? { desktop: ov('desktop'), startmenu: ov('startmenu') } : null } };
    },
    'settings.save': async ({ body }) => {
      const patch = {};
      if (body?.desktopAlerts !== undefined) patch.desktopAlerts = body.desktopAlerts === true;
      if (body?.desktopWidgets !== undefined) patch.desktopWidgets = body.desktopWidgets === true;
      if (body?.updates?.check !== undefined) {
        if (!['daily', 'off'].includes(body.updates.check)) throw badRequest('updates.check must be daily or off.');
        patch.updates = { ...settings.get().updates, check: body.updates.check };
      }
      if (body?.widgets !== undefined) {
        if (!Array.isArray(body.widgets) || body.widgets.length > 16) throw badRequest('widgets must be a list of at most 16.');
        patch.widgets = body.widgets.map((w) => {
          if (!WIDGET_KINDS.includes(w?.kind)) throw badRequest(`Unknown widget "${w?.kind}".`);
          if (!['s', 'm', 'l'].includes(w.size)) throw badRequest('size must be s, m or l.');
          const projectId = typeof w.projectId === 'string' && /^[a-z0-9_-]{1,60}$/.test(w.projectId) ? w.projectId : null;
          return { kind: w.kind, size: w.size, projectId, desktop: w.desktop !== false };
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
    'app.update.get': async ({ query }) => ({ version: appVersion(config.appRoot), update: query.get('check') === '1' ? await app.updates.check({ force: true }) : app.updates.last, check: settings.get().updates.check }),
    'app.update.apply': async () => {
      const r = await (app.overrides?.applyUpdate || applyUpdate)(config.appRoot);
      if (!r.ok) throw badRequest(r.message);
      app.updates.last = null;
      // The launcher sees that the code on disk is newer than this server, stops it and starts the new one.
      // Through wscript, so the launcher is not a child of this process (stopping this one must not stop it).
      if (app.overrides?.restart) app.overrides.restart();
      else if (process.platform === 'win32') setTimeout(() => {
        const child = spawn('wscript.exe', [path.join(config.appRoot, 'scripts', 'launch.vbs'), '--background'], { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => {});
        child.unref();
      }, 500);
      return { ...r, restarting: process.platform === 'win32' || Boolean(app.overrides?.restart) };
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
        const url = `${base()}/widget.html?w=${t.kind}&size=${t.size}${project ? `&p=${encodeURIComponent(project.id)}` : ''}`;
        return { opened: true, ...(await app.showWindow(`tile:${t.kind}:${t.size}${project ? `:${project.id}` : ''}`, url, { size: TILE_WINDOW[t.size] })) };
      }
      const hash = typeof body?.hash === 'string' && /^#\/[A-Za-z0-9_/-]{0,120}$/.test(body.hash) ? body.hash : project ? `#/projects/${encodeURIComponent(project.id)}/workflow` : '';
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
      const tiles = settings.get().widgets || [];
      const usage = tiles.some((t) => t.kind === 'spend' && t.desktop !== false) ? await usageOf(30).catch(() => null) : null;
      const recent = projects.list().filter((p) => p.exists);
      return buildFeed({
        tiles, usage,
        pulseOf: (id) => { try { return id ? pulseOf(id) : null; } catch { return null; } },
        stats: tiles.some((t) => t.kind === 'overview') ? computeStats(app) : null,
        pending: app.inbox.list({ status: 'pending' }),
        alerts: app.listAlerts('open'),
        nameOf: (id) => { try { return projects.get(id).name; } catch { return id; } },
        palette: readPalette(config.appRoot, query.get('theme') === 'light' ? 'light' : 'dark'),
        defaultProject: recent[0]?.id || null,
      });
    },
    'desktop.widgets': async ({ body }) => {
      const host = desktopWidgets(config);
      const action = body?.action;
      if (action === 'start') { await settings.set({ desktopWidgets: true }); return host.start(); }
      if (action === 'stop') { await settings.set({ desktopWidgets: false }); return host.stop(); }
      if (action === 'status' || action === undefined) return host.status();
      throw badRequest('action must be start, stop or status.');
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
