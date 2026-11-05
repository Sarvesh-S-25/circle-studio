import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { toast, confirmDialog } from '../components/overlay.js';

const STATES = [['planned', 'Planned'], ['working', 'Working'], ['needs-you', 'Needs you'], ['blocked', 'Blocked'], ['review', 'Ready for review'], ['done', 'Done'], ['cancelled', 'Cancelled'], ['superseded', 'Superseded']];

export async function mount(el, { project }) {
  let alive = true;
  let data = await api.progress(project.id);
  const workflow = (await api.workflow(project.id)).workflow;
  let edit = null;
  let filter = '';
  let page = 0;
  const box = h('div', { class: 'cs-stack cs-stack--loose' }); el.append(box);
  function draw() {
    if (!alive) return;
    const tasks = data.tasks.filter((t) => !filter || `${t.title} ${t.owner} ${t.status}`.toLowerCase().includes(filter.toLowerCase()));
    const toggle = h('input', { type: 'checkbox', checked: data.achievementsEnabled || undefined, onchange: async (e) => { try { await api.saveSettings({ achievements: e.target.checked }); data = await api.progress(project.id); draw(); } catch (error) { toast(error.message, { kind: 'danger' }); } } });
    box.replaceChildren(
      h('header', { class: 'cs-row cs-row--between cs-row--wrap' }, h('div', {}, h('h2', { class: 'cs-h2' }, 'Tasks & progress'), h('p', { class: 'cs-soft' }, `${data.summary.done} of ${data.summary.total} required tasks accepted · ${data.summary.cancelled} cancelled or superseded`)), h('button', { class: 'cs-btn cs-btn--primary', onclick: () => { edit = {}; draw(); } }, icon('plus', 's'), 'Add task')),
      h('p', { class: 'cs-soft cs-small' }, 'A task becomes complete after you review it and record its evidence. Agent activity and successful chat turns do not complete tasks automatically.'),
      h('label', { class: 'cs-row' }, toggle, 'Show local achievements'),
      h('div', { class: 'cs-row cs-row--wrap' }, h('button', { class: 'cs-btn cs-btn--small', onclick: () => {
        const url = URL.createObjectURL(new Blob([JSON.stringify({ schema: 'circle-progress/1', ...data }, null, 2)], { type: 'application/json' })); const a = h('a', { href: url, download: `circle-progress-${project.id}.json` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } }, 'Export tasks & achievement evidence'), h('button', { class: 'cs-btn cs-btn--small', onclick: async () => {
        if (!await confirmDialog({ title: 'Reset local achievements?', message: 'This starts achievement progress again. Tasks and the acceptance audit remain intact. Previously accepted tasks cannot be replayed to earn awards again.', confirmLabel: 'Reset achievements' })) return;
        try { await api.saveTask(project.id, { action: 'reset-achievements' }); data = await api.progress(project.id); draw(); } catch (error) { toast(error.message, { kind: 'danger' }); }
      } }, 'Reset achievements')),
      data.board?.total ? h('button', { class: 'cs-btn', onclick: async () => { try { const result = await api.saveTask(project.id, { action: 'import-board' }); data = await api.progress(project.id); draw(); toast(`${result.imported} board tasks imported. Completed rows await your review.`, { kind: 'ok' }); } catch (error) { toast(error.message, { kind: 'danger' }); } } }, `Import project board (${data.board.total} rows)`) : null,
      data.board?.dropped?.length ? h('p', { class: 'cs-soft' }, `${data.board.dropped.length} malformed board rows need correction; they were not imported.`) : null,
      data.events?.some((e) => e.type === 'handoff-prepared') ? h('details', { class: 'cs-details' }, h('summary', {}, 'Reviewed handoff drafts'), ...data.events.filter((e) => e.type === 'handoff-prepared').slice(-20).reverse().map((e) => h('article', { class: 'cs-card cs-stack' }, h('strong', {}, e.sourceEngine + ' to ' + e.targetEngine), h('p', { class: 'cs-soft cs-small' }, 'Reviewed draft prepared ' + new Date(e.at).toLocaleString() + '. This is not evidence that another agent executed it.'), h('pre', {}, e.summary)))) : null,
      data.achievementsEnabled ? h('div', { class: 'cs-row cs-row--wrap' }, data.achievements.length ? data.achievements.map((a) => h('span', { class: 'cs-pill cs-pill--info' }, icon('check', 's'), a.title)) : h('p', { class: 'cs-soft' }, 'Achievements appear after accepted work.')) : null,
      h('input', { class: 'cs-input', 'aria-label': 'Find tasks', placeholder: 'Find a task, owner or status', value: filter, onchange: (e) => { filter = e.target.value; page = 0; draw(); } }),
      ...tasks.slice(page * 30, page * 30 + 30).map((t) => h('article', { class: 'cs-card cs-stack cs-stack--tight' }, h('div', { class: 'cs-row cs-row--between' }, h('h3', { class: 'cs-h3' }, t.title), h('button', { class: 'cs-btn cs-btn--small', onclick: () => { edit = t; draw(); } }, 'Edit')), h('p', { class: 'cs-soft' }, `${STATES.find(([s]) => s === t.status)?.[1] || t.status}${t.owner ? ` · ${t.owner}` : ''}${t.engine ? ` · ${t.engine}` : ''}${t.optional ? ' · optional' : ''}`), t.detail ? h('p', {}, t.detail) : null, t.dependencyNotice ? h('p', { class: 'cs-banner cs-banner--info' }, t.dependencyNotice) : null, t.evidence?.length ? h('ul', {}, t.evidence.map((e) => h('li', {}, `${e.kind}: ${e.detail}`, e.reference ? (/^#\/projects\/[A-Za-z0-9_/-]+$/.test(e.reference) || /^https:\/\/[^\s]+$/.test(e.reference) ? h('a', { href: e.reference, target: e.reference.startsWith('https:') ? '_blank' : undefined, rel: 'noopener noreferrer' }, ' Open evidence') : h('span', { class: 'cs-soft' }, ' (' + e.reference + ')')) : null))) : null)),
      !tasks.length ? h('p', { class: 'cs-soft' }, 'No matching tasks. Add the first task for this project.') : null,
      h('div', { class: 'cs-row' }, h('button', { class: 'cs-btn cs-btn--small', disabled: page === 0, onclick: () => { page--; draw(); } }, 'Previous'), h('span', {}, `Page ${page + 1}`), h('button', { class: 'cs-btn cs-btn--small', disabled: (page + 1) * 30 >= tasks.length, onclick: () => { page++; draw(); } }, 'Next')),
      edit ? editor(edit) : null);
  }
  function editor(task) {
    const title = h('input', { class: 'cs-input', value: task.title || '', required: true, maxlength: 200 });
    const detail = h('textarea', { class: 'cs-textarea', rows: 3, value: task.detail || '' });
    const owner = h('input', { class: 'cs-input', value: task.owner || '' });
    const status = h('select', { class: 'cs-select' }, STATES.map(([id, label]) => h('option', { value: id, selected: id === (task.status || 'planned') || undefined }, label)));
    const stage = h('select', { class: 'cs-select' }, h('option', { value: '' }, 'No stage'), (workflow?.nodes || []).filter((n) => n.kind === 'stage').map((n) => h('option', { value: n.id, selected: n.id === task.stageId || undefined }, n.title)));
    const engine = h('select', { class: 'cs-select' }, h('option', { value: '' }, 'No engine'), ['codex', 'claude', 'copilot', 'gemini'].map((id) => h('option', { value: id, selected: id === task.engine || undefined }, id)));
    const evidenceRows = [];
    const evidence = h('div', { class: 'cs-stack' });
    const addEvidence = (value = {}) => {
      if (evidenceRows.filter((r) => !r.removed).length >= 20) return;
      const row = { removed: false };
      row.kind = h('select', { class: 'cs-select', 'aria-label': 'Evidence type' }, ['manual', 'test', 'review', 'file'].map((kind) => h('option', { value: kind, selected: kind === (value.kind || 'manual') || undefined }, kind)));
      row.detail = h('textarea', { class: 'cs-textarea', rows: 2, maxlength: 1000, 'aria-label': 'Evidence result', placeholder: 'What you checked and the actual result', value: value.detail || '' });
      row.reference = h('input', { class: 'cs-input', maxlength: 500, 'aria-label': 'Evidence reference', placeholder: 'Conversation link, HTTPS reference or project file path', value: value.reference || '' });
      row.el = h('div', { class: 'cs-card cs-stack' }, row.kind, row.detail, row.reference, h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => { row.removed = true; row.el.remove(); } }, 'Remove evidence'));
      evidenceRows.push(row); evidence.append(row.el);
    };
    for (const item of task.evidence?.length ? task.evidence : [{}]) addEvidence(item);
    const addEvidenceButton = h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => addEvidence() }, 'Add evidence');
    const reviewed = h('input', { type: 'checkbox', checked: task.reviewed || undefined });
    const optional = h('input', { type: 'checkbox', checked: task.optional || undefined });
    const dependencies = data.tasks.filter((t) => t.id !== task.id).map((t) => ({ task: t, input: h('input', { type: 'checkbox', checked: task.dependencies?.includes(t.id) || undefined }) }));
    const field = (label, control) => h('label', { class: 'cs-field' }, h('span', { class: 'cs-field__label' }, label), control);
    return h('form', { class: 'cs-card cs-stack', onsubmit: async (event) => {
      event.preventDefault();
      try {
        data = await api.saveTask(project.id, { id: task.id, title: title.value, detail: detail.value, owner: owner.value, status: status.value, stageId: stage.value || null, engine: engine.value || null, optional: optional.checked, reviewed: reviewed.checked, dependencies: dependencies.filter((d) => d.input.checked).map((d) => d.task.id), evidence: evidenceRows.filter((r) => !r.removed && r.detail.value.trim()).map((r) => ({ kind: r.kind.value, detail: r.detail.value, reference: r.reference.value })) });
        edit = null; draw(); toast('Task saved.', { kind: 'ok' });
      } catch (error) { toast(error.message, { kind: 'danger' }); }
    } }, h('h3', { class: 'cs-h3' }, task.id ? 'Edit task' : 'New task'), field('Title', title), field('Acceptance criteria and details', detail), field('Owner', owner), field('Status', status), field('Stage', stage), field('Engine', engine), field('Evidence and references', evidence), addEvidenceButton, h('label', { class: 'cs-row' }, optional, 'Optional task'), h('label', { class: 'cs-row' }, reviewed, 'I reviewed this work and accept the evidence'), dependencies.length ? h('details', { class: 'cs-details' }, h('summary', {}, 'Depends on'), ...dependencies.map((d) => h('label', { class: 'cs-row' }, d.input, d.task.title))) : null, h('div', { class: 'cs-row' }, h('button', { class: 'cs-btn cs-btn--primary', type: 'submit' }, 'Save task'), h('button', { class: 'cs-btn', type: 'button', onclick: () => { edit = null; draw(); } }, 'Cancel')));
  }
  draw();
  return { destroy() { alive = false; } };
}
