// Where workflows live and how they get their versions. Templates are the human's own workflows under
// data/templates; each project's workflow is a copy under data/workflows. Nothing here reads a folder
// outside the app, except the one file a template import names.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { badRequest, forbidden, notFound, tooLarge } from './errors.mjs';
import { ID_RE, isSensitiveName, toPosix } from './paths.mjs';
import { scanSecrets } from './secrets.mjs';
import { atomicWrite } from './textfile.mjs';
import { normalizeWorkflow, blankWorkflow, planToWorkflow, stagesOf, agentsOf } from './workflow.mjs';
import { startHistory, appendVersion, restoreVersion, describeVersions } from './semver.mjs';
import { discoverWorkflow, isUntouchedTemplateCopy } from './discover.mjs';

export const SEED_ID = 'staged_build_team';
export const IMPORT_MAX_BYTES = 1024 * 1024;
const DIR = 'templates';
const MARKER = `${DIR}/.seeded`;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const now = () => new Date().toISOString();

/**
 * Read the ONE file an import names: a single .json file, or a folder's workflow.json. Nothing else is opened,
 * links are not followed, and the size is capped. Returns the text.
 */
export function readImportFile(input) {
  if (typeof input !== 'string' || input.trim() === '' || input.includes('\0')) throw badRequest('Give the full path of a .json file, or of a folder that holds workflow.json.');
  const p = input.trim().replace(/^"(.*)"$/, '$1');
  const local = process.platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(p) : p.startsWith('/') && !p.startsWith('//');
  if (!local) throw badRequest('The path must be absolute and on this PC, for example C:\\Users\\you\\flows\\workflow.json.');
  const inspect = (target) => {
    let st;
    try { st = fs.lstatSync(target); } catch { throw notFound('That path does not exist.'); }
    if (st.isSymbolicLink()) throw badRequest('Links are not followed. Give the real path.');
    return st;
  };
  let file = p;
  const st = inspect(p);
  if (st.isDirectory()) {
    file = path.join(p, 'workflow.json');
    if (!fs.existsSync(file)) throw notFound('That folder has no workflow.json.');
    inspect(file);
  } else if (!st.isFile()) throw badRequest('That is not a file or a folder.');
  if (path.extname(file).toLowerCase() !== '.json') throw badRequest('Only a .json file can be imported.');
  if (isSensitiveName(toPosix(file))) throw forbidden('That file may hold secrets and is not read.');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw badRequest('That is not a file.');
    if (opened.size > IMPORT_MAX_BYTES) throw tooLarge('The file is larger than 1 MB.');
    const buf = Buffer.alloc(opened.size);
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** JSON text from outside (a file or a paste) to a normalised workflow. Never repeats what the text says. */
export function parseWorkflowText(raw) {
  if (typeof raw !== 'string' || raw.length > IMPORT_MAX_BYTES) throw tooLarge('The workflow is larger than 1 MB.');
  let parsed;
  try { parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { throw badRequest('That is not valid JSON.'); }
  if (scanSecrets(raw).length) throw badRequest('This workflow contains something that looks like a secret (a key or token). Nothing was imported. Remove it and try again.');
  return normalizeWorkflow(parsed);
}

export const headWorkflow = (record) => record.versions.find((v) => v.version === record.head).workflow;

/** What the browser gets for any workflow record: the head, its graph and every version with its distance from the head. */
export function historyView(record) {
  return { head: record.head, workflow: headWorkflow(record), versions: describeVersions(record) };
}

function usable(record) {
  return isObj(record) && typeof record.id === 'string' && Array.isArray(record.versions) && record.versions.length > 0
    && record.versions.every((v) => isObj(v) && isObj(v.workflow)) && record.versions.some((v) => v.version === record.head);
}

export class Templates {
  constructor({ store, seedFile }) {
    this.store = store;
    this.seedFile = seedFile;
    this.dir = store.abs(DIR);
    this.#seedOnce();
  }

  /** The bundled template is copied in once. A marker file remembers it, so deleting it keeps it deleted. */
  #seedOnce() {
    if (fs.existsSync(this.store.abs(MARKER))) return;
    let workflow;
    try { workflow = this.seedWorkflow(); } catch (e) {
      console.error(`The bundled template could not be read (${e.message}); it will be tried again next start.`);
      return;
    }
    const at = now();
    this.store.writeJson(`${DIR}/${SEED_ID}.json`, { id: SEED_ID, name: workflow.name, description: workflow.description, createdAt: at, updatedAt: at, builtin: true, ...startHistory(workflow, { note: 'Bundled template', at }) });
    atomicWrite(this.store.abs(MARKER), `${at}\n`);
  }

  seedWorkflow() {
    return normalizeWorkflow(JSON.parse(fs.readFileSync(this.seedFile, 'utf8')));
  }

  #load(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw notFound('No such template.');
    const record = this.store.readJson(`${DIR}/${id}.json`, null);
    if (!usable(record) || record.id !== id) throw notFound('No such template.');
    return record;
  }

  #summary(record) {
    const wf = headWorkflow(record);
    const agents = agentsOf(wf);
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      builtin: record.builtin === true,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      head: record.head,
      stages: stagesOf(wf).length,
      agents: agents.length,
      engines: [...new Set(agents.map((a) => a.engine))],
    };
  }

  /** Oldest first, so the bundled one leads. */
  list() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { /* none yet */ }
    const out = [];
    for (const f of files) {
      const record = this.store.readJson(`${DIR}/${f}`, null);
      if (usable(record) && ID_RE.test(record.id) && `${record.id}.json` === f) out.push(this.#summary(record));
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  get(id) {
    const record = this.#load(id);
    return { template: this.#summary(record), ...historyView(record) };
  }

  head(id) {
    return headWorkflow(this.#load(id));
  }

  /** A new template from a workflow (the caller has already resolved blank / another template / a project). */
  create({ workflow, name, description }) {
    const base = normalizeWorkflow(workflow || blankWorkflow());
    const clean = normalizeWorkflow({ ...base, name: name || base.name, description: description ?? base.description });
    const at = now();
    let id;
    do { id = `t_${crypto.randomBytes(4).toString('hex')}`; } while (fs.existsSync(this.store.abs(`${DIR}/${id}.json`)));
    const record = { id, name: clean.name, description: clean.description, createdAt: at, updatedAt: at, builtin: false, ...startHistory(clean, { note: 'Created', at }) };
    this.store.writeJson(`${DIR}/${id}.json`, record);
    return { template: this.#summary(record), ...historyView(record) };
  }

  /** From a path (one .json file or a folder's workflow.json) or from pasted JSON. */
  import({ path: filePath, json, name }) {
    if (filePath !== undefined && json !== undefined) throw badRequest('Give a path or pasted JSON, not both.');
    let raw;
    if (filePath !== undefined) raw = readImportFile(filePath);
    else if (typeof json === 'string') raw = json;
    else if (isObj(json)) raw = JSON.stringify(json);
    else throw badRequest('Give the path of a workflow.json, or paste its JSON.');
    return this.create({ workflow: parseWorkflowText(raw), name: typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : undefined });
  }

  save(id, { workflow, note, bump }) {
    const record = this.#load(id);
    const wf = normalizeWorkflow(workflow);
    const result = appendVersion(record, wf, { note, bump, at: now() });
    const outcome = { unchanged: result.unchanged, level: result.level, version: result.version };
    if (result.unchanged) return { ...outcome, ...this.get(id) };
    const next = { ...result.record, name: wf.name, description: wf.description, updatedAt: now() };
    this.store.writeJson(`${DIR}/${id}.json`, next);
    return { ...outcome, template: this.#summary(next), ...historyView(next) };
  }

  remove(id) {
    this.#load(id);
    fs.rmSync(this.store.abs(`${DIR}/${id}.json`), { force: true });
  }
}

export class Workflows {
  constructor({ store, templates }) {
    this.store = store;
    this.templates = templates;
  }

  #file(id) { return `workflows/${id}.json`; }

  #view(record, project) {
    const view = { templateId: record.templateId ?? null, origin: record.origin ?? (record.templateId ? 'template' : 'saved'), ...historyView(record) };
    // an older Circle Studio copied a template into projects that had none: say so, and offer what the folder really has
    if (project?.path && isUntouchedTemplateCopy(record)) {
      const found = discoverWorkflow(project.path, project.name);
      view.autoTemplate = { templateName: record.versions[0].note.replace(/^Started from the template "?|"$/g, ''), folder: { origin: found.origin, note: found.note, workflow: found.workflow } };
    }
    return view;
  }

  #make(project, workflow, templateId, note, origin) {
    const at = now();
    const wf = normalizeWorkflow(workflow);
    return { id: project.id, name: wf.name, description: wf.description, createdAt: at, updatedAt: at, builtin: false, ...(templateId ? { templateId } : {}), ...(origin ? { origin } : {}), ...startHistory(wf, { note, at }) };
  }

  /**
   * The project's record. A project with none gets one now: migrated from the phases of its old plan file when
   * that has any, otherwise from what the folder really has (its workflow.json, else its agent files, else blank).
   * Never a template the human did not choose.
   */
  ensure(project) {
    const saved = this.store.readJson(this.#file(project.id), null);
    if (usable(saved)) return saved;
    const old = this.store.readJson(`plans/${project.id}.json`, null);
    let record;
    if (Array.isArray(old?.phases) && old.phases.length) {
      record = this.#make(project, planToWorkflow(old, this.templates.seedWorkflow()), undefined, 'Migrated from the phases of the old plan', 'plan');
    } else {
      const found = project.path ? discoverWorkflow(project.path, project.name) : { workflow: blankWorkflow(project.name), origin: 'blank', note: 'Blank workflow' };
      record = this.#make(project, found.workflow, undefined, found.note, found.origin);
    }
    this.store.writeJson(this.#file(project.id), record);
    return record;
  }

  /** The first version of a new project's workflow. */
  create(project, { workflow, templateId }) {
    const record = this.#make(project, workflow, templateId, templateId ? 'Created from a template' : 'Created');
    this.store.writeJson(this.#file(project.id), record);
    return record;
  }

  get(project) {
    const record = this.ensure(project);
    return this.#view(record, project);
  }

  head(project) {
    return headWorkflow(this.ensure(project));
  }

  save(project, { workflow, note, bump }) {
    const record = this.ensure(project);
    const wf = normalizeWorkflow(workflow);
    return this.#commit(project, record, appendVersion(record, wf, { note, bump, at: now() }), wf);
  }

  restore(project, version, note) {
    const record = this.ensure(project);
    const result = restoreVersion(record, version, { note, at: now() });
    return this.#commit(project, record, result, headWorkflow(result.record));
  }

  /** Store the record a save or restore produced, and answer with what changed and the new view. */
  #commit(project, record, result, wf) {
    const outcome = { unchanged: result.unchanged, level: result.level, version: result.version };
    if (result.unchanged) return { ...outcome, ...this.#view(record, project) };
    const next = { ...result.record, name: wf.name, description: wf.description, updatedAt: now() };
    this.store.writeJson(this.#file(project.id), next);
    return { ...outcome, ...this.#view(next, project) };
  }

  /** Make the head's lanes and flags match the brief's, saving a patch version only when they differ. */
  syncFlags(project, { lanes, localOnly, humanDoesGit }) {
    const wf = this.head(project);
    const want = { ...wf, lanes: { ...wf.lanes, ...lanes }, flags: { localOnly, humanDoesGit } };
    return this.save(project, { workflow: want, note: 'Lanes or flags changed in the brief' });
  }
}
