// The key vault: API keys for connectors (MCP servers), kept on this PC only, encrypted with Windows DPAPI for the
// signed-in Windows user (PowerShell's ConvertFrom-SecureString without a key). A value goes in and never comes back
// out through the API: it is decrypted only to hand it, as an environment variable, to an engine run in a project the
// key is allowed for. Anthropic credentials are refused: Circle Studio never uses an API key for Claude.
import { spawnSync } from 'node:child_process';
import { badRequest, notFound } from './errors.mjs';

export const VAULT_NAME = /^[A-Z_][A-Z0-9_]{1,63}$/;
const FORBIDDEN = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$)/;

function ps(script, env) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20_000, env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('Windows could not encrypt or decrypt the key.');
  return r.stdout;
}

/** DPAPI, per Windows user. Tests pass their own (reversible, fake) codec. */
export const dpapi = {
  protect(value) { return ps('ConvertTo-SecureString -String $env:CS_V -AsPlainText -Force | ConvertFrom-SecureString', { CS_V: value }).trim(); },
  unprotectMany(blobs) {
    if (!blobs.length) return [];
    const script = '$o = @(); foreach ($b in ($env:CS_B | ConvertFrom-Json)) { $s = ConvertTo-SecureString $b; $o += [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }; ConvertTo-Json -InputObject @($o) -Compress';
    const out = JSON.parse(ps(script, { CS_B: JSON.stringify(blobs) }).trim() || '[]');
    return Array.isArray(out) ? out : [out];
  },
};

export class Vault {
  constructor(store, codec = dpapi) { this.store = store; this.codec = codec; }

  #read() { const v = this.store.readJson('vault.json', null); return v && typeof v.entries === 'object' ? v : { version: 1, entries: {} }; }

  /** Names and where each may be used. Never the values. */
  list() {
    return Object.entries(this.#read().entries).map(([name, e]) => ({ name, note: e.note || '', projects: e.projects, createdAt: e.createdAt, updatedAt: e.updatedAt })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async set(name, { value, note, projects }) {
    if (!VAULT_NAME.test(name)) throw badRequest('Use a name like STITCH_API_KEY: capitals, digits and _.');
    if (FORBIDDEN.test(name)) throw badRequest('Circle Studio never stores an Anthropic key or token: Claude runs through your own sign-in.');
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 8000 || /[\r\n\0]/.test(value))) throw badRequest('The value must be one line, at most 8000 characters.');
    if (value !== undefined && /sk-ant-/i.test(value)) throw badRequest('That is an Anthropic key. Circle Studio never stores one: Claude runs through your own sign-in. If it was ever written in a file, revoke it in the Anthropic console.');
    const projectsOk = projects === 'all' || (Array.isArray(projects) && projects.every((p) => typeof p === 'string' && /^[a-z0-9_-]{1,60}$/.test(p)));
    return this.store.serial('vault', () => {
      const v = this.#read();
      const cur = v.entries[name];
      if (!cur && value === undefined) throw notFound(`No key "${name}".`);
      const now = new Date().toISOString();
      v.entries[name] = {
        blob: value !== undefined ? this.codec.protect(value.trim()) : cur.blob,
        note: typeof note === 'string' ? note.slice(0, 200) : cur?.note || '',
        projects: projectsOk ? projects : cur?.projects || [],
        createdAt: cur?.createdAt || now,
        updatedAt: now,
      };
      this.store.writeJson('vault.json', v);
      return this.list().find((e) => e.name === name);
    });
  }

  async remove(name) {
    return this.store.serial('vault', () => {
      const v = this.#read();
      if (!v.entries[name]) throw notFound(`No key "${name}".`);
      delete v.entries[name];
      this.store.writeJson('vault.json', v);
      return true;
    });
  }

  /** One key's value, for the connection manager to put where Claude Code reads it. Never sent to the browser. */
  value(name) {
    const e = this.#read().entries[name];
    if (!e) return null;
    try { return this.codec.unprotectMany([e.blob])[0] || null; } catch { return null; }
  }

  /** The variables for an engine run in `projectId` (decrypted here, handed to the child only). */
  envFor(projectId) {
    const pick = Object.entries(this.#read().entries).filter(([, e]) => e.projects === 'all' || (Array.isArray(e.projects) && e.projects.includes(projectId)));
    if (!pick.length) return {};
    let values;
    try { values = this.codec.unprotectMany(pick.map(([, e]) => e.blob)); } catch { return {}; }
    return Object.fromEntries(pick.map(([name], i) => [name, values[i]]).filter(([, v]) => typeof v === 'string' && v));
  }
}
