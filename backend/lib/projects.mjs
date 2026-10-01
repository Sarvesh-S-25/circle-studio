// The registry of projects the human works on, and where a new project's files may go.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { badRequest, conflict, forbidden, notFound, HttpError } from './errors.mjs';
import { ID_RE, resolveInside } from './paths.mjs';
import { isTeamProject } from './team.mjs';

const FILE = 'registry.json';

/** What the human allowed Circle Studio to do in a project folder. Reading is implied by adding it. */
export const PERMISSION_KEYS = ['write', 'run', 'claude'];
export const normalizePermissions = (p) => Object.fromEntries(PERMISSION_KEYS.map((k) => [k, p?.[k] === true]));

function slugId(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  return s || 'project';
}

export class Projects {
  constructor({ store, config }) {
    this.store = store;
    this.config = config;
  }

  #read() {
    const reg = this.store.readJson(FILE, { version: 1, projects: [] });
    if (!Array.isArray(reg.projects)) reg.projects = [];
    reg.projects = reg.projects.filter((p) => p && ID_RE.test(p.id) && typeof p.path === 'string');
    return reg;
  }

  summary(rec) {
    let exists = false;
    try { exists = fs.statSync(rec.path).isDirectory(); } catch { /* missing */ }
    return {
      id: rec.id,
      name: rec.name,
      path: rec.path,
      exists,
      isTeamProject: exists && isTeamProject(rec.path),
      permissions: normalizePermissions(rec.permissions),
      addedAt: rec.addedAt,
      lastOpenedAt: rec.lastOpenedAt,
    };
  }

  list() {
    return this.#read().projects
      .slice()
      .sort((a, b) => String(b.lastOpenedAt || b.addedAt).localeCompare(String(a.lastOpenedAt || a.addedAt)))
      .map((p) => this.summary(p));
  }

  get(id) {
    const rec = this.#read().projects.find((p) => p.id === id);
    if (!rec) throw notFound(`No project "${id}".`);
    return this.summary(rec);
  }

  /** Resolve a project to its folder, checking the permissions the caller needs. */
  resolve(id, { write = false, need } = {}) {
    const p = this.get(id);
    if (!p.exists) throw notFound(`The folder for "${p.name}" no longer exists: ${p.path}`);
    const label = { write: 'change files in', claude: 'send text to an engine from' };
    for (const k of [write ? 'write' : null, need].filter(Boolean)) {
      if (!p.permissions[k]) throw forbidden(`You have not allowed Circle Studio to ${label[k] || k} "${p.name}". Turn it on under Permissions.`, { permission: k });
    }
    return { id: p.id, root: p.path, name: p.name, permissions: p.permissions };
  }

  /** Root of a registered project (the source of an agent to copy). */
  resolveRoot(from) {
    return this.resolve(from).root;
  }

  add(inputPath, permissions) {
    if (typeof inputPath !== 'string' || inputPath.trim() === '' || inputPath.includes('\0')) throw badRequest('Give the full path of the project folder.');
    const p = inputPath.trim().replace(/^"(.*)"$/, '$1');
    if (!path.isAbsolute(p)) throw badRequest('The path must be absolute, for example C:\\Users\\you\\Desktop\\my-project.');
    let real;
    try {
      real = fs.realpathSync(p);
      if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
    } catch {
      throw badRequest('That folder does not exist.');
    }
    return this.store.serial(FILE, () => this.#addLocked(real, permissions));
  }

  #addLocked(real, permissions) {
    const reg = this.#read();
    const existing = reg.projects.find((x) => path.resolve(x.path).toLowerCase() === path.resolve(real).toLowerCase());
    const now = new Date().toISOString();
    if (existing) {
      existing.lastOpenedAt = now;
      if (permissions) existing.permissions = normalizePermissions(permissions);
      this.store.writeJson(FILE, reg);
      return this.summary(existing);
    }
    const name = path.basename(real);
    let id = slugId(name);
    for (let n = 2; reg.projects.some((x) => x.id === id); n++) id = `${slugId(name).slice(0, 26)}_${n}`;
    const rec = { id, name, path: real, permissions: normalizePermissions(permissions), addedAt: now, lastOpenedAt: now };
    reg.projects.push(rec);
    this.store.writeJson(FILE, reg);
    return this.summary(rec);
  }

  setPermissions(id, permissions) {
    return this.store.serial(FILE, () => {
      const reg = this.#read();
      const rec = reg.projects.find((p) => p.id === id);
      if (!rec) throw notFound(`No project "${id}".`);
      rec.permissions = normalizePermissions(permissions);
      this.store.writeJson(FILE, reg);
      return this.summary(rec);
    });
  }

  remove(id) {
    return this.store.serial(FILE, () => {
      const reg = this.#read();
      const before = reg.projects.length;
      reg.projects = reg.projects.filter((p) => p.id !== id);
      if (reg.projects.length === before) throw notFound(`No project "${id}".`);
      this.store.writeJson(FILE, reg);
    });
  }

  touch(id) {
    return this.store.serial(FILE, () => {
      const reg = this.#read();
      const rec = reg.projects.find((p) => p.id === id);
      if (rec) { rec.lastOpenedAt = new Date().toISOString(); this.store.writeJson(FILE, reg); }
    });
  }
}

/* ---- a new project's folder ------------------------------------------------------------------------------- */

const NAME_OK = /^[a-z0-9][a-z0-9-]{1,40}$/;
const sameFolder = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Where a new project goes: `folder` when given, else <projectsRoot>/<name>. It must not exist or be empty, its
 * parent must exist, and it must be a real folder on this PC, not the app's own, not a drive root, not the home folder.
 */
export function newProjectFolder(config, name, folder) {
  if (typeof name !== 'string' || !NAME_OK.test(name)) throw badRequest('Use 2 to 41 characters: lowercase letters, digits and hyphens, starting with a letter or digit.');
  let target = path.join(config.projectsRoot, name);
  if (folder !== undefined && folder !== null && folder !== '') {
    if (typeof folder !== 'string' || folder.includes('\0')) throw badRequest('Give the full path of the new project folder.');
    target = folder.trim().replace(/^"(.*)"$/, '$1');
    const local = process.platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(target) : path.isAbsolute(target) && !target.startsWith('//');
    if (!local) throw badRequest('The folder must be an absolute path on this PC, for example C:\\Users\\you\\Desktop\\my-project.');
  }
  target = path.resolve(target);
  const inside = (root) => sameFolder(target, root) || target.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep);
  if (path.parse(target).root === target || sameFolder(target, os.homedir()) || inside(config.appRoot) || inside(config.dataDir)) {
    throw badRequest('That folder cannot hold a project. Pick a new folder of its own.');
  }
  if (!fs.existsSync(path.dirname(target)) || !fs.statSync(path.dirname(target)).isDirectory()) throw badRequest(`The folder ${path.dirname(target)} does not exist. Create it first, or pick another place.`);
  if (fs.existsSync(target)) {
    if (!fs.lstatSync(target).isDirectory()) throw badRequest('That path is a file or a link, not a plain folder.');
    const entries = fs.readdirSync(target).length;
    if (entries) throw conflict(`${target} is not empty (${entries} entries). Pick a new folder, or use "Add project" to register it.`);
  }
  return target;
}

/** Write the rendered files ([{ path, content }]) into `target`. All or nothing: a failure removes what was written. */
export function writeNewProject(target, files) {
  const existed = fs.existsSync(target);
  try {
    if (!existed) fs.mkdirSync(target);
    else if (fs.readdirSync(target).length) throw conflict(`${target} is not empty any more. Nothing was written.`);
    for (const f of files) {
      const abs = resolveInside(target, f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content, { flag: 'wx' });
    }
  } catch (e) {
    if (existed) for (const entry of fs.readdirSync(target)) fs.rmSync(path.join(target, entry), { recursive: true, force: true });
    else fs.rmSync(target, { recursive: true, force: true });
    if (e instanceof HttpError) throw e;
    throw new HttpError('internal', `Writing the project failed (${e.code || e.message}). Nothing was kept.`);
  }
}
