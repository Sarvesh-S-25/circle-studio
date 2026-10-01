// "What do you want to create today?": pick a template (or make one), adjust the workflow as a graph, see every file
// that will be written, then create the project. Or register a folder you already have. Nothing outside the new
// project folder is read or written.
import { api } from '../api.js';
import { h, icon, plural } from '../dom.js';
import { refreshProjects, refreshShell, state } from '../state.js';
import { openModal, toast } from './overlay.js';
import { mountGraph } from './graph/index.js';
import { openNodePanel } from './graph/nodepanel.js';
import { renderFile } from './diffreview.js';

export function suggestName(idea) {
  const words = String(idea).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w && !['a', 'an', 'the', 'to', 'for', 'of', 'and', 'that', 'with', 'my', 'i', 'want', 'create', 'build', 'make'].includes(w));
  return words.slice(0, 3).join('-').slice(0, 40).replace(/^-+|-+$/g, '');
}

const blankWorkflow = (name) => ({
  schema: 'circle-workflow/1', name: name || 'My workflow', description: '', version: '1.0.0',
  lanes: { frontend: true, backend: true, contract: true, migrations: false }, flags: { localOnly: true, humanDoesGit: true }, links: [],
  nodes: [
    { id: 'you', kind: 'human', title: 'You', does: 'Decides at every gate.' },
    { id: 'work', kind: 'stage', title: 'Work', gate: { on: true, label: 'You decide' }, needs: [], skills: [], links: [], notes: '' },
  ],
  edges: [{ from: 'you', to: 'work' }],
});

export function openNewProject({ idea = '' } = {}) {
  let mode = 'create';
  let step = 'details';
  const S = { name: suggestName(idea), idea, target: '', templateId: null, blank: false, workflow: null, saveAs: false, saveName: '', templates: null, preview: null };
  let graph = null;
  let panel = null;

  const nameInput = h('input', { class: 'cs-input', id: 'np-name', autocomplete: 'off', spellcheck: 'false', value: S.name, placeholder: 'my-new-project' });
  const ideaInput = h('textarea', { class: 'cs-textarea', id: 'np-idea', rows: 3, placeholder: 'One or two sentences. It becomes the first line of the brief.' }, idea);
  const pathInput = h('input', { class: 'cs-input', id: 'np-path', autocomplete: 'off', spellcheck: 'false', placeholder: 'C:\\Users\\you\\Desktop\\my-project' });
  const error = h('div', { class: 'cs-banner cs-banner--danger', hidden: true, role: 'alert' });
  const body = h('div', { class: 'cs-stack' });
  const showError = (msg) => { error.hidden = false; error.replaceChildren(icon('danger', 's'), h('span', {}, msg)); };
  const primary = h('button', { class: 'cs-btn cs-btn--primary', type: 'button' });
  const back = h('button', { class: 'cs-btn cs-btn--quiet', type: 'button', onclick: () => { leaveStep(); step = { template: 'details', customize: 'template', files: 'customize' }[step]; draw(); } }, 'Back');

  const seg = h('div', { class: 'cs-segmented', role: 'radiogroup', 'aria-label': 'What to do' },
    ['create', 'add'].map((m) => h('button', { class: 'cs-segmented__btn', type: 'button', role: 'radio', 'aria-checked': String(m === mode), dataset: { mode: m }, onclick: () => { mode = m; step = 'details'; draw(); } }, m === 'create' ? 'New project' : 'Add existing folder')));

  const defaultTarget = () => `${(state.health?.projectsRoot || '').replace(/[\\/]+$/, '')}\\${nameInput.value.trim() || 'my-new-project'}`;
  const targetOf = () => S.target || defaultTarget();

  function leaveStep() {
    if (step === 'details') { S.name = nameInput.value.trim(); S.idea = ideaInput.value; }
    if (step === 'customize') { S.workflow = graph?.getWorkflow() || S.workflow; graph?.destroy(); graph = null; panel?.destroy(); panel = null; }
  }

  function detailsStep() {
    const targetText = h('code', { class: 'cs-mono' }, targetOf());
    nameInput.addEventListener('input', () => { targetText.textContent = targetOf(); });
    body.append(
      h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'np-name' }, 'Project name'), nameInput, h('span', { class: 'cs-field__hint' }, 'Lowercase letters, digits and hyphens.')),
      h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'np-idea' }, 'The idea'), ideaInput),
      h('div', { class: 'cs-field' }, h('span', { class: 'cs-field__label' }, 'Where it goes'), h('div', { class: 'cs-row cs-row--wrap' }, targetText,
        h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: async () => {
          try { const r = await api.pickFolder(); if (r.path) { S.target = `${r.path.replace(/[\\/]+$/, '')}\\${nameInput.value.trim() || 'my-new-project'}`; targetText.textContent = S.target; } } catch (e) { showError(e.message); }
        } }, icon('folder', 's'), 'Choose a folder...')),
      h('span', { class: 'cs-field__hint' }, 'A new folder of its own is created here. Nothing else is touched.')));
    primary.textContent = 'Next: choose a template';
  }

  async function templateStep() {
    if (!S.templates) { try { S.templates = (await api.templates()).templates; } catch (e) { showError(e.message); S.templates = []; } }
    const grid = h('div', { class: 'cs-tplgrid', role: 'group', 'aria-label': 'Templates' });
    const pick = (id, blank) => { S.templateId = id; S.blank = blank; S.workflow = null; drawGrid(); };
    function drawGrid() {
      grid.replaceChildren(
        ...S.templates.map((t) => h('button', { class: 'cs-tpl', type: 'button', 'aria-pressed': String(S.templateId === t.id && !S.blank), onclick: () => pick(t.id, false) },
          h('strong', {}, t.name), h('span', { class: 'cs-soft cs-small' }, t.description || 'No description'), h('span', { class: 'cs-soft cs-small' }, `v${t.head} · ${plural(t.stages, 'stage')} · ${plural(t.agents, 'agent')}${t.engines?.length ? ` · ${t.engines.join(', ')}` : ''}`))),
        h('button', { class: 'cs-tpl', type: 'button', 'aria-pressed': String(S.blank), onclick: () => pick(null, true) }, h('strong', {}, 'Blank'), h('span', { class: 'cs-soft cs-small' }, 'Start from you and one stage, and build it yourself.')));
    }
    drawGrid();
    const importPath = h('input', { class: 'cs-input', placeholder: 'C:\\path\\to\\workflow.json (or a folder that holds one)', 'aria-label': 'Path of a workflow.json' });
    const importJson = h('textarea', { class: 'cs-textarea', rows: 3, placeholder: 'Or paste the JSON here', 'aria-label': 'Workflow JSON' });
    const importBtn = h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: async () => {
      error.hidden = true;
      try {
        const r = await api.importTemplate(importPath.value.trim() ? { path: importPath.value.trim() } : { json: importJson.value });
        const t = r.template || r;
        S.templates = (await api.templates()).templates;
        pick(t.id, false);
        toast(`Imported "${t.name}" as a template.`, { kind: 'ok' });
      } catch (e) { showError(e.message); }
    } }, 'Import');
    body.append(
      h('p', { class: 'cs-soft' }, 'A template is a workflow you made or imported: its stages, gates, agents and the engine each one uses. You can change everything in the next step.'), grid,
      h('details', {}, h('summary', { class: 'cs-small cs-soft' }, 'Import a workflow.json'), h('div', { class: 'cs-stack cs-stack--tight' }, importPath, importJson, h('div', {}, importBtn))));
    primary.textContent = 'Next: adjust the workflow';
  }

  async function customizeStep() {
    if (!S.workflow) {
      if (S.blank) S.workflow = blankWorkflow(S.name);
      else if (S.templateId) { try { S.workflow = (await api.template(S.templateId)).workflow; } catch (e) { showError(e.message); return; } }
    }
    const graphHost = h('div');
    const side = h('div', { class: 'cs-newproj__side' });
    body.append(h('p', { class: 'cs-soft' }, 'Click a node to change its engine, model, skills or gate. Add stages and agents, drag to connect. Nothing is saved anywhere until you create the project.'),
      h('div', { class: 'cs-newproj' }, graphHost, side));
    graph = mountGraph(graphHost, {
      workflow: S.workflow, mode: 'edit', modes: ['edit'],
      onChange: (wf) => { S.workflow = wf; },
      onOpenNode: (n) => { panel?.destroy(); panel = n ? openNodePanel(side, { node: graph.getWorkflow().nodes.find((x) => x.id === n.id), workflow: () => graph.getWorkflow(), graph, project: null }) : null; },
    });
    const saveName = h('input', { class: 'cs-input', placeholder: 'Template name', value: S.saveName || S.workflow.name || '', 'aria-label': 'Template name', disabled: !S.saveAs || undefined, oninput: (e) => { S.saveName = e.target.value; } });
    body.append(h('div', { class: 'cs-row cs-row--wrap' }, h('label', { class: 'cs-switch' }, h('input', { class: 'cs-switch__input', type: 'checkbox', checked: S.saveAs || undefined, onchange: (e) => { S.saveAs = e.target.checked; saveName.disabled = !S.saveAs; if (S.saveAs && !S.saveName) S.saveName = saveName.value; } }), h('span', { class: 'cs-switch__track' }), h('span', {}, 'Also keep this as a template for next time')), saveName));
    primary.textContent = 'Next: see the files';
  }

  async function filesStep() {
    S.preview = null;
    try {
      S.preview = await api.createProject({ name: S.name, idea: S.idea, ...(S.templateId ? { templateId: S.templateId } : {}), workflow: S.workflow, folder: S.target || undefined, confirm: false });
    } catch (e) { showError(e.detail?.output ? `${e.message}\n${e.detail.output}` : e.message); step = 'details'; draw(); return; }
    body.append(
      h('p', {}, `Creating the project writes ${plural(S.preview.files.length, 'file')} into a new folder:`), h('div', { class: 'cs-cmd', tabindex: 0 }, S.preview.target),
      ...(S.preview.warnings || []).map((w) => h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, w))),
      h('div', { class: 'cs-files' }, S.preview.files.map(renderFile)),
      h('p', { class: 'cs-soft cs-small' }, 'No git command is run and no script is copied. You do git yourself.'));
    primary.textContent = 'Create project';
  }

  async function draw() {
    error.hidden = true;
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    body.replaceChildren(seg, error);
    back.hidden = mode === 'add' || step === 'details';
    if (mode === 'add') {
      body.append(h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'np-path' }, 'Folder path'), pathInput,
        h('span', { class: 'cs-field__hint' }, 'A browser cannot tell an app where a folder lives, so paste the full path. Nothing in the folder is changed by adding it.')));
      primary.textContent = 'Add project';
      return;
    }
    ctrl.el.classList.toggle('cs-modal--xl', step === 'customize');
    if (step === 'details') detailsStep();
    else if (step === 'template') await templateStep();
    else if (step === 'customize') await customizeStep();
    else await filesStep();
  }

  const ctrl = openModal({
    title: 'What do you want to create today?', body, size: 'wide',
    actions: [{ label: 'Cancel', kind: 'quiet', onClick: (c) => c.close(null) }],
    initialFocus: '#np-name',
    onClose: () => { graph?.destroy(); panel?.destroy(); },
  });
  const foot = ctrl.el.querySelector('.cs-modal__foot');
  foot.append(back, primary);

  primary.addEventListener('click', async () => {
    error.hidden = true;
    primary.disabled = true;
    ctrl.setBusy(true);
    try {
      if (mode === 'add') {
        const r = await api.addProject(pathInput.value);
        await Promise.all([refreshProjects(), refreshShell()]);
        ctrl.close(r.project);
        location.hash = `#/projects/${r.project.id}/workflow`;
      } else if (step === 'details') {
        leaveStep();
        if (!S.name) { showError('Give the project a name.'); return; }
        step = 'template';
        await draw();
      } else if (step === 'template') {
        if (!S.templateId && !S.blank) { showError('Pick a template, or Blank.'); return; }
        step = 'customize';
        await draw();
      } else if (step === 'customize') {
        leaveStep();
        step = 'files';
        await draw();
      } else {
        primary.textContent = 'Creating...';
        const r = await api.createProject({ name: S.name, idea: S.idea, ...(S.templateId ? { templateId: S.templateId } : {}), workflow: S.workflow, folder: S.target || undefined, confirm: true });
        if (S.saveAs && S.saveName.trim()) { try { await api.createTemplate({ name: S.saveName.trim(), workflow: S.workflow }); } catch (e) { toast(`The project was created, but the template was not saved: ${e.message}`, { kind: 'warn', ms: 8000 }); } }
        await Promise.all([refreshProjects(), refreshShell()]);
        toast(`Created ${r.project.name}.`, { kind: 'ok' });
        ctrl.close(r.project);
        location.hash = `#/projects/${r.project.id}/workflow`;
      }
    } catch (e) {
      showError(e.detail?.output ? `${e.message}\n${e.detail.output}` : e.message);
    } finally {
      ctrl.setBusy(false);
      primary.disabled = false;
    }
  });
  draw();
  ctrl.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input') && !primary.disabled) { e.preventDefault(); primary.click(); } });
  return ctrl;
}
