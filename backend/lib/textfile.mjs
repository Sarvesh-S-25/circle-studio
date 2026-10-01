// Reading and writing text files without disturbing their bytes: EOL per file, BOM, atomic writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** The dominant line ending of a text: 'crlf' when at least as many CRLF as bare LF exist (and at least one). */
export function detectEol(raw) {
  let crlf = 0;
  let lf = 0;
  for (let i = raw.indexOf('\n'); i !== -1; i = raw.indexOf('\n', i + 1)) {
    if (i > 0 && raw.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n';
}

export const toLf = (s) => s.replace(/\r\n/g, '\n');

export function readTextIfExists(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
}

/** Write bytes through a sibling temp file and a rename. The temp name never ends in `.md`/`.json`. */
export function atomicWrite(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.circle-tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

export function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
