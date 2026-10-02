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
import { SECRET_NAME, whichCommand } from './connections.mjs';
import { scanSecrets } from './secrets.mjs';

const isRef = (v) => typeof v === 'string' && /^(Bearer\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v.trim());
const envNameOf = (header) => header.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
const setupOf = (s) => (s.transport === 'stdio' ? `${s.command} ${s.argsText || ''}`.trim() : s.url || '');
const where = (s) => (s.folder ? path.basename(s.folder) : s.scope === 'user' ? 'every project' : s.file);

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
  const out = [];
  for (const [name, copies] of groups) {
    const findings = [];
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
      findings.push({ kind: 'broken', severity: 'danger', title: `Broken in ${where(b)}`, detail: twin ? `It starts fine in ${where(twin)}: copy that setup.` : 'No working copy to learn from: Test it to see why.', action: twin && b.engine === 'claude' ? { kind: 'repair', id: b.id, from: twin.id, label: 'Fix it for me' } : null, serverId: b.id });
    }
    const biggest = [...setups.values()].sort((a, c) => c.length - a.length)[0] || [];
    const sameLocal = biggest.filter((s) => claudeLocal.includes(s));
    if (sameLocal.length >= 2 && !live.some((s) => s.engine === 'claude' && s.scope === 'user')) {
      findings.push({ kind: 'duplicate', severity: 'info', title: `The same setup is copied into ${sameLocal.length} projects`, detail: `${sameLocal.map(where).join(', ')} each keep their own copy (and their own key). One shared server for all your projects is easier to keep working: change it once.`, action: { kind: 'share', ids: sameLocal.map((s) => s.id), from: sameLocal[0].id, label: `Make it one shared server (replaces ${sameLocal.length} copies)` } });
    }
    if (setups.size > 1) findings.push({ kind: 'conflict', severity: 'info', title: `${setups.size} different setups share the name "${name}"`, detail: [...setups].map(([k, ss]) => `${k} (${ss.map(where).join(', ')})`).join('; ') });
    const plain = live.filter((s) => s.plainSecrets.length);
    if (plain.length) findings.push({ kind: 'plain', severity: 'danger', title: `${plain.length === 1 ? 'A key is' : `Keys are`} written in plain text in ${plain.length === 1 ? 'one copy' : `${plain.length} copies`}`, detail: plain.map((s) => `${where(s)}: ${s.plainSecrets.join(', ')}`).join('; '), action: plain.every((s) => s.engine === 'claude') ? { kind: 'secure', ids: plain.map((s) => s.id), label: 'Move the keys to my Windows environment' } : null });
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
  const needClaude = (s) => { if (s.engine !== 'claude' || s.scope === 'project') throw new Error(`Only Claude Code's own config is changed this way; ${s.file} is not.`); };

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
    const name = String(action.name || (field === 'env' ? key : envNameOf(key))).toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]{1,63}$/.test(name)) throw new Error('Use a name like STITCH_API_KEY: capitals, digits and _.');
    if (typeof action.value !== 'string' || !action.value.trim() || /[\r\n\0]/.test(action.value)) throw new Error('Paste the key: one line.');
    if (/sk-ant-/i.test(action.value) || /^ANTHROPIC_/i.test(name)) throw new Error('That is an Anthropic key: Circle Studio never stores one. Claude runs through your own sign-in.');
    const bearer = field === 'headers' && (/^Bearer\s/i.test(String(raw.headers?.[key] || '')) || /^authorization$/i.test(key));
    const value = action.value.trim().replace(/^Bearer\s+/i, '');
    const toConfig = action.target === 'config';
    if (!toConfig) {
      secrets.set(name, value);
      steps.push({ text: `Save the key as ${name} in your Windows user environment and in the vault (it is not shown).`, run: { kind: 'key', name, projects: s.folder && ctx.projectIdFor(s.folder) ? [ctx.projectIdFor(s.folder)] : ctx.projectId ? [ctx.projectId] : 'all' } });
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
  throw new Error('Unknown action.');
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
export async function runPlan(plan, deps) {
  const results = [];
  let backup = null;
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
  return { ok: true, results, backup };
}
