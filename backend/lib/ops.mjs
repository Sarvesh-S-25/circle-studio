// The change operations. Each op turns a small request into text patches on a Workspace (a virtual
// copy of the project's files). Nothing here touches the disk; changes.mjs shows the diff and applies it.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { badRequest, conflict, notFound } from './errors.mjs';
import { assertName, NAME_RE, ADR_FILE_RE, resolveInside } from './paths.mjs';
import { setPath, removePath } from './jsonpatch.mjs';
import { parseFrontMatter, setFrontMatterField, fieldString } from './frontmatter.mjs';
import { detectEol, looksBinary, readTextIfExists } from './textfile.mjs';
import { scanSecrets } from './secrets.mjs';
import { P, TIERS, ENGINES, parseJson, roleEntry, readProjectText } from './team.mjs';
import { buildBrief, rosterFromWorkflow } from './plan.mjs';
import { ENGINE_IDS } from './workflow.mjs';
import { renderProject, skillTargets, GEMINI_SKILLS_NOTE } from './render.mjs';
import { GI_START, GI_END } from './gitblock.mjs';
import { answerAlertText } from './alerts.mjs';

const LANES = ['frontend', 'backend', 'both', 'all'];

/* ---- JSON helpers -------------------------------------------------------------------------- */

function readJson(ws, rel, what = rel) {
  const text = ws.read(rel);
  if (text == null) throw notFound(`${what} does not exist in this project.`);
  const p = parseJson(text);
  if (!p.ok) throw conflict(`${rel} is not valid JSON (${p.error}). Fix it by hand first; Circle Studio will not guess.`);
  return p.value;
}

function setIn(obj, pathArr, value) {
  let cur = obj;
  pathArr.slice(0, -1).forEach((k) => { if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}; cur = cur[k]; });
  cur[pathArr[pathArr.length - 1]] = value;
}

/** Patch one JSON path in place, then prove the result is the same data with only that path changed. */
function patchJson(ws, rel, pathArr, value) {
  const raw = ws.read(rel);
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  const next = setPath(text, pathArr, value, { eol: detectEol(text) });
  const expected = JSON.parse(text);
  setIn(expected, pathArr, value);
  try {
    assert.deepStrictEqual(JSON.parse(next), expected);
  } catch {
    throw conflict(`Could not patch ${rel} safely (verification failed). Nothing was changed.`);
  }
  ws.write(rel, (bom ? '\ufeff' : '') + next);
}

function unpatchJson(ws, rel, pathArr) {
  const raw = ws.read(rel);
  const bom = raw.charCodeAt(0) === 0xfeff;
  const next = removePath(bom ? raw.slice(1) : raw, pathArr);
  JSON.parse(next);
  ws.write(rel, (bom ? '\ufeff' : '') + next);
}

/* ---- keeping agent files in step with models.json --------------------------------------------- */

function syncAgents(ws, env, { target } = {}) {
  const models = readJson(ws, P.models, 'models.json');
  const allowed = Array.isArray(models._allowed) ? models._allowed : TIERS;
  const scriptThere = fs.existsSync(resolveInside(env.root, P.applyModels));
  const hasScript = scriptThere && env.canRun !== false;
  const also = [];
  for (const role of Object.keys(models.roles || {})) {
    if (role.startsWith('_')) continue;
    const entry = roleEntry(models, role);
    if (!entry || !allowed.includes(entry.model)) continue;
    const file = `${P.agentsDir}/${role}.md`;
    const raw = ws.read(file);
    if (raw == null) continue;
    const fm = parseFrontMatter(raw);
    if (!fm.ok || fm.bom) {
      if (role === target) throw conflict(`${file} has ${fm.ok ? 'a BOM' : `broken front matter (${fm.reason})`}; apply-models.mjs would refuse it. Fix the file first.`);
      continue;
    }
    if (fieldString(fm, 'model') === entry.model) continue;
    ws.write(file, setFrontMatterField(raw, 'model', entry.model), { via: hasScript ? 'apply-models.mjs' : 'app' });
    if (role !== target) also.push(role);
  }
  if (hasScript) {
    env.command({ id: 'apply-models', label: 'Apply models.json to the agent files', cmd: 'node', args: ['scripts/apply-models.mjs'], cwd: '.' });
  } else {
    env.warn(scriptThere
      ? 'Running project scripts is off for this project, so the agent file\'s model: line was edited directly.'
      : 'This project has no scripts/apply-models.mjs, so the agent file\'s model: line was edited directly.');
  }
  if (also.length) env.warn(`apply-models.mjs will also bring ${also.join(', ')} back in line with models.json (they had drifted).`);
  env.warn('Agent definitions load once, when Claude Code starts. Restart it to use the new tier.');
}

/* ---- engines ---------------------------------------------------------------------------------- */

function checkChain(engine, failover) {
  if (!ENGINES.includes(engine)) throw badRequest(`Unknown engine "${engine}". Use ${ENGINES.join(', ')}.`);
  if (!Array.isArray(failover)) throw badRequest('failover must be a list.');
  const all = [engine, ...failover];
  for (const e of all) if (!ENGINES.includes(e)) throw badRequest(`Unknown engine "${e}" in the failover list.`);
  if (new Set(all).size !== all.length) throw badRequest('An engine appears twice in the chain.');
  if (engine === 'self' && failover.length) throw badRequest('"self" ends the chain: nothing may come after it.');
  if (failover.includes('self') && failover[failover.length - 1] !== 'self') throw badRequest('"self" must be last in the chain.');
}

/**
 * Replace a literal key in .mcp.json (an env variable or a header of one server) by a ${NAME} reference, which Claude
 * Code fills from the environment; the value itself goes to the vault first (route vault.import).
 */
function opMcpEnvRef(ws, op) {
  if (typeof op.server !== 'string' || !op.server || op.server.length > 80) throw badRequest('Say which server.');
  if (!['env', 'headers'].includes(op.field)) throw badRequest('field must be env or headers.');
  if (typeof op.key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(op.key)) throw badRequest('Say which variable or header.');
  if (typeof op.ref !== 'string' || !/^[A-Z_][A-Z0-9_]{1,63}$/.test(op.ref)) throw badRequest('The reference must be a vault name like STITCH_API_KEY.');
  const config = readJson(ws, '.mcp.json', '.mcp.json');
  const cur = config.mcpServers?.[op.server]?.[op.field]?.[op.key];
  if (cur === undefined) throw notFound(`.mcp.json has no ${op.field === 'env' ? 'variable' : 'header'} ${op.key} for ${op.server}.`);
  const prefix = op.field === 'headers' && /^Bearer\s/i.test(String(cur)) ? 'Bearer ' : '';
  patchJson(ws, '.mcp.json', ['mcpServers', op.server, op.field, op.key], `${prefix}\${${op.ref}}`);
}

/** Set one variable or header of a server in .mcp.json: a ${NAME} reference, or the key itself when the human chose so. */
function opMcpEnvSet(ws, op) {
  if (typeof op.server !== 'string' || !op.server || op.server.length > 80) throw badRequest('Say which server.');
  if (!['env', 'headers'].includes(op.field)) throw badRequest('field must be env or headers.');
  if (typeof op.key !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(op.key)) throw badRequest('Say which variable or header.');
  if (typeof op.value !== 'string' || !op.value.trim() || op.value.length > 8000 || /[\r\n\0]/.test(op.value)) throw badRequest('The value must be one line.');
  if (/sk-ant-/i.test(op.value)) throw badRequest('That is an Anthropic key: it is never written anywhere.');
  const config = readJson(ws, '.mcp.json', '.mcp.json');
  if (!config.mcpServers?.[op.server]) throw notFound(`.mcp.json has no server ${op.server}.`);
  if (!config.mcpServers[op.server][op.field]) patchJson(ws, '.mcp.json', ['mcpServers', op.server, op.field], {});
  patchJson(ws, '.mcp.json', ['mcpServers', op.server, op.field, op.key], op.value);
}

/** Correct the command and arguments of one server in .mcp.json (a fix proposed on Connections). */
function opMcpServerSet(ws, op) {
  if (typeof op.server !== 'string' || !op.server || op.server.length > 80) throw badRequest('Say which server.');
  const config = readJson(ws, '.mcp.json', '.mcp.json');
  if (!config.mcpServers?.[op.server]) throw notFound(`.mcp.json has no server ${op.server}.`);
  if (op.command !== undefined) {
    if (typeof op.command !== 'string' || !op.command.trim() || op.command.length > 300 || /[\r\n\0&|<>^]/.test(op.command)) throw badRequest('The command must be one program, without shell symbols.');
    patchJson(ws, '.mcp.json', ['mcpServers', op.server, 'command'], op.command.trim());
  }
  if (op.args !== undefined) {
    if (!Array.isArray(op.args) || op.args.length > 30 || !op.args.every((a) => typeof a === 'string' && a.length <= 300 && !/[\r\n\0]/.test(a))) throw badRequest('args must be a list of at most 30 short strings.');
    patchJson(ws, '.mcp.json', ['mcpServers', op.server, 'args'], op.args);
  }
}

function opEngines(ws, op, env) {
  assertName(op.role, 'role');
  const config = readJson(ws, P.consult, 'consult.config.json');
  const failover = op.failover ?? [];
  checkChain(op.engine, failover);
  const prev = config.roles?.[op.role];
  let next;
  if (prev && typeof prev === 'object' && !Array.isArray(prev)) {
    next = { ...prev, engine: op.engine, failover: [...failover] };
  } else {
    next = { engine: op.engine, ...(op.web === true ? { web: true } : {}), failover: [...failover] };
  }
  if (op.web === true) next.web = true;
  else if (op.web === false) delete next.web;
  patchJson(ws, P.consult, ['roles', op.role], next);
  if (!ws.exists(`${P.agentsDir}/${op.role}.md`)) {
    env.warn(`"${op.role}" is not an agent. This order takes effect only if that skill calls consult.mjs --role ${op.role}.`);
  }
}

function opEnginesDefault(ws, op, env) {
  const engine = op.engine;
  if (!['gemini', 'copilot', 'codex'].includes(engine)) throw badRequest('The default engine must be gemini, copilot or codex.');
  const config = readJson(ws, P.consult, 'consult.config.json');
  const reorder = (chain) => {
    const rest = chain.filter((e) => ENGINES.includes(e) && e !== engine && e !== 'self');
    return [engine, ...rest, 'self'];
  };
  patchJson(ws, P.consult, ['default'], engine);
  const top = Array.isArray(config.failover) ? config.failover : ['gemini', 'copilot', 'codex', 'self'];
  patchJson(ws, P.consult, ['failover'], reorder(top));
  let touched = 0;
  for (const [role, entry] of Object.entries(config.roles || {})) {
    if (role.startsWith('_')) continue;
    if (typeof entry === 'string') {
      patchJson(ws, P.consult, ['roles', role], engine);
      touched++;
    } else if (entry && typeof entry === 'object' && typeof entry.engine === 'string') {
      const chain = reorder([entry.engine, ...(Array.isArray(entry.failover) ? entry.failover : [])]);
      patchJson(ws, P.consult, ['roles', role], { ...entry, engine: chain[0], failover: chain.slice(1) });
      touched++;
    } else {
      env.warn(`Skipped roles["${role}"] in consult.config.json: it is not a string or an object.`);
    }
  }
  env.warn(`Set ${engine} first for ${touched} role${touched === 1 ? '' : 's'}; "self" stays last.`);
}

/* ---- the simple ones -------------------------------------------------------------------------- */

function opModel(ws, op, env) {
  assertName(op.role, 'role');
  const models = readJson(ws, P.models, 'models.json');
  const allowed = Array.isArray(models._allowed) ? models._allowed : TIERS;
  if (!allowed.includes(op.model)) throw badRequest(`"${op.model}" is not allowed. Use ${allowed.join(', ')}.`);
  const cur = models.roles?.[op.role];
  if (cur === undefined) throw notFound(`"${op.role}" is not in models.json. Install the agent first.`);
  if (typeof cur === 'string') patchJson(ws, P.models, ['roles', op.role], op.model);
  else patchJson(ws, P.models, ['roles', op.role, 'model'], op.model);
  if (typeof op.note === 'string' && typeof cur !== 'string') {
    if (op.note.length > 2000) throw badRequest('The note is longer than 2000 characters.');
    patchJson(ws, P.models, ['roles', op.role, 'note'], op.note);
  }
  syncAgents(ws, env, { target: op.role });
}

function opRoster(ws, op) {
  const roster = readJson(ws, P.roster, 'roster.json');
  if (typeof op.key !== 'string' || !roster.optional || !Object.prototype.hasOwnProperty.call(roster.optional, op.key)) {
    throw notFound(`"${op.key}" is not an optional agent in roster.json.`);
  }
  patchJson(ws, P.roster, ['optional', op.key], op.value === true);
}

function opAgentField(ws, op) {
  assertName(op.role, 'role');
  const file = `${P.agentsDir}/${op.role}.md`;
  const raw = ws.read(file);
  if (raw == null) throw notFound(`${file} does not exist.`);
  if (op.field === 'model') throw badRequest('Change the tier with the "model" operation, so models.json stays the source of truth.');
  if (!['description', 'tools', 'skills'].includes(op.field)) throw badRequest('field must be description, tools or skills.');
  let value = op.value;
  if (op.field === 'skills') {
    if (!Array.isArray(value) || !value.every((s) => typeof s === 'string' && NAME_RE.test(s))) throw badRequest('skills must be a list of skill names.');
  } else {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value) || value.length > 1024) throw badRequest(`${op.field} must be one line of at most 1024 characters.`);
    value = value.trim();
    if (op.field === 'tools' && !/^[A-Za-z0-9_():.*,\- ]+$/.test(value)) throw badRequest('tools may only contain tool names, commas and spaces.');
  }
  ws.write(file, setFrontMatterField(raw, op.field, value));
}

function opSkillModel(ws, op) {
  assertName(op.name, 'skill name');
  const file = `${P.skillsDir}/${op.name}/SKILL.md`;
  const raw = ws.read(file);
  if (raw == null) throw notFound(`${file} does not exist. Install the skill first.`);
  if (![...TIERS, 'inherit'].includes(op.model)) throw badRequest('A skill\'s model is opus, sonnet, haiku or inherit.');
  let next = setFrontMatterField(raw, 'model', op.model);
  if (op.effort !== undefined && op.effort !== null && op.effort !== '') {
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(op.effort)) throw badRequest('effort must be low, medium, high, xhigh or max.');
    next = setFrontMatterField(next, 'effort', op.effort);
  }
  ws.write(file, next);
}

function asContent(buf) {
  if (looksBinary(buf)) return buf;
  const s = buf.toString('utf8');
  return Buffer.from(s, 'utf8').equals(buf) ? s : buf;
}

const sameContent = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a === b : Buffer.compare(Buffer.from(a ?? ''), Buffer.from(b ?? '')) === 0);

/** The files of a library skill under each folder, as content the workspace can hold. */
const skillWrites = (name, files, dirs) => dirs.flatMap((dir) => files.map((f) => ({ rel: `${dir}/${name}/${f.path}`, content: asContent(f.buffer) })));

/** Which of these writes would replace a file that has different content. */
const clashes = (ws, writes) => writes.filter((w) => {
  const cur = ws.entry(w.rel).after;
  return cur !== null && !sameContent(cur, w.content);
}).map((w) => w.rel);

function opSkillInstall(ws, op, env) {
  assertName(op.name, 'skill name');
  const files = env.ctx.libraryFiles(op.name);
  if (!files.length) throw notFound(`Skill "${op.name}" is not in the library.`);
  const wanted = op.engines === undefined ? ['claude'] : op.engines;
  if (!Array.isArray(wanted) || !wanted.length || !wanted.every((e) => ENGINE_IDS.includes(e))) throw badRequest(`engines must be a list of ${ENGINE_IDS.join(', ')}.`);
  const { dirs, engines, skipped } = skillTargets([...new Set(wanted)], env.ctx.skillEngines(op.name));
  if (!dirs.length) throw badRequest(`Skill "${op.name}" is not for ${wanted.join(', ')}. Change its partition or engines in the library first.`);
  for (const e of skipped) env.warn(`Skill "${op.name}" is not for ${e}, so it was not installed for it.`);
  const writes = skillWrites(op.name, files, dirs);
  const changes = clashes(ws, writes);
  if (changes.length && op.overwrite !== true) {
    throw conflict(`Skill "${op.name}" is already installed here with different content (${changes.length} file${changes.length === 1 ? '' : 's'}). Choose "replace" to overwrite it.`, { files: changes.slice(0, 20) });
  }
  for (const w of writes) ws.write(w.rel, w.content);
  env.effect({ kind: 'skill-use', name: op.name });
  env.warn('Skills are inert files until an engine loads them. Nothing in the skill is run by Circle Studio.');
  if (engines.includes('gemini')) env.warn(GEMINI_SKILLS_NOTE);
}

function opAgentInstall(ws, op, env) {
  assertName(op.role, 'role');
  if (typeof op.from !== 'string' || op.from === '') throw badRequest('Say which project to copy the agent from.');
  const srcRoot = env.ctx.resolveRoot(op.from);
  if (path.resolve(srcRoot) === path.resolve(env.root)) throw badRequest('The source and the target project are the same.');
  const agentText = readTextIfExists(path.join(srcRoot, ...`${P.agentsDir}/${op.role}.md`.split('/')));
  if (agentText == null) throw notFound(`The source has no agent "${op.role}".`);
  const file = `${P.agentsDir}/${op.role}.md`;
  if (ws.exists(file)) throw conflict(`Agent "${op.role}" already exists in this project.`);
  if (!ws.exists(P.models)) throw conflict('This project has no models.json, so it has nowhere to record the agent\'s model.');
  const models = readJson(ws, P.models, 'models.json');
  const srcModelsJ = parseJson(readProjectText(srcRoot, P.models));
  const fm = parseFrontMatter(agentText);
  if (!fm.ok) throw conflict(`The source agent file has broken front matter (${fm.reason}).`);
  let entry = srcModelsJ.ok ? srcModelsJ.value.roles?.[op.role] : undefined;
  if (entry === undefined) {
    entry = { model: fieldString(fm, 'model') || 'sonnet', note: '' };
    env.warn(`The source models.json has no entry for "${op.role}"; used the agent file's model with an empty note.`);
  }
  ws.write(file, agentText);
  if (models.roles?.[op.role] === undefined) patchJson(ws, P.models, ['roles', op.role], entry);
  const srcCfg = parseJson(readProjectText(srcRoot, P.consult));
  const srcRoute = srcCfg.ok ? srcCfg.value.roles?.[op.role] : undefined;
  if (srcRoute !== undefined && srcRoute !== null && ws.exists(P.consult)) {
    const cfg = readJson(ws, P.consult, 'consult.config.json');
    if (cfg.roles?.[op.role] === undefined) patchJson(ws, P.consult, ['roles', op.role], srcRoute);
  }
  const links = ws.read(P.refLinks);
  if (links == null) {
    env.warn('REFERENCE-LINKS.md is missing, so verify-session.py will fail until it has a section for this agent.');
  } else if (!new RegExp(`^##\\s+${op.role}\\s*$`, 'm').test(links)) {
    const eol = detectEol(links);
    ws.write(P.refLinks, `${links.replace(/(\r?\n)*$/, '')}${eol}${eol}## ${op.role}${eol}`);
  }
  syncAgents(ws, env, { target: op.role });
}

/* ---- board ------------------------------------------------------------------------------------ */

const TODAY = () => new Date().toISOString().slice(0, 10);

function opBoardPost(ws, op, env) {
  const rel = P.board;
  const text = typeof op.text === 'string' ? op.text.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
  if (!text || text.length > 400) throw badRequest('The message must be between 1 and 400 characters.');
  if (scanSecrets(text).length) throw badRequest('The message looks like it contains a secret. Circle Studio will not write it to the board.');
  const owner = op.to ? String(op.to) : 'lead';
  if (!(owner === 'all' || owner === 'lead' || NAME_RE.test(owner))) throw badRequest('"to" must be an agent name, "lead" or "all".');
  const sup = Array.isArray(op.supersedes) ? op.supersedes.filter((n) => Number.isInteger(n) && n > 0 && n < 100000) : [];
  const existing = ws.read(rel);
  const eol = existing != null ? detectEol(existing) : '\n';
  const lf = (existing ?? '# Board\n\n| TX | Owner | Status | Source | Summary | Updated |\n|---|---|---|---|---|---|\n').replace(/\r\n/g, '\n');
  const lines = lf.split('\n');
  const isRow = (l) => /^\|\s*TX-\d+\s*\|/i.test(l);
  const max = lines.filter(isRow).reduce((m, l) => Math.max(m, Number(/TX-(\d+)/i.exec(l)[1])), 0);
  const id = `TX-${String(max + 1).padStart(3, '0')}`;
  const esc = (s) => s.replace(/\|/g, '\\|');
  const summary = `${op.urgent === false ? '' : 'URGENT - '}${text}${sup.length ? `; supersedes ${sup.map((n) => `TX-${String(n).padStart(3, '0')}`).join(', ')}` : ''}`;
  const row = `| ${id} | ${owner} | open | human (Circle Studio) | ${esc(summary)} | ${TODAY()} |`;
  const cells = row.replace(/\\\|/g, '').split('|').length - 2;
  if (cells !== 6) throw conflict('The row would not have exactly six cells; the dashboard would drop it.');
  const sepAt = lines.findIndex((l) => /^\|\s*-{2,}/.test(l));
  let out;
  if (sepAt < 0) {
    out = `${lf.replace(/\n*$/, '')}\n\n| TX | Owner | Status | Source | Summary | Updated |\n|---|---|---|---|---|---|\n${row}\n`;
  } else if (op.urgent === false) {
    let last = sepAt;
    while (lines[last + 1] && /^\|/.test(lines[last + 1])) last++;
    lines.splice(last + 1, 0, row);
    out = lines.join('\n');
  } else {
    lines.splice(sepAt + 1, 0, row);
    out = lines.join('\n');
  }
  ws.write(rel, eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out);
  env.warn(`${id} is at the ${op.urgent === false ? 'bottom' : 'top'} of the board. Builders read the board, but a running session only sees it when it next looks.`);
}

/* ---- alerts ------------------------------------------------------------------------------------ */

// The human's answer to a question texter raised. Writes `Status: answered` and an `Answer:` line into that one
// entry, so the team's tracker (which hides answered alerts) and this app's Inbox agree.
function opAlertAnswer(ws, op) {
  const raw = ws.read(P.alerts);
  if (raw == null) throw notFound(`${P.alerts} does not exist.`);
  ws.write(P.alerts, answerAlertText(raw, op.id, op.answer, TODAY()));
}

/* ---- ADRs, freeze ------------------------------------------------------------------------------ */

function opAdrStatus(ws, op) {
  if (typeof op.file !== 'string' || !ADR_FILE_RE.test(op.file)) throw badRequest('file must look like 001-some-title.md.');
  if (!['accepted', 'proposed'].includes(op.status)) throw badRequest('status must be accepted or proposed.');
  const rel = `${P.adrDir}/${op.file}`;
  const raw = ws.read(rel);
  if (raw == null) throw notFound(`${rel} does not exist.`);
  const cut = raw.search(/\r?\n## /);
  const head = cut < 0 ? raw : raw.slice(0, cut);
  const re = /^(- \*\*Status:\*\*)([ \t]*)(.*?)(\r?)$/m;
  const m = re.exec(head);
  if (!m) throw conflict(`${rel} has no "- **Status:**" line before its first "## " heading.`);
  const replaced = head.replace(re, (_, a, sp, _v, cr) => `${a}${sp || ' '}${op.status}${cr}`);
  ws.write(rel, replaced + raw.slice(head.length));
}

function opFreezeSet(ws, op, env) {
  const frozen = Array.isArray(op.frozen) ? op.frozen : [];
  if (!frozen.every((l) => LANES.includes(l)) || new Set(frozen).size !== frozen.length) {
    throw badRequest(`frozen may contain ${LANES.join(', ')} (lowercase, once each).`);
  }
  if (op.requestId != null && op.requestId !== '' && !/^[A-Za-z0-9-]{1,20}$/.test(op.requestId)) throw badRequest('requestId is at most 20 letters, digits or hyphens.');
  const rel = P.freeze;
  const cur = ws.read(rel);
  if (cur == null) {
    const body = JSON.stringify({ frozen, request_id: op.requestId || null, paths: [] }, null, 2);
    ws.write(rel, `${body}\n`);
    return;
  }
  const parsed = readJson(ws, rel, 'freeze.json');
  patchJson(ws, rel, ['frozen'], frozen);
  if (op.requestId !== undefined) patchJson(ws, rel, ['request_id'], op.requestId ? op.requestId : null);
  if (Array.isArray(parsed.paths) && parsed.paths.length) {
    env.warn('freeze.json has "paths", but the guard ignores them: a frozen lane is frozen as a whole.');
  }
}

/* ---- secrets ---------------------------------------------------------------------------------- */

function opSecretsFix(ws, op, env) {
  let fixed = 0;
  for (const rel of [P.mcp, '.claude/settings.json']) {
    const text = ws.read(rel);
    if (text == null) continue;
    let count = 0;
    const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*):-[^}]+\}/g, (_m, name) => { count++; return `\${${name}}`; });
    if (count) { ws.write(rel, out); fixed += count; }
    for (const f of scanSecrets(text).filter((x) => x.kind !== 'default-value')) {
      env.warn(`${rel} line ${f.line} holds what looks like a literal ${f.kind === 'literal-assignment' ? 'secret' : f.kind} (${f.preview}). Move it to an environment variable; Circle Studio cannot pick the variable name for you.`);
    }
  }
  if (!fixed) env.warn('No ${VAR:-default} defaults with a value were found.');
  env.warn('Rotate any key that was ever in these files: it has been readable on disk and may have been committed.');
}

/* ---- human does git --------------------------------------------------------------------------- */

const LOCAL_ONLY = ['/.mcp.json', '/.claude/', '/CLAUDE.md', '/SETUP.md', '/START-HERE.md', '/HOW-TO-RUN.md', '/REFERENCE-LINKS.md', '/trail.md', '/models.json', '/push.md', '/scripts/', '/docs/', '/research/', '/business/'];

export function gitignoreBlock({ ignoreContracts = false } = {}) {
  const entries = ignoreContracts ? [...LOCAL_ONLY, '/contracts/'] : LOCAL_ONLY;
  return [GI_START, '# Local-only: team tooling, planning artefacts and secrets. Only code goes to git.', '# Entries are anchored with a leading slash, so backend/scripts/ and frontend/docs/ stay tracked.', ...entries, GI_END];
}

function pushMd(name, root, ignoreContracts) {
  const check = ['\\.mcp\\.json', '\\.claude/', 'CLAUDE\\.md', 'docs/', ...(ignoreContracts ? ['contracts/'] : []), '\\.env'].join('|');
  return `# Pushing ${name}

Only code goes to GitHub. The team tooling, planning documents and secrets stay on this PC; they are listed in .gitignore.
Circle Studio wrote this page and never runs these commands. You do.

Run everything in Git Bash, in \`${root.replace(/\\/g, '/')}\`.

## First push (once)

\`\`\`
git branch -M main
git status --porcelain -uall | grep -E "${check}"
\`\`\`

The second command must print nothing. If it prints a path, that file is about to be committed: stop and fix .gitignore.

\`\`\`
git add .
git status
git commit -m "First commit"
git remote add origin https://github.com/<you>/${name}.git
git push -u origin main
\`\`\`

Or, with the GitHub CLI: \`gh repo create ${name} --private --source . --push\`

## Every push after that

\`\`\`
git status
git add <the files you mean>
git commit -m "What changed"
git push
\`\`\`

## Before each push, check for secrets

\`\`\`
git diff --cached | grep -iE "api[_-]?key|secret|token|password"
\`\`\`

It should print nothing you would not show a stranger.

## Note for the agent team

\`human_does_git\` is set in .claude/state/roster.json. The team's own files do not read it yet, so tell the lead not to spawn versioner.
`;
}

function opHumanGit(ws, op, env) {
  const on = op.value === true;
  const rosterText = ws.read(P.roster);
  if (rosterText == null) env.warn('This project has no .claude/state/roster.json, so the setting is not recorded there.');
  else patchJson(ws, P.roster, ['human_does_git'], on);
  const gi = ws.read('.gitignore');
  const eol = gi != null ? detectEol(gi) : '\n';
  const lf = (gi ?? '').replace(/\r\n/g, '\n');
  const a = lf.indexOf(GI_START);
  const b = lf.indexOf(GI_END);
  let without = lf;
  if (a >= 0 && b > a) {
    without = (lf.slice(0, a) + lf.slice(b + GI_END.length)).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '\n');
    if (without.trim() === '') without = '';
  }
  if (on) {
    const block = gitignoreBlock({ ignoreContracts: op.ignoreContracts === true }).join('\n');
    const next = a >= 0 && b > a ? lf.slice(0, a) + block + lf.slice(b + GI_END.length) : `${lf.replace(/\n*$/, '')}${lf.trim() ? '\n\n' : ''}${block}\n`;
    ws.write('.gitignore', eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next);
    const name = path.basename(env.root);
    ws.write('push.md', pushMd(name, env.root, op.ignoreContracts === true));
    if (op.ignoreContracts === true) env.warn('/contracts/ is ignored: guard.py\'s task-complete gate cannot see contract changes then. Leave it tracked unless you are sure.');
    env.warn('The team\'s /team-up and versioner do not read human_does_git. Tell the lead to skip versioner; the setting alone changes nothing they do.');
  } else if (a >= 0) {
    ws.write('.gitignore', eol === '\r\n' ? without.replace(/\n/g, '\r\n') : without);
    env.warn('Removed the local-only block from .gitignore. push.md was left alone.');
  }
}

/* ---- the plan --------------------------------------------------------------------------------- */

function opPlanWrite(ws, op, env) {
  const plan = env.ctx.getPlan(env.projectId);
  const workflow = env.ctx.getWorkflow(env.projectId);
  const existing = ws.read(P.brief);
  const eol = existing != null ? detectEol(existing) : '\n';
  ws.write(P.brief, buildBrief(plan, workflow, existing, { eol, today: TODAY() }));
  if (ws.exists(P.roster)) {
    const roster = readJson(ws, P.roster, 'roster.json');
    const want = rosterFromWorkflow(workflow);
    for (const [key, value] of Object.entries(want)) {
      if (roster.optional && Object.prototype.hasOwnProperty.call(roster.optional, key) && roster.optional[key] !== value) {
        patchJson(ws, P.roster, ['optional', key], value);
      }
    }
  }
  if (existing == null) env.warn('docs/brief.md did not exist; it was created from the plan.');
  else env.warn('docs/brief.md exists: only the block between the circle:plan markers changes; your own sections are untouched.');
}

/* ---- the workflow ------------------------------------------------------------------------------ */

const SKILL_FILE = /^\.(?:claude|agents|gemini)\/skills\//;

/** workflow.json, AGENTS.md, the Claude agent files and the skills the nodes list. The brief is plan-write's. */
function opWorkflowWrite(ws, op, env) {
  const workflow = env.ctx.getWorkflow(env.projectId);
  const plan = env.ctx.getPlan(env.projectId);
  const { files, warnings } = renderProject({
    name: plan.brief.name || path.basename(env.root),
    idea: plan.idea,
    workflow,
    plan,
    library: { files: env.ctx.libraryFiles, enginesFor: env.ctx.skillEngines },
    brief: false,
    claudeMd: false,
  });
  warnings.forEach((w) => env.warn(w));
  const left = [];
  let rewritten = 0;
  for (const f of files) {
    const content = typeof f.content === 'string' ? f.content : asContent(f.content);
    const cur = ws.entry(f.path).after;
    if (cur !== null && SKILL_FILE.test(f.path) && !sameContent(cur, content)) { left.push(f.path); continue; }
    if (cur !== null && f.path.startsWith(`${P.agentsDir}/`) && !sameContent(cur, content)) rewritten++;
    ws.write(f.path, content);
  }
  if (left.length) env.warn(`${left.length} installed skill file${left.length === 1 ? ' differs' : 's differ'} from the library and ${left.length === 1 ? 'was' : 'were'} left alone. Use "replace" on the skill to overwrite.`);
  if (rewritten) env.warn(`${rewritten} agent file${rewritten === 1 ? '' : 's'} already existed and ${rewritten === 1 ? 'is' : 'are'} rewritten from the workflow. Check the diff for edits you made by hand.`);
  const claudeMd = ws.read('CLAUDE.md');
  if (files.some((f) => f.path.startsWith(`${P.agentsDir}/`)) && !/^@AGENTS\.md\s*$/m.test(claudeMd ?? '')) {
    env.warn('Claude does not read AGENTS.md by itself. Add the line @AGENTS.md to CLAUDE.md; Circle Studio does not write that file in an existing project.');
  }
}

/* ---- registry --------------------------------------------------------------------------------- */

function opSyncAgents(ws, op, env) {
  syncAgents(ws, env, {});
}

export const OPS = {
  model: opModel,
  'sync-agents': opSyncAgents,
  engines: opEngines,
  'engines-default': opEnginesDefault,
  roster: opRoster,
  'agent-field': opAgentField,
  'skill-model': opSkillModel,
  'skill-install': opSkillInstall,
  'agent-install': opAgentInstall,
  'plan-write': opPlanWrite,
  'workflow-write': opWorkflowWrite,
  'board-post': opBoardPost,
  'human-git': opHumanGit,
  'secrets-fix': opSecretsFix,
  'adr-status': opAdrStatus,
  'alert-answer': opAlertAnswer,
  'mcp-env-ref': opMcpEnvRef,
  'mcp-server-set': opMcpServerSet,
  'mcp-env-set': opMcpEnvSet,
  'freeze-set': opFreezeSet,
};

export function runOps(ws, ops, env) {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 50) throw badRequest('ops must be a list of 1 to 50 operations.');
  for (const op of ops) {
    const fn = op && typeof op === 'object' ? OPS[op.op] : undefined;
    if (!fn) throw badRequest(`Unknown operation "${op && op.op}".`);
    fn(ws, op, env);
  }
}
