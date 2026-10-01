// The diff-first engine: preview turns operations into a change set (writes nothing); apply writes
// exactly what the human saw, after checking the files did not change in between.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Workspace } from './workspace.mjs';
import { runOps } from './ops.mjs';
import { diffText } from './diff.mjs';
import { scanSecrets, redact } from './secrets.mjs';
import { atomicWrite, detectEol, sha256, toLf } from './textfile.mjs';
import { resolveInside, isWritable } from './paths.mjs';
import { runCommand } from './run.mjs';
import { conflict, notFound, HttpError } from './errors.mjs';

const TTL_MS = 15 * 60 * 1000;

function fileView(e) {
  const status = e.before === null ? 'added' : 'modified';
  const base = { path: e.rel, status, via: e.via };
  if (Buffer.isBuffer(e.after) || Buffer.isBuffer(e.before)) {
    return { ...base, binary: true, bytes: Buffer.isBuffer(e.after) ? e.after.length : Buffer.byteLength(e.after ?? ''), diff: { added: 0, removed: 0, hunks: [] } };
  }
  const before = toLf(e.before ?? '');
  const after = toLf(e.after ?? '');
  const secret = scanSecrets(before).length > 0 || scanSecrets(after).length > 0;
  const diff = diffText(secret ? redact(before) : before, secret ? redact(after) : after);
  return { ...base, redacted: secret || undefined, eol: detectEol(e.after ?? e.before ?? '') === '\r\n' ? 'crlf' : 'lf', diff };
}

export class ChangeManager {
  /**
   * @param {object} o
   * @param {import('./store.mjs').Store} o.store
   * @param {(id:string, opts:{write:boolean})=>{id:string, root:string, name:string}} o.resolveProject
   * @param {object} o.ctx        { libraryFiles(name), resolveRoot(from), getPlan(projectId) }
   * @param {(effect:object)=>void} [o.onEffect]
   */
  constructor({ store, resolveProject, ctx, onEffect = () => {}, nodeBin = process.execPath }) {
    this.store = store;
    this.resolveProject = resolveProject;
    this.ctx = ctx;
    this.onEffect = onEffect;
    this.nodeBin = nodeBin;
    this.sets = new Map();
  }

  purge() {
    const now = Date.now();
    for (const [id, cs] of this.sets) if (cs.expiresAt < now) this.sets.delete(id);
  }

  preview(projectId, ops) {
    this.purge();
    const proj = this.resolveProject(projectId, { write: true });
    const ws = new Workspace(proj.root);
    const warnings = [];
    const commands = new Map();
    const effects = [];
    const env = {
      root: proj.root,
      projectId: proj.id,
      canRun: proj.permissions ? proj.permissions.run === true : true,
      ctx: this.ctx,
      warn: (m) => { if (!warnings.includes(m)) warnings.push(m); },
      command: (c) => { commands.set(c.id, c); },
      effect: (e) => { effects.push(e); },
    };
    runOps(ws, ops, env);
    const changed = ws.changed();
    if (!changed.length) {
      return { id: null, projectId: proj.id, files: [], commands: [], warnings: ['Nothing would change.', ...warnings.filter((w) => !/restart|load once/i.test(w))], expiresAt: null };
    }
    const id = crypto.randomBytes(12).toString('hex');
    const expiresAt = Date.now() + TTL_MS;
    const cmdList = [...commands.values()].map((c) => ({ ...c, when: 'after-write' }));
    this.sets.set(id, {
      id,
      projectId: proj.id,
      expiresAt,
      files: changed.map((e) => ({ rel: e.rel, abs: e.abs, hash: e.hash, existed: e.before !== null, after: e.after, via: e.via })),
      commands: cmdList,
      effects,
      warnings,
    });
    return { id, projectId: proj.id, files: changed.map(fileView), commands: cmdList, warnings, expiresAt: new Date(expiresAt).toISOString() };
  }

  async apply(id) {
    const cs = this.sets.get(id);
    if (!cs || cs.expiresAt < Date.now()) {
      this.sets.delete(id);
      throw notFound('This change set expired or was already applied. Preview it again.');
    }
    return this.store.serial(`apply:${cs.projectId}`, () => this.#apply(cs));
  }

  async #apply(cs) {
    const proj = this.resolveProject(cs.projectId, { write: true });
    for (const f of cs.files) {
      resolveInside(proj.root, f.rel);
      if (!isWritable(f.rel)) throw new HttpError('forbidden', `Circle Studio does not write ${f.rel}.`);
      let cur = null;
      try { cur = fs.readFileSync(f.abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const hash = cur === null ? null : sha256(cur);
      if (hash !== f.hash) throw conflict(`${f.rel} changed on disk since the preview. Nothing was written. Preview again.`, { path: f.rel });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupRoot = path.join(this.store.dir, 'backups', cs.projectId, stamp);
    const written = [];
    try {
      for (const f of cs.files) {
        if (f.via === 'apply-models.mjs') continue;
        if (f.existed) {
          const dest = path.join(backupRoot, ...f.rel.split('/'));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(f.abs, dest);
        }
        atomicWrite(f.abs, f.after);
        written.push(f);
      }
    } catch (e) {
      for (const f of written.reverse()) {
        try {
          if (f.existed) fs.copyFileSync(path.join(backupRoot, ...f.rel.split('/')), f.abs);
          else fs.rmSync(f.abs, { force: true });
        } catch { /* best effort */ }
      }
      throw new HttpError('internal', `Writing failed (${e.code || e.message}). The files were restored.`);
    }

    const warnings = [...cs.warnings];
    const results = [];
    for (const c of cs.commands) {
      const cmd = c.cmd === 'node' ? this.nodeBin : c.cmd;
      const r = await runCommand(cmd, c.args, { cwd: path.join(proj.root, c.cwd === '.' ? '' : c.cwd), timeoutMs: 30_000 });
      const ok = r.code === 0 && !r.error && !r.timedOut;
      results.push({ id: c.id, label: c.label, ok, code: r.code, timedOut: r.timedOut || undefined, output: redact(`${r.stdout}${r.stderr}`.trim()).slice(0, 4000) });
      if (!ok) warnings.push(`${c.label} did not finish cleanly (exit ${r.code ?? r.error}). The files above were written; run \`${c.args.join(' ')}\` in the project once the cause is fixed.`);
    }
    for (const f of cs.files.filter((x) => x.via === 'apply-models.mjs')) {
      let now = null;
      try { now = fs.readFileSync(f.abs, 'utf8'); } catch { /* missing */ }
      if (now !== f.after) warnings.push(`${f.rel} is not what the preview predicted. Check it.`);
    }
    for (const e of cs.effects) { try { this.onEffect(e); } catch { /* usage counters must not fail a write */ } }
    this.sets.delete(cs.id);
    return {
      applied: written.map((f) => f.rel),
      viaScript: cs.files.filter((f) => f.via === 'apply-models.mjs').map((f) => f.rel),
      backup: written.some((f) => f.existed) ? path.relative(this.store.dir, backupRoot).split(path.sep).join('/') : null,
      commands: results,
      warnings,
    };
  }
}
