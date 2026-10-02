// Desktop services: settings, the open-window count, and Windows notifications for questions that arrive while no
// Circle Studio window is open (an agent's request, or a team question in docs/tasks/ALERTS.md). An open window shows
// its own popups and browser notifications instead, so nothing is announced twice. Returned keys are spread onto `app`.
import { randomBytes } from 'node:crypto';
import { Settings, windowsToast, focusWindowMarked, openAppWindow } from './lib/desktop.mjs';
import { readProjectText, P } from './lib/team.mjs';
import { parseAlerts } from './lib/alerts.mjs';
import { checkUpdate } from './lib/updater.mjs';
import { listServers } from './lib/connections.mjs';
import { analyze } from './lib/mcpmanage.mjs';

const ALERT_POLL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createDesktopServices({ config, store, projects, sessions, overrides = {} }) {
  const settings = new Settings(store);
  // Tests never pop real notifications.
  const toast = overrides.toast || (process.env.NODE_TEST_CONTEXT ? () => false : windowsToast);
  const viewers = { count: 0 };
  const base = () => `http://127.0.0.1:${config.port}`;
  const nameOf = (id) => { try { return projects.get(id).name; } catch { return id; } };

  function listAlerts(status = 'open') {
    const alerts = [];
    for (const p of projects.list()) {
      if (!p.exists) continue;
      const text = readProjectText(p.path, P.alerts);
      if (text == null) continue;
      for (const a of parseAlerts(text)) if (status === 'all' || a.open) alerts.push({ ...a, projectId: p.id, projectName: p.name });
    }
    return alerts;
  }

  const quiet = () => viewers.count > 0 || settings.get().desktopAlerts === false;

  sessions.subscribe((name, data) => {
    if (name !== 'request' || quiet()) return;
    const who = data.kind === 'question' ? 'has a question' : 'asks to go ahead';
    toast({ title: `${nameOf(data.projectId)}: ${data.nodeId || 'the agent'} ${who}`, body: data.title || 'Open Circle Studio to answer.', url: `${base()}/#/inbox` });
  });

  let known = null;
  function pollAlerts() {
    let open;
    try { open = listAlerts('open'); } catch { return; }
    const keys = new Set(open.map((a) => `${a.projectId}:${a.id}`));
    if (known && !quiet()) {
      for (const a of open) if (!known.has(`${a.projectId}:${a.id}`)) toast({ title: `${a.projectName}: your team has a question`, body: a.title || 'Open Circle Studio to answer.', url: `${base()}/#/inbox` });
    }
    known = keys;
  }
  const timer = overrides.toast || !process.env.NODE_TEST_CONTEXT ? setInterval(pollAlerts, ALERT_POLL_MS) : null;
  timer?.unref?.();
  pollAlerts();

  // Updates for the app itself: checked once a day (read only), applied only when the human clicks.
  const updates = {
    last: null,
    checking: null,
    async check({ force = false } = {}) {
      if (!force && this.last && Date.now() - Date.parse(this.last.at) < DAY_MS) return this.last;
      this.checking ||= (async () => {
        try {
          this.last = await (overrides.checkUpdate || checkUpdate)(config.appRoot);
          await settings.set({ updates: { ...settings.get().updates, lastCheck: this.last.at, available: this.last.available === true } });
          if (this.last.available && viewers.count === 0 && settings.get().desktopAlerts !== false) toast({ title: 'Circle Studio: an update is ready', body: 'Open Circle Studio and press Update in Settings.', url: `${base()}/#/settings` });
          return this.last;
        } finally { this.checking = null; }
      })();
      return this.checking;
    },
  };
  const daily = () => { if (settings.get().updates.check !== 'off') updates.check().catch(() => {}); };
  const updTimer = process.env.NODE_TEST_CONTEXT ? null : setInterval(daily, 6 * 60 * 60 * 1000);
  updTimer?.unref?.();
  const first = process.env.NODE_TEST_CONTEXT ? null : setTimeout(daily, 20_000);
  first?.unref?.();

  // Connections: checked every few hours without starting anything; a connection that has just broken is announced
  // (in the app as a toast through the next window, on Windows when no window is open).
  async function watchConnections() {
    let groups;
    try { groups = analyze(listServers({ root: null, home: config.userHome, codexHome: config.codexHome })); } catch { return []; }
    const broken = groups.flatMap((g) => g.findings.filter((f) => f.kind === 'broken').map((f) => ({ id: f.serverId, name: g.name, title: f.title, canFix: Boolean(f.action) })));
    const before = new Set(settings.get().connectionsBroken || []);
    const fresh = broken.filter((b) => !before.has(b.id));
    await settings.set({ connectionsBroken: broken.map((b) => b.id) });
    for (const b of fresh) if (settings.get().desktopAlerts !== false) toast({ title: `Connection "${b.name}" stopped working`, body: `${b.title}.${b.canFix ? ' Circle Studio can fix it for you.' : ' Open Connections to see why.'}`, url: `${base()}/#/connections` });
    return fresh;
  }
  const cxTimer = process.env.NODE_TEST_CONTEXT ? null : setInterval(() => watchConnections().catch(() => {}), 6 * 60 * 60 * 1000);
  cxTimer?.unref?.();
  const cxFirst = process.env.NODE_TEST_CONTEXT ? null : setTimeout(() => watchConnections().catch(() => {}), 60_000);
  cxFirst?.unref?.();

  // Open windows by what they show ('app', 'board', 'widget:<project>', 'tile:<kind>:<size>:<project>'), each with its
  // event stream. Opening one again brings the open window to the front (on the page asked for) instead of a second
  // window, and a window that is still loading is not started twice.
  const windows = new Map();
  const starting = new Map();
  // Windows that were open before this server started (the launcher restarted it after an update) reconnect within a
  // few seconds; until then a request with `settle` waits for them rather than opening a second window.
  const upAt = Date.now();
  const graceMs = overrides.windowGraceMs ?? 6000;
  const waiters = new Set();
  function addWindow(key, send) {
    const w = { send };
    windows.set(key, [...(windows.get(key) || []), w]);
    starting.delete(key);
    for (const f of waiters) f();
    return () => {
      const rest = (windows.get(key) || []).filter((x) => x !== w);
      if (rest.length) windows.set(key, rest); else windows.delete(key);
    };
  }
  // tests never raise or open real windows
  const focus = (mark) => (overrides.focusWindow || (process.env.NODE_TEST_CONTEXT ? async () => false : focusWindowMarked))(mark);
  const open = (url, size) => (overrides.openWindow || (process.env.NODE_TEST_CONTEXT ? () => false : openAppWindow))(url, size);
  async function reconnected(key) {
    while (!windows.get(key)?.length && Date.now() - upAt < graceMs) {
      await new Promise((resolve) => {
        const done = () => { waiters.delete(done); clearTimeout(t); resolve(); };
        const t = setTimeout(done, graceMs - (Date.now() - upAt));
        waiters.add(done);
      });
    }
  }
  async function showWindow(key, url, { size = {}, hash = '', settle = false } = {}) {
    if (settle) await reconnected(key);
    const open_ = windows.get(key);
    if (open_?.length) {
      // the window puts this invisible mark in its title for a moment, so exactly that window is found and raised
      const mark = `\u200b${[...randomBytes(12)].map((b) => (b & 1 ? '\u200c' : '\u200d')).join('')}`;
      open_.at(-1).send('show', { hash, mark });
      if (await focus(mark)) return { shown: 'existing' };
      // it is open but cannot be found on screen (a background tab, a frozen window): open a fresh one
    } else if (Date.now() - (starting.get(key) || 0) < 15_000) {
      return { shown: 'starting' };
    }
    starting.set(key, Date.now());
    return { shown: 'new', appWindow: open(url, size) };
  }

  return { settings, viewers, listAlerts, pollAlerts, updates, watchConnections, addWindow, showWindow, openWindows: () => [...windows.keys()], stopDesktop: () => { clearInterval(timer); clearInterval(updTimer); clearTimeout(first); clearInterval(cxTimer); clearTimeout(cxFirst); } };
}
