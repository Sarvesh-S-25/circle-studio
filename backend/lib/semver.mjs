// Semantic versions of a workflow. One version per save, each holding the whole workflow, chained by `parent`.
// patch = property edits only; minor = nodes or edges added; major = nodes or edges removed, `needs` changed
// or the stage order changed. Records look like { head, versions:[{ version, at, note, parent, restoredFrom?, summary, workflow }] }.
import { badRequest, notFound } from './errors.mjs';
import { diffWorkflows } from './workflow.mjs';

export const MAX_VERSIONS = 200;
export const LEVELS = ['patch', 'minor', 'major'];

/** The level a diff calls for, or null when nothing changed. */
export function bumpLevel(diff) {
  if (diff.empty) return null;
  if (diff.nodes.removed.length || diff.edges.removed.length || diff.needsChanged.length || diff.stageOrderChanged) return 'major';
  if (diff.nodes.added.length || diff.edges.added.length) return 'minor';
  return 'patch';
}

/** The counts shown as +added -removed ~changed. */
export function summarize(diff) {
  return {
    added: diff.nodes.added.length + diff.edges.added.length,
    removed: diff.nodes.removed.length + diff.edges.removed.length,
    changed: diff.nodes.changed.length + diff.edges.changed.length + diff.meta.length,
  };
}

export function nextVersion(version, level) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const headOf = (record) => record.versions.find((v) => v.version === record.head);
const clip = (note) => (typeof note === 'string' ? note.trim().slice(0, 500) : '');

/** The first version of a new record. */
export function startHistory(workflow, { note = '', at }) {
  const wf = { ...workflow, version: '1.0.0' };
  const summary = summarize(diffWorkflows({ ...wf, nodes: [], edges: [] }, wf));
  return { head: '1.0.0', versions: [{ version: '1.0.0', at, note: clip(note), parent: null, summary, workflow: wf }] };
}

/**
 * Add `workflow` as the next version. Returns { record, unchanged, level, version }; identical content is not
 * saved again. `bump` forces the level, otherwise it comes from what changed. `restoredFrom` marks a restore.
 */
export function appendVersion(record, workflow, { note = '', bump, at, restoredFrom } = {}) {
  if (bump !== undefined && !LEVELS.includes(bump)) throw badRequest(`bump must be ${LEVELS.join(', ')}.`);
  const head = headOf(record);
  const diff = diffWorkflows(head.workflow, workflow);
  if (diff.empty) return { record, unchanged: true, level: null, version: head.version };
  const level = bump || bumpLevel(diff);
  const version = nextVersion(record.head, level);
  const entry = { version, at, note: clip(note), parent: head.version, ...(restoredFrom ? { restoredFrom } : {}), summary: summarize(diff), workflow: { ...workflow, version } };
  const versions = [...record.versions, entry];
  if (versions.length > MAX_VERSIONS) {
    versions.splice(0, versions.length - MAX_VERSIONS);
    versions[0] = { ...versions[0], parent: null };
  }
  return { record: { ...record, head: version, versions }, unchanged: false, level, version };
}

/** Restore an older version by saving its workflow as a new version. */
export function restoreVersion(record, version, { note, at } = {}) {
  const old = record.versions.find((v) => v.version === version);
  if (!old) throw notFound(`There is no version ${String(version).slice(0, 20)}.`);
  return appendVersion(record, old.workflow, { note: note || `Restored ${version}`, at, restoredFrom: version });
}

/** The versions as the browser sees them: each one with what differs between it and the head. */
export function describeVersions(record) {
  const head = headOf(record).workflow;
  return record.versions.map((v) => {
    const diff = diffWorkflows(v.workflow, head);
    return { ...v, vsHead: { summary: summarize(diff), changes: diff.changes } };
  });
}
