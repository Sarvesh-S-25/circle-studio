// Desktop alerts from an open window: when an agent asks something or a team question arrives while this window is
// not in front, Windows shows a notification (the browser's, so clicking it brings this window back). The window
// title also carries the count of what waits. When no window is open at all, the server shows a Windows
// notification itself (backend/services.desktop.mjs).
import { pref, setPref } from '../state.js';

const BASE_TITLE = document.title;

export const alertsOn = () => pref('desktopAlerts', 'true') !== 'false';

export function alertsPermission() {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/** Ask Windows (through the browser) for permission to notify. Call from a click. */
export async function enableAlerts() {
  setPref('desktopAlerts', true);
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'default') { try { return await Notification.requestPermission(); } catch { return Notification.permission; } }
  return Notification.permission;
}

/** Show a notification when this window is not the one the human is looking at. Returns true when shown. */
export function desktopAlert({ title, body, tag, onClick }) {
  if (!alertsOn() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  if (document.visibilityState === 'visible' && document.hasFocus()) return false;
  try {
    const n = new Notification(title, { body, tag, icon: '/favicon.svg', requireInteraction: true });
    n.onclick = () => { window.focus(); n.close(); onClick?.(); };
    return true;
  } catch { return false; }
}

/** "(2) Circle Studio": how many things wait, in the taskbar button. */
export function setWaitingCount(n) {
  document.title = n > 0 ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
}
