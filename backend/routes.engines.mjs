// Engines, chat, approvals and questions (the Inbox), live runs, and the advisor.
// Handlers for the contract routes engines.*, requests.*, events.stream, projects.live, chat.send, chat.stop and
// advisor.run. The shape of every route is in docs/spec.md.
import fs from 'node:fs';
import path from 'node:path';
import { badRequest, forbidden, notFound, tooLarge } from './lib/errors.mjs';
import { isSensitiveName, resolveInside, toPosix, NAME_RE } from './lib/paths.mjs';
import { redact, scanSecrets } from './lib/secrets.mjs';
import { advisorPrompt, MODELS } from './lib/claude.mjs';
import { ENGINE_IDS } from './lib/engines/index.mjs';
import { str, readTextFile, SECRET_DIRS } from './lib/route-helpers.mjs';
import { searchHelp, guidePrompt, guideFolder, askEngine } from './lib/guide.mjs';
import { quickAttention } from './lib/health.mjs';
import { SETUP, openSetupTerminal } from './lib/engines/setup.mjs';
import { ghStatus, ghSignOut } from './lib/ghcli.mjs';

const withSetup = (e) => ({ ...e, setup: SETUP[e.id] || null });

function assignIds(list, prefix, sanitize) {
  return (Array.isArray(list) ? list : []).slice(0, 12).map((it, n) => ({
    id: `${prefix}${n + 1}`,
    title: redact(String(it.title ?? '')).slice(0, 200),
    detail: redact(String(it.detail ?? '')).slice(0, 1500),
    ...(typeof it.phase === 'string' && NAME_RE.test(it.phase) ? { phase: it.phase } : {}),
    ...sanitize(it),
  }));
}

export function buildEngineHandlers(app) {
  const { projects, claude, engines, inbox, sessions } = app;

  // Requests from Claude Code in a terminal or an editor (its PermissionRequest hook, scripts/permission-hook.mjs): the
  // hook waits on them while you answer on a card. When it stops asking (the terminal answered, or the session ended),
  // the card goes after a short while.
  const outside = new Map(); // request id -> { done, result, seen }
  const OUTSIDE_TTL_MS = app.overrides?.outsideTtlMs ?? 40_000;
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const inside = (dir, root) => same(dir, root) || path.resolve(dir).toLowerCase().startsWith(`${path.resolve(root).toLowerCase()}${path.sep}`);
  const sweep = setInterval(() => {
    for (const [id, o] of outside) {
      if (o.result) { if (Date.now() - o.seen > OUTSIDE_TTL_MS) outside.delete(id); continue; }
      if (Date.now() - o.seen > OUTSIDE_TTL_MS) { sessions.releaseExternal(id, 'The terminal stopped waiting (answered there, or the session ended).'); outside.delete(id); }
    }
  }, Math.min(10_000, OUTSIDE_TTL_MS));
  sweep.unref?.();
  const STATUS = new Set(['pending', 'all', 'allowed', 'denied', 'answered', 'expired', 'auto-denied']);
  return {
    // each engine also says how a person gets it going (what account, the install and sign-in commands)
    'engines.list': async () => ({ engines: (await engines.list()).map(withSetup), github: { ...(await ghStatus()), setup: SETUP.github } }),
    'engines.check': async () => ({ engines: (await engines.list({ force: true })).map(withSetup), github: { ...(await ghStatus({ force: true })), setup: SETUP.github } }),
    // "Do it for me" on Let's begin: a visible terminal runs the fixed install or sign-in command for that engine
    'github.signout': async () => ({ ...(await ghSignOut()), github: { ...(await ghStatus({ force: true })), setup: SETUP.github } }),
    'engines.terminal': ({ body }) => openSetupTerminal(str(body?.engine, 'engine', 20), body?.step, { spawnImpl: app.overrides?.spawnTerminal || (process.env.NODE_TEST_CONTEXT ? () => ({}) : undefined) }), // tests never open a window

    'requests.list': ({ query }) => {
      const status = query.get('status') || 'pending';
      if (!STATUS.has(status)) throw badRequest('status must be pending, all, allowed, denied, answered, expired or auto-denied.');
      const projectId = query.get('projectId') || undefined;
      if (projectId) projects.get(projectId);
      return { requests: inbox.list({ status, projectId }) };
    },
    'requests.respond': ({ params, body }) => ({ request: sessions.respond(params.id, body) }),
    // From the hook: a Claude Code session outside Circle Studio asks to use a tool (or asks a question).
    'hooks.permission': ({ body }) => {
      const tool = str(body?.tool_name, 'tool_name', 80);
      const folder = str(body?.cwd, 'cwd', 1000);
      if (!path.isAbsolute(folder)) throw badRequest('cwd must be a full path.');
      const input = body?.tool_input && typeof body.tool_input === 'object' && !Array.isArray(body.tool_input) ? body.tool_input : {};
      const sessionId = typeof body?.session_id === 'string' && /^[0-9a-f-]{8,64}$/i.test(body.session_id) ? body.session_id : null;
      // the project it belongs to, when it is one of yours; else it is kept apart, under the folder's name
      const p = projects.list().filter((x) => x.exists && inside(folder, x.path)).sort((a, b) => b.path.length - a.path.length)[0];
      const { rec, done } = sessions.externalRequest({ projectId: p ? p.id : '_terminal', folder, tool, input, sessionId });
      const o = { done, result: null, seen: Date.now() };
      done.then((r) => { o.result = r; });
      outside.set(rec.id, o);
      return { id: rec.id };
    },
    // The hook waits here (a few seconds at a time) for your answer.
    'hooks.permission.wait': async ({ params, query }) => {
      const o = outside.get(params.id);
      if (!o) return { status: 'gone' };
      o.seen = Date.now();
      const wait = Math.max(0, Math.min(25, Number(query.get('wait')) || 0)) * 1000;
      if (!o.result && wait) {
        let timer;
        await Promise.race([o.done, new Promise((r) => { timer = setTimeout(r, wait); })]);
        clearTimeout(timer); // answered early: no timer left behind
      }
      o.seen = Date.now();
      if (!o.result) return { status: 'pending' };
      const r = o.result;
      return { status: 'done', decision: r.decision, message: r.message || null, answers: r.answers || null };
    },
    // "In the terminal" on the card: the hook steps aside and Claude Code asks in the terminal as usual.
    'hooks.permission.release': ({ params }) => ({ released: sessions.releaseExternal(params.id) }),

    'events.stream': async ({ query, sse, signal }) => {
      const stream = sse();
      app.viewers.count++; // an open window: it shows its own popups, so the server does not notify Windows
      // what the window shows, so opening it again brings this one forward instead of a second window
      const key = query.get('window');
      const forget = key && /^[a-z]+(:[A-Za-z0-9_-]{0,60}){0,3}$/.test(key) ? app.addWindow(key, (name, data) => stream.send(name, data)) : () => {};
      // a request a desktop card already shows carries carded: the window then shows no Windows notification of its own
      const tag = (name, data) => (name === 'request' ? { ...data, carded: Boolean(app.carded?.()) } : data);
      for (const r of inbox.list({ status: 'pending' }).reverse()) stream.send('request', tag('request', r));
      const off = sessions.subscribe((name, data) => stream.send(name, tag(name, data)));
      const offNotice = app.notices ? app.notices.subscribe((n) => stream.send('notice', n)) : () => {};
      await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      off();
      offNotice();
      forget();
      app.viewers.count = Math.max(0, app.viewers.count - 1);
      stream.end();
    },

    'projects.live': ({ params }) => { projects.get(params.id); return sessions.live(params.id); },

    // The run belongs to the chat, not to the window that sent it: closing or reloading the window does not stop it
    // (Stop or /stop does). Every window, the desktop and the overlay see it go on and can answer what it asks.
    'chat.send': async ({ body, sse }) => {
      const projectId = str(body?.projectId, 'projectId', 60);
      const message = str(body?.message, 'message', 20000);
      const engineId = body?.engine === undefined ? 'claude' : body.engine;
      if (!ENGINE_IDS.includes(engineId)) throw badRequest(`engine must be one of ${ENGINE_IDS.join(', ')}.`);
      const nodeId = body?.nodeId === undefined || body.nodeId === null ? null : body.nodeId;
      if (nodeId !== null && !(typeof nodeId === 'string' && NAME_RE.test(nodeId))) throw badRequest('nodeId is not valid.');
      const model = typeof body?.model === 'string' && /^[A-Za-z0-9._:-]{1,60}$/.test(body.model) ? body.model : undefined;
      await sessions.preflight({ projectId, nodeId, engineId });
      const stream = sse();
      try {
        await sessions.runTurn({ projectId, nodeId, engineId, model, message, newSession: body?.newSession === true, emit: (name, data) => stream.send(name, data) });
      } catch (e) {
        stream.send('error', { code: e.code || 'internal', message: redact(String(e.message || e)).slice(0, 400) });
      }
      stream.end();
      return undefined;
    },
    'chat.stop': async ({ body }) => {
      const key = str(body?.projectId ?? body?.runId, 'projectId', 60);
      return { stopped: sessions.stop(key, typeof body?.nodeId === 'string' ? body.nodeId : undefined) || (await claude.stop(key)) };
    },

    // Ask Circle: help topics (no AI), and an answer from any engine the human chose and has signed in to.
    'guide.ask': async ({ body }) => {
      const message = str(body?.message, 'message', 2000);
      const topics = searchHelp(message).map(({ id, title, text, href }) => ({ id, title, text, href }));
      if (body?.engine === 'none') return { topics, reply: null, engine: null };
      const list = await engines.list();
      const order = [body?.engine, 'claude', 'codex', 'copilot', 'gemini'].filter((x) => typeof x === 'string');
      const pick = order.map((id) => list.find((e) => e.id === id && e.usable)).find(Boolean);
      if (!pick) return { topics, reply: null, engine: null, note: 'No engine is signed in, so only the built-in help answers. Settings shows how to sign in.' };
      const projectsNow = projects.list().filter((p) => p.exists).slice(0, 8);
      const summary = [
        projectsNow.length ? `Projects: ${projectsNow.map((p) => p.name).join(', ')}.` : 'No projects yet.',
        `${inbox.list({ status: 'pending' }).length} requests wait in the Inbox.`,
        ...projectsNow.slice(0, 4).map((p) => { const a = quickAttention(p.path); return a.length ? `${p.name} needs: ${a.map((x) => x.title).join(', ')}.` : ''; }),
      ].filter(Boolean).join(' ');
      const r = await askEngine(engines.adapter(pick.id), { prompt: guidePrompt({ question: message, summary: redact(summary).slice(0, 1500) }), cwd: guideFolder(app.config.dataDir) });
      return { topics, reply: r.reply || null, error: r.error, engine: { id: pick.id, label: pick.label } };
    },

    'advisor.run': async ({ body }) => {
      const src = body?.source;
      if (!src || typeof src !== 'object') throw badRequest('Say which file to review.');
      let name;
      let text;
      let root;
      if (src.type === 'text') {
        name = str(src.name || 'pasted.txt', 'name', 200);
        text = str(src.text, 'text', 400 * 1024);
        if (Buffer.byteLength(text) > 400 * 1024) throw tooLarge('The text is larger than 400 KB.');
      } else if (src.type === 'project') {
        const p = projects.resolve(str(src.projectId, 'projectId', 60), { need: 'claude' });
        root = p.root;
        const rel = toPosix(str(src.path, 'path', 500));
        if (isSensitiveName(rel)) throw forbidden('That file may hold secrets and is not sent.');
        name = rel;
        text = readTextFile(resolveInside(root, rel), 400 * 1024);
      } else if (src.type === 'path') {
        const p = str(src.path, 'path', 1000).trim().replace(/^"(.*)"$/, '$1');
        if (!path.isAbsolute(p)) throw badRequest('Give the full path of the file, for example C:\\Users\\you\\notes\\plan.md.');
        let real;
        try { real = fs.realpathSync(p); } catch { throw notFound('That file does not exist.'); }
        const segs = toPosix(real).split('/');
        if (isSensitiveName(toPosix(real)) || segs.some((s) => SECRET_DIRS.has(s.toLowerCase()))) throw forbidden('That file may hold secrets and is not sent.');
        name = path.basename(real);
        text = readTextFile(real, 400 * 1024);
      } else throw badRequest('source.type must be path, project or text.');

      const found = scanSecrets(text);
      if (found.length && body?.redact !== true) {
        throw badRequest(`This file contains ${found.length} thing${found.length === 1 ? '' : 's'} that look like secrets. Nothing was sent.`, { secrets: found.slice(0, 20).map((f) => ({ kind: f.kind, line: f.line, preview: f.preview })) });
      }
      if (found.length) text = redact(text);
      const model = MODELS.includes(body?.model) ? body.model : undefined;
      await claude.requireReady();
      const r = await claude.advise({ key: 'advisor', prompt: advisorPrompt(name, text), model, root });
      const d = r.data;
      return {
        file: { name, bytes: Buffer.byteLength(text), masked: found.length },
        summary: redact(String(d.summary ?? '')).slice(0, 1500),
        keep: assignIds(d.keep, 'k', () => ({})),
        build: assignIds(d.build, 'b', () => ({})),
        issues: assignIds(d.issues, 'i', (it) => ({ severity: ['high', 'medium', 'low'].includes(it.severity) ? it.severity : 'medium' })),
        models: r.models,
        costUsd: r.costUsd,
        ms: r.ms,
      };
    },
  };
}
