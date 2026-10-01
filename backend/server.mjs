#!/usr/bin/env node
// Circle Studio's local server. Binds 127.0.0.1 only. Serves the frontend and the /api routes in contracts/api.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';
import { buildHandlers } from './routes.mjs';
import { HttpError } from './lib/errors.mjs';
import { ID_RE, NAME_RE } from './lib/paths.mjs';
import { redact } from './lib/secrets.mjs';
import { desktopWidgets } from './lib/deskhost.mjs';

const MB = 1024 * 1024;
const BODY_LIMIT = { 'import.files': 16 * MB, 'skills.save': 4 * MB };
const DEFAULT_LIMIT = 1 * MB;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function compileRoutes(contract) {
  return contract.routes.map((r) => ({
    ...r,
    names: [...r.path.matchAll(/:([a-z]+)/g)].map((m) => m[1]),
    re: new RegExp(`^${r.path.replace(/:([a-z]+)/g, '([^/]+)')}$`),
  }));
}

function matchRoute(routes, method, pathname) {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    const params = {};
    r.names.forEach((n, i) => { try { params[n] = decodeURIComponent(m[i + 1]); } catch { params[n] = m[i + 1]; } });
    return { route: r, params };
  }
  return { route: null, pathMatched };
}

function validateParams(params) {
  if ('id' in params && !ID_RE.test(params.id)) throw new HttpError('bad_request', 'Invalid id.');
  if ('name' in params && !(typeof params.name === 'string' && params.name.length <= 64 && NAME_RE.test(params.name))) {
    throw new HttpError('bad_request', 'Invalid name: use lowercase letters, digits and single hyphens.');
  }
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError('too_large', `The request is larger than ${Math.round(limit / MB)} MB.`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError('too_large', `The request is larger than ${Math.round(limit / MB)} MB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createServer(config, overrides = {}) {
  const app = createApp(config, overrides);
  const contract = JSON.parse(fs.readFileSync(path.join(config.appRoot, 'contracts', 'api.json'), 'utf8'));
  const routes = compileRoutes(contract);
  const handlers = buildHandlers(app);
  for (const r of routes) if (typeof handlers[r.id] !== 'function') throw new Error(`No handler for contract route ${r.id}`);
  for (const id of Object.keys(handlers)) if (!routes.some((r) => r.id === id)) throw new Error(`Handler ${id} is not in contracts/api.json`);

  let port = config.port;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  function sendJson(res, status, payload, extra = {}) {
    if (res.headersSent) return;
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
    res.end(body);
  }

  function sendError(res, e) {
    if (e instanceof HttpError) {
      sendJson(res, e.status, { ok: false, error: { code: e.code, message: redact(e.message), ...(e.detail !== undefined ? { detail: e.detail } : {}) } });
    } else {
      console.error('internal error:', redact(String(e && e.stack ? e.stack : e)));
      sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'Something went wrong on the server. Nothing was changed by this request unless it said so.' } });
    }
  }

  async function handleApi(req, res, url) {
    const method = req.method;
    const { route, params, pathMatched } = matchRoute(routes, method, url.pathname);
    if (!route) {
      if (pathMatched) throw new HttpError('bad_request', 'Method not allowed for this path.', { status: 405 });
      throw new HttpError('not_found', 'No such API route.');
    }
    validateParams(params);
    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      if (req.headers['x-circle'] !== '1') throw new HttpError('forbidden', 'Missing the X-Circle header.');
      const raw = await readBody(req, BODY_LIMIT[route.id] || DEFAULT_LIMIT);
      if (raw.length) {
        if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new HttpError('bad_request', 'Send JSON with Content-Type: application/json.');
        try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError('bad_request', 'The request body is not valid JSON.'); }
      }
    }
    let streamed = false;
    const abort = new AbortController();
    const sse = () => {
      streamed = true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...SECURITY_HEADERS });
      res.write(': open\n\n');
      const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
      let done = false;
      res.on('close', () => { clearInterval(ping); if (!done) abort.abort(); });
      return {
        send(name, data) { if (!res.writableEnded && !res.destroyed) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); },
        end() { done = true; clearInterval(ping); if (!res.writableEnded) res.end(); },
      };
    };
    try {
      const data = await handlers[route.id]({ app, params, query: url.searchParams, body, sse, signal: abort.signal });
      if (!streamed) sendJson(res, 200, { ok: true, ...(data || {}) });
    } catch (e) {
      if (streamed && res.headersSent) {
        if (!res.writableEnded) {
          const err = e instanceof HttpError ? e : new HttpError('internal', 'Something went wrong on the server.');
          res.write(`event: error\ndata: ${JSON.stringify({ code: err.code, message: redact(err.message) })}\n\n`);
          res.end();
        }
        return;
      }
      throw e;
    }
  }

  // The web app manifest, so Edge can install Circle Studio as an app; its jump list holds a widget per recent project.
  function serveManifest(res) {
    const recent = app.projects.list().filter((p) => p.exists).slice(0, 6);
    const body = JSON.stringify({
      name: 'Circle Studio', short_name: 'Circle', id: '/', start_url: '/', scope: '/', display: 'standalone',
      description: 'A local control room for AI agent teams.',
      icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      shortcuts: recent.map((p) => ({ name: `${p.name} widget`, short_name: p.name, url: `/widget.html?p=${encodeURIComponent(p.id)}`, icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }] })),
    });
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(body);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError('bad_request', 'Method not allowed.', { status: 405 });
    if (url.pathname === '/manifest.webmanifest') { serveManifest(res); return; }
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { throw new HttpError('bad_request', 'Bad path.'); }
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel.includes('\0') || rel.includes('\\')) throw new HttpError('bad_request', 'Bad path.');
    const abs = path.resolve(config.frontendDir, `.${rel}`);
    const root = path.resolve(config.frontendDir);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError('forbidden', 'Not found.');
    let st;
    try { st = fs.statSync(abs); } catch { throw new HttpError('not_found', 'Not found.'); }
    if (!st.isFile()) throw new HttpError('not_found', 'Not found.');
    const type = MIME[path.extname(abs).toLowerCase()];
    if (!type) throw new HttpError('not_found', 'Not found.');
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(abs).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || '';
      if (!allowedHosts().has(host)) throw new HttpError('forbidden', 'This server only answers on 127.0.0.1.');
      const origin = req.headers.origin;
      if (origin !== undefined && !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(origin)) {
        throw new HttpError('forbidden', 'Cross-origin requests are not allowed.');
      }
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname.startsWith('/api/') || url.pathname === '/api') await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError && e.detail?.status === 405) {
        sendJson(res, 405, { ok: false, error: { code: 'bad_request', message: e.message } });
        return;
      }
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      sendError(res, e);
    }
  });
  server.requestTimeout = 0;
  server.on('listening', () => { port = server.address().port; });
  return { server, app, get port() { return port; } };
}

/* ---- command line ------------------------------------------------------------------------------- */

export function openBrowser(url) {
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
  const child = edge ? spawn(edge, [`--app=${url}`], { detached: true, stdio: 'ignore', windowsHide: false }) : spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

async function main() {
  const config = loadConfig();
  const { server, app } = createServer(config);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Circle Studio may already be running: open http://127.0.0.1:${config.port}, or set CIRCLE_PORT.`);
    else console.error('Server error:', e.message);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    console.log(`Circle Studio is running at ${url}`);
    console.log(`Data folder: ${config.dataDir}`);
    if (process.argv.includes('--open')) openBrowser(url);
    // the desktop widgets come back with the server once the human has put them on the desktop
    if (app.settings.get().desktopWidgets && process.platform === 'win32') desktopWidgets(config).start();
  });
  const shutdown = async () => {
    await Promise.all([app.sessions.stopAll(), app.claude.stopAll()]).catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
