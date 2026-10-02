// Connections: every MCP server (connector) the engines on this PC are set up to use, where it is configured, whether
// it looks healthy, and whether a secret sits in plain text in its config. Read only. Values of env variables and
// headers are never returned: only their names, and whether a value looks like a literal secret.
//   Claude Code: <project>/.mcp.json, ~/.claude.json (user servers and the per-project ones)
//   Codex:       ~/.codex/config.toml [mcp_servers.<name>]
//   Gemini:      ~/.gemini/settings.json and <project>/.gemini/settings.json "mcpServers"
//   Copilot:     ~/.copilot/mcp-config.json "mcpServers"
//   VS Code:     <project>/.vscode/mcp.json "servers"
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { scanSecrets } from './secrets.mjs';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const tilde = (p) => { const home = os.homedir(); return p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length).split(path.sep).join('/')}` : p; };
export const SECRET_NAME = /(key|token|secret|password|passwd|auth|bearer|credential|cookie)/i;
const isRef = (v) => typeof v === 'string' && /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v.trim());

/** A tiny reader for the part of TOML Codex uses for MCP servers: [tables], strings, arrays, inline tables. */
export function parseCodexToml(text) {
  const out = {};
  let cur = null;
  const value = (raw) => {
    raw = raw.trim();
    try { return JSON.parse(raw); } catch { /* not JSON */ }
    if (/^'.*'$/.test(raw)) return raw.slice(1, -1);
    if (raw.startsWith('{') && raw.endsWith('}')) {
      const o = {};
      for (const part of raw.slice(1, -1).split(',')) { const m = /^\s*"?([A-Za-z0-9_.-]+)"?\s*=\s*(.+)$/.exec(part); if (m) o[m[1]] = value(m[2]); }
      return o;
    }
    if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean).map(value);
    if (raw === 'true' || raw === 'false') return raw === 'true';
    return Number.isNaN(Number(raw)) ? raw : Number(raw);
  };
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.replace(/\s+#.*$/, '').trim();
    if (!t || t.startsWith('#')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(t);
    if (sec) {
      const keys = sec[1].split('.').map((k) => k.trim().replace(/^["']|["']$/g, ''));
      cur = out;
      for (const k of keys) cur = (cur[k] ||= {});
      continue;
    }
    const kv = /^("?[A-Za-z0-9_.-]+"?)\s*=\s*(.+)$/.exec(t);
    if (kv && cur) cur[kv[1].replace(/"/g, '')] = value(kv[2]);
  }
  return out;
}

function describe(name, raw, { engine, scope, file, folder = null }) {
  const env = raw.env && typeof raw.env === 'object' ? raw.env : {};
  const headers = raw.headers && typeof raw.headers === 'object' ? raw.headers : {};
  const url = typeof raw.url === 'string' ? raw.url : typeof raw.httpUrl === 'string' ? raw.httpUrl : typeof raw.serverUrl === 'string' ? raw.serverUrl : null;
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const transport = url ? (raw.type === 'sse' || /\/sse\b/.test(url) ? 'sse' : 'http') : 'stdio';
  const plain = [];
  for (const [k, v] of [...Object.entries(env).map(([k, v]) => [`env ${k}`, v]), ...Object.entries(headers).map(([k, v]) => [`header ${k}`, v])]) {
    if (typeof v !== 'string' || !v || isRef(v)) continue;
    if (SECRET_NAME.test(k) || scanSecrets(v).length) plain.push(k);
  }
  for (const a of args) if (scanSecrets(a).length) plain.push('an argument');
  let host = null;
  let tokenInUrl = false;
  if (url) {
    try {
      const u = new URL(url);
      host = `${u.protocol}//${u.host}`;
      tokenInUrl = Boolean(u.username || u.password || [...u.searchParams.keys()].some((k) => SECRET_NAME.test(k)));
    } catch { host = '(not a valid URL)'; }
  }
  return {
    id: `${engine}:${scope}:${name}`, name, engine, scope, file, folder,
    transport, command: transport === 'stdio' ? String(raw.command || '') : null, args: args.length, argsText: transport === 'stdio' ? args.map((a) => (scanSecrets(a).length ? '<secret>' : a)).join(' ').slice(0, 200) : null,
    url: host, envNames: Object.keys(env), headerNames: Object.keys(headers), plainSecrets: plain, tokenInUrl,
    anthropicKey: [...Object.values(env), ...Object.values(headers), ...args].some((v) => /sk-ant-/i.test(String(v))),
    disabled: raw.disabled === true || raw.enabled === false,
  };
}

const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Every configured server, for one project (its own and the user-level ones) or for the whole PC (root null). */
/** Every configured server with its raw config (kept inside this module: raw values never leave it). */
function collect({ root = null, home = os.homedir(), codexHome = path.join(os.homedir(), '.codex') } = {}) {
  const out = [];
  const add = (servers, meta) => { for (const [name, raw] of Object.entries(servers || {})) if (raw && typeof raw === 'object') out.push({ desc: describe(name, raw, meta), raw }); };
  // Claude Code
  if (root) add(readJson(path.join(root, '.mcp.json'))?.mcpServers, { engine: 'claude', scope: 'project', file: '.mcp.json' });
  const cj = readJson(path.join(home, '.claude.json'));
  if (cj) {
    add(cj.mcpServers, { engine: 'claude', scope: 'user', file: '~/.claude.json' });
    for (const [p, v] of Object.entries(cj.projects || {})) {
      if (root ? sameDir(p, root) : true) add(v?.mcpServers, { engine: 'claude', scope: root ? 'local' : `local: ${path.basename(p)}`, file: '~/.claude.json', folder: p });
    }
  }
  // Codex
  try { add(parseCodexToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).mcp_servers, { engine: 'codex', scope: 'user', file: tilde(path.join(codexHome, 'config.toml')) }); } catch { /* no Codex */ }
  // Gemini
  add(readJson(path.join(home, '.gemini', 'settings.json'))?.mcpServers, { engine: 'gemini', scope: 'user', file: '~/.gemini/settings.json' });
  if (root) add(readJson(path.join(root, '.gemini', 'settings.json'))?.mcpServers, { engine: 'gemini', scope: 'project', file: '.gemini/settings.json' });
  // Copilot
  add(readJson(path.join(home, '.copilot', 'mcp-config.json'))?.mcpServers, { engine: 'copilot', scope: 'user', file: '~/.copilot/mcp-config.json' });
  // VS Code (Copilot in the editor)
  if (root) add(readJson(path.join(root, '.vscode', 'mcp.json'))?.servers, { engine: 'vscode', scope: 'project', file: '.vscode/mcp.json' });
  return out;
}

export function listServers(opts = {}) { return collect(opts).map((x) => x.desc); }

/** Find a program the way Windows would (PATH and PATHEXT), without running it. */
export function whichCommand(cmd, env = process.env) {
  if (!cmd || /^[\\/.\s]+$/.test(cmd)) return null; // "\" alone is the drive root on Windows, not a program
  if (path.isAbsolute(cmd)) { try { return fs.statSync(cmd).isFile() ? cmd : null; } catch { return null; } }
  // Windows runs "npx" as npx.cmd: a name without an extension is looked up with PATHEXT only (an extensionless "npx"
  // next to it is a Unix script that Windows cannot start).
  const exts = process.platform === 'win32' ? (path.extname(cmd) ? [''] : (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)) : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) { const p = path.join(dir, cmd + e); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } }
  }
  return null;
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

function tcp(host, port, ms = 2500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * Is the server usable from here? stdio: its program can be found. A local URL: something listens. A remote URL is
 * only contacted when `remote` is true (it is a request that leaves this PC), and then only to open a connection.
 */
export async function checkServer(server, raw, { remote = false } = {}) {
  if (server.disabled) return { status: 'off', text: 'Turned off in its config.' };
  if (server.transport === 'stdio') {
    const found = whichCommand(String(raw.command || ''));
    if (!found) return { status: 'broken', text: /^[\\/.\s]*$/.test(String(raw.command || '')) ? 'Its command is empty or broken. Press Test to see how to repair it.' : `"${server.command}" is not installed or not on PATH. Press Test for the fix.` };
    if (/^(npx|uvx|bunx|pnpm)$/i.test(path.basename(found, path.extname(found))) || /^(npx|uvx)/i.test(server.command)) return { status: 'ok', text: `Found ${path.basename(found)}; it downloads the server when it starts.` };
    return { status: 'ok', text: `Found ${tilde(found)}.` };
  }
  let u;
  try { u = new URL(raw.url || raw.httpUrl || raw.serverUrl); } catch { return { status: 'broken', text: 'The URL is not valid.' }; }
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  if (LOCAL_HOST.test(u.hostname)) return (await tcp(u.hostname.replace(/^\[|\]$/g, ''), port)) ? { status: 'ok', text: `Something answers on ${u.host}.` } : { status: 'broken', text: `Nothing listens on ${u.host}. Start the server first.` };
  if (!remote) return { status: 'unknown', text: 'A remote server: not contacted. Press Check to try a connection.' };
  return (await tcp(u.hostname, port)) ? { status: 'ok', text: `${u.host} accepts connections (sign-in not checked).` } : { status: 'broken', text: `${u.host} cannot be reached from here.` };
}

/** The raw config of one server (for checks and tests only; never sent to the browser). */
export function rawServer(id, { root, home = os.homedir(), codexHome = path.join(os.homedir(), '.codex') } = {}) {
  return collect({ root, home, codexHome }).find((x) => x.desc.id === id)?.raw || null;
}
