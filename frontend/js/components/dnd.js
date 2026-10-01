// Drag and drop between skills, agents, projects and plan phases; plus dropping files on the window.
// Every drag has a keyboard path: focus the item and press A (or use its menu).
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { state, refreshSkills, refreshShell } from '../state.js';
import { openMenu, toast } from './overlay.js';
import { reviewChanges } from './diffreview.js';

export const SKILL_TYPE = 'application/x-circle-skill';
export const AGENT_TYPE = 'application/x-circle-agent';
export const PHASE_TYPE = 'application/x-circle-phase';

export function dragSource(el, type, payload) {
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData(type, JSON.stringify(payload));
    e.dataTransfer.setData('text/plain', payload.name || payload.role || '');
    e.dataTransfer.effectAllowed = 'copyMove';
    el.setAttribute('data-dragging', 'true');
  });
  el.addEventListener('dragend', () => el.removeAttribute('data-dragging'));
  return el;
}

/** Make `el` accept drops of the given types. `onDrop(payload, type, event)`; `dropClass` is toggled while a drag is over it. */
export function dropTarget(el, types, onDrop, dropClass = 'cs-list__item--drop') {
  const accepts = (e) => types.some((t) => e.dataTransfer?.types?.includes(t));
  let depth = 0;
  el.addEventListener('dragenter', (e) => { if (!accepts(e)) return; e.preventDefault(); depth++; el.classList.add(dropClass); });
  el.addEventListener('dragover', (e) => { if (!accepts(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove(dropClass); });
  el.addEventListener('drop', (e) => {
    const type = types.find((t) => e.dataTransfer?.types?.includes(t));
    depth = 0;
    el.classList.remove(dropClass);
    if (!type) return;
    e.preventDefault();
    e.stopPropagation();
    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData(type)); } catch { return; }
    onDrop(payload, type, e);
  });
  return el;
}

/** Install a library skill into a project through the diff review. */
export async function installSkill(projectId, name, engines) {
  const chosen = engines || (await chooseSkillEngines(projectId, name));
  if (!chosen) return null;
  const r = await reviewChanges({ projectId, ops: [{ op: 'skill-install', name, engines: chosen }], title: `Install "${name}"`, applyLabel: 'Install skill' });
  if (r) { refreshSkills().catch(() => {}); refreshShell().catch(() => {}); }
  return r;
}

const SKILL_DIR = { claude: '.claude/skills', codex: '.agents/skills', copilot: '.agents/skills', gemini: '.gemini/skills' };

/** Ask which engines a skill is installed for. Each engine's own folder is shown, so nothing is a surprise. */
export function chooseSkillEngines(projectId, name) {
  return new Promise(async (resolve) => {
    const skill = state.skills.find((s) => s.name === name);
    const allowed = new Set(skill?.partition && skill.partition !== 'shared' ? [skill.partition] : skill?.engines || ['claude', 'codex', 'gemini', 'copilot']);
    let used = ['claude'];
    try {
      const wf = (await api.workflow(projectId)).workflow;
      const e = [...new Set(wf.nodes.map((n) => n.engine).filter(Boolean))];
      if (e.length) used = e;
    } catch { /* a project without a workflow: Claude */ }
    const boxes = ['claude', 'codex', 'gemini', 'copilot'].map((id) => {
      const ok = allowed.has(id);
      const cb = h('input', { type: 'checkbox', value: id, checked: (ok && used.includes(id)) || undefined, disabled: !ok || undefined });
      const label = state.engines.find((x) => x.id === id)?.label || id;
      return h('label', { class: 'cs-radio' }, cb, h('span', {}, h('strong', {}, label), h('span', { class: 'cs-soft' }, ` ${SKILL_DIR[id]}/${name}/${ok ? '' : ' (this skill is not for it)'}${id === 'gemini' ? ' (folder not verified)' : ''}`)));
    });
    const ctrl = openModal({
      title: `Install "${name}" for which engines?`, size: 'narrow',
      body: h('div', { class: 'cs-stack' }, h('p', { class: 'cs-soft' }, 'Each engine reads skills from its own folder. Codex and Copilot share one. You see every file before it is written.'), h('div', { class: 'cs-stack cs-stack--tight' }, boxes)),
      actions: [{ label: 'Cancel', kind: 'quiet', onClick: (c) => c.close(null) }, { label: 'Show the files', kind: 'primary', onClick: (c) => {
        const picked = [...boxes.map((b) => b.querySelector('input'))].filter((i) => i.checked).map((i) => i.value);
        if (!picked.length) { toast('Pick at least one engine.', { kind: 'warn' }); return; }
        c.close(picked);
      } }],
      onClose: (r) => resolve(Array.isArray(r) ? r : null),
    });
    void ctrl;
  });
}

/** Install an agent from the template or another project. */
export async function installAgent(projectId, role, from) {
  const r = await reviewChanges({ projectId, ops: [{ op: 'agent-install', role, from }], title: `Add the ${role} agent`, applyLabel: 'Add agent' });
  if (r) refreshShell().catch(() => {});
  return r;
}

/** Keyboard/menu path for "install this into a project": pick a project, then the diff review. */
export function chooseProject(anchor, label, onPick) {
  const projects = state.projects.filter((p) => p.exists);
  if (!projects.length) { toast('Add a project first.', { kind: 'info' }); return; }
  openMenu({
    anchor,
    label,
    items: [{ group: label }, ...projects.map((p) => ({ label: p.name, icon: 'project', onSelect: () => onPick(p) }))],
  });
}

/** Press A on a focused draggable item to open the project picker. */
export function addKeyboardPath(el, describe, onPick) {
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !e.altKey && e.target === el) {
      e.preventDefault();
      chooseProject(el, describe, onPick);
    }
  });
}

/* ---- dropping files on the window ---------------------------------------------------------------- */
const LIMITS = { files: 300, fileBytes: 1024 * 1024, totalBytes: 10 * 1024 * 1024 };
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'dist', 'build']);
let pageHandler = null;

/** A view may take over file drops (the advisor does). Returns a function that removes the handler. */
export function setFileDropHandler(fn) {
  pageHandler = fn;
  return () => { if (pageHandler === fn) pageHandler = null; };
}

function readEntry(entry, path, out, stats) {
  return new Promise((resolve) => {
    if (stats.count >= LIMITS.files) { stats.skipped.push(`${path}${entry.name} (over ${LIMITS.files} files)`); resolve(); return; }
    if (entry.isFile) {
      entry.file(async (file) => {
        if (file.size > LIMITS.fileBytes) stats.skipped.push(`${path}${entry.name} (over 1 MB)`);
        else if (stats.bytes + file.size > LIMITS.totalBytes) stats.skipped.push(`${path}${entry.name} (over 10 MB in total)`);
        else {
          stats.count++;
          stats.bytes += file.size;
          out.push({ path: `${path}${entry.name}`, file });
        }
        resolve();
      }, () => resolve());
    } else if (entry.isDirectory) {
      if (SKIP_DIRS.has(entry.name)) { resolve(); return; }
      const reader = entry.createReader();
      const all = [];
      const pull = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const child of all) await readEntry(child, `${path}${entry.name}/`, out, stats);
          resolve();
        } else { all.push(...batch); pull(); }
      }, () => resolve());
      pull();
    } else resolve();
  });
}

/** Read everything in a drop into [{ path, file }] honouring the limits. */
export async function collectDropped(dataTransfer) {
  const out = [];
  const stats = { count: 0, bytes: 0, skipped: [] };
  const items = [...(dataTransfer.items || [])].filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) for (const e of entries) await readEntry(e, '', out, stats);
  else for (const f of dataTransfer.files || []) out.push({ path: f.name, file: f });
  return { files: out, skipped: stats.skipped };
}

const toBase64 = async (file) => {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
};

async function importDropped(dt) {
  const { files, skipped } = await collectDropped(dt);
  if (!files.length) { toast('Nothing readable was dropped.', { kind: 'warn' }); return; }
  toast(`Reading ${files.length} file${files.length === 1 ? '' : 's'}...`, { ms: 2000 });
  const payload = [];
  for (const f of files) payload.push({ path: f.path, encoding: 'base64', data: await toBase64(f.file) });
  try {
    const r = await api.importFiles({ files: payload });
    if (r.imported.length) toast(`Imported ${r.imported.join(', ')} into the library.`, { kind: 'ok' });
    if (r.conflicts.length) toast(`Already in the library: ${r.conflicts.map((c) => c.key).join(', ')}. Open the library to replace or rename.`, { kind: 'warn', ms: 9000 });
    if (r.skipped.length) toast(`Skipped: ${r.skipped.map((s) => `${s.dir} (${s.reason})`).join('; ')}`, { kind: 'warn', ms: 9000 });
    if (r.hint && !r.imported.length) toast(r.hint, { kind: 'info', ms: 9000 });
    if (skipped.length) toast(`Not read: ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? '...' : ''}`, { kind: 'warn', ms: 9000 });
    if (r.imported.length) { await refreshSkills(); if (location.hash !== '#/library') location.hash = '#/library'; }
  } catch (e) {
    toast(e.message, { kind: 'danger', ms: 9000 });
  }
}

export function initWindowDrop() {
  let overlay = null;
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
  const show = () => {
    if (overlay) return;
    overlay = h('div', { class: 'cs-drop', role: 'presentation' }, h('div', { class: 'cs-drop__box' }, icon('download', 'l'), pageHandler ? 'Drop the file to review it' : 'Drop a folder or .md to import'));
    document.getElementById('overlays').append(overlay);
  };
  const hide = () => { overlay?.remove(); overlay = null; depth = 0; };
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; show(); });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hide(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    if (pageHandler) await pageHandler(e.dataTransfer);
    else await importDropped(e.dataTransfer);
  });
  window.addEventListener('dragend', hide);
}
