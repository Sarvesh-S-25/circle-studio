// Desktop services: settings, the open-window count, and Windows notifications for questions that arrive while no
// Circle Studio window is open (an agent's request, or a team question in docs/tasks/ALERTS.md). An open window shows
// its own popups and browser notifications instead, so nothing is announced twice. Returned keys are spread onto `app`.
import { Settings, windowsToast } from './lib/desktop.mjs';
import { readProjectText, P } from './lib/team.mjs';
import { parseAlerts } from './lib/alerts.mjs';
import { checkUpdate } from './lib/updater.mjs';

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

  return { settings, viewers, listAlerts, pollAlerts, updates, stopDesktop: () => { clearInterval(timer); clearInterval(updTimer); clearTimeout(first); } };
}
