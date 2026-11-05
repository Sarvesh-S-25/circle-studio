import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { badRequest, conflict } from './errors.mjs';
import { scanSecrets } from './secrets.mjs';

const MAX_BACKUP = 40 * 1024 * 1024;
const ALLOWED = /^(registry\.json|settings\.json|chat-selections\.json|library\.json|catalog\.json|(?:chats|conversations|inbox-archive|progress|plans|workflows|templates|knowledge|library\/skills)\/[A-Za-z0-9_./ -]+)$/;
const digest = (s) => createHash('sha256').update(s).digest('hex');
const safe = (rel) => typeof rel === 'string' && !rel.includes('..') && !rel.includes('\\') && !path.isAbsolute(rel) && ALLOWED.test(rel);

export function storageFiles(dataDir) {
  const out = [];
  const walk = (dir, base = '', depth = 0) => {
    if (depth > 15 || out.length >= 20000) return;
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, rel, depth + 1);
      else if (e.isFile()) { const st = fs.statSync(abs); out.push({ path: rel, bytes: st.size, modifiedAt: st.mtime.toISOString() }); }
    }
  };
  walk(dataDir);
  return out;
}

export class Storage {
  constructor(store) { this.store = store; this.plans = new Map(); this.download = null; this.downloadTimer = null; }
  retention() {
    const value = this.store.readJson('settings.json', {}).retention || {};
    return { generatedDays: Math.max(1, Math.min(365, Number(value.generatedDays) || 7)), generatedMaxMiB: Math.max(1, Math.min(5000, Number(value.generatedMaxMiB) || 100)), chats: 'Saved conversations are durable until you explicitly archive them; archiving preserves their contents.', audit: 'Pending requests are never pruned. The latest 1,000 completed requests per project remain hot; older records are archived on disk and loaded on demand.', workflows: 'Up to 200 workflow versions are retained. Pinned versions and the current version are protected; unpin an old version if all retained versions are pinned.' };
  }
  prepareDownload() {
    const backup = this.backup();
    const token = randomUUID();
    clearTimeout(this.downloadTimer);
    this.expireDownload();
    const file = this.store.abs(`cache/downloads/${token}.json`);
    fs.mkdirSync(this.store.abs('cache/downloads'), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(backup, null, 2), { flag: 'wx' });
    const bytes = fs.statSync(file).size;
    this.download = { token, file, bytes, filename: `circle-backup-${new Date().toISOString().slice(0, 10)}.json`, at: Date.now() };
    this.downloadTimer = setTimeout(() => this.expireDownload(), 120000); this.downloadTimer.unref();
    return { token, files: backup.entries.length, bytes, skipped: backup.skipped, expiresInSeconds: 120 };
  }
  expireDownload() { if (this.download?.file) { try { fs.unlinkSync(this.download.file); } catch { /* an active stream may still own it; generated-cache cleanup can remove it later */ } } this.download = null; }
  readDownload(token) {
    if (!this.download || token !== this.download.token || Date.now() - this.download.at > 120000) throw conflict('This download expired. Prepare the backup again.');
    return { filename: this.download.filename, file: this.download.file, bytes: this.download.bytes };
  }
  inspect() {
    const groups = new Map();
    for (const f of storageFiles(this.store.dir)) {
      const category = f.path.includes('/') ? f.path.split('/')[0] : 'settings';
      const g = groups.get(category) || { category, files: 0, bytes: 0, rebuildable: ['cache', 'logs', 'chat-view'].includes(category) };
      g.files++; g.bytes += f.bytes; groups.set(category, g);
    }
    return { categories: [...groups.values()].sort((a, b) => b.bytes - a.bytes), totalBytes: [...groups.values()].reduce((n, g) => n + g.bytes, 0), retention: this.retention(), owns: 'Only Circle Studio data. Provider-owned histories are excluded.' };
  }
  cleanupPreview() {
    const policy = this.retention(); const before = Date.now() - policy.generatedDays * 86400000;
    const generated = storageFiles(this.store.dir).filter((f) => /^(cache|logs|chat-view)\//.test(f.path) || /^(server|desktop-widgets)\.log$/.test(f.path)).sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt));
    let remaining = generated.reduce((n, f) => n + f.bytes, 0);
    const files = generated.filter((f) => { const remove = Date.parse(f.modifiedAt) < before || remaining > policy.generatedMaxMiB * 1024 * 1024; if (remove) remaining -= f.bytes; return remove; }).map((f) => ({ ...f, sha256: digest(fs.readFileSync(this.store.abs(f.path))) }));
    const id = randomUUID();
    if (this.plans.size > 5) this.plans.clear();
    this.plans.set(id, { kind: 'cleanup', files, at: Date.now() });
    return { id, files, bytes: files.reduce((n, f) => n + f.bytes, 0), note: `Removes generated caches, diagnostic logs and editor chat views older than ${policy.generatedDays} days, plus the oldest generated files above ${policy.generatedMaxMiB} MiB. Saved chats, approvals, audit archives, tasks, backups, credentials and provider histories are excluded. Nothing is removed until you confirm this preview.` };
  }
  cleanup(id) {
    const plan = this.plans.get(id);
    if (plan?.kind !== 'cleanup' || Date.now() - plan.at > 10 * 60_000) throw conflict('The cleanup preview expired. Preview again.');
    this.plans.delete(id);
    const root = fs.realpathSync(this.store.dir) + path.sep;
    // Validate the entire preview before deleting anything. Never follow a replaced link outside Circle data.
    for (const f of plan.files) {
      const file = this.store.abs(f.path);
      if (!fs.realpathSync(file).startsWith(root) || fs.lstatSync(file).isSymbolicLink() || digest(fs.readFileSync(file)) !== f.sha256) throw conflict('A cleanup file changed after preview. Preview again.');
    }
    for (const f of plan.files) fs.unlinkSync(this.store.abs(f.path));
    return { removed: plan.files.length, bytes: plan.files.reduce((n, f) => n + f.bytes, 0) };
  }
  backup() {
    const entries = [];
    const skipped = [];
    let bytes = 0;
    for (const f of storageFiles(this.store.dir)) {
      if (!safe(f.path)) continue;
      if (f.bytes > 8 * 1024 * 1024) { skipped.push({ path: f.path, reason: 'Larger than the per-file export limit.' }); continue; }
      const buffer = fs.readFileSync(this.store.abs(f.path));
      if (scanSecrets(buffer.toString('utf8')).length) { skipped.push({ path: f.path, reason: 'Contains a possible credential; export omitted.' }); continue; }
      bytes += buffer.length;
      if (bytes > MAX_BACKUP * 0.7) throw badRequest('This export exceeds the supported size. Export individual conversations or skills first.');
      entries.push({ path: f.path, data: buffer.toString('base64'), sha256: digest(buffer) });
    }
    return { schema: 'circle-backup/1', at: new Date().toISOString(), entries, skipped, note: 'Provider sign-ins and connector vault keys are excluded. Re-enter connector keys after restoring.' };
  }
  preview(backup) {
    if (backup?.schema !== 'circle-backup/1' || !Array.isArray(backup.entries) || backup.entries.length > 10000) throw badRequest('Unsupported backup.');
    let size = 0;
    const seen = new Set();
    const entries = backup.entries.map((e) => {
      if (!safe(e.path) || seen.has(e.path) || typeof e.data !== 'string') throw badRequest('Backup contains an invalid or duplicate path.');
      seen.add(e.path);
      const data = Buffer.from(e.data, 'base64'); size += data.length;
      if (size > MAX_BACKUP || data.length > 8 * 1024 * 1024 || digest(data) !== e.sha256) throw badRequest('Backup integrity or size check failed.');
      if (scanSecrets(data.toString('utf8')).length) throw badRequest('A backup entry may contain credentials.');
      return { path: e.path, data, sha256: e.sha256 };
    });
    const id = randomUUID();
    if (this.plans.size > 5) this.plans.clear();
    this.plans.set(id, { entries, at: Date.now() });
    return { id, files: entries.map((e) => ({ path: e.path, bytes: e.data.length })), bytes: size, note: 'Restore creates a separate recovered-data folder. Current data is not overwritten.' };
  }
  restore(id) {
    const plan = this.plans.get(id);
    if (!plan || plan.kind === 'cleanup' || Date.now() - plan.at > 10 * 60_000) throw conflict('The restore preview expired. Preview the backup again.');
    this.plans.delete(id);
    const recoveryDir = this.store.abs(`restored/${id}`);
    fs.mkdirSync(recoveryDir, { recursive: true });
    for (const e of plan.entries) {
      const target = path.resolve(recoveryDir, e.path);
      if (!target.startsWith(path.resolve(recoveryDir) + path.sep)) throw badRequest('Restore path escapes its folder.');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data, { flag: 'wx' });
      if (digest(fs.readFileSync(target)) !== e.sha256) throw conflict('A restored file did not match its checksum.');
    }
    return { verified: true, files: plan.entries.length, dataDir: recoveryDir, note: 'Restored into an isolated folder. Start Circle with CIRCLE_DATA pointing to this folder to use the recovered data.' };
  }
}
