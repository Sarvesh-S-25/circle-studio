// The catalog: one small local database (data/catalog.json) of every building block the human has, each described in
// one short line, so the workflow helper can be told the few that fit a request instead of everything:
//   skills (the library), agents (every registered project and every template), connectors (MCP servers), links
//   (reading links on workflow nodes and REFERENCE-LINKS.md). A link can be indexed: its page is fetched once, turned
//   into text and kept in chunks (data/knowledge), so its content is searchable too.
// Search is BM25 over name + summary + tags (+ chunks for links): local, instant, no model and no embeddings.
// Summaries come from the files themselves; "Describe with Haiku" rewrites missing or long ones in one cheap call.
import crypto from 'node:crypto';
import { redact } from './secrets.mjs';

const STOP = new Set('a an and are as at be by for from has have i in is it its of on or that the this to was we were will with you your our not can do does use used using into than then them they also each which when what how all any only more most other some such'.split(' '));
export const tokens = (s) => (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => w.replace(/(ing|ers|er|es|s)$/, '') || w);
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** BM25 over documents [{ id, text }]. Returns [{ id, score }] best first. */
export function bm25(docs, query, { k1 = 1.4, b = 0.75, limit = 10 } = {}) {
  const q = [...new Set(tokens(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => tokens(d.text));
  const avg = toks.reduce((n, t) => n + t.length, 0) / docs.length || 1;
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
  const N = docs.length;
  return docs.map((d, i) => {
    const tf = new Map();
    for (const w of toks[i]) tf.set(w, (tf.get(w) || 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks[i].length) / avg)));
    }
    return { id: d.id, score };
  }).filter((r) => r.score > 0).sort((a, c) => c.score - a.score).slice(0, limit);
}

/** Turn a fetched page into plain text (scripts, styles and tags dropped). */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

/** Split text into ~900-character chunks on paragraph boundaries. */
export function chunk(text, size = 900) {
  const out = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if ((cur + para).length > size && cur) { out.push(cur.trim()); cur = ''; }
    cur += `${para}\n\n`;
    while (cur.length > size * 1.6) { out.push(cur.slice(0, size).trim()); cur = cur.slice(size); }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.slice(0, 200);
}

export class Catalog {
  constructor(store) { this.store = store; }

  read() { const c = this.store.readJson('catalog.json', null); return c && Array.isArray(c.entries) ? c : { version: 1, builtAt: null, entries: [] }; }

  /**
   * Rebuild from the sources, keeping summaries already written (by Haiku or the human) for entries that still exist
   * and whose source text did not change.
   */
  rebuild(sources) {
    return this.store.serial('catalog', () => {
      const old = new Map(this.read().entries.map((e) => [e.id, e]));
      const entries = [];
      const seen = new Set();
      for (const s of sources) {
        const id = `${s.type}:${s.key || s.name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const sourceText = redact(String(s.text || '')).replace(/\s+/g, ' ').trim();
        const prev = old.get(id);
        const keep = prev && prev.sourceHash === hash(sourceText) && prev.summaryBy === 'haiku';
        entries.push({
          id, type: s.type, name: s.name, where: s.where || '', model: s.model || null, url: s.url || null,
          summary: keep ? prev.summary : clip(sourceText || s.name, 220),
          tags: keep ? prev.tags || [] : [],
          summaryBy: keep ? 'haiku' : 'file',
          sourceHash: hash(sourceText),
          indexed: prev?.indexed || null,
        });
      }
      const cat = { version: 1, builtAt: new Date().toISOString(), entries };
      this.store.writeJson('catalog.json', cat);
      return cat;
    });
  }

  /** Entries whose one-line description is missing, too long, or just their name. */
  // patterns come with their own wording: never sent to Haiku to be described
  weak() { return this.read().entries.filter((e) => e.type !== 'pattern' && e.summaryBy !== 'haiku' && (e.summary.length < 25 || e.summary.length > 160 || e.summary === e.name)); }

  setSummaries(items) {
    return this.store.serial('catalog', () => {
      const cat = this.read();
      const by = new Map(items.map((i) => [i.id, i]));
      for (const e of cat.entries) {
        const i = by.get(e.id);
        if (!i || typeof i.summary !== 'string' || !i.summary.trim()) continue;
        e.summary = clip(redact(i.summary.trim()), 200);
        e.tags = Array.isArray(i.tags) ? i.tags.filter((t) => typeof t === 'string').slice(0, 6).map((t) => t.toLowerCase().slice(0, 24)) : [];
        e.summaryBy = 'haiku';
      }
      this.store.writeJson('catalog.json', cat);
      return cat;
    });
  }

  /** Store the text of a fetched link in chunks; the entry remembers when it was indexed. */
  saveLink(url, { title, text }) {
    const id = hash(url);
    const chunks = chunk(redact(text));
    this.store.writeJson(`knowledge/${id}.json`, { url, title: title || url, fetchedAt: new Date().toISOString(), chunks });
    return this.store.serial('catalog', () => {
      const cat = this.read();
      let e = cat.entries.find((x) => x.type === 'link' && x.url === url);
      if (!e) { e = { id: `link:${url}`, type: 'link', name: title || url, where: 'indexed by you', url, summary: '', tags: [], summaryBy: 'file', sourceHash: '' }; cat.entries.push(e); }
      e.indexed = { at: new Date().toISOString(), chunks: chunks.length, file: id };
      if (title) e.name = clip(title, 120);
      if (e.summaryBy !== 'haiku') e.summary = clip(chunks[0] || url, 200).replace(/\s+/g, ' ');
      this.store.writeJson('catalog.json', cat);
      return e;
    });
  }

  chunksOf(entry) {
    if (!entry.indexed) return [];
    const k = this.store.readJson(`knowledge/${entry.indexed.file}.json`, null);
    return (k?.chunks || []).map((text, i) => ({ id: `${entry.id}#${i}`, text, url: entry.url, title: entry.name }));
  }

  /** The building blocks that fit `query` best, optionally only some types. */
  search(query, { types = null, limit = 12 } = {}) {
    const entries = this.read().entries.filter((e) => !types || types.includes(e.type));
    const hits = bm25(entries.map((e) => ({ id: e.id, text: `${e.name} ${e.name} ${e.summary} ${(e.tags || []).join(' ')} ${e.type}` })), query, { limit: limit * 2 });
    const by = new Map(entries.map((e) => [e.id, e]));
    // the same block copied into several places (a template and the project made from it) is listed once
    const seen = new Map();
    for (const h of hits) {
      const e = by.get(h.id);
      const key = `${e.type}:${e.name.toLowerCase()}:${e.summary}`;
      if (seen.has(key)) { const first = seen.get(key); if (!first.where.includes(e.where)) first.where = `${first.where}, ${e.where}`; continue; }
      seen.set(key, { ...e, score: Math.round(h.score * 100) / 100 });
    }
    return [...seen.values()].slice(0, limit);
  }

  /** Retrieval over the indexed links' text (the RAG part): the passages that best answer `query`. */
  passages(query, { urls = null, limit = 4 } = {}) {
    const links = this.read().entries.filter((e) => e.type === 'link' && e.indexed && (!urls || urls.includes(e.url)));
    const all = links.flatMap((e) => this.chunksOf(e));
    const by = new Map(all.map((c) => [c.id, c]));
    return bm25(all, query, { limit }).map((h) => by.get(h.id));
  }
}

/** One Claude call (Haiku) that writes short summaries and tags for up to 40 entries. */
export const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'summary', 'tags'], properties: { id: { type: 'string' }, summary: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } } } },
};

export function summaryPrompt(entries) {
  return [
    'You keep a catalog of building blocks for AI coding agent teams: skills, agents, connectors (MCP servers) and reading links.',
    'For each item write one plain sentence of at most 20 words saying what it is for and when to use it, and up to 4 short lowercase tags. Use the given text only; do not invent features. Keep each id exactly as given.',
    '',
    ...entries.map((e) => `- id: ${e.id}\n  type: ${e.type}\n  name: ${e.name}\n  text: ${clip(e.summary, 700)}`),
  ].join('\n');
}
