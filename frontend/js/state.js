// Shared app state: what the taskbar shows, and the theme. Views read it; refresh functions update it.
import { api } from './api.js';

export const state = {
  health: null,        // /api/health (Claude login state etc.)
  recent: [],          // recent projects
  projects: [],        // every registered project
  mostUsed: [],        // most used skills
  attention: [],       // per-project things that need attention
  skills: [],          // library skills
  engines: [],         // /api/engines: claude, codex, gemini, copilot
  pending: [],         // requests (approvals, questions) waiting for the human
  alerts: [],          // open questions from a team's docs/tasks/ALERTS.md, across projects
  update: null,        // the last check for a newer Circle Studio (/api/update)
  version: null,
  loaded: false,
};

const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const notify = () => listeners.forEach((f) => f(state));

export async function refreshShell() {
  const s = await api.state();
  state.recent = s.recent;
  state.mostUsed = s.mostUsed;
  state.attention = s.attention;
  state.loaded = true;
  notify();
  // The login check can take seconds (it asks the CLI), and nothing on screen waits for it.
  api.health().then((h) => { state.health = h; notify(); }).catch(() => {});
}

export async function refreshProjects() {
  const r = await api.projects();
  state.projects = r.projects;
  notify();
  return r;
}

export async function refreshEngines(force = false) {
  const r = force ? await api.checkEngines() : await api.engines();
  state.engines = r.engines;
  notify();
  window.dispatchEvent(new CustomEvent('circle:engines'));
  return r.engines;
}

export async function refreshSkills() {
  const r = await api.skills();
  state.skills = r.skills;
  notify();
  return r.skills;
}

/* ---- preferences kept in this browser only ------------------------------------------------------ */
export function pref(key, fallback) {
  try { return localStorage.getItem(`circle.${key}`) ?? fallback; } catch { return fallback; }
}
export function setPref(key, value) {
  try { localStorage.setItem(`circle.${key}`, value); } catch { /* private window: keep going */ }
}

export function applyTheme(theme = pref('theme', 'system'), density = pref('density', 'comfortable')) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme); else root.removeAttribute('data-theme');
  if (density === 'compact') root.setAttribute('data-density', 'compact'); else root.removeAttribute('data-density');
}

export function currentTheme() {
  const t = pref('theme', 'system');
  if (t === 'light' || t === 'dark') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
