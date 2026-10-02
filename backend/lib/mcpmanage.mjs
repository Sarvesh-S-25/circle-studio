// The connection manager: every MCP server grouped by name across projects and engines, what is redundant or broken,
// and one-click plans that fix it. A plan is a list of plain steps shown before anything runs; it then runs them:
//   - Claude Code's own config (~/.claude.json) changes through its official CLI (claude mcp add-json / remove), after a
//     backup of the file; a folder that no longer exists is cleaned straight in the file (the CLI needs the folder).
//   - A key goes to your Windows user environment (so Claude Code in any terminal reads it; it fills ${NAME} in its
//     configs, verified on this PC) and to the vault (for engines Circle Studio runs). Or, when you choose, literally
//     into the config file.
//   - A project's .mcp.json changes only through the usual diff review: such steps come back as ops to review.
// Key values stay in this process: plans and results carry names only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SECRET_NAME, whichCommand, isBundled } from './connections.mjs';
import { scanSecrets } from './secrets.mjs';

const isRef = (v) => typeof v === 'string' && /^(Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v.trim());
const envNameOf = (header) => header.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
const setupOf = (s) => (s.transport === 'stdio' ? `${s.command} ${s.argsText || ''}`.trim() : s.url || '');
const where = (s) => (s.folder ? path.basename(s.folder) : s.scope === 'user' ? 'every project' : isBundled(s) ? `the ${s.scope.replace(': ', ' "')}"` : s.file);
// "npx -y @playwright/mcp@latest" and "npx @playwright/mcp" are the same server: compare without flags and versions
const sameServer = (a, b) => {
  const norm = (s) => (s.transport === 'stdio' ? `${s.command} ${s.argsText || ''}`.replace(/\s-y\b|\s--yes\b/g, '').replace(/@(latest|\^?[\d.]+)(?=\s|$)/g, '') : s.url || '').trim().toLowerCase();
  return a.engine === b.engine && norm(a) === norm(b);
};

/** What already gives `engine` a server like this (by name or by the same command) in the project at `root`, if any. */
export function alreadyAvailable(servers, { engine, name, setup }) {
  const probe = { engine, transport: setup?.url ? 'http' : 'stdio', command: setup?.command || '', argsText: (setup?.args || []).join(' '), url: setup?.url ? (() => { try { const u = new URL(setup.url); return `${u.protocol}//${u.host}`; } catch { return setup.url; } })() : null };
  return servers.filter((s) => s.engine === engine && !s.disabled && (s.name.toLowerCase() === String(name || '').toLowerCase() || (setup && sameServer(s, probe))));
}

/** The secret entries of one raw config: [{ field: 'env'|'headers', key, name (the variable to use), literal, bearer }]. */
export function secretsOf(raw) {
  const out = [];
  for (const [k, v] of Object.entries(raw?.env || {})) {
    if (typeof v !== 'string') continue;
    if (isRef(v)) { out.push({ field: 'env', key: k, name: /\$\{([^}]+)\}/.exec(v)[1], literal: null }); continue; }
    if (SECRET_NAME.test(k) || scanSecrets(v).length) out.push({ field: 'env', key: k, name: k.toUpperCase().replace(/[^A-Z0-9_]/g, '_'), literal: v });
  }
  for (const [k, v] of Object.entries(raw?.headers || {})) {
    if (typeof v !== 'string') continue;
    const bearer = /^Bearer\s+/i.test(v);
    const bare = v.replace(/^Bearer\s+/i, '');
    if (isRef(v)) { out.push({ field: 'headers', key: k, name: /\$\{([^}]+)\}/.exec(v)[1], literal: null, bearer }); continue; }
    if (SECRET_NAME.test(k) || scanSecrets(bare).length || bearer) out.push({ field: 'headers', key: k, name: envNameOf(k), literal: bare, bearer });
  }
  return out;
}

/** The same server config with every secret replaced by ${NAME} (what Claude Code fills from the environment). */
export function withRefs(raw, names = {}) {
  const sec = secretsOf(raw);
  const cfg = raw.url || raw.httpUrl || raw.serverUrl
    ? { type: raw.type === 'sse' ? 'sse' : 'http', url: raw.url || raw.httpUrl || raw.serverUrl, ...(raw.headers ? { headers: { ...raw.headers } } : {}) }
    : { type: 'stdio', command: raw.command, args: [...(raw.args || [])], ...(raw.env ? { env: { ...raw.env } } : {}) };
  for (const s of sec) {
    const name = names[s.key] || s.name;
    if (s.field === 'env') cfg.env[s.key] = `\${${name}}`;
    else cfg.headers[s.key] = `${s.bearer ? 'Bearer ' : ''}\${${name}}`;
  }
  return cfg;
}

/** Group the servers by name and find what to fix. `health` = { id: 'ok'|'broken'|... } from quick checks. */
export function analyze(servers, { health = {}, exists = (p) => fs.existsSync(p) } = {}) {
  const groups = new Map();
  for (const s of servers) { if (!groups.has(s.name)) groups.set(s.name, []); groups.get(s.name).push(s); }
  const bundled = servers.filter(isBundled);
  const out = [];
  for (const [name, copies] of groups) {
    const findings = [];
    // set up by hand although a plugin already brings the same server to every project
    const covered = copies.filter((s) => !isBundled(s) && s.engine === 'claude' && !(s.folder && !exists(s.folder)))
      .map((s) => ({ s, by: bundled.find((b) => b.engine === s.engine && (b.name === s.name || sameServer(b, s))) })).filter((x) => x.by);
    if (covered.length) {
      const by = covered[0].by;
      const removable = covered.filter((x) => x.s.scope !== 'project').map((x) => x.s);
      findings.push({ kind: 'covered', severity: 'warn', title: `Already comes with ${where(by)}`, detail: `Claude Code gets "${by.name}" from the plugin in every project, so ${covered.map((x) => where(x.s)).join(', ')} ${covered.length === 1 ? 'does' : 'do'} not need ${covered.length === 1 ? 'its own copy' : 'their own copies'}. Two copies of one server start it twice and can confuse the agent.`, action: removable.length ? { kind: 'remove', ids: removable.map((s) => s.id), label: `Remove the extra ${removable.length === 1 ? 'copy' : 'copies'}` } : null });
    }
    const isBroken = (s) => health[s.id] === 'broken' || (s.transport === 'stdio' && !whichCommand(s.command || ''));
    const stale = copies.filter((s) => s.folder && !exists(s.folder));
    const live = copies.filter((s) => !stale.includes(s));
    const broken = live.filter(isBroken);
    const working = live.filter((s) => !isBroken(s));
    const claudeLocal = live.filter((s) => s.engine === 'claude' && s.scope.startsWith('local') && !isBroken(s));
    const setups = new Map();
    for (const s of live.filter((x) => !isBroken(x))) { const k = setupOf(s); if (!setups.has(k)) setups.set(k, []); setups.get(k).push(s); }
    if (stale.length) findings.push({ kind: 'stale', severity: 'warn', title: `${stale.length === 1 ? 'A copy is' : `${stale.length} copies are`} set up for ${stale.length === 1 ? 'a folder' : 'folders'} that no longer exist${stale.length === 1 ? 's' : ''}`, detail: stale.map((s) => s.folder).join(', '), action: { kind: 'remove', ids: stale.map((s) => s.id), label: 'Clean them up' } });
    for (const b of broken) {
      const twin = working.find((w) => w.engine === b.engine) || working[0];
      findings.push({ kind: 'broken', severity: 'danger', title: `Broken in ${where(b)}`, detail: isBundled(b) ? 'It comes with a plugin: update or reinstall the plugin in Claude Code (/plugin).' : twin ? `It starts fine in ${where(twin)}: copy that setup.` : 'No working copy to learn from: Test it to see why.', action: twin && b.engine === 'claude' && !isBundled(b) ? { kind: 'repair', id: b.id, from: twin.id, label: 'Fix it for me' } : null, serverId: b.id });
    }
    // a project's own copy that is the same as the one every project already gets (same command and the same key names)
    const shared = live.filter((s) => s.engine === 'claude' && s.scope === 'user' && !isBroken(s));
    const sameKeys = (a, b) => [...a.envNames, ...a.headerNames].sort().join() === [...b.envNames, ...b.headerNames].sort().join();
    const extra = claudeLocal.filter((s) => shared.some((u) => sameServer(u, s) && sameKeys(u, s)) && !covered.some((x) => x.s === s));
    if (extra.length) findings.push({ kind: 'redundant', severity: 'info', title: `${extra.length === 1 ? 'A project keeps its own copy' : `${extra.length} projects keep their own copy`} of the shared server`, detail: `${extra.map(where).join(', ')} ${extra.length === 1 ? 'has' : 'have'} the same "${name}" that every project already gets. Removing ${extra.length === 1 ? 'it' : 'them'} changes nothing for those projects, and you have one setup less to keep working.`, action: { kind: 'remove', ids: extra.map((s) => s.id), label: `Remove the extra ${extra.length === 1 ? 'copy' : 'copies'}` } });
    const biggest = [...setups.values()].sort((a, c) => c.length - a.length)[0] || [];
    const sameLocal = biggest.filter((s) => claudeLocal.includes(s));
    if (sameLocal.length >= 2 && !live.some((s) => s.engine === 'claude' && s.scope === 'user')) {
      findings.push({ kind: 'duplicate', severity: 'info', title: `The same setup is copied into ${sameLocal.length} projects`, detail: `${sameLocal.map(where).join(', ')} each keep their own copy (and their own key). One shared server for all your projects is easier to keep working: change it once.`, action: { kind: 'share', ids: sameLocal.map((s) => s.id), from: sameLocal[0].id, label: `Make it one shared server (replaces ${sameLocal.length} copies)` } });
    }
    if (setups.size > 1) findings.push({ kind: 'conflict', severity: 'info', title: `${setups.size} different setups share the name "${name}"`, detail: [...setups].map(([k, ss]) => `${k} (${ss.map(where).join(', ')})`).join('; ') });
    const plain = live.filter((s) => s.plainSecrets.length);
    const securable = plain.filter((s) => s.engine === 'claude' && !isBundled(s) && s.scope !== 'project');
    if (plain.length) findings.push({ kind: 'plain', severity: 'danger', title: `${plain.length === 1 ? 'A key is' : `Keys are`} written in plain text in ${plain.length === 1 ? 'one copy' : `${plain.length} copies`}`, detail: plain.map((s) => `${where(s)}: ${s.plainSecrets.join(', ')}`).join('; '), action: securable.length ? { kind: 'secure', ids: securable.map((s) => s.id), label: 'Move the keys to my Windows environment' } : null });
    out.push({ name, copies: copies.map((s) => ({ id: s.id, engine: s.engine, scope: s.scope, where: where(s), setup: setupOf(s), transport: s.transport, broken: isBroken(s), stale: stale.includes(s), plainSecrets: s.plainSecrets, envNames: s.envNames, headerNames: s.headerNames })), findings });
  }
  return out.sort((a, b) => b.findings.length - a.findings.length || a.name.localeCompare(b.name));
}

/* ---- plans --------------------------------------------------------------------------------------------------- */

const scopeOf = (s) => (s.scope === 'project' ? 'project' : s.scope === 'user' ? 'user' : 'local');

/**
 * Build a plan. `ctx` = { servers, rawOf(id), projectIdFor(folder) }. Returns { title, steps: [{ text, cmd?, run }], ops?,
 * projectId?, retest: [ids], secrets: Map(name -> value) } where `secrets` never leaves the server.
 */
export function makePlan(action, ctx) {
  const byId = new Map(ctx.servers.map((s) => [s.id, s]));
  const steps = [];
  const secrets = new Map();
  const retest = [];
  const claudeCmd = (args, cwd) => ({ kind: 'claude', args, cwd });
  const shown = (args) => `claude ${args.map((a) => (/[\s"{}]/.test(a) ? `'${a}'` : a)).join(' ')}`;
  const addJson = (server, cfg, scope, cwd) => {
    const args = ['mcp', 'add-json', server.name, JSON.stringify(cfg), '-s', scope];
    steps.push({ text: `Add "${server.name}" ${scope === 'user' ? 'for every project' : `in ${where(server)}`} with the working setup${cfg.env || cfg.headers ? ', reading its key from the environment' : ''}.`, cmd: shown(args), run: claudeCmd(args, cwd) });
  };
  const remove = (server) => {
    const args = ['mcp', 'remove', server.name, '-s', scopeOf(server)];
    if (server.folder && !fs.existsSync(server.folder)) steps.push({ text: `Remove "${server.name}" for ${server.folder} (the folder is gone), straight from ~/.claude.json.`, run: { kind: 'drop-local', folder: server.folder, name: server.name } });
    else steps.push({ text: `Remove the copy of "${server.name}" in ${where(server)}.`, cmd: shown(args), run: claudeCmd(args, server.folder || undefined) });
  };
  const keepKeys = (raw, projects, from = null) => {
    for (const sec of secretsOf(raw)) {
      if (!sec.literal || secrets.has(sec.name)) continue;
      secrets.set(sec.name, sec.literal);
      steps.push({ text: `Save the key${from ? ` already used in ${from}` : ''} as ${sec.name} in your Windows user environment and in the vault (it is not shown).`, run: { kind: 'key', name: sec.name, projects } });
    }
  };
  const needClaude = (s) => {
    if (isBundled(s)) throw new Error(`"${s.name}" comes with ${where(s)}: change or turn off the plugin in Claude Code instead.`);
    if (s.engine !== 'claude' || s.scope === 'project') throw new Error(`Only Claude Code's own config is changed this way; ${s.file} is not.`);
  };

  if (action.kind === 'remove') {
    for (const id of action.ids) { const s = byId.get(id); if (s) { needClaude(s); remove(s); } }
    return { title: 'Clean up copies', steps, secrets, retest };
  }
  if (action.kind === 'repair') {
    const s = byId.get(action.id);
    const twin = byId.get(action.from);
    if (!s || !twin) throw new Error('That server is gone; reload Connections.');
    needClaude(s);
    const raw = ctx.rawOf(twin.id);
    keepKeys(raw, ctx.projectIdFor(s.folder) ? [ctx.projectIdFor(s.folder)] : 'all', where(twin));
    remove(s);
    addJson(s, withRefs(raw), scopeOf(s), s.folder || undefined);
    retest.push(s.id);
    return { title: `Fix "${s.name}" in ${where(s)} with the setup from ${where(twin)}`, steps, secrets, retest };
  }
  if (action.kind === 'share') {
    const copies = action.ids.map((id) => byId.get(id)).filter(Boolean);
    const from = byId.get(action.from) || copies[0];
    if (!from) throw new Error('Those servers are gone; reload Connections.');
    copies.forEach(needClaude);
    const raw = ctx.rawOf(from.id);
    keepKeys(raw, 'all', where(from));
    addJson({ ...from, scope: 'user', folder: null }, withRefs(raw), 'user', undefined);
    for (const c of copies) remove(c);
    retest.push(`claude:user:${from.name}`);
    return { title: `One shared "${from.name}" for all your projects`, note: 'A shared server is available in every project, including ones that did not have it.', steps, secrets, retest };
  }
  if (action.kind === 'secure') {
    for (const id of action.ids) {
      const s = byId.get(id);
      if (!s) continue;
      needClaude(s);
      const raw = ctx.rawOf(id);
      keepKeys(raw, ctx.projectIdFor(s.folder) ? [ctx.projectIdFor(s.folder)] : 'all');
      remove(s);
      addJson(s, withRefs(raw), scopeOf(s), s.folder || undefined);
      retest.push(s.id);
    }
    return { title: 'Move the keys out of the config files', steps, secrets, retest };
  }
  if (action.kind === 'key') {
    // the human pastes a key: to the environment (recommended) or literally into the config
    const s = byId.get(action.id);
    if (!s) throw new Error('That server is gone; reload Connections.');
    const raw = ctx.rawOf(s.id) || {};
    const field = action.field === 'headers' ? 'headers' : 'env';
    const key = String(action.key || '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(key)) throw new Error('Say which variable or header the key is for.');
    // a key already saved on the Keys page: only its name goes into the config
    const fromVault = typeof action.fromVault === 'string' && action.fromVault ? action.fromVault.toUpperCase() : null;
    const name = String(fromVault || action.name || (field === 'env' ? key : envNameOf(key))).toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]{1,63}$/.test(name)) throw new Error('Use a name like STITCH_API_KEY: capitals, digits and _.');
    if (/^ANTHROPIC_/i.test(name)) throw new Error('Circle Studio never stores an Anthropic key: Claude runs through your own sign-in.');
    const bearer = field === 'headers' && (/^Bearer\s/i.test(String(raw.headers?.[key] || '')) || /^authorization$/i.test(key));
    const toConfig = !fromVault && action.target === 'config';
    let value = '';
    if (fromVault) {
      if (!ctx.vaultHas?.(fromVault)) throw new Error(`There is no saved key called ${fromVault}.`);
      steps.push({ text: `Make your saved key ${name} readable by Claude Code in any terminal (your Windows user environment; it is not shown).`, run: { kind: 'env-from-vault', name } });
    } else {
      if (typeof action.value !== 'string' || !action.value.trim() || /[\r\n\0]/.test(action.value)) throw new Error('Paste the key: one line.');
      if (/sk-ant-/i.test(action.value)) throw new Error('That is an Anthropic key: Circle Studio never stores one. Claude runs through your own sign-in.');
      value = action.value.trim().replace(/^Bearer\s+/i, '');
      if (!toConfig) {
        secrets.set(name, value);
        steps.push({ text: `Save the key as ${name} in your Windows user environment and in your saved keys (it is not shown).`, run: { kind: 'key', name, projects: s.folder && ctx.projectIdFor(s.folder) ? [ctx.projectIdFor(s.folder)] : ctx.projectId ? [ctx.projectId] : 'all' } });
      }
    }
    const literal = `${bearer ? 'Bearer ' : ''}${value}`;
    const ref = `${bearer ? 'Bearer ' : ''}\${${name}}`;
    if (s.scope === 'project' && s.engine === 'claude') {
      const op = toConfig ? { op: 'mcp-env-set', server: s.name, field, key, value: literal } : { op: 'mcp-env-set', server: s.name, field, key, value: ref };
      return { title: `Give "${s.name}" its key`, steps, secrets, retest: [s.id], ops: [op], projectId: ctx.projectId };
    }
    needClaude(s);
    const cfg = withRefs(raw);
    if (field === 'env') cfg.env = { ...(cfg.env || {}), [key]: toConfig ? literal : ref };
    else cfg.headers = { ...(cfg.headers || {}), [key]: toConfig ? literal : ref };
    remove(s);
    const args = ['mcp', 'add-json', s.name, '__CONFIG__', '-s', scopeOf(s)];
    steps.push({ text: `Add "${s.name}" again in ${where(s)}${toConfig ? ' with the key written into ~/.claude.json (plain text, as you chose)' : ` reading ${name} from the environment`}.`, cmd: shown(['mcp', 'add-json', s.name, JSON.stringify(withRefs(cfg)), '-s', scopeOf(s)]), run: { kind: 'claude', args, cwd: s.folder || undefined, config: cfg } });
    retest.push(s.id);
    return { title: `Give "${s.name}" its key`, steps, secrets, retest };
  }
  if (action.kind === 'add') return planAdd(action, ctx, { steps, secrets, retest, shown });
  throw new Error('Unknown action.');
}

/**
 * Add a server to one project for Claude Code: "local" (only this folder, kept in Claude Code's own settings) or
 * "project" (the project's .mcp.json, shared with whoever uses the folder; reviewed as a diff). A key comes from the
 * saved keys or is pasted, and the config only names it (${NAME}). Refused when the project already gets a server
 * like it (same name or same command, from every-project settings, a plugin or this project) unless `force`.
 */
function planAdd(action, ctx, { steps, secrets, retest, shown }) {
  const name = String(action.name || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(name)) throw new Error('Name it with letters, digits, - _ or . (for example stitch).');
  const s = action.setup || {};
  const url = typeof s.url === 'string' && s.url.trim() ? s.url.trim() : null;
  const command = typeof s.command === 'string' ? s.command.trim() : '';
  const args = Array.isArray(s.args) ? s.args.map(String).filter((a) => a.length) : String(s.args || '').trim().split(/\s+/).filter(Boolean);
  if (!url && !command) throw new Error('Give the command that starts it (for example npx -y some-mcp-server) or its web address.');
  if (url && !/^https?:\/\//i.test(url)) throw new Error('The address must start with https://.');
  if (command && /[\r\n\0&|<>^]/.test(command)) throw new Error('The command must be one program, without shell symbols.');
  const setup = url ? { url } : { command, args };
  const dupes = alreadyAvailable(ctx.servers, { engine: 'claude', name, setup });
  if (dupes.length && !action.force) {
    const e = new Error(`This project already has it: ${dupes.map((d) => `"${d.name}" from ${where(d)}`).join(', ')}. Adding it again would start the same server twice.`);
    e.duplicates = dupes.map((d) => ({ id: d.id, name: d.name, where: where(d) }));
    throw e;
  }
  const scope = action.scope === 'project' ? 'project' : 'local';
  const k = action.key && typeof action.key === 'object' ? action.key : null;
  let ref = null;
  let field = null;
  let keyName = null;
  if (k) {
    field = k.field === 'headers' || (url && k.field !== 'env') ? 'headers' : 'env';
    keyName = String(k.name || '').toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]{1,63}$/.test(keyName)) throw new Error('Name the key like STITCH_API_KEY: capitals, digits and _.');
    if (/^ANTHROPIC_/.test(keyName)) throw new Error('Circle Studio never stores an Anthropic key: Claude runs through your own sign-in.');
    const slot = String(k.slot || (field === 'headers' ? 'Authorization' : keyName));
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(slot)) throw new Error('Say which variable or header the server reads the key from.');
    const bearer = field === 'headers' && /^authorization$/i.test(slot);
    ref = { slot, value: `${bearer ? 'Bearer ' : ''}\${${keyName}}` };
    if (typeof k.value === 'string' && k.value.trim()) {
      if (/[\r\n\0]/.test(k.value)) throw new Error('Paste the key: one line.');
      if (/sk-ant-/i.test(k.value)) throw new Error('That is an Anthropic key: Circle Studio never stores one. Claude runs through your own sign-in.');
      secrets.set(keyName, k.value.trim().replace(/^Bearer\s+/i, ''));
      steps.push({ text: `Save the key as ${keyName} in your Windows user environment and in your saved keys (it is not shown).`, run: { kind: 'key', name: keyName, projects: ctx.projectId ? [ctx.projectId] : 'all' } });
    } else {
      if (!ctx.vaultHas?.(keyName)) throw new Error(`There is no saved key called ${keyName}. Add it on the Keys page, or paste it here.`);
      steps.push({ text: `Make your saved key ${keyName} readable by Claude Code in any terminal (your Windows user environment; it is not shown).`, run: { kind: 'env-from-vault', name: keyName } });
    }
  }
  const cfg = url
    ? { type: /\/sse\b/.test(url) ? 'sse' : 'http', url, ...(ref ? { headers: { [ref.slot]: ref.value } } : {}) }
    : { type: 'stdio', command, args, ...(ref ? { env: { [ref.slot]: ref.value } } : {}) };
  if (scope === 'project') {
    const { type, ...entry } = cfg;
    return { title: `Add "${name}" to this project's .mcp.json`, note: 'Everyone who opens this folder with Claude Code gets it. Only the key\'s name is written; each person keeps the key in their own environment.', steps, secrets, retest: [`claude:project:${name}`], ops: [{ op: 'mcp-server-add', server: name, config: url ? { ...entry, type } : entry }], projectId: ctx.projectId };
  }
  if (!ctx.root) throw new Error('Pick a project first.');
  const cmdArgs = ['mcp', 'add-json', name, JSON.stringify(cfg), '-s', 'local'];
  steps.push({ text: `Add "${name}" to Claude Code for this project only${ref ? `, reading ${keyName} from the environment` : ''}.`, cmd: shown(cmdArgs), run: { kind: 'claude', args: cmdArgs, cwd: ctx.root } });
  retest.push(`claude:local:${name}`);
  return { title: `Add "${name}" to this project`, steps, secrets, retest, projectId: ctx.projectId };
}

/** Plans live here for a few minutes between the preview and the click (with their secrets, never sent out). */
export class Plans {
  constructor() { this.map = new Map(); }
  put(plan) {
    const id = `cp_${crypto.randomBytes(5).toString('hex')}`;
    this.map.set(id, { ...plan, at: Date.now() });
    for (const [k, v] of this.map) if (Date.now() - v.at > 10 * 60_000) this.map.delete(k);
    return id;
  }
  take(id) { const p = this.map.get(id); this.map.delete(id); return p; }
  view(id, p) { return { id, title: p.title, note: p.note || null, steps: p.steps.map(({ text, cmd }) => ({ text, cmd: cmd || null })), ops: p.ops || null, projectId: p.projectId || null }; }
}

/** Remove one server from ~/.claude.json for a folder that is gone (the CLI cannot, it needs that folder). */
export function dropLocal(claudeJson, folder, name) {
  const j = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
  const norm = (p) => path.resolve(p).toLowerCase();
  for (const [p, v] of Object.entries(j.projects || {})) if (norm(p) === norm(folder) && v?.mcpServers?.[name]) delete v.mcpServers[name];
  fs.writeFileSync(claudeJson, `${JSON.stringify(j, null, 2)}\n`);
}

/** A persistent user environment variable (HKCU\Environment), read by every program started after this. */
export function setUserEnv(name, value) {
  if (process.platform !== 'win32') throw new Error('Saving to the user environment works on Windows only.');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::SetEnvironmentVariable($env:CS_N, $env:CS_V, "User")'], { windowsHide: true, timeout: 20_000, env: { ...process.env, CS_N: name, CS_V: value } });
  if (r.status !== 0) throw new Error('Windows did not save the variable.');
}

/**
 * Run a plan. deps = { runClaude(args, cwd) -> {code, stdout, stderr}, setUserEnv, vault, claudeJson, backupDir }.
 * ~/.claude.json is backed up before the first change and put back if a step fails, so a server is never left half
 * removed. Returns [{ text, ok, detail }] (no key values).
 */
/**
 * Backups of ~/.claude.json are copies of a file that may hold keys: keep them only as long as they are useful
 * (the newest few, for a day at most).
 */
export function pruneBackups(dir, { keep = 3, maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^claude\.json\..+\.bak$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })); } catch { return 0; }
  files.sort((a, b) => b.t - a.t);
  let removed = 0;
  files.forEach((x, i) => { if (i >= keep || now - x.t > maxAgeMs) { try { fs.rmSync(path.join(dir, x.f)); removed++; } catch { /* in use */ } } });
  return removed;
}

export async function runPlan(plan, deps) {
  const results = [];
  let backup = null;
  pruneBackups(deps.backupDir);
  const touchesClaude = plan.steps.some((s) => s.run.kind === 'claude' || s.run.kind === 'drop-local');
  if (touchesClaude && fs.existsSync(deps.claudeJson)) {
    fs.mkdirSync(deps.backupDir, { recursive: true });
    backup = path.join(deps.backupDir, `claude.json.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
    fs.copyFileSync(deps.claudeJson, backup);
  }
  const hide = (t) => { let s = String(t || ''); for (const v of plan.secrets.values()) if (v) s = s.split(v).join('<key>'); return s.slice(0, 600); };
  for (const step of plan.steps) {
    const r = step.run;
    try {
      if (r.kind === 'claude') {
        const args = r.args.map((a) => (a === '__CONFIG__' ? JSON.stringify(r.config) : a));
        const out = await deps.runClaude(args, r.cwd);
        const ok = out.code === 0;
        results.push({ text: step.text, ok, detail: hide(`${out.stdout}${out.stderr}`.trim()) });
        if (!ok) throw new Error('step failed');
      } else if (r.kind === 'key') {
        const value = plan.secrets.get(r.name);
        deps.setUserEnv(r.name, value);
        await deps.vault.set(r.name, { value, projects: r.projects, note: 'Saved by the connection manager' });
        results.push({ text: step.text, ok: true, detail: `${r.name} saved. Open a new terminal (or restart Claude Code) so it sees it.` });
      } else if (r.kind === 'env-from-vault') {
        const value = deps.vault.value(r.name);
        if (!value) throw new Error(`Could not read the saved key ${r.name}.`);
        plan.secrets.set(r.name, value); // so it is masked in any output below
        deps.setUserEnv(r.name, value);
        results.push({ text: step.text, ok: true, detail: `${r.name} is set. Open a new terminal (or restart Claude Code) so it sees it.` });
      } else if (r.kind === 'drop-local') {
        dropLocal(deps.claudeJson, r.folder, r.name);
        results.push({ text: step.text, ok: true, detail: '' });
      }
    } catch (e) {
      if (e.message !== 'step failed') results.push({ text: step.text, ok: false, detail: hide(e.message) });
      if (backup) { fs.copyFileSync(backup, deps.claudeJson); results.push({ text: 'Put ~/.claude.json back as it was before.', ok: true, detail: path.basename(backup) }); }
      return { ok: false, results, backup };
    }
  }
  // the fix moved or used keys: its backup is the one place left with them in plain text, so it goes now
  if (backup && plan.secrets.size) {
    try { fs.rmSync(backup); results.push({ text: 'Deleted the backup of ~/.claude.json: it held keys in plain text, and the fix worked.', ok: true, detail: '' }); backup = null; } catch { /* kept: pruned within a day */ }
  }
  return { ok: true, results, backup };
}
