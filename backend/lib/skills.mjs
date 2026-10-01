// The local skills library: folders under data/library/skills/<name>/ plus usage counters.
// Skills here are inert data. Nothing in them is ever executed, imported or spawned.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { badRequest, conflict, notFound, tooLarge } from './errors.mjs';
import { NAME_RE, assertName, safeRelPath } from './paths.mjs';
import { parseFrontMatter, fieldString } from './frontmatter.mjs';
import { atomicWrite, looksBinary } from './textfile.mjs';
import { ENGINE_IDS } from './workflow.mjs';

export const LIMITS = { files: 400, fileBytes: 3 * 1024 * 1024, skillBytes: 12 * 1024 * 1024, requestBytes: 40 * 1024 * 1024 };
const META = 'library.json';
const META_VERSION = 2;

/** Which engine folder group a skill is for: shared by all its engines, or one engine's own. */
export const PARTITIONS = ['shared', 'claude', 'copilot', 'gemini'];

/** Validate a partition and an engine list from outside. Missing values mean the defaults. */
export function normalizePlacement({ partition, engines } = {}) {
  if (partition !== undefined && !PARTITIONS.includes(partition)) throw badRequest(`partition must be ${PARTITIONS.join(', ')}.`);
  if (engines !== undefined && !(Array.isArray(engines) && engines.every((e) => ENGINE_IDS.includes(e)))) throw badRequest(`engines must be a list of ${ENGINE_IDS.join(', ')}.`);
  const list = engines === undefined ? [...ENGINE_IDS] : ENGINE_IDS.filter((e) => engines.includes(e));
  return { partition: partition ?? 'shared', engines: list };
}

/** What a stored record says, with the defaults for anything missing or out of range. */
const placementOf = (m) => normalizePlacement({
  partition: PARTITIONS.includes(m?.partition) ? m.partition : undefined,
  engines: Array.isArray(m?.engines) ? m.engines.filter((e) => ENGINE_IDS.includes(e)) : undefined,
});

export function slugify(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 64).replace(/-+$/g, '');
}

/** Add name/description when a file has no front matter, so Claude Code can load it. */
export function ensureFrontMatter(text, key) {
  if (parseFrontMatter(text).ok) return { text, wrapped: false };
  const lines = text.split(/\r?\n/);
  const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l));
  const first = heading ? heading.replace(/^#+\s+/, '') : lines.find((l) => l.trim() !== '') || key;
  const desc = first.replace(/\s+/g, ' ').trim().slice(0, 200).replace(/"/g, '\\"');
  return { text: `---\nname: ${key}\ndescription: "${desc}"\n---\n\n${text}`, wrapped: true };
}

export class Library {
  constructor({ store }) {
    this.store = store;
    this.dir = store.abs('library/skills');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** The library's records. Entries from before partitions get the defaults, once. */
  #meta() {
    const meta = this.store.readJson(META, { version: META_VERSION, skills: {} });
    if (meta.version !== META_VERSION) {
      for (const [name, m] of Object.entries(meta.skills || {})) meta.skills[name] = { ...m, ...placementOf(m) };
      meta.version = META_VERSION;
      this.#saveMeta(meta);
    }
    return meta;
  }
  #saveMeta(m) { this.store.writeJson(META, m); }

  #walk(dir, base = '') {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...this.#walk(path.join(dir, e.name), rel));
      else if (e.isFile()) out.push({ path: rel, abs: path.join(dir, e.name), bytes: fs.statSync(path.join(dir, e.name)).size });
    }
    return out;
  }

  #summarize(name, meta) {
    const dir = path.join(this.dir, name);
    const files = this.#walk(dir);
    const skillFile = files.find((f) => f.path === 'SKILL.md');
    let description = '';
    let declaredName = null;
    let updatedAt = null;
    let problem = null;
    if (skillFile) {
      const fm = parseFrontMatter(fs.readFileSync(skillFile.abs, 'utf8'));
      if (fm.ok) {
        description = fieldString(fm, 'description');
        declaredName = fieldString(fm, 'name') || null;
      } else problem = `SKILL.md: ${fm.reason}`;
      updatedAt = fs.statSync(skillFile.abs).mtime.toISOString();
    } else problem = 'no SKILL.md';
    const m = meta.skills[name] || {};
    return {
      name,
      description,
      declaredName: declaredName && declaredName !== name ? declaredName : null,
      problem,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      updatedAt,
      uses: m.uses || 0,
      source: m.source || { type: 'local' },
      ...placementOf(m),
    };
  }

  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME_RE.test(d.name)).map((d) => d.name); } catch { /* empty */ }
    const meta = this.#meta();
    return names.sort().map((n) => this.#summarize(n, meta));
  }

  has(name) { return NAME_RE.test(name) && fs.existsSync(path.join(this.dir, name, 'SKILL.md')); }

  /** The engines a skill may be installed for: only its own engine when it has its own partition. */
  enginesFor(name) {
    const { partition, engines } = placementOf(this.#meta().skills[name]);
    return partition === 'shared' ? engines : engines.filter((e) => e === partition);
  }

  get(name) {
    assertName(name, 'skill name');
    if (!this.has(name)) throw notFound(`No skill "${name}" in the library.`);
    const summary = this.#summarize(name, this.#meta());
    const files = this.#walk(path.join(this.dir, name)).map((f) => {
      const item = { path: f.path, bytes: f.bytes };
      if (f.path !== 'SKILL.md' && f.bytes <= 100 * 1024) {
        const buf = fs.readFileSync(f.abs);
        if (!looksBinary(buf)) item.text = buf.toString('utf8');
      }
      return item;
    });
    return { ...summary, skillMd: fs.readFileSync(path.join(this.dir, name, 'SKILL.md'), 'utf8'), files };
  }

  /** Files of a skill as buffers, for installing into a project. */
  files(name) {
    assertName(name, 'skill name');
    if (!this.has(name)) return [];
    return this.#walk(path.join(this.dir, name)).map((f) => ({ path: f.path, buffer: fs.readFileSync(f.abs) }));
  }

  /**
   * Create or replace a skill. Without `skillMd` only the placement of an existing skill changes.
   * `placement` = { partition?, engines? }; what it leaves out stays as it was (the defaults for a new skill).
   */
  save(name, skillMd, placement = {}) {
    assertName(name, 'skill name');
    const isNew = !this.has(name);
    const wanted = normalizePlacement(placement);
    const warnings = [];
    if (skillMd === undefined && !isNew) {
      if (placement.partition === undefined && placement.engines === undefined) throw badRequest('Send skillMd, a partition or engines.');
    } else {
      if (typeof skillMd !== 'string') throw badRequest('skillMd must be text.');
      if (Buffer.byteLength(skillMd) > 4 * 1024 * 1024) throw tooLarge('SKILL.md is larger than 4 MB.');
      const fm = parseFrontMatter(skillMd);
      if (!fm.ok) warnings.push(`SKILL.md has no usable front matter (${fm.reason}). Claude Code needs name and description.`);
      else {
        if (!fieldString(fm, 'description')) warnings.push('The description is empty; Claude cannot tell when to use this skill.');
        const declared = fieldString(fm, 'name');
        if (declared && declared !== name) warnings.push(`The name in the file is "${declared}" but the folder is "${name}".`);
      }
      atomicWrite(path.join(this.dir, name, 'SKILL.md'), skillMd);
    }
    const meta = this.#meta();
    const kept = placementOf(meta.skills[name]);
    meta.skills[name] = {
      ...(meta.skills[name] || {}),
      source: meta.skills[name]?.source || { type: 'created', importedAt: new Date().toISOString() },
      partition: placement.partition === undefined ? kept.partition : wanted.partition,
      engines: placement.engines === undefined ? kept.engines : wanted.engines,
    };
    this.#saveMeta(meta);
    return { skill: this.#summarize(name, meta), created: isNew, warnings };
  }

  remove(name) {
    assertName(name, 'skill name');
    if (!this.has(name)) throw notFound(`No skill "${name}" in the library.`);
    fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
    const meta = this.#meta();
    delete meta.skills[name];
    this.#saveMeta(meta);
  }

  use(name) {
    assertName(name, 'skill name');
    if (!this.has(name)) return;
    const meta = this.#meta();
    const m = meta.skills[name] || {};
    meta.skills[name] = { ...m, uses: (m.uses || 0) + 1, lastUsedAt: new Date().toISOString() };
    this.#saveMeta(meta);
  }

  /** Most used first (used at least once), for the taskbar. */
  mostUsed(n = 6) {
    return this.list().filter((s) => s.uses > 0).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)).slice(0, n);
  }

  /**
   * Put a skill in the library, all or nothing. `files` = [{ path, buffer }] with repo-relative paths.
   * Returns { key } or throws conflict / bad_request / too_large with nothing left on disk.
   */
  put(key, files, source, { overwrite = false, partition, engines } = {}) {
    assertName(key, 'skill name');
    const wanted = normalizePlacement({ partition, engines });
    if (files.length > LIMITS.files) throw tooLarge(`More than ${LIMITS.files} files.`);
    const dest = path.join(this.dir, key);
    const seen = new Set();
    let total = 0;
    for (const f of files) {
      const safe = safeRelPath(f.path, dest.length);
      if (!safe.ok) throw badRequest(`Illegal path "${f.path}": ${safe.reason}.`);
      const fold = safe.path.toLowerCase();
      if (seen.has(fold)) throw badRequest(`Two files differ only by case: "${f.path}".`);
      seen.add(fold);
      if (f.buffer.length > LIMITS.fileBytes) throw tooLarge(`"${f.path}" is larger than 3 MB.`);
      total += f.buffer.length;
      f.safe = safe.path;
    }
    if (total > LIMITS.skillBytes) throw tooLarge('The skill is larger than 12 MB.');
    let skillMd = files.find((f) => f.safe === 'SKILL.md');
    if (!skillMd) {
      const alt = files.find((f) => f.safe.toLowerCase() === 'skill.md');
      if (!alt) throw badRequest('The skill has no SKILL.md.');
      alt.safe = 'SKILL.md';
      skillMd = alt;
    }
    const wrapped = ensureFrontMatter(skillMd.buffer.toString('utf8'), key);
    if (wrapped.wrapped) skillMd.buffer = Buffer.from(wrapped.text, 'utf8');
    if (this.has(key) && !overwrite) throw conflict(`"${key}" is already in the library.`, { key, suggestion: this.#freeName(key) });

    const stage = path.join(this.dir, `.stage-${crypto.randomBytes(4).toString('hex')}`);
    try {
      for (const f of files) {
        const abs = path.join(stage, ...f.safe.split('/'));
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, f.buffer);
      }
      const trash = `${dest}.old-${crypto.randomBytes(3).toString('hex')}`;
      const had = fs.existsSync(dest);
      if (had) fs.renameSync(dest, trash);
      try {
        fs.renameSync(stage, dest);
      } catch (e) {
        if (had) fs.renameSync(trash, dest);
        throw e;
      }
      if (had) fs.rmSync(trash, { recursive: true, force: true });
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
    const meta = this.#meta();
    const kept = placementOf(meta.skills[key]);
    meta.skills[key] = {
      uses: meta.skills[key]?.uses || 0,
      source: { ...source, importedAt: new Date().toISOString() },
      partition: partition === undefined ? kept.partition : wanted.partition,
      engines: engines === undefined ? kept.engines : wanted.engines,
    };
    this.#saveMeta(meta);
    return { key, wrapped: wrapped.wrapped, files: files.length, bytes: total };
  }

  #freeName(key) {
    for (let n = 2; n < 100; n++) {
      const cand = `${key.slice(0, 60)}-${n}`;
      if (!this.has(cand)) return cand;
    }
    return `${key}-copy`;
  }

  /**
   * Import dropped files. `files` = [{ path, buffer }] relative to the dropped folder (or a single .md).
   * Returns { imported, skipped, conflicts, hint }.
   */
  importDropped(files, { overwrite = false, rename = {}, partition, engines } = {}) {
    normalizePlacement({ partition, engines });
    const clean = files.map((f) => ({ path: f.path.replace(/\\/g, '/').replace(/^\/+/, ''), buffer: f.buffer }));
    const result = { imported: [], skipped: [], conflicts: [], hint: null };
    if (!clean.length) { result.hint = 'Nothing was dropped.'; return result; }
    const skillDirs = clean.filter((f) => f.path.split('/').pop().toLowerCase() === 'skill.md').map((f) => path.posix.dirname(f.path)).map((d) => (d === '.' ? '' : d));
    if (!skillDirs.length) {
      const md = clean.filter((f) => /\.md$/i.test(f.path));
      if (clean.length === 1 && md.length === 1) {
        const text = md[0].buffer.toString('utf8');
        const fm = parseFrontMatter(text);
        const key = slugify((fm.ok && fieldString(fm, 'name')) || path.posix.basename(md[0].path, path.extname(md[0].path)));
        if (!key) { result.skipped.push({ dir: md[0].path, reason: 'could not derive a skill name' }); return result; }
        this.#tryPut(result, key, [{ path: 'SKILL.md', buffer: md[0].buffer }], { type: 'drop', path: md[0].path }, { overwrite, rename, partition, engines });
        return result;
      }
      if (clean.some((f) => /(^|\/)(models\.json|\.claude\/)/.test(f.path))) {
        result.hint = 'This looks like a project folder, not a skill. Use "Add project" and paste its path; a browser cannot tell the app where a dropped folder lives.';
      } else result.hint = 'No SKILL.md was found in what you dropped.';
      return result;
    }
    const dirs = [...new Set(skillDirs)].sort((a, b) => b.length - a.length);
    const owner = (p) => dirs.find((d) => d === '' || p === d || p.startsWith(`${d}/`));
    const groups = new Map();
    for (const f of clean) {
      const d = owner(f.path);
      if (d === undefined) continue;
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push({ path: d === '' ? f.path : f.path.slice(d.length + 1), buffer: f.buffer });
    }
    for (const [dir, list] of groups) {
      const key = slugify(dir === '' ? 'imported-skill' : dir.split('/').pop());
      if (!key) { result.skipped.push({ dir, reason: 'could not derive a skill name' }); continue; }
      this.#tryPut(result, key, list, { type: 'drop', path: dir }, { overwrite, rename, partition, engines });
    }
    return result;
  }

  #tryPut(result, key, files, source, { overwrite, rename, partition, engines }) {
    const useKey = rename[key] ? slugify(rename[key]) : key;
    try {
      this.put(useKey, files, source, { overwrite, partition, engines });
      result.imported.push(useKey);
    } catch (e) {
      if (e.code === 'conflict') result.conflicts.push({ key: useKey, suggestion: e.detail?.suggestion });
      else result.skipped.push({ dir: source.path || key, reason: e.message });
    }
  }
}
