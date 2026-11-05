// Desktop services: settings, the open-window count, and Windows notifications for questions that arrive while no
// Circle Studio window is open (an agent's request, or a team question in docs/tasks/ALERTS.md). An open window shows
// its own popups and browser notifications instead, so nothing is announced twice. Returned keys are spread onto `app`.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { codeFingerprint } from './lib/codeversion.mjs';
import { Settings, windowsToast, focusWindowMarked, openAppWindow } from './lib/desktop.mjs';
import { readProjectText, P } from './lib/team.mjs';
import { parseAlerts } from './lib/alerts.mjs';
import { checkUpdate } from './lib/updater.mjs';
import { listServers } from './lib/connections.mjs';
import { analyze } from './lib/mcpmanage.mjs';
import { Notices, notificationAllowed } from './lib/notices.mjs';
import { Replies } from './lib/replies.mjs';
import { desktopWidgets } from './lib/deskhost.mjs';

const ALERT_POLL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function createDesktopServices({ config, store, projects, sessions, overrides = {}, advisoryCount = () => 0 }) {
  const settings = new Settings(store);
  // every notice is kept for the Notifications tile; the Windows toast is extra, only when no window is open
  const notices = overrides.notices || new Notices(store);
  // Tests never pop real notifications.
  const toast = overrides.toast || (process.env.NODE_TEST_CONTEXT ? () => false : windowsToast);
  const viewers = { count: 0, notifiers: 0 };
  // chat answers to show on the desktop as cards you can reply to; `fromDesktop` marks turns you started there
  const replies = new Replies();
  const fromDesktop = new Set();
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

  const quiet = () => (viewers.count > 0 && viewers.notifiers > 0) || settings.get().desktopAlerts === false;
  // the desktop host shows an agent's request as a card with its own buttons: then a Windows toast would say it twice
  const carded = () => settings.get().desktopAsks !== false && (overrides.asksOnDesktop ? overrides.asksOnDesktop() : !process.env.NODE_TEST_CONTEXT && desktopWidgets(config).status().running);

  // runs that took a while (or failed) are worth a notice; a quick chat answer you watched is not
  const runStarts = new Map();
  sessions.subscribe((name, data) => {
    if (name === 'run') {
      if (data.status === 'active') { if (!runStarts.has(data.runId)) runStarts.set(data.runId, Date.now()); return; }
      if (!['done', 'error', 'idle'].includes(data.status)) return; // waiting for you: still the same run
      const started = runStarts.get(data.runId);
      runStarts.delete(data.runId);
      const who = `${nameOf(data.projectId)}: ${data.nodeId && data.nodeId !== 'main' ? data.nodeId : ({ claude: 'Claude', codex: 'Codex', copilot: 'Copilot', gemini: 'Gemini' })[data.engine] || 'the chat'}`;
      // an answer to something said from the desktop, or one nobody was watching: a card to read and reply to
      const turn = `${data.projectId}|${data.nodeId || ''}`;
      if (data.status === 'done' && notificationAllowed(settings.get(), 'done') && (fromDesktop.has(turn) || viewers.count === 0 || carded())) replies.add({ projectId: data.projectId, nodeId: data.nodeId && data.nodeId !== 'main' ? data.nodeId : null, engine: data.engine, conversationId: data.conversationId, runId: data.runId });
      fromDesktop.delete(turn);
      const url = `#/projects/${data.projectId}/chat/${data.engine || 'claude'}/${data.conversationId || '_'}${data.nodeId && data.nodeId !== 'main' ? `/${data.nodeId}` : ''}`;
      if (data.status === 'error' || data.status === 'done') {
        const kind = data.status === 'done' ? 'done' : 'error';
        const notice = notices.add({ kind, title: `${who} ${kind === 'done' ? 'finished' : 'stopped with an error'}`, body: started ? `after ${Math.max(0, Math.round((Date.now() - started) / 1000))} s` : '', projectId: data.projectId, url, engine: data.engine, conversationId: data.conversationId, runId: data.runId, eventId: `run:${data.runId}:${kind}` });
        if (!quiet() && !(kind === 'done' && carded()) && notificationAllowed(settings.get(), kind)) toast({ title: notice.title, body: notice.body || 'Open the saved conversation.', url: `${base()}/${url}` });
      }
      return;
    }
    if (name !== 'request') return;
    const who = data.kind === 'question' ? 'has a question' : 'asks to go ahead';
    const title = `${nameOf(data.projectId)}: ${data.nodeId || ({ claude: 'Claude', codex: 'Codex', copilot: 'Copilot', gemini: 'Gemini' })[data.engine] || 'the agent'} ${who}`;
    notices.add({ kind: data.kind === 'question' ? 'question' : 'approval', title, body: data.title || '', projectId: data.projectId, url: '#/inbox' });
    if (!quiet() && !carded()) toast({ title, body: data.title || 'Open Circle Studio to answer.', url: `${base()}/#/inbox` });
  });

  let known = null;
  function pollAlerts() {
    let open;
    try { open = listAlerts('open'); } catch { return; }
    const keys = new Set(open.map((a) => `${a.projectId}:${a.id}`));
    if (known) {
      for (const a of open) {
        if (known.has(`${a.projectId}:${a.id}`)) continue;
        notices.add({ kind: 'team', title: `${a.projectName}: your team has a question`, body: a.title || '', projectId: a.projectId, url: '#/inbox' });
        if (!quiet()) toast({ title: `${a.projectName}: your team has a question`, body: a.title || 'Open Circle Studio to answer.', url: `${base()}/#/inbox` });
      }
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
          const before = settings.get().updates?.available === true;
          this.last = await (overrides.checkUpdate || checkUpdate)(config.appRoot);
          if (this.last.available && !before) notices.add({ kind: 'update', title: 'An update for Circle Studio is ready', body: (this.last.changes || []).slice(0, 2).join('; '), url: '#/settings' });
          await settings.set({ updates: { ...settings.get().updates, lastCheck: this.last.at, available: this.last.available === true } });
          if (this.last.available && viewers.count === 0 && settings.get().desktopAlerts !== false && notificationAllowed(settings.get(), 'update')) toast({ title: 'Circle Studio: an update is ready', body: 'Open Circle Studio and press Update in Settings.', url: `${base()}/#/settings` });
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

  // Newer code on disk (an update, or a change to the app's own files): the server restarts into it. Through the
  // launcher, started with wscript so it is not a child of this server: it sees this server is older than the code,
  // stops it and starts the new one. Open windows notice and reload (or offer to). By itself only when nothing is
  // running or waiting for an answer, and the code has stayed the same for a minute (not in the middle of an update);
  // turned off with updates.autoRestart = false, and the app's banner then offers Restart now.
  const codeAtStart = codeFingerprint(config.appRoot);
  const restart = { pending: false };
  const isStale = () => codeFingerprint(config.appRoot) !== codeAtStart;
  const busy = () => (sessions?.runs?.size || 0) + (sessions?.inbox?.list({ status: 'pending' }).length || 0) + advisoryCount();
  function restartIntoNewCode(nextRoot = config.appRoot) {
    if (restart.pending) return true;
    if (overrides.restart) { restart.pending = true; overrides.restart(nextRoot); return true; }
    if (process.platform !== 'win32' || process.env.NODE_TEST_CONTEXT) return false;
    restart.pending = true;
    setTimeout(() => {
      const child = spawn('wscript.exe', [path.join(nextRoot, 'scripts', 'launch.vbs'), '--background'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => { restart.pending = false; });
      child.unref();
    }, 500);
    return true;
  }
  let seen = null;
  function autoRestart() {
    if (settings.get().updates?.autoRestart === false || !isStale()) { seen = null; return false; }
    const now = codeFingerprint(config.appRoot);
    const steady = seen === now; // the same newer code a minute ago: the update has finished writing
    seen = now;
    if (!steady || busy()) return false;
    return restartIntoNewCode();
  }
  const autoTimer = process.env.NODE_TEST_CONTEXT ? null : setInterval(autoRestart, 60_000);
  autoTimer?.unref?.();

  // Connections: checked every few hours without starting anything; a connection that has just broken is announced
  // (in the app as a toast through the next window, on Windows when no window is open).
  async function watchConnections() {
    let groups;
    try { groups = analyze(listServers({ root: null, home: config.userHome, codexHome: config.codexHome })); } catch { return []; }
    const broken = groups.flatMap((g) => g.findings.filter((f) => f.kind === 'broken').map((f) => ({ id: f.serverId, name: g.name, title: f.title, canFix: Boolean(f.action) })));
    const before = new Set(settings.get().connectionsBroken || []);
    const fresh = broken.filter((b) => !before.has(b.id));
    await settings.set({ connectionsBroken: broken.map((b) => b.id) });
    for (const b of fresh) notices.add({ kind: 'connection', title: `Connection "${b.name}" stopped working`, body: b.title, url: '#/connections' });
    for (const b of fresh) if (settings.get().desktopAlerts !== false) toast({ title: `Connection "${b.name}" stopped working`, body: `${b.title}.${b.canFix ? ' Circle Studio can fix it for you.' : ' Open Keys, Everything on this PC, to see why.'}`, url: `${base()}/#/connections` });
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

  const testNotification = async (engine) => {
    if (settings.get().desktopAlerts === false) return { requested: false, reason: 'Desktop notifications are turned off in Settings.' };
    const title = 'Circle Studio: ' + engine + ' notification test';
    const body = 'This is a dummy test. No model turn was started.';
    const requested = await toast({ title, body, url: base() + '/#/settings' });
    notices.add({ kind: 'done', title, body, eventId: 'test:' + randomBytes(6).toString('hex'), engine, url: '#/settings' });
    return { requested: Boolean(requested), reason: requested ? 'Notification submitted to Windows. Check the notification center; submission does not confirm display. Windows Do not disturb or app notification settings can hide it.' : 'The operating-system notification request could not be submitted.' };
  };
  return { testNotification, settings, notices, viewers, replies, fromDesktop, carded, listAlerts, pollAlerts, updates, watchConnections, addWindow, showWindow, restartIntoNewCode, autoRestart, isStale, busyCount: busy, restart, openWindows: () => [...windows.keys()], stopDesktop: () => { clearInterval(autoTimer); clearInterval(timer); clearInterval(updTimer); clearTimeout(first); clearInterval(cxTimer); clearTimeout(cxFirst); } };
}
