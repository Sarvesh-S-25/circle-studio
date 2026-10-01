// Open questions from a team's texter (docs/tasks/ALERTS.md) in every registered project. They are not agent
// requests, so they do not come over the event stream: the server reads the files, and this asks again every few
// seconds and when the window regains focus. state.alerts feeds the Inbox badge; the Inbox lists them and answers them.
import { api } from '../api.js';
import { notify, state } from '../state.js';
import { toast } from './overlay.js';
import { desktopAlert } from './notify.js';

const POLL_MS = 10_000;
let started = false;
let known = null; // keys of the open alerts seen last time; null until the first answer, so a restart does not toast old ones
const key = (a) => `${a.projectId}:${a.id}`;

/** Ask the server now. Announces `circle:alerts` (and toasts) only when the set of open alerts changed. */
export async function loadAlerts() {
  let alerts;
  try { alerts = (await api.alerts('open')).alerts; } catch { return; } // the server may be restarting: the next poll tells us
  const fresh = known ? alerts.filter((a) => !known.has(key(a))) : [];
  const changed = known === null ? alerts.length > 0 : fresh.length > 0 || alerts.length !== state.alerts.length;
  known = new Set(alerts.map(key));
  state.alerts = alerts;
  for (const a of fresh) desktopAlert({ title: `${a.projectName}: your team has a question`, body: a.title || '', tag: `alert:${key(a)}`, onClick: () => { location.hash = '#/inbox'; } });
  for (const a of fresh) toast(`${a.projectName}: ${(a.title || 'your team has a question').replace(/[.?!\s]+$/, '')}. It is waiting in the Inbox.`, { kind: 'warn', ms: 10_000 });
  if (changed) { notify(); window.dispatchEvent(new CustomEvent('circle:alerts')); }
}

export function initAlerts() {
  if (started) return;
  started = true;
  loadAlerts();
  setInterval(loadAlerts, POLL_MS);
  window.addEventListener('focus', loadAlerts);
}
