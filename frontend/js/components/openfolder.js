// "Which folder should I work on?": choose it (Windows folder dialog or a pasted path), grant permissions, open it.
import { api } from '../api.js';
import { refreshProjects, refreshShell } from '../state.js';
import { askPermissions } from './permissions.js';
import { toast } from './overlay.js';

const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** Ask what Circle Studio may do in `path`, register the folder and open its plan. Returns the project or null. */
export async function openFolder(path) {
  const p = String(path || '').trim().replace(/^"(.*)"$/, '$1');
  if (!p) return null;
  const perms = await askPermissions({ name: baseName(p), path: p });
  if (!perms) return null;
  try {
    const r = await api.addProject(p, perms);
    await Promise.all([refreshProjects(), refreshShell()]);
    location.hash = `#/projects/${r.project.id}/workflow`;
    return r.project;
  } catch (e) {
    toast(e.message, { kind: 'danger', ms: 8000 });
    return null;
  }
}

/** Show the Windows folder dialog, then continue as openFolder. */
export async function browseForFolder() {
  try {
    const r = await api.pickFolder();
    if (r.busy) { toast('A folder dialog is already open.', { kind: 'info' }); return null; }
    if (!r.path) return null;
    return openFolder(r.path);
  } catch (e) {
    toast(e.message, { kind: 'danger' });
    return null;
  }
}
