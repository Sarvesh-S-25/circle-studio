// Claude Code mods and plugins: what is installed, what each one changes, and where it is on.
//
// A mod is a Claude Code plugin with a hooks module (hooks/hooks.json names `modules`): it can change the chat itself
// (panes, a band above the prompt, the status line, toasts, colours), check or rewrite tool calls, or add to the prompt
// and context. A plain plugin brings skills, agents, commands, scripts on events or MCP servers. Both are switched on
// in a settings file:
//   ~/.claude/settings.json            enabledPlugins   for every project ("general")
//   <project>/.claude/settings.json    enabledPlugins   this project only, wins over the general one
//   <project>/.claude/settings.local.json               this project, this PC only, wins over both
// Read only here. Changes go through ops.mjs (`mod-set`, the project file, diff first) or the claude CLI for the
// general setting (`claude plugin enable|disable --scope user`), so the files stay in the shape Claude Code writes.
import fs from 'node:fs';
import path from 'node:path';

const MAX_SOURCE = 512 * 1024;

const readJson = (file) => {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch { return null; }
};
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const listDir = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const samePath = (a, b) => Boolean(a && b) && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** What a mod or plugin changes, in plain words. Each has an id, a label and a line saying what it means. */
export const CATEGORIES = {
  look: { label: 'Chat look', means: 'Changes what the chat shows: panes, a band above the prompt, the status line, toasts or colours.' },
  context: { label: 'Prompt and context', means: 'Adds to or changes what Claude reads: your prompt, the system prompt or the context.' },
  checks: { label: 'Tool checks', means: 'Looks at commands and edits before they run, and can stop or change them.' },
  commands: { label: 'Commands', means: 'Adds slash commands.' },
  skills: { label: 'Skills', means: 'Adds skills Claude can use.' },
  agents: { label: 'Agents', means: 'Adds agent types.' },
  tools: { label: 'Tools', means: 'Adds tools or MCP servers Claude can call.' },
  scripts: { label: 'Scripts on events', means: 'Runs its own scripts when something happens (a hook).' },
  sound: { label: 'Sound', means: 'Plays sounds or speaks.' },
};

/** Read a hooks module's sources (the files hooks.json names, and what sits beside them) and say what they touch. */
export function scanModule(text) {
  const cats = new Set();
  const events = new Set();
  for (const m of text.matchAll(/\bon\(\s*['"`]([a-z]+(?:\.[a-zA-Z]+)+)['"`]/g)) events.add(m[1]);
  if (/ui\.render|\$\.ui\.(open|status|toast|notice|log)\b|AbovePrompt|['"`]Pane['"`]/.test(text)) cats.add('look');
  if ([...events].some((e) => /^prompt\.|^context\./.test(e)) || /\bcontext\b\s*:/.test(text)) cats.add('context');
  if ([...events].some((e) => /^tool\.(call|check)/.test(e))) cats.add('checks');
  if (/\$\.command\.register/.test(text)) cats.add('commands');
  if (/\$\.tool\.register/.test(text)) cats.add('tools');
  if (/\$\.agent\.register/.test(text)) cats.add('agents');
  if (/\$\.audio\./.test(text)) cats.add('sound');
  return { cats, events: [...events].sort() };
}

/** Everything a plugin folder brings. `root` is its folder (the one holding .claude-plugin/plugin.json). */
export function inspectPlugin(root) {
  const manifest = readJson(path.join(root, '.claude-plugin', 'plugin.json')) || {};
  const cats = new Set();
  const events = new Set();
  const counts = {};
  let isMod = false;
  const hooksFile = typeof manifest.hooks === 'string' ? path.resolve(root, manifest.hooks) : path.join(root, 'hooks', 'hooks.json');
  const hooks = readJson(hooksFile);
  if (hooks && Array.isArray(hooks.modules) && hooks.modules.length) {
    isMod = true;
    let text = '';
    const dirs = new Set();
    for (const rel of hooks.modules.slice(0, 10)) {
      if (typeof rel !== 'string') continue;
      const file = path.resolve(path.dirname(hooksFile), rel);
      if (!file.toLowerCase().startsWith(path.resolve(root).toLowerCase())) continue; // never read outside the plugin
      dirs.add(path.dirname(file));
      try { text += fs.readFileSync(file, 'utf8').slice(0, MAX_SOURCE); } catch { /* listed but missing */ }
    }
    // modules often import their own helpers from the same folder
    for (const d of dirs) for (const e of listDir(d)) if (e.isFile() && /\.(tsx?|m?js)$/.test(e.name) && !/\.test\./.test(e.name) && text.length < MAX_SOURCE * 2) {
      try { text += fs.readFileSync(path.join(d, e.name), 'utf8').slice(0, MAX_SOURCE); } catch { /* skip */ }
    }
    const s = scanModule(text);
    s.cats.forEach((c) => cats.add(c));
    s.events.forEach((e) => events.add(e));
  }
  if (hooks && hooks.hooks && typeof hooks.hooks === 'object' && Object.keys(hooks.hooks).length) {
    cats.add('scripts');
    Object.keys(hooks.hooks).forEach((e) => events.add(e));
  }
  const count = (dir, test) => listDir(path.join(root, dir)).filter(test).length;
  counts.skills = count('skills', (e) => e.isDirectory());
  counts.agents = count('agents', (e) => e.isFile() && e.name.endsWith('.md'));
  counts.commands = count('commands', (e) => e.isFile() && e.name.endsWith('.md'));
  const mcp = readJson(path.join(root, '.mcp.json'));
  const servers = mcp?.mcpServers || mcp || (manifest.mcpServers && typeof manifest.mcpServers === 'object' ? manifest.mcpServers : {});
  counts.tools = servers && typeof servers === 'object' ? Object.keys(servers).length : 0;
  if (counts.skills) cats.add('skills');
  if (counts.agents) cats.add('agents');
  if (counts.commands) cats.add('commands');
  if (counts.tools) cats.add('tools');
  return {
    name: typeof manifest.name === 'string' ? manifest.name : path.basename(root),
    description: typeof manifest.description === 'string' ? manifest.description.slice(0, 400) : '',
    version: typeof manifest.version === 'string' ? manifest.version : '',
    isMod,
    categories: Object.keys(CATEGORIES).filter((c) => cats.has(c)),
    events: [...events].sort().slice(0, 30),
    counts,
  };
}

/** The enabledPlugins of one settings file, or {}. */
const enabledIn = (file) => {
  const v = readJson(file)?.enabledPlugins;
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
};

/**
 * Every plugin Claude Code knows of on this PC. `claudeHome` is ~/.claude. Returns
 * [{ id, root, installScope: 'user'|'project'|'local'|'skills-dir', projectPath? }].
 */
export function installedPlugins(claudeHome) {
  const out = [];
  const seen = new Set();
  const installed = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'))?.plugins || {};
  for (const [id, entries] of Object.entries(installed)) {
    for (const e of Array.isArray(entries) ? entries : [entries]) {
      if (!e?.installPath || !isDir(e.installPath)) continue;
      const key = `${id}|${e.scope}|${e.projectPath || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id, root: e.installPath, installScope: e.scope || 'user', projectPath: e.projectPath || null });
    }
  }
  // a plugin folder under ~/.claude/skills loads by itself as <name>@skills-dir
  for (const d of listDir(path.join(claudeHome, 'skills'))) {
    const root = path.join(claudeHome, 'skills', d.name);
    if (d.isDirectory() && fs.existsSync(path.join(root, '.claude-plugin', 'plugin.json'))) out.push({ id: `${d.name}@skills-dir`, root, installScope: 'skills-dir', projectPath: null });
  }
  return out;
}

/** A project's own plugin folders (.claude/skills/<name> with a manifest): they load only in that project. */
function projectSkillPlugins(root) {
  const out = [];
  for (const d of listDir(path.join(root, '.claude', 'skills'))) {
    const p = path.join(root, '.claude', 'skills', d.name);
    if (d.isDirectory() && fs.existsSync(path.join(p, '.claude-plugin', 'plugin.json'))) out.push({ id: `${d.name}@skills-dir`, root: p, installScope: 'project-skills', projectPath: root });
  }
  return out;
}

/**
 * Where one plugin is on, for one project folder (or none: the general view).
 * Returns { on, from: 'user'|'project'|'local'|'default'|null, general, project, local }.
 */
export function stateFor(p, { user, project = {}, local = {} }) {
  const general = p.installScope === 'project-skills' ? null : user[p.id] ?? (p.installScope === 'skills-dir' ? true : p.installScope === 'user' ? false : null);
  const proj = project[p.id];
  const loc = local[p.id];
  if (typeof loc === 'boolean') return { on: loc, from: 'local', general, project: proj ?? null, local: loc };
  if (typeof proj === 'boolean') return { on: proj, from: 'project', general, project: proj, local: null };
  if (p.installScope === 'project-skills') return { on: true, from: 'project', general: null, project: null, local: null };
  if (typeof general === 'boolean') return { on: general, from: user[p.id] === undefined ? 'default' : 'user', general, project: null, local: null };
  return { on: false, from: null, general, project: null, local: null };
}

/**
 * The mods and plugins as one project sees them, sorted into
 *   general  on for every project (and not turned off here)
 *   project  on only in this project (its own settings or its own plugin folders)
 *   off      installed, but off here
 */
export function projectMods({ claudeHome, root }) {
  const user = enabledIn(path.join(claudeHome, 'settings.json'));
  const project = enabledIn(path.join(root, '.claude', 'settings.json'));
  const local = enabledIn(path.join(root, '.claude', 'settings.local.json'));
  const all = [...installedPlugins(claudeHome).filter((p) => !p.projectPath || samePath(p.projectPath, root)), ...projectSkillPlugins(root)];
  const byId = new Map();
  for (const p of all) if (!byId.has(p.id) || p.projectPath) byId.set(p.id, p);
  // a name in the project's settings whose plugin is not installed: say so instead of hiding it
  for (const id of new Set([...Object.keys(project), ...Object.keys(local)])) if (!byId.has(id)) byId.set(id, { id, root: null, installScope: 'missing', projectPath: null });
  const mods = [];
  for (const p of byId.values()) {
    const st = stateFor(p, { user, project, local });
    const info = p.root ? inspectPlugin(p.root) : { name: p.id.split('@')[0], description: '', version: '', isMod: false, categories: [], events: [], counts: {} };
    const group = !st.on ? 'off' : st.from === 'user' || st.from === 'default' ? (st.general ? 'general' : 'project') : 'project';
    mods.push({ id: p.id, ...info, source: p.id.split('@')[1] || '', installScope: p.installScope, missing: !p.root, group, state: st });
  }
  return sortMods(mods);
}

/** Every mod and plugin across the PC: on for every project or not, and which projects turn it on or off. */
export function allMods({ claudeHome, projects = [] }) {
  const user = enabledIn(path.join(claudeHome, 'settings.json'));
  const roots = projects.filter((p) => p.exists !== false && p.path).map((p) => ({ name: p.name, id: p.id, root: p.path, project: enabledIn(path.join(p.path, '.claude', 'settings.json')), local: enabledIn(path.join(p.path, '.claude', 'settings.local.json')) }));
  const plugins = installedPlugins(claudeHome);
  for (const r of roots) plugins.push(...projectSkillPlugins(r.root));
  const byId = new Map();
  for (const p of plugins) {
    const cur = byId.get(p.id);
    if (cur) { if (p.projectPath) cur.projectPaths.push(p.projectPath); continue; }
    byId.set(p.id, { ...p, projectPaths: p.projectPath ? [p.projectPath] : [] });
  }
  const mods = [];
  for (const p of byId.values()) {
    const general = p.installScope === 'project-skills' ? null : stateFor(p, { user }).on;
    const onIn = []; const offIn = [];
    for (const r of roots) {
      const reachable = !p.projectPaths.length || p.installScope === 'user' || p.installScope === 'skills-dir' || p.projectPaths.some((pp) => samePath(pp, r.root));
      if (!reachable) continue;
      const st = stateFor({ ...p, installScope: p.installScope === 'project-skills' ? (p.projectPaths.some((pp) => samePath(pp, r.root)) ? 'project-skills' : 'missing') : p.installScope }, { user, project: r.project, local: r.local });
      if (st.from === 'project' || st.from === 'local') (st.on ? onIn : offIn).push({ id: r.id, name: r.name });
    }
    mods.push({ id: p.id, ...inspectPlugin(p.root), source: p.id.split('@')[1] || '', installScope: p.installScope, group: general ? 'general' : onIn.length ? 'project' : 'off', general: Boolean(general), onIn, offIn });
  }
  return sortMods(mods);
}

const GROUP_ORDER = { general: 0, project: 1, off: 2 };
const sortMods = (mods) => mods.sort((a, b) => (GROUP_ORDER[a.group] - GROUP_ORDER[b.group]) || (Number(b.isMod) - Number(a.isMod)) || a.name.localeCompare(b.name));

/** The folder of one installed mod or plugin, by its id (any scope, or a project's own .claude/skills), or null. */
export function findPluginRoot(id, { claudeHome, projects = [] }) {
  const all = [...installedPlugins(claudeHome)];
  for (const p of projects) if (p.exists !== false && p.path) all.push(...projectSkillPlugins(p.path));
  return all.find((p) => p.id === id)?.root || null;
}

/** A plugin id as Claude Code writes it: name@marketplace, both plain. */
export const PLUGIN_ID_RE = /^[A-Za-z0-9][\w.-]{0,80}@[A-Za-z0-9][\w.-]{0,80}$/;
