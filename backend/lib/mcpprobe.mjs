// Test one MCP server for real, the way an engine would start it, and say in plain words why it fails and how to fix
// it. stdio: start the program (never through a shell), send `initialize` and `tools/list` over JSON-RPC, then stop
// the whole process tree. http: POST `initialize` to the URL. Values from the config and the vault go to the server
// only; nothing printed back contains them (redacted), and nothing here runs until the human presses Test.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { redact } from './secrets.mjs';
import { whichCommand } from './connections.mjs';
import { cleanEnv, killTree } from './run.mjs';

const PROTOCOL = '2025-06-18';
const INIT = (id) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'circle-studio', version: '1' } } });

/** ${VAR} and ${VAR:-default} in a config value, from `vars`. Missing names are reported. */
export function expand(value, vars, missing) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (m, name, def) => {
    if (vars[name] !== undefined && vars[name] !== '') return vars[name];
    if (def !== undefined) return def;
    missing.add(name);
    return '';
  });
}

/**
 * How to start a stdio server without a shell. npx is a .cmd shim on Windows, so it is run as node npx-cli.js; other
 * .cmd or .bat launchers cannot be started without a shell and are reported, not run.
 */
export function resolveLaunch(command, args) {
  if (!command || !String(command).trim() || /^[\\/.\s]+$/.test(command)) return { error: 'empty' };
  const found = whichCommand(command);
  if (!found) return { error: 'not-found' };
  if (/\.(cmd|bat)$/i.test(found)) {
    if (/^npx(\.cmd)?$/i.test(path.basename(found))) {
      const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
      if (fs.existsSync(cli)) return { file: process.execPath, args: [cli, ...args], shown: `npx ${args.join(' ')}` };
    }
    return { error: 'shell-launcher', found };
  }
  return { file: found, args, shown: `${path.basename(found)} ${args.join(' ')}` };
}

/** Start a stdio server and do the MCP handshake. Resolves { ok, stage, serverInfo, tools, error, stderr, ms, code }. */
export function probeStdio({ file, args, cwd, env, timeoutMs = 45_000 }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try { child = spawn(file, args, { cwd, env: cleanEnv(env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { resolve({ ok: false, stage: 'start', error: e.code || e.message, stderr: '', ms: 0 }); return; }
    let stderr = '';
    let buf = '';
    let stage = 'start';
    let serverInfo = null;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { killTree(child); } catch { /* gone */ }
      resolve({ stage, serverInfo, ms: Date.now() - t0, stderr: redact(stderr.slice(-4000)), ...r });
    };
    const send = (o) => { try { child.stdin.write(`${JSON.stringify(o)}\n`); } catch { /* closed */ } };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
    child.on('error', (e) => finish({ ok: false, error: e.code || e.message }));
    child.on('exit', (code) => { if (!done) finish({ ok: false, error: 'exited', code }); });
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => { if (stderr.length < 64_000) stderr += d; });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.id === 1) {
          if (o.error) { finish({ ok: false, error: 'initialize-error', message: redact(String(o.error.message || '')).slice(0, 300) }); return; }
          serverInfo = o.result?.serverInfo || null;
          stage = 'tools';
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (o.id === 2) {
          finish({ ok: !o.error, tools: (o.result?.tools || []).map((x) => String(x.name)).slice(0, 80), error: o.error ? 'tools-error' : null, message: o.error ? redact(String(o.error.message || '')).slice(0, 300) : undefined });
        }
      }
    });
    stage = 'initialize';
    send(INIT(1));
  });
}

/** POST initialize to an http MCP server. */
export async function probeHttp({ url, headers, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(INIT(1)), signal: AbortSignal.timeout(timeoutMs) });
    const text = (await res.text()).slice(0, 20_000);
    if (!res.ok) return { ok: false, stage: 'initialize', error: `http-${res.status}`, ms: Date.now() - t0, stderr: redact(text.slice(0, 600)) };
    const json = /"jsonrpc"/.test(text) ? JSON.parse((/\{[\s\S]*\}/.exec(text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('') || text) || ['{}'])[0]) : null;
    return { ok: Boolean(json?.result), stage: 'initialize', serverInfo: json?.result?.serverInfo || null, error: json?.error ? 'initialize-error' : json ? null : 'not-mcp', ms: Date.now() - t0, stderr: '' };
  } catch (e) {
    const code = e.cause?.code || e.name;
    return { ok: false, stage: 'connect', error: code === 'TimeoutError' ? 'timeout' : code || 'connect', ms: Date.now() - t0, stderr: redact(String(e.cause?.message || e.message)).slice(0, 300) };
  }
}

/**
 * Plain-words causes and fixes from what the test saw. `cmds` are commands the human can copy (never with a secret).
 * `configFix` is a change to a project's .mcp.json that the app can apply through the usual review.
 */
/**
 * The same server set up elsewhere with a command that exists: [{ id, where, command, args, envNames, transport, url }].
 * A broken copy can usually be repaired by repeating a working one.
 */
export function workingTwins(server, all) {
  return all.filter((s) => s.name === server.name && s.id !== server.id && (s.transport !== 'stdio' || (s.command && whichCommand(s.command))));
}

/** The claude mcp commands that recreate `twin` in place of `server` (key names only; values come from the vault). */
export function recreateCommands(server, twin, twinRaw) {
  if (server.engine !== 'claude' || !twinRaw) return [];
  const scope = server.scope === 'project' ? 'project' : server.scope === 'user' ? 'user' : 'local';
  const q = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const env = Object.keys(twinRaw.env || {}).map((k) => `-e ${k}=$env:${k}`);
  const head = server.folder ? [`cd "${server.folder}"`] : [];
  const add = twin.transport === 'stdio'
    ? `claude mcp add ${server.name} -s ${scope} ${env.join(' ')} -- ${q(twinRaw.command)} ${(twinRaw.args || []).map((a) => (scanLike(a) ? '<secret>' : q(String(a)))).join(' ')}`.replace(/\s+/g, ' ').trim()
    : `claude mcp add --transport ${twin.transport} ${server.name} -s ${scope} ${twinRaw.url || twinRaw.httpUrl || ''}${Object.keys(twinRaw.headers || {}).map((k) => ` --header "${k}: $env:${k.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}"`).join('')}`;
  return [...head, `claude mcp remove ${server.name} -s ${scope}`, add];
}
const scanLike = (v) => /sk-|ghp_|github_pat_|AIza|eyJ|[A-Za-z0-9_-]{32,}/.test(String(v));

export function diagnose({ server, raw, probe, launch, missing = [], root, twins = [] }) {
  const out = [];
  const add = (cause, fix, extra = {}) => out.push({ cause, fix, ...extra });
  const cmd = String(raw?.command || '');
  const removeCmd = server.engine === 'claude' && server.scope !== 'project' ? `claude mcp remove ${server.name} -s ${server.scope === 'user' ? 'user' : 'local'}` : null;
  for (const m of missing) add(`${m} is not set.`, `Add ${m} to the Key vault (Connections, Key vault) and allow it for this project, or set it in your environment.`, { vault: m });
  const twin = twins[0];
  if ((launch?.error === 'empty' || launch?.error === 'not-found') && twin) {
    add(`The same "${server.name}" server is set up correctly ${twin.where}.`, `Repeat that setup here. Run these in PowerShell${server.folder ? ' (the first one goes to the project folder)' : ''}; the keys come from your environment or vault, never typed into the command.`, { cmds: twin.cmds, twin: twin.where });
  }
  if (launch?.error === 'empty') add(`The command is empty or broken ("${cmd}").`, twin ? 'Or remove this entry if this project does not need it.' : 'This entry cannot start. Remove it, or add the server again with its real command.', { cmds: removeCmd && !twin ? [removeCmd] : [], remove: server.scope === 'project' });
  if (launch?.error === 'not-found') {
    if (/\.venv|venv/i.test(cmd)) {
      const dir = cmd.split(/[\\/]\.?venv[\\/]/i)[0] || root || '.';
      const hasProj = fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, 'requirements.txt'));
      add(`Its Python environment is missing: ${cmd} does not exist.`, 'Create the virtual environment and install the project into it, in that folder.', { cmds: [`cd "${dir}"`, 'python -m venv .venv', hasProj ? (fs.existsSync(path.join(dir, 'pyproject.toml')) ? '.venv\\Scripts\\pip install -e .' : '.venv\\Scripts\\pip install -r requirements.txt') : '.venv\\Scripts\\pip install <the server package>'] });
    } else if (/^(npx|npm|node)$/i.test(cmd)) add('Node.js is not installed or not on PATH.', 'Install Node.js (nodejs.org), then open a new terminal so PATH is fresh.');
    else if (/^(uvx|uv)$/i.test(cmd)) add('uv is not installed.', 'Install uv, then try again.', { cmds: ['winget install --id=astral-sh.uv -e'] });
    else if (/^(python|python3|py)$/i.test(cmd)) add('Python is not installed or not on PATH.', 'Install Python 3 (python.org or winget install Python.Python.3.12) and tick "Add to PATH".');
    else if (/^docker$/i.test(cmd)) add('Docker is not installed or not running.', 'Install Docker Desktop and start it.');
    else add(`"${cmd}" is not installed or not on PATH.`, path.isAbsolute(cmd) ? 'That file does not exist any more. Fix the path in the config, or reinstall the server.' : `Install ${cmd}, or give its full path in the config.`);
  }
  if (launch?.error === 'shell-launcher') add(`"${cmd}" starts through a .cmd launcher, which Circle Studio does not run without a shell.`, 'The engines run it through cmd, so it may still work there. To test it here, point the config at the real program (for example node.exe and its script).');
  const err = probe?.stderr || '';
  if (probe && !probe.ok) {
    const mod = /ModuleNotFoundError: No module named '([^']+)'/.exec(err);
    const nodeMod = /Cannot find module '([^']+)'/.exec(err);
    if (mod) add(`Python cannot find the module "${mod[1]}".`, 'Install the server\'s dependencies into the Python it runs with.', { cmds: [/venv/i.test(cmd) ? `"${cmd}" -m pip install ${mod[1].split('.')[0]}` : `pip install ${mod[1].split('.')[0]}`] });
    else if (nodeMod) add(`Node cannot find "${nodeMod[1]}".`, 'Install the server\'s packages in its folder (npm install), or check the script path in the config.');
    else if (/EADDRINUSE|address already in use/i.test(err)) add('Its port is already taken by another program.', 'Close the other program (or the server already running), or give this one another port.');
    else if (/401|403|unauthori[sz]ed|forbidden|invalid.{0,20}(api[_ -]?key|token)|expired/i.test(err) || /^http-40[13]$/.test(probe.error || '')) add('The server refused the key (wrong, expired or missing).', 'Create a new key with the service, put it in the Key vault, and refer to it from the config as ${NAME}.');
    else if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(err + probe.error)) add('The server\'s address cannot be found.', 'Check the URL and your internet connection.');
    else if (/certificate|SSL|TLS/i.test(err)) add('A certificate problem (TLS).', 'Check the URL is https with a valid certificate; a company proxy may be intercepting it.');
    else if (/^http-404$/.test(probe.error || '')) add('Nothing answers at that URL path (404).', 'Check the path: MCP servers usually listen on /mcp or /sse.');
    else if (probe.error === 'not-mcp') add('The URL answers, but not as an MCP server.', 'Check that the URL is the MCP endpoint, not the service\'s website.');
    else if (probe.error === 'timeout' && probe.stage === 'initialize') add(`It started but did not answer the MCP handshake within ${Math.round((probe.ms || 0) / 1000)} s.`, /npx|uvx/i.test(cmd) ? 'The first start downloads the package: try again. If it still waits, the package may not be a stdio MCP server, or it needs an argument it is missing.' : 'It may not be a stdio MCP server, or it is waiting for something (a key, an argument, a login prompt). See its output below.');
    else if (probe.error === 'exited') add(`It stopped straight away (exit code ${probe.code ?? '?'}).`, err ? 'Its own message is below: it usually says what is missing.' : 'It printed nothing. Run the command in a terminal to see why.');
    else if (probe.error && !out.length) add(`It failed: ${probe.error}${probe.message ? ` (${probe.message})` : ''}.`, 'See its output below.');
  }
  return out;
}
