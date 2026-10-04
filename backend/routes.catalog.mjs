// The catalog of building blocks (skills, agents, connectors, links) the workflow helper searches, and link indexing.
// Handlers for catalog.*. Shapes are in docs/spec.md.
import fs from 'node:fs';
import path from 'node:path';
import { badRequest, notReady } from './lib/errors.mjs';
import { htmlToText, SUMMARY_SCHEMA, summaryPrompt } from './lib/catalog.mjs';
import { listServers } from './lib/connections.mjs';
import { parseFrontMatter, fieldString } from './lib/frontmatter.mjs';
import { str } from './lib/route-helpers.mjs';
import { patternSources } from './lib/patterns.mjs';

const STALE_MS = 10 * 60 * 1000;
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

/** Everything the human has, as catalog sources. Read only. */
export function catalogSources(app) {
  // the pattern store comes first: ways to shape a team, with their trade-offs (backend/seed/patterns.json)
  const out = [...patternSources()];
  for (const s of app.library.list()) out.push({ type: 'skill', name: s.name, text: s.description || '', where: 'your library' });
  for (const p of app.projects.list().filter((x) => x.exists)) {
    const dir = path.join(p.path, '.claude', 'agents');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { /* none */ }
    for (const f of files.slice(0, 60)) {
      const fm = parseFrontMatter(read(path.join(dir, f)) || '');
      const name = (fm.ok && fieldString(fm, 'name')) || f.slice(0, -3);
      out.push({ type: 'agent', key: `${p.id}/${name}`, name, text: fm.ok ? fieldString(fm, 'description') || '' : '', model: fm.ok ? fieldString(fm, 'model') : null, where: p.name });
    }
    try {
      for (const n of app.workflows.head(app.projects.get(p.id)).nodes) for (const url of n.links || []) out.push({ type: 'link', key: url, name: url.replace(/^https:\/\//, '').slice(0, 80), url, text: `Reading link of ${n.title} in ${p.name}`, where: p.name });
    } catch { /* no workflow */ }
    for (const m of (read(path.join(p.path, 'REFERENCE-LINKS.md')) || '').matchAll(/https:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:[/?#][^\s)>\]`'"]*)?/g)) out.push({ type: 'link', key: m[0], name: m[0].replace(/^https:\/\//, '').slice(0, 80), url: m[0], text: `Reference link in ${p.name}`, where: p.name });
  }
  for (const t of app.templates.list()) {
    try {
      for (const n of app.templates.head(t.id).nodes.filter((x) => x.kind === 'agent')) out.push({ type: 'agent', key: `template:${t.id}/${n.id}`, name: n.title || n.id, text: n.does || '', model: n.model, where: `template ${t.name}` });
    } catch { /* unreadable template */ }
  }
  for (const s of listServers({ root: null, home: app.config.userHome, codexHome: app.config.codexHome })) {
    out.push({ type: 'connector', key: s.id, name: s.name, text: `${s.engine} MCP server (${s.transport}) ${s.command || s.url || ''} ${s.envNames.join(' ')}`, where: `${s.engine}, ${s.file}` });
  }
  return out;
}

export function ensureCatalog(app, { force = false } = {}) {
  const cur = app.catalog.read();
  if (!force && cur.builtAt && Date.now() - Date.parse(cur.builtAt) < STALE_MS) return cur;
  return app.catalog.rebuild(catalogSources(app));
}

export function buildCatalogHandlers(app) {
  const { catalog, claude } = app;
  const view = (cat) => {
    const counts = {};
    for (const e of cat.entries) counts[e.type] = (counts[e.type] || 0) + 1;
    return { builtAt: cat.builtAt, counts, weak: catalog.weak().length };
  };
  return {
    'catalog.get': async ({ query }) => {
      const cat = await ensureCatalog(app);
      const q = query.get('q');
      const type = query.get('type');
      const entries = q ? catalog.search(q, { types: type ? [type] : null, limit: 30 }) : cat.entries.filter((e) => !type || e.type === type).slice(0, 400);
      return { ...view(cat), entries: entries.map(({ sourceHash, ...e }) => e) };
    },
    'catalog.rebuild': async () => view(await ensureCatalog(app, { force: true })),
    // One Haiku call writes the missing one-line descriptions (at most 40 a time). Sends names and their own text only.
    'catalog.describe': async () => {
      await ensureCatalog(app);
      const weak = catalog.weak().slice(0, 40);
      if (!weak.length) return { described: 0, left: 0 };
      await claude.requireReady();
      const r = await claude.advise({ key: 'catalog', prompt: summaryPrompt(weak), model: 'haiku', schema: SUMMARY_SCHEMA, kind: 'catalog' });
      const ids = new Set(weak.map((e) => e.id));
      await catalog.setSummaries((r.data?.items || []).filter((i) => ids.has(i.id)));
      return { described: (r.data?.items || []).length, left: catalog.weak().length, costUsd: r.costUsd };
    },
    // Fetch one https page once, keep its text locally in chunks. This request leaves the PC: only on the human's click.
    'catalog.index': async ({ body }) => {
      const url = str(body?.url, 'url', 1000).trim();
      let u;
      try { u = new URL(url); } catch { throw badRequest('That is not a URL.'); }
      if (u.protocol !== 'https:') throw badRequest('Only https links are indexed.');
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[::1\])/i.test(u.hostname)) throw badRequest('Links to this PC or the local network are not fetched.');
      if (u.username || u.password) throw badRequest('Remove the credentials from the link first.');
      let res;
      try { res = await (app.fetchImpl || fetch)(u.href, { headers: { 'User-Agent': 'circle-studio', Accept: 'text/html,text/plain,text/markdown;q=0.9,*/*;q=0.1' }, redirect: 'follow', signal: AbortSignal.timeout(15_000) }); } catch { throw notReady('The page could not be fetched.'); }
      if (!res.ok) throw notReady(`The page answered ${res.status}.`);
      const type = String(res.headers.get('content-type') || '');
      if (!/text\/|json|markdown|xml/i.test(type)) throw badRequest('Only text pages are indexed (not PDFs, images or downloads).');
      const raw = (await res.text()).slice(0, 2 * 1024 * 1024);
      const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(raw)?.[1]?.trim();
      const text = /html/i.test(type) ? htmlToText(raw) : raw;
      if (text.length < 40) throw badRequest('The page has almost no text.');
      await ensureCatalog(app);
      const entry = await catalog.saveLink(u.href, { title, text });
      return { entry: { id: entry.id, name: entry.name, url: entry.url, indexed: entry.indexed } };
    },
  };
}
