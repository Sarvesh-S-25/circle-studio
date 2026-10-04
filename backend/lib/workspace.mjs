// A virtual copy of the files an edit touches. Ops read and write through it; nothing reaches the
// disk until a change set is applied. Text files keep their bytes; only the patched spans change.
import fs from 'node:fs';
import { resolveInside, isWritable, toPosix } from './paths.mjs';
import { forbidden } from './errors.mjs';
import { isCondenseFile, checkCondenseWrite } from './condenseguard.mjs';
import { looksBinary, detectEol, sha256 } from './textfile.mjs';

const same = (a, b) => {
  if (a === b) return true;
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  return false;
};

export class Workspace {
  constructor(root) {
    this.root = root;
    this.map = new Map();
  }

  entry(rel) {
    const key = toPosix(rel);
    let e = this.map.get(key);
    if (!e) {
      const abs = resolveInside(this.root, key);
      let buf = null;
      try {
        buf = fs.readFileSync(abs);
      } catch (err) {
        if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes(err.code)) throw err;
      }
      // A file that is not clean UTF-8 is never text-patched: re-encoding it would change bytes.
      const binary = buf !== null && (looksBinary(buf) || !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf));
      const before = buf === null ? null : binary ? buf : buf.toString('utf8');
      e = { rel: key, abs, before, after: before, via: 'app', binary, hash: buf === null ? null : sha256(buf) };
      this.map.set(key, e);
    }
    return e;
  }

  /** Current (virtual) text, or null when the file does not exist. Binary files read as null. */
  read(rel) {
    const e = this.entry(rel);
    return typeof e.after === 'string' ? e.after : null;
  }

  exists(rel) { return this.entry(rel).after !== null; }

  eol(rel) {
    const e = this.entry(rel);
    const text = typeof e.before === 'string' ? e.before : typeof e.after === 'string' ? e.after : '';
    return detectEol(text);
  }

  write(rel, content, { via = 'app' } = {}) {
    const e = this.entry(rel);
    if (!isWritable(e.rel)) throw forbidden(`Circle Studio does not write ${e.rel}.`);
    if (isCondenseFile(e.rel)) checkCondenseWrite(e.rel, content);
    e.after = content;
    e.via = via;
    if (Buffer.isBuffer(content)) e.binary = true;
  }

  /** Entries whose content differs from what is on disk. */
  changed() {
    return [...this.map.values()].filter((e) => !same(e.before, e.after));
  }
}
