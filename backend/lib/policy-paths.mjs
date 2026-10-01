// Path facts for the approval policy (backend/lib/policy.mjs): is a path inside the project, is it a secret,
// does it belong to the app itself. Pure functions apart from the realpath lookups.
import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker']);
const SENSITIVE_NAMES = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|pfx|p12|kdbx|ppk|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /^\.?npmrc$/i,
  /^_?\.?netrc$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
  /^\.htpasswd$/i,
  /^credentials(\..*)?$/i,
  /^secrets?\.(json|ya?ml|toml|txt|env)$/i,
  /^service[-_]?account.*\.json$/i,
];
// Files that only document the variables a project needs. They hold no values by convention.
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/i;
const GUARD_PATH = /(^|\/)\.claude\/(settings(\.local)?\.json|hooks(\/|$))/i;
export const DEVICE_RE = /^(\/dev\/(null|stdin|stdout|stderr)|nul|\$null)$/i;
// Names a glob could stand for. A pattern that can match one of them is treated as naming a secret.
const GLOB_PROBES = ['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', 'credentials', 'credentials.json', 'secret.pem', 'private.key', 'cert.pfx', '.npmrc', '.netrc', '.git-credentials', '.ssh', '.aws'];

export const isWinPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
export const flavorOf = (root) => (isWinPath(root) ? path.win32 : path.posix);
const norm = (F, p) => (F === path.win32 ? p.toLowerCase() : p);

const segments = (p) => p.split(/[\\/]+/).filter(Boolean);

/** Why a path (any separator, absolute or relative) names a secret, or null. */
export function sensitiveReason(p) {
  const segs = segments(p);
  const base = segs[segs.length - 1] || '';
  if (ENV_TEMPLATE.test(base)) return null;
  if (segs.some((s) => SENSITIVE_DIRS.has(s.toLowerCase()))) return 'a folder that holds keys or credentials';
  if (SENSITIVE_NAMES.some((re) => re.test(base))) return 'a file that may hold secrets';
  const i = segs.findIndex((s) => s.toLowerCase() === '.git');
  if (i >= 0 && (segs[i + 1] || '').toLowerCase() === 'config') return 'the git config, which can hold credentials';
  return null;
}

/** True when a wildcard pattern could stand for a secret file (a bare `*` does not count). */
export function globNamesSecret(pattern) {
  const base = segments(pattern).pop() || '';
  if (!/[*?[]/.test(base) || base.replace(/[*?[\]]/g, '') === '') return false;
  let re;
  try {
    re = new RegExp(`^${base.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  } catch { return false; }
  return GLOB_PROBES.some((n) => re.test(n));
}

export const isGuardPath = (p) => GUARD_PATH.test(segments(p).join('/'));
export const isGitDir = (p) => segments(p).some((s) => s.toLowerCase() === '.git');

function realOf(F, abs) {
  let probe = abs;
  const tail = [];
  for (;;) {
    try {
      return F.join(fs.realpathSync.native(probe), ...tail.reverse());
    } catch {
      const up = F.dirname(probe);
      if (up === probe) return abs;
      tail.push(F.basename(probe));
      probe = up;
    }
  }
}

function within(F, dir, abs) {
  const rel = F.relative(norm(F, dir), norm(F, abs));
  return rel === '' || (!rel.startsWith('..') && !F.isAbsolute(rel));
}

/** `/c/Users/x` (Git Bash) and `/cygdrive/c/x` mean `C:\Users\x` when the project lives on a Windows drive. */
function unixDrive(p) {
  const m = /^\/(?:cygdrive\/)?([A-Za-z])(?:\/(.*))?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:/${m[2] || ''}` : p;
}

const VARIABLE_RE = /\$|%[^%\s]+%|`/;

/**
 * Resolve a path the way the shell would from `cwd` and say where it lands.
 * status: 'inside' | 'outside' | 'unknown' (a variable or an unknown working folder). Also flags for the app's own folders.
 */
export function classifyPath(raw, { root, cwd, protect = [] }) {
  const F = flavorOf(root);
  const p = String(raw).replace(/^["']|["']$/g, '');
  if (DEVICE_RE.test(p)) return { status: 'inside', device: true, abs: p };
  if (p === '' || p.includes('\0')) return { status: 'unknown', why: 'an empty or invalid path' };
  if (VARIABLE_RE.test(p)) return { status: 'unknown', why: 'a variable the app cannot resolve' };
  if (p === '~' || /^~[\\/]/.test(p) || /^~[A-Za-z0-9_.-]+/.test(p)) return { status: 'outside', abs: p, why: 'your home folder' };
  if (cwd === null && !F.isAbsolute(p)) return { status: 'unknown', why: 'a folder the app lost track of' };
  const win = F === path.win32;
  const fixed = win ? unixDrive(p.replace(/^\\\\\?\\/, '')) : p;
  const abs = F.resolve(cwd ?? root, fixed);
  if (win && /^\\\\/.test(abs)) return { status: 'outside', abs, why: 'a network or device path' };
  const real = realOf(F, abs);
  const realRoot = realOf(F, F.resolve(root));
  const status = within(F, realRoot, real) && within(F, F.resolve(root), abs) ? 'inside' : 'outside';
  const protectedDir = protect.find((d) => within(F, realOf(F, F.resolve(d)), real) || within(F, F.resolve(d), abs));
  return { status, abs, real, protectedDir: protectedDir || null, why: status === 'outside' ? 'outside the project folder' : undefined };
}

/** The path relative to the project (posix separators) for display, or the path itself when outside. */
export function displayPath(raw, root) {
  const F = flavorOf(root);
  try {
    const rel = F.relative(F.resolve(root), F.resolve(root, String(raw)));
    if (rel && !rel.startsWith('..') && !F.isAbsolute(rel)) return rel.split(F.sep).join('/');
  } catch { /* fall through */ }
  return String(raw);
}
