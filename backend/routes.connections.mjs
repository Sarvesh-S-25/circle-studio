// Connections (MCP servers of every engine), the key vault, and the local security check.
// Handlers for connections.*, vault.* and security.scan. Nothing here contacts another computer unless the human
// presses Check on a remote server, and no secret value is ever returned.
import fs from 'node:fs';
import path from 'node:path';
import { badRequest, notFound } from './lib/errors.mjs';
import { listServers, checkServer, rawServer } from './lib/connections.mjs';
import { scanServers, scanProject, GITHUB_PRACTICE } from './lib/secscan.mjs';
import { VAULT_NAME } from './lib/vault.mjs';
import { str } from './lib/route-helpers.mjs';
import { expand, resolveLaunch, probeStdio, probeHttp, diagnose, workingTwins, recreateCommands } from './lib/mcpprobe.mjs';
import { projectDigest } from './lib/digest.mjs';
import { redact } from './lib/secrets.mjs';
import { analyze, makePlan, runPlan, Plans, setUserEnv } from './lib/mcpmanage.mjs';
import { runCommand, cleanEnv } from './lib/run.mjs';

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'steps', 'commands', 'codebase'],
  properties: {
    summary: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    commands: { type: 'array', items: { type: 'string' } },
    config: { type: 'object', additionalProperties: false, properties: { command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } } },
    codebase: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['advice'], properties: { file: { type: 'string' }, advice: { type: 'string' } } } },
  },
};

export function buildConnectionHandlers(app) {
  const { projects, config, vault } = app;
  const homeOpts = () => ({ home: config.userHome, codexHome: config.codexHome });
  const rootOf = (projectId) => (projectId ? projects.resolve(projectId).root : null);

  const lastTest = new Map(); // server id -> { result, diagnosis, output }

  /** Start one server the way an engine would, and explain what happened. */
  async function testServer(id, projectId) {
    const root = rootOf(projectId);
    const server = listServers({ root, ...homeOpts() }).find((s) => s.id === id);
    const raw = server && rawServer(id, { root, ...homeOpts() });
    if (!server || !raw) throw notFound('No such connection.');
    const vars = { ...process.env, ...(projectId ? vault.envFor(projectId) : vault.envFor('__all__')) };
    const missing = new Set();
    const env = Object.fromEntries(Object.entries(raw.env || {}).map(([k, v]) => [k, expand(v, vars, missing)]));
    let launch = null;
    let probe = null;
    if (server.transport === 'stdio') {
      launch = resolveLaunch(String(raw.command || ''), (raw.args || []).map((a) => expand(a, vars, missing)));
      if (!launch.error) probe = await (app.overrides?.probeStdio || probeStdio)({ file: launch.file, args: launch.args, cwd: root || config.userHome, env: { ...process.env, ...env } });
    } else {
      const headers = Object.fromEntries(Object.entries(raw.headers || {}).map(([k, v]) => [k, expand(v, vars, missing)]));
      probe = await probeHttp({ url: raw.url || raw.httpUrl || raw.serverUrl, headers, fetchImpl: app.fetchImpl || fetch });
    }
    const twins = workingTwins(server, listServers({ root: null, ...homeOpts() })).map((t) => ({ id: t.id, where: t.scope.startsWith('local: ') ? `in ${t.scope.slice(7)}` : t.scope === 'user' ? 'for every project' : `in ${t.file}`, setup: t.transport === 'stdio' ? `${t.command} ${t.argsText || ''}`.trim() : t.url, cmds: recreateCommands(server, t, rawServer(t.id, { root: null, ...homeOpts() })) }));
    const diagnosis = diagnose({ server, raw, probe, launch, missing: [...missing], root, twins });
    const result = { ok: Boolean(probe?.ok) && !missing.size, stage: probe?.stage || 'start', error: launch?.error || probe?.error || null, serverInfo: probe?.serverInfo || null, tools: probe?.tools || [], ms: probe?.ms ?? 0 };
    const out = { id, result, diagnosis, twins: twins.map(({ id: tid, where, setup }) => ({ id: tid, where, setup })), output: probe?.stderr || '', command: launch?.shown ? redact(launch.shown) : server.transport === 'stdio' ? server.command : server.url };
    lastTest.set(id, out);
    return out;
  }

  /** The folder whose code the server runs: the project around a .venv path, else the project. */
  function codeRootOf(server, root) {
    if (server?.command && path.isAbsolute(server.command)) {
      const dir = server.command.split(/[\\/]\.?venv[\\/]/i)[0];
      try { if (dir !== server.command && fs.statSync(dir).isDirectory()) return dir; } catch { /* not there */ }
    }
    return root;
  }

  /* ---- the manager: grouped view, plans, running them ------------------------------------------------------- */
  const plans = new Plans();
  const projectIdFor = (folder) => (folder ? projects.list().find((p) => p.exists && path.resolve(p.path).toLowerCase() === path.resolve(folder).toLowerCase())?.id || null : null);
  const runClaude = (args, cwd) => (app.overrides?.runClaude || ((a, c) => runCommand(app.claude.bin, [...(app.claude.prefix || []), ...a], { cwd: c, timeoutMs: 90_000, env: cleanEnv() })))(args, cwd);
  const planDeps = () => ({ runClaude, setUserEnv: app.overrides?.setUserEnv || setUserEnv, vault, claudeJson: path.join(config.userHome, '.claude.json'), backupDir: path.join(config.dataDir, 'backups') });

  return {
    // Every server grouped by name across projects and engines, with what is redundant or broken and a fix for each.
    'connections.manage': () => ({ groups: analyze(listServers({ root: null, ...homeOpts() })) }),
    // Preview a fix: plain steps and the exact commands (names only, never a key).
    'connections.plan': ({ body }) => {
      const projectId = body?.projectId || null;
      const root = rootOf(projectId);
      const action = body?.action;
      if (!action || typeof action !== 'object') throw badRequest('Say what to do.');
      let plan;
      try {
        plan = makePlan(action, { servers: listServers({ root, ...homeOpts() }), rawOf: (id) => rawServer(id, { root, ...homeOpts() }), projectIdFor, projectId });
      } catch (e) { throw badRequest(e.message); }
      return plans.view(plans.put(plan), plan);
    },
    // Run it, then start each server it touched once to prove it works. Project .mcp.json changes come back as ops
    // for the usual review.
    'connections.apply': async ({ body }) => {
      const plan = plans.take(str(body?.id, 'id', 40));
      if (!plan) throw notFound('That plan expired. Preview it again.');
      const run = await runPlan(plan, planDeps());
      const tests = [];
      if (run.ok && !plan.ops) for (const id of plan.retest) { try { tests.push(await testServer(id, plan.projectId || null)); } catch (e) { tests.push({ id, result: { ok: false, error: e.message }, diagnosis: [] }); } }
      return { ok: run.ok, results: run.results, tests, ops: run.ok ? plan.ops || null : null, projectId: plan.projectId || null, retest: plan.retest };
    },
    // Start it for real and do the MCP handshake (only when the human presses Test).
    'connections.test': async ({ body }) => testServer(str(body?.id, 'id', 200), body?.projectId || null),
    // Claude reads the failure, the server's config (names only) and the code around it, and says how to fix it.
    'connections.fix': async ({ body }) => {
      const id = str(body?.id, 'id', 200);
      const projectId = body?.projectId || null;
      const t = lastTest.get(id) || (await testServer(id, projectId));
      const root = rootOf(projectId);
      const server = listServers({ root, ...homeOpts() }).find((s) => s.id === id);
      if (!server) throw notFound('No such connection.');
      const codeRoot = codeRootOf(server, root);
      const digest = codeRoot ? projectDigest(codeRoot) : '';
      await app.claude.requireReady();
      const prompt = [
        'You fix a broken MCP server (a connector an AI coding agent uses). Be concrete and short. The PC runs Windows with PowerShell.',
        `Server "${server.name}" for ${server.engine}, configured in ${server.file} (${server.scope}). Transport: ${server.transport}. Command: ${t.command || '-'}. Variables it reads: ${server.envNames.join(', ') || 'none'}.`,
        `What the test saw: ${t.result.ok ? 'it works' : `failed at ${t.result.stage}: ${t.result.error}`}.`,
        t.diagnosis.length ? `Circle Studio's own diagnosis: ${t.diagnosis.map((d) => `${d.cause} ${d.fix}`).join(' ')}` : '',
        t.twins?.length ? `The same server is set up and starts fine elsewhere: ${t.twins.map((x) => `${x.where}: ${x.setup}`).join('; ')}.` : '',
        t.output ? `Its output (secrets masked):\n${t.output.slice(-2500)}` : 'It printed nothing.',
        digest ? `The code of the server's project:\n${digest}` : '',
        'Never suggest printing or opening config files that hold keys (such as ~/.claude.json): say which entry to change instead. Never invent a path: use a real one from above, or say how to find it. Answer with: summary (one or two sentences: the cause), steps (what to do, in order), commands (only commands safe to copy into PowerShell, never a secret), config (a corrected command and args only when the config itself is wrong), codebase (advice for the server code or its packaging, with the file when you know it; empty when there is none).',
      ].filter(Boolean).join('\n\n');
      const r = await app.claude.advise({ key: `mcpfix:${id}`, prompt, model: ['haiku', 'sonnet', 'opus'].includes(body?.model) ? body.model : 'sonnet', schema: FIX_SCHEMA, kind: 'mcpfix', root: codeRoot || undefined });
      const d = r.data || {};
      const clean = (a, n) => (Array.isArray(a) ? a.slice(0, n).map((x) => redact(String(x)).slice(0, 400)) : []);
      const placeholder = (v) => /^[A-Z]{3,}_[A-Z_]{3,}$|path[\\/]to|<[^>]+>|your[-_ ]/i.test(String(v || ''));
      const cfg = d.config && (d.config.command || d.config.args) && !placeholder(d.config.command) && !(d.config.args || []).some(placeholder) ? { ...(d.config.command ? { command: redact(String(d.config.command)).slice(0, 300) } : {}), ...(Array.isArray(d.config.args) ? { args: d.config.args.map((x) => String(x).slice(0, 300)).slice(0, 30) } : {}) } : null;
      return {
        summary: redact(String(d.summary || '')).slice(0, 800), steps: clean(d.steps, 10), commands: clean(d.commands, 8),
        codebase: (Array.isArray(d.codebase) ? d.codebase : []).slice(0, 8).map((c) => ({ file: c.file ? String(c.file).slice(0, 200) : null, advice: redact(String(c.advice || '')).slice(0, 600) })),
        config: cfg, op: cfg && server.scope === 'project' && server.file === '.mcp.json' ? { op: 'mcp-server-set', server: server.name, ...cfg } : null,
        models: r.models, costUsd: r.costUsd,
      };
    },
    'connections.list': ({ query }) => {
      const projectId = query.get('projectId') || null;
      const root = rootOf(projectId);
      const servers = listServers({ root, ...homeOpts() });
      const findings = [...scanServers(servers), ...(root ? scanProject(root) : [])];
      const vaultNames = new Set(vault.list().map((v) => v.name));
      return {
        projectId,
        servers: servers.map((s) => ({ ...s, vaultRefs: s.envNames.filter((n) => vaultNames.has(n)) })),
        findings,
        github: GITHUB_PRACTICE,
      };
    },
    'connections.check': async ({ body }) => {
      const projectId = body?.projectId || null;
      const root = rootOf(projectId);
      const id = str(body?.id, 'id', 200);
      const server = listServers({ root, ...homeOpts() }).find((s) => s.id === id);
      if (!server) throw notFound('No such connection.');
      const raw = rawServer(id, { root, ...homeOpts() });
      if (!raw) throw notFound('No such connection.');
      return { id, health: await checkServer(server, raw, { remote: body?.remote === true }) };
    },
    // Every project's findings at once, for Health and the Connections page.
    'security.scan': () => {
      const out = [];
      for (const p of projects.list().filter((x) => x.exists)) {
        const servers = listServers({ root: p.path, ...homeOpts() }).filter((s) => s.scope === 'project');
        for (const f of [...scanServers(servers), ...scanProject(p.path)]) out.push({ ...f, projectId: p.id, projectName: p.name });
      }
      for (const f of scanServers(listServers({ root: null, ...homeOpts() }).filter((s) => s.scope !== 'project'))) out.push({ ...f, projectId: null, projectName: 'This PC' });
      return { findings: out, github: GITHUB_PRACTICE };
    },

    'vault.list': () => ({ keys: vault.list(), platform: process.platform }),
    'vault.set': async ({ params, body }) => {
      if (process.platform !== 'win32') throw badRequest('The vault uses Windows encryption and works on Windows only.');
      return { key: await vault.set(params.key, { value: body?.value, note: body?.note, projects: body?.projects }) };
    },
    'vault.remove': async ({ params }) => { await vault.remove(params.key); return {}; },
    // Take a literal key out of a project's .mcp.json into the vault (the value never passes through the browser).
    // The file itself is changed afterwards through the usual review, with the mcp-env-ref op.
    'vault.import': async ({ body }) => {
      if (process.platform !== 'win32') throw badRequest('The vault uses Windows encryption and works on Windows only.');
      const p = projects.resolve(str(body?.projectId, 'projectId', 60));
      const field = body?.field === 'headers' ? 'headers' : 'env';
      const server = str(body?.server, 'server', 80);
      const key = str(body?.key, 'key', 80);
      const name = str(body?.name, 'name', 64);
      if (!VAULT_NAME.test(name)) throw badRequest('Use a name like STITCH_API_KEY: capitals, digits and _.');
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(path.join(p.root, '.mcp.json'), 'utf8')); } catch { throw notFound('.mcp.json is missing or not valid JSON.'); }
      let value = cfg.mcpServers?.[server]?.[field]?.[key];
      if (typeof value !== 'string' || !value.trim()) throw badRequest('That entry holds no literal key.');
      if (field === 'headers') value = value.replace(/^Bearer\s+/i, '');
      // ${VAR:-literal}: the literal default is the secret; ${VAR} alone holds none
      const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}$/.exec(value.trim());
      if (ref && !ref[2]) throw badRequest('That entry already reads from the environment.');
      if (ref) value = ref[2];
      const saved = await vault.set(name, { value, note: `From ${server} in ${p.name}/.mcp.json`, projects: [p.id] });
      return { key: saved, op: { op: 'mcp-env-ref', server, field, key, ref: name } };
    },
  };
}
