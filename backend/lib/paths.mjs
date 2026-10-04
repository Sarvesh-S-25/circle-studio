// Every filesystem path that comes from outside goes through this file.
import fs from 'node:fs';
import path from 'node:path';
import { badRequest, forbidden } from './errors.mjs';

export const ID_RE = /^[a-z0-9_]{1,40}$/;
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ROLE_RE = NAME_RE;
export const ADR_FILE_RE = /^\d{3}-[a-z0-9-]+\.md$/;

export function assertName(name, what = 'name') {
  if (typeof name !== 'string' || name.length > 64 || !NAME_RE.test(name)) {
    throw badRequest(`Invalid ${what}: use lowercase letters, digits and single hyphens (max 64).`);
  }
  return name;
}

export const toPosix = (p) => p.split(path.sep).join('/');

function isInside(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve `rel` under `root`. Rejects absolute paths, NUL, `..` traversal and any symlink or junction
 * that leads outside the root (checked on the deepest existing ancestor).
 */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) throw badRequest('Invalid path.');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\')) throw forbidden('Path must be relative to the project.');
  const parts = rel.split(/[\\/]+/);
  if (parts.some((s) => s === '..')) throw forbidden('Path escapes the project folder.');
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, rel);
  if (!isInside(rootAbs, abs)) throw forbidden('Path escapes the project folder.');
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  let realRoot;
  try { realRoot = fs.realpathSync(rootAbs); } catch { realRoot = rootAbs; }
  let realProbe;
  try { realProbe = fs.realpathSync(probe); } catch { realProbe = probe; }
  if (!isInside(realRoot, realProbe)) throw forbidden('Path leads outside the project folder.');
  return abs;
}

/* ---- what the app may write inside a project (posix, relative) ---------------------------------- */
const WRITE_ALLOW = [
  /^models\.json$/,
  /^\.claude\/consult\.config\.json$/,
  /^\.claude\/state\/roster\.json$/,
  /^\.claude\/state\/freeze\.json$/,
  /^\.claude\/agents\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/,
  /^\.claude\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/.+/,
  /^\.agents\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/.+/,
  /^\.gemini\/skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/.+/,
  /^workflow\.json$/,
  /^AGENTS\.md$/,
  /^REFERENCE-LINKS\.md$/,
  /^docs\/brief\.md$/,
  /^docs\/tasks\/BOARD\.md$/,
  /^docs\/tasks\/ALERTS\.md$/,
  /^docs\/adr\/\d{3}-[a-z0-9-]+\.md$/,
  /^push\.md$/,
  /^\.gitignore$/,
  /^\.mcp\.json$/,
  /^\.claude\/settings\.json$/,
];

export function isWritable(relPosix) {
  if (relPosix.includes('..') || relPosix.includes('\0')) return false;
  if (/^\.git\//.test(relPosix) || /^CLAUDE\.md$/i.test(relPosix)) return false;
  // the one exception in .claude/hooks/: Circle Studio's own condense hook, content-checked on every write (condenseguard)
  if (relPosix === '.claude/hooks/circle-condense.mjs' || relPosix === '.claude/hooks/circle-condense.json') return true;
  if (/^\.claude\/hooks\//.test(relPosix) || /^scripts\//.test(relPosix)) return false;
  if (/\/\.circle/.test(relPosix)) return false;
  return WRITE_ALLOW.some((re) => re.test(relPosix));
}

/* ---- what the app may read from a project ------------------------------------------------------- */
const READ_DENY_SEG = /^(\.git|node_modules)$/;
const READ_DENY_NAME = /^(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|\.npmrc|credentials.*|.*\.pfx|.*\.p12)$/i;

export function isSensitiveName(relPosix) {
  const segs = relPosix.split('/');
  if (segs.some((s) => READ_DENY_SEG.test(s))) return true;
  return READ_DENY_NAME.test(segs[segs.length - 1] || '');
}

/* ---- GitHub repo paths -> safe relative paths ---------------------------------------------------- */
const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const BAD_CHARS = /[\\\0:<>"|?*\u0000-\u001f\u007f]/;
const FORMAT_CHARS = /\p{Cf}/u;

/**
 * Map a path from a repository to a safe relative path (posix) or `null` with a reason.
 * `baseAbsLen` is the length of the absolute directory it will be written under; the whole path must stay under 240.
 */
export function safeRelPath(repoPath, baseAbsLen = 0) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof repoPath !== 'string' || repoPath === '') return fail('empty path');
  if (repoPath.startsWith('/')) return fail('absolute path');
  if (BAD_CHARS.test(repoPath) || FORMAT_CHARS.test(repoPath)) return fail('illegal characters');
  const segs = repoPath.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return fail('empty or dot segment');
    if (/[. ]$/.test(s)) return fail('segment ends with a dot or space');
    if (RESERVED_WIN.test(s.split('.')[0])) return fail('reserved Windows name');
    if (/~\d/.test(s)) return fail('8.3 alias segment');
  }
  const norm = repoPath.normalize('NFC');
  if (baseAbsLen + 1 + norm.length > 240) return fail('path too long for Windows (over 240 characters)');
  return { ok: true, path: norm };
}
