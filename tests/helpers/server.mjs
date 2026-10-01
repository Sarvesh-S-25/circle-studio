// Start the real server on a free port with a temp data folder and (optionally) the fake claude.
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from '../../backend/config.mjs';
import { createServer } from '../../backend/server.mjs';
import { ClaudeService } from '../../backend/lib/claude.mjs';
import { createClaudeAdapter } from '../../backend/lib/engines/claude.mjs';
import { tempDir, rmDir } from './project.mjs';

export const FAKE = path.resolve(import.meta.dirname, 'fake-claude.mjs');

// A reversible stand-in for Windows encryption, so vault tests never touch DPAPI.
export const FAKE_CODEC = { protect: (v) => `fake:${Buffer.from(v).toString('base64')}`, unprotectMany: (bs) => bs.map((b) => Buffer.from(b.slice(5), 'base64').toString()) };

export async function startServer({ fetch: fetchOverride, pickFolder, adapters, toast } = {}) {
  const dataDir = tempDir('circle-srv-');
  const projectsRoot = tempDir('circle-projroot-');
  const claudeHome = tempDir('circle-claudehome-'); // never the human's real ~/.claude
  const config = { ...loadConfig({ CIRCLE_DATA: dataDir, CIRCLE_PORT: '0', CIRCLE_PROJECTS_ROOT: projectsRoot, CIRCLE_CLAUDE_HOME: claudeHome, CIRCLE_CODEX_HOME: path.join(claudeHome, 'codex-home'), CIRCLE_USER_HOME: path.join(claudeHome, 'user-home') }), port: 0 };
  const claude = new ClaudeService({ bin: process.execPath, prefixArgs: [FAKE] });
  // Only the fake Claude by default: a test must never start the real Codex, Copilot or agy.
  const s = createServer(config, { claude, adapters: adapters ? adapters(claude) : [createClaudeAdapter({ service: claude, bin: claude.bin, prefixArgs: claude.prefix })], fetch: fetchOverride, pickFolder, toast, vaultCodec: FAKE_CODEC });
  await new Promise((resolve) => s.server.listen(0, '127.0.0.1', resolve));
  const port = s.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function call(method, urlPath, body, headers = {}) {
    const res = await fetch(base + urlPath, {
      method,
      headers: { ...(method !== 'GET' ? { 'X-Circle': '1' } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json, headers: res.headers };
  }

  /** Raw request with full control of the headers (Host, Origin...). */
  function raw(method, urlPath, headers = {}, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /** POST and read a server-sent-event stream to the end. Returns { status, events:[{event,data}] }. */
  async function sse(urlPath, body) {
    const res = await fetch(base + urlPath, { method: 'POST', headers: { 'X-Circle': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!String(res.headers.get('content-type')).startsWith('text/event-stream')) return { status: res.status, json: await res.json(), events: [] };
    const text = await res.text();
    const events = text.split('\n\n').filter((b) => b.trim() && !b.startsWith(':')).map((b) => {
      const ev = /^event: (.*)$/m.exec(b)?.[1];
      const data = /^data: (.*)$/m.exec(b)?.[1];
      return { event: ev, data: data ? JSON.parse(data) : null };
    });
    return { status: res.status, events };
  }

  return {
    base, port, call, raw, sse, app: s.app, dataDir, projectsRoot, claudeHome,
    async close() {
      await Promise.all([s.app.sessions.stopAll(), s.app.claude.stopAll()]);
      await new Promise((r) => s.server.close(r));
      rmDir(dataDir);
      rmDir(projectsRoot);
      rmDir(claudeHome);
    },
  };
}
