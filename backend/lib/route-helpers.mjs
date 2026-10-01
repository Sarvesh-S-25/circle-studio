// Small helpers shared by the route files (backend/routes*.mjs).
import fs from 'node:fs';
import { badRequest, notFound, tooLarge } from './errors.mjs';
import { looksBinary } from './textfile.mjs';

export const str = (v, what, max = 1000) => {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw badRequest(`${what} is required (text, at most ${max} characters).`);
  return v;
};

export const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker']);

export function readTextFile(abs, maxBytes) {
  let st;
  try { st = fs.statSync(abs); } catch { throw notFound('That file does not exist.'); }
  if (!st.isFile()) throw badRequest('That is not a file.');
  if (st.size > maxBytes) throw tooLarge(`The file is larger than ${Math.round(maxBytes / 1024)} KB.`);
  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) throw badRequest('Only text files can be read.');
  return buf.toString('utf8');
}
