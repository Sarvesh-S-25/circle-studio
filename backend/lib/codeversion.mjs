// A fingerprint of the server's own code (backend/ and contracts/api.json): size and time of every file. The server
// records it when it starts; the launcher and the app compare it with the files on disk to see that the running
// server is older than the code, so an update is picked up without the human stopping anything by hand.
// The frontend is not included: it is read from disk on every request, so it is never stale.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, out);
    else if (/\.(mjs|js|json)$/.test(e.name)) out.push(abs);
  }
}

export function codeFingerprint(appRoot) {
  const files = [];
  walk(path.join(appRoot, 'backend'), files);
  files.push(path.join(appRoot, 'contracts', 'api.json'));
  const h = crypto.createHash('sha256');
  for (const f of files.sort()) {
    try {
      const st = fs.statSync(f);
      h.update(`${path.relative(appRoot, f)}:${st.size}:${Math.round(st.mtimeMs)}\n`);
    } catch { /* a file that went away changes the list anyway */ }
  }
  return h.digest('hex').slice(0, 16);
}
