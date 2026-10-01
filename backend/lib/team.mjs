// Reading a project's team files (models.json, agents, consult config, roster, skills) tolerantly:
// a malformed file becomes a `problems` entry, never a crash.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontMatter, fieldString } from './frontmatter.mjs';
import { readTextIfExists } from './textfile.mjs';

export const TIERS = ['opus', 'sonnet', 'haiku'];
export const ENGINES = ['gemini', 'copilot', 'codex', 'self'];
// guard.py LANE_OF: connector is "both" (freezing frontend or backend does not block it).
export const LANE_OF = { 'fe-builder': 'frontend', 'be-builder': 'backend', migrator: 'backend', connector: 'both' };

export const P = {
  models: 'models.json',
  consult: '.claude/consult.config.json',
  roster: '.claude/state/roster.json',
  freeze: '.claude/state/freeze.json',
  engines: '.claude/state/engines.json',
  agentsDir: '.claude/agents',
  skillsDir: '.claude/skills',
  applyModels: 'scripts/apply-models.mjs',
  refLinks: 'REFERENCE-LINKS.md',
  brief: 'docs/brief.md',
  board: 'docs/tasks/BOARD.md',
  alerts: 'docs/tasks/ALERTS.md',
  adrDir: 'docs/adr',
  mcp: '.mcp.json',
};

export function parseJson(text) {
  if (text == null) return { ok: false, missing: true };
  try {
    return { ok: true, value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const abs = (root, rel) => path.join(root, ...rel.split('/'));

export function readProjectText(root, rel) {
  return readTextIfExists(abs(root, rel));
}

export function listAgentFiles(root) {
  try {
    return fs.readdirSync(abs(root, P.agentsDir))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export function roleEntry(models, role) {
  const e = models?.roles?.[role];
  if (typeof e === 'string') return { model: e, note: '' };
  if (e && typeof e === 'object') return { model: typeof e.model === 'string' ? e.model : '', note: typeof e.note === 'string' ? e.note : '' };
  return null;
}

/** The engine chain a role really gets from consult.config.json. */
export function effectiveEngine(config, role) {
  const topFailover = Array.isArray(config?.failover) ? config.failover.filter((x) => typeof x === 'string') : [];
  const def = typeof config?.default === 'string' ? config.default : 'gemini';
  const entry = config?.roles?.[role];
  if (typeof entry === 'string') return { engine: entry, failover: topFailover.filter((e) => e !== entry), web: false, model: null, source: 'role' };
  if (entry && typeof entry === 'object' && typeof entry.engine === 'string' && entry.engine !== '') {
    const failover = Array.isArray(entry.failover) ? entry.failover.filter((x) => typeof x === 'string') : topFailover.filter((e) => e !== entry.engine);
    return { engine: entry.engine, failover, web: entry.web === true, model: typeof entry.model === 'string' && entry.model ? entry.model : null, source: 'role' };
  }
  return { engine: def, failover: topFailover.filter((e) => e !== def), web: false, model: null, source: 'default' };
}

/** Entries in consult.config.json `roles` that crash `consult.mjs --list` (null, "", 0, false). */
export function badConsultEntries(config) {
  const out = [];
  const roles = config?.roles;
  if (!roles || typeof roles !== 'object') return out;
  for (const [k, v] of Object.entries(roles)) {
    if (k.startsWith('_')) continue;
    if (v === null || v === '' || v === 0 || v === false || (typeof v !== 'string' && typeof v !== 'object')) out.push(k);
  }
  return out;
}

export function readSkillsInProject(root, config) {
  const dir = abs(root, P.skillsDir);
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const skillFile = path.join(dir, name, 'SKILL.md');
    const raw = readTextIfExists(skillFile);
    if (raw == null) continue;
    const fm = parseFrontMatter(raw);
    let files = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name)); else files++;
      }
    };
    try { walk(path.join(dir, name)); } catch { /* ignore */ }
    out.push({
      name,
      description: fieldString(fm, 'description'),
      files,
      model: fieldString(fm, 'model') || null,
      engine: config?.roles?.[name] ? effectiveEngine(config, name) : null,
    });
  }
  return out;
}

export function isTeamProject(root) {
  return fs.existsSync(abs(root, P.models)) || fs.existsSync(abs(root, P.agentsDir));
}

/** Everything the Team and Skills tabs need about one project. */
export function inspectTeam(root) {
  const problems = [];
  const modelsText = readProjectText(root, P.models);
  const modelsJ = parseJson(modelsText);
  if (!modelsJ.ok && !modelsJ.missing) problems.push({ file: P.models, message: `Not valid JSON: ${modelsJ.error}` });
  const models = modelsJ.ok ? modelsJ.value : null;

  const cfgText = readProjectText(root, P.consult);
  const cfgJ = parseJson(cfgText);
  if (!cfgJ.ok && !cfgJ.missing) problems.push({ file: P.consult, message: `Not valid JSON: ${cfgJ.error}` });
  const config = cfgJ.ok ? cfgJ.value : null;

  const rosterText = readProjectText(root, P.roster);
  const rosterJ = parseJson(rosterText);
  if (!rosterJ.ok && !rosterJ.missing) problems.push({ file: P.roster, message: `Not valid JSON: ${rosterJ.error}` });
  const roster = rosterJ.ok ? rosterJ.value : null;

  const enginesJ = parseJson(readProjectText(root, P.engines));
  const engineHealth = enginesJ.ok && enginesJ.value && typeof enginesJ.value === 'object'
    ? Object.entries(enginesJ.value).map(([name, v]) => ({ name, state: typeof v?.state === 'string' ? v.state : 'unknown', reason: typeof v?.reason === 'string' ? v.reason : null }))
    : [];

  const agentFiles = listAgentFiles(root);
  const roleNames = [...new Set([...Object.keys(models?.roles || {}), ...agentFiles])].filter((r) => !r.startsWith('_')).sort();
  const roles = roleNames.map((role) => {
    const entry = roleEntry(models, role);
    const raw = agentFiles.includes(role) ? readProjectText(root, `${P.agentsDir}/${role}.md`) : null;
    const fm = raw == null ? null : parseFrontMatter(raw);
    if (fm && !fm.ok) problems.push({ file: `${P.agentsDir}/${role}.md`, message: `Front matter: ${fm.reason}` });
    if (fm?.ok && fm.bom) problems.push({ file: `${P.agentsDir}/${role}.md`, message: 'File starts with a BOM; apply-models.mjs refuses it.' });
    const agentModel = fm?.ok ? fieldString(fm, 'model') || null : null;
    const configModel = entry?.model || null;
    const optionalMap = roster?.optional && typeof roster.optional === 'object' ? roster.optional : {};
    const optional = Object.prototype.hasOwnProperty.call(optionalMap, role);
    return {
      role,
      file: raw == null ? null : `${P.agentsDir}/${role}.md`,
      description: fm?.ok ? fieldString(fm, 'description') : '',
      tools: fm?.ok ? fieldString(fm, 'tools').split(',').map((s) => s.trim()).filter(Boolean) : [],
      lane: LANE_OF[role] || null,
      agentModel,
      configModel,
      note: entry?.note || '',
      drift: Boolean(agentModel && configModel && agentModel !== configModel),
      missingAgentFile: raw == null,
      missingModelsEntry: !entry,
      engine: effectiveEngine(config, role),
      optional,
      enabled: optional ? optionalMap[role] === true : null,
      skills: fm?.ok && Array.isArray(fm.fields.get('skills')?.value) ? fm.fields.get('skills').value : [],
    };
  });

  const topFailover = Array.isArray(config?.failover) ? config.failover : [];
  return {
    roles,
    defaults: {
      engine: typeof config?.default === 'string' ? config.default : null,
      failover: topFailover.filter((x) => typeof x === 'string'),
    },
    engineHealth,
    roster: {
      optional: roster?.optional && typeof roster.optional === 'object' ? roster.optional : {},
      humanDoesGit: roster?.human_does_git === true,
    },
    skills: readSkillsInProject(root, config),
    allowedModels: Array.isArray(models?._allowed) && models._allowed.every((x) => typeof x === 'string') ? models._allowed : TIERS,
    allowedEngines: ENGINES,
    files: {
      modelsJson: modelsText != null,
      consultConfig: cfgText != null,
      roster: rosterText != null,
      applyModels: fs.existsSync(abs(root, P.applyModels)),
      brief: fs.existsSync(abs(root, P.brief)),
      board: fs.existsSync(abs(root, P.board)),
    },
    problems,
  };
}
