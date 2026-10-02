// Importing skills from public GitHub repos. Only api.github.com and raw.githubusercontent.com are
// ever contacted. Everything downloaded is inert data. Limits and shapes: docs/research/github-skills.md.
import path from 'node:path';
import { badRequest, notFound, tooLarge, upstream } from './errors.mjs';
import { safeRelPath } from './paths.mjs';
import { parseFrontMatter, fieldString } from './frontmatter.mjs';
import { LIMITS, slugify } from './skills.mjs';

const OWNER_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9_./+-]{1,200}$/;
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const MAX_DESCRIBED = 150;

/** Accepts github.com/{owner}/{repo}[.git][/tree/<ref...>[/subpath]] and .../blob/<ref...>/.../SKILL.md. */
export function parseGithubUrl(input) {
  if (typeof input !== 'string') throw badRequest('Paste a GitHub repository URL.');
  const s = input.trim();
  if (!s || s.length > 2048) throw badRequest('The URL is empty or longer than 2048 characters.');
  if (/[\u0000-\u001f\u007f\\]/.test(s)) throw badRequest('The URL contains illegal characters.');
  if (/^git@/i.test(s)) throw badRequest('SSH addresses are not supported. Paste the https://github.com/... address.');
  let u;
  try { u = new URL(s); } catch { throw badRequest('That is not a valid URL. Paste something like https://github.com/anthropics/skills.'); }
  if (u.protocol !== 'https:') throw badRequest('Only https:// GitHub URLs are accepted.');
  if (!['github.com', 'www.github.com'].includes(u.hostname)) throw badRequest('Only github.com repositories can be imported.');
  if (u.username || u.password) throw badRequest('The URL must not contain a user name or password.');
  if (u.port) throw badRequest('The URL must not contain a port.');
  if (u.search) throw badRequest('Remove the ?query part of the URL.');
  const segs = u.pathname.split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  if (segs.length < 2) throw badRequest('The URL needs an owner and a repository: github.com/owner/repo.');
  const owner = segs[0];
  const repo = segs[1].replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner) || owner === '.' || owner === '..' || !OWNER_RE.test(repo) || repo === '.' || repo === '..') {
    throw badRequest('The owner or repository name has illegal characters.');
  }
  if (segs.length === 2) return { owner, repo, kind: 'repo', rest: [] };
  if (segs[2] !== 'tree' && segs[2] !== 'blob') throw badRequest('Paste the repository URL, or a /tree/<branch>/<folder> URL.');
  const rest = segs.slice(3);
  if (!rest.length) throw badRequest('The URL names a /tree/ or /blob/ but no branch.');
  if (rest.some((x) => x === '..' || x === '.' || /[\u0000-\u001f]/.test(x))) throw badRequest('The path in the URL is not valid.');
  return { owner, repo, kind: segs[2], rest };
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

export function createGithub({ fetchImpl = globalThis.fetch, token = '', libraryDirLength = 0, exists = () => false } = {}) {
  const rate = { remaining: null, resetAt: null };

  function remember(res) {
    const rem = res.headers.get('x-ratelimit-remaining');
    const reset = res.headers.get('x-ratelimit-reset');
    if (rem !== null) rate.remaining = Number(rem);
    if (reset) rate.resetAt = new Date(Number(reset) * 1000).toISOString();
  }

  async function request(url, { api = false, retry = true, binary = false } = {}) {
    const headers = { 'User-Agent': 'circle-studio-local', Accept: api ? 'application/vnd.github+json' : '*/*' };
    if (api) headers['X-GitHub-Api-Version'] = '2022-11-28';
    if (token && api) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      throw upstream(`Could not reach GitHub (${e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.message}).`);
    }
    if (api) remember(res);
    if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
      const loc = res.headers.get('location') || '';
      if (api && loc.startsWith(`${API}/`)) return request(loc, { api, retry, binary });
      throw upstream('GitHub redirected somewhere this app does not follow.');
    }
    if (res.status === 404) throw notFound('Not found, or the repository is private.');
    if (res.status === 403 || res.status === 429) {
      if (rate.remaining === 0 || res.status === 429) throw upstream('GitHub rate limit reached.', { resetAt: rate.resetAt });
      throw upstream('GitHub refused the request (403).', { resetAt: rate.resetAt });
    }
    if (res.status === 409) throw upstream('The repository is empty.');
    if (res.status >= 500 && retry) return request(url, { api, retry: false, binary });
    if (!res.ok) throw upstream(`GitHub answered ${res.status}.`);
    return binary ? Buffer.from(await res.arrayBuffer()) : res;
  }

  const apiJson = async (p) => (await request(`${API}${p}`, { api: true })).json();
  const rawFile = (owner, repo, ref, p) => request(`${RAW}/${owner}/${repo}/${encPath(ref)}/${encPath(p)}`, { binary: true });

  /** Find the ref (branch/tag/sha) and sub-path that the URL means, and load the recursive tree. */
  async function loadTree(parsed, knownRef) {
    const { owner, repo } = parsed;
    if (knownRef && (!REF_RE.test(knownRef) || knownRef.split('/').includes('..'))) throw badRequest('Invalid ref.');
    const meta = knownRef ? {} : await apiJson(`/repos/${owner}/${repo}`);
    let candidates;
    if (knownRef) candidates = [{ ref: knownRef, sub: '' }];
    else if (parsed.kind === 'repo') candidates = [{ ref: meta.default_branch, sub: '' }];
    else {
      const max = Math.min(3, parsed.kind === 'blob' ? parsed.rest.length - 1 : parsed.rest.length);
      candidates = [];
      for (let n = 1; n <= Math.max(1, max); n++) candidates.push({ ref: parsed.rest.slice(0, n).join('/'), sub: parsed.rest.slice(n).join('/') });
    }
    let tree = null;
    let chosen = null;
    for (const c of candidates) {
      if (!REF_RE.test(c.ref)) continue;
      try {
        tree = await apiJson(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(c.ref)}?recursive=1`);
        chosen = c;
        break;
      } catch (e) {
        if (e.code !== 'not_found') throw e;
      }
    }
    if (!tree) throw notFound('The branch or folder in that URL was not found, or the repository is private.');
    if (tree.truncated) throw tooLarge('This repository is too large to list at once. Paste a /tree/<branch>/<folder> URL for the folder that holds the skills.');
    return { meta, tree, ref: chosen.ref, sub: knownRef ? '' : chosen.sub };
  }

  function findSkills(tree, sub, repoName) {
    const skipped = { links: 0, submodules: 0 };
    const usable = [];
    for (const e of tree.tree) {
      if (e.mode === '120000') skipped.links++;
      else if (e.mode === '160000' || e.type === 'commit') skipped.submodules++;
      else if (e.type === 'blob') usable.push(e);
    }
    const isSkillFile = (e) => path.posix.basename(e.path).toLowerCase() === 'skill.md';
    const allDirs = usable.filter(isSkillFile).map((e) => (path.posix.dirname(e.path) === '.' ? '' : path.posix.dirname(e.path)));
    const inScope = (d) => {
      if (!sub) return true;
      const subDir = /skill\.md$/i.test(sub) ? (path.posix.dirname(sub) === '.' ? '' : path.posix.dirname(sub)) : sub;
      return d === subDir || d.startsWith(`${subDir}/`);
    };
    const dirs = [...new Set(allDirs)].filter(inScope).sort();
    const skills = [];
    const usedKeys = new Set();
    for (const dir of dirs) {
      // files of this skill, minus those that belong to a skill nested inside it
      const nested = allDirs.filter((d) => d !== dir && (dir === '' ? d !== '' : d.startsWith(`${dir}/`)));
      const inside = usable.filter((e) => (dir === '' || e.path.startsWith(`${dir}/`)) && !nested.some((d) => e.path.startsWith(`${d}/`)));
      let key = slugify(dir === '' ? repoName : path.posix.basename(dir));
      if (!key) key = slugify(repoName) || 'skill';
      const base = key;
      for (let n = 2; usedKeys.has(key); n++) key = `${base.slice(0, 60)}-${n}`;
      usedKeys.add(key);
      const bytes = inside.reduce((n, e) => n + (e.size || 0), 0);
      let reason = null;
      if (inside.length > LIMITS.files) reason = `${inside.length} files (limit ${LIMITS.files})`;
      else if (inside.some((e) => (e.size || 0) > LIMITS.fileBytes)) reason = 'a file is larger than 3 MB';
      else if (bytes > LIMITS.skillBytes) reason = `${(bytes / 1048576).toFixed(1)} MB in total (limit 12 MB)`;
      else {
        const base2 = libraryDirLength + 1 + key.length;
        for (const e of inside) {
          const rel = dir === '' ? e.path : e.path.slice(dir.length + 1);
          const safe = safeRelPath(rel, base2);
          if (!safe.ok) { reason = `${safe.reason} in "${rel.slice(0, 80)}"`; break; }
        }
      }
      skills.push({ key, dir, files: inside.map((e) => ({ path: e.path, rel: dir === '' ? e.path : e.path.slice(dir.length + 1), size: e.size || 0 })), bytes, skipped: reason });
    }
    return { skills, skipped };
  }

  return {
    rate,

    /** Public repositories matching a search (one API call; GitHub allows about 10 searches a minute without a login). */
    async searchRepos(q, { perPage = 5 } = {}) {
      if (typeof q !== 'string' || !q.trim() || q.length > 200) throw badRequest('Nothing to search for.');
      const j = await apiJson(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${Math.min(10, Math.max(1, perPage))}`);
      return (Array.isArray(j.items) ? j.items : []).filter((r) => r && typeof r.full_name === 'string' && /^https:\/\/github\.com\//.test(r.html_url || ''))
        .map((r) => ({ fullName: r.full_name, url: r.html_url, stars: Number(r.stargazers_count) || 0, pushedAt: r.pushed_at || null, description: String(r.description || '').slice(0, 300), archived: r.archived === true, fork: r.fork === true }));
    },

    /** List the skills a repo URL offers (2 API calls + one raw read per SKILL.md, at most 150). */
    // `describeOnly(key, dir)` limits which SKILL.md files are read (finding skills reads only promising ones)
    async scan(url, { describeOnly = null, maxDescribed = MAX_DESCRIBED } = {}) {
      const parsed = parseGithubUrl(url);
      const { meta, tree, ref, sub } = await loadTree(parsed);
      const { skills, skipped } = findSkills(tree, sub, parsed.repo);
      const described = skills.filter((s) => !s.skipped && (!describeOnly || describeOnly(s.key, s.dir))).slice(0, Math.min(maxDescribed, MAX_DESCRIBED));
      await pool(described, 4, async (s) => {
        const skillPath = s.files.find((f) => path.posix.basename(f.rel).toLowerCase() === 'skill.md' && path.posix.dirname(f.rel) === '.')?.path;
        if (!skillPath) return;
        try {
          const buf = await rawFile(parsed.owner, parsed.repo, ref, skillPath);
          const fm = parseFrontMatter(buf.toString('utf8'));
          s.description = fm.ok ? fieldString(fm, 'description') : null;
          s.declaredName = fm.ok ? fieldString(fm, 'name') || null : null;
          s.needsWrap = !fm.ok;
        } catch { s.description = null; }
      });
      return {
        repo: { owner: parsed.owner, repo: parsed.repo, ref, subpath: sub || null, defaultBranch: meta.default_branch, archived: meta.archived === true },
        skills: skills.map((s) => ({
          key: s.key,
          dir: s.dir,
          description: s.description ?? null,
          declaredName: s.declaredName && s.declaredName !== s.key ? s.declaredName : null,
          needsWrap: s.needsWrap || false,
          files: s.files.length,
          bytes: s.bytes,
          exists: exists(s.key),
          skipped: s.skipped,
        })),
        ignored: skipped,
        rate: { ...rate },
        hint: skills.length ? null : 'No SKILL.md was found. Paste a /tree/<branch>/<folder> URL for the folder that holds the skills.',
      };
    },

    /** Download the picked skill directories into the library. Per-skill failures do not stop the others. */
    async fetch({ url, ref, picks, overwrite = false, rename = {}, library }) {
      const parsed = parseGithubUrl(url);
      if (!Array.isArray(picks) || !picks.length || picks.length > 100) throw badRequest('Pick between 1 and 100 skills.');
      const { tree, ref: usedRef } = await loadTree(parsed, ref || undefined);
      const { skills } = findSkills(tree, '', parsed.repo);
      const byDir = new Map(skills.map((s) => [s.dir, s]));
      const result = { imported: [], skipped: [], conflicts: [], rate: null };
      let budget = LIMITS.requestBytes;
      for (const dir of picks) {
        const s = byDir.get(typeof dir === 'string' ? dir : dir?.dir);
        const label = typeof dir === 'string' ? dir : dir?.dir;
        if (!s) { result.skipped.push({ dir: label, reason: 'not found in the repository' }); continue; }
        if (s.skipped) { result.skipped.push({ dir: label, reason: s.skipped }); continue; }
        if (s.bytes > budget) { result.skipped.push({ dir: label, reason: 'over the 40 MB limit for one import' }); continue; }
        const key = rename[s.key] ? slugify(rename[s.key]) : s.key;
        if (library.has(key) && !overwrite) { result.conflicts.push({ key, suggestion: `${key.slice(0, 60)}-2` }); continue; }
        try {
          const files = await pool(s.files, 4, async (f) => ({ path: f.rel, buffer: await rawFile(parsed.owner, parsed.repo, usedRef, f.path) }));
          library.put(key, files, { type: 'github', url: `https://github.com/${parsed.owner}/${parsed.repo}`, ref: usedRef, path: s.dir }, { overwrite });
          budget -= s.bytes;
          result.imported.push(key);
        } catch (e) {
          result.skipped.push({ dir: label, reason: e.message });
        }
      }
      result.rate = { ...rate };
      return result;
    },
  };
}
