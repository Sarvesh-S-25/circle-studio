// Advisor: give it any file; the claude CLI says what to keep, what to build and what the issues are.
// Each item can be pinned to a project's plan.
import { api } from '../api.js';
import { h, icon, fmtBytes, statusPill } from '../dom.js';
import { state } from '../state.js';
import { setFileDropHandler } from '../components/dnd.js';
import { toast } from '../components/overlay.js';

export async function mount(el) {
  let source = null; // { type, ... }
  let result = null;
  let pinProject = state.recent[0]?.id || state.projects[0]?.id || '';
  const pinned = new Set();

  const pathInput = h('input', { class: 'cs-input', id: 'adv-path', placeholder: 'C:\\Users\\you\\Desktop\\notes\\plan.md', autocomplete: 'off', spellcheck: 'false' });
  const picked = h('p', { class: 'cs-small cs-soft', role: 'status' });
  const fileInput = h('input', { type: 'file', class: 'cs-sr', id: 'adv-file', tabindex: '-1' });
  const modelSel = h('select', { class: 'cs-select', 'aria-label': 'Model' }, [['', 'Default model'], ['haiku', 'haiku'], ['sonnet', 'sonnet'], ['opus', 'opus']].map(([v, l]) => h('option', { value: v }, l)));
  const errorEl = h('div', { class: 'cs-stack cs-stack--tight', role: 'alert' });
  const out = h('div', { class: 'cs-stack cs-stack--loose' });
  const run = h('button', { class: 'cs-btn cs-btn--primary', type: 'button' }, icon('advisor', 's'), 'Ask the advisor');

  async function takeFile(file) {
    if (file.size > 400 * 1024) { toast('That file is larger than 400 KB.', { kind: 'warn' }); return; }
    const text = await file.text();
    if (text.includes('\u0000')) { toast('Only text files can be reviewed.', { kind: 'warn' }); return; }
    source = { type: 'text', name: file.name, text };
    pathInput.value = '';
    picked.textContent = `Ready: ${file.name} (${fmtBytes(file.size)}). It stays in your browser until you press Ask.`;
  }
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) takeFile(fileInput.files[0]); });
  const offDrop = setFileDropHandler(async (dt) => { const f = dt.files[0]; if (f) await takeFile(f); });
  pathInput.addEventListener('input', () => { source = null; picked.textContent = ''; });

  function pin(kind, item, btn) {
    return async () => {
      if (!pinProject) { toast('Add a project first.', { kind: 'warn' }); return; }
      try {
        const { plan } = await api.plan(pinProject);
        plan.pins.push({ kind, title: item.title, detail: item.detail, phaseId: item.phase || null, done: false, source: { type: 'advisor', file: result.file.name, at: new Date().toISOString() } });
        await api.savePlan(pinProject, plan);
        pinned.add(item.id);
        btn.replaceChildren(icon('pin-filled', 's'), 'Pinned');
        btn.disabled = true;
        toast('Pinned to the plan.', { kind: 'ok', ms: 2500 });
      } catch (e) { toast(e.message, { kind: 'danger' }); }
    };
  }

  function column(title, kind, items, ic) {
    return h('section', { class: 'cs-stack cs-stack--tight', 'aria-label': title }, h('h2', { class: 'cs-h2 cs-row' }, icon(ic, 'm'), `${title} (${items.length})`),
      items.length ? items.map((it) => {
        const btn = h('button', { class: 'cs-btn cs-btn--small', type: 'button', 'aria-label': `Pin "${it.title}" to the plan`, disabled: pinned.has(it.id) || undefined }, icon(pinned.has(it.id) ? 'pin-filled' : 'pin', 's'), pinned.has(it.id) ? 'Pinned' : 'Pin to plan');
        btn.addEventListener('click', pin(kind, it, btn));
        return h('article', { class: 'cs-card cs-stack cs-stack--tight' },
          h('div', { class: 'cs-row cs-row--wrap' }, h('h3', { class: 'cs-h3 cs-grow' }, it.title), it.severity ? statusPill(it.severity === 'high' ? 'danger' : it.severity === 'medium' ? 'warn' : 'info', it.severity) : null, it.phase ? h('span', { class: 'cs-pill cs-pill--quiet' }, it.phase) : null),
          h('p', { class: 'cs-soft' }, it.detail), h('div', {}, btn));
      }) : h('p', { class: 'cs-soft' }, 'Nothing to report here.'));
  }

  function drawResult() {
    out.replaceChildren();
    if (!result) return;
    const projSel = h('select', { class: 'cs-select cs-advisor__pin', id: 'pin-project', 'aria-label': 'Pin to this project\'s plan', onchange: (e) => { pinProject = e.target.value; } },
      state.projects.filter((p) => p.exists).map((p) => h('option', { value: p.id, selected: p.id === pinProject || undefined }, p.name)));
    out.append(
      h('div', { class: 'cs-card cs-stack cs-stack--tight' }, h('div', { class: 'cs-eyebrow' }, `Summary of ${result.file.name}`), h('p', {}, result.summary),
        h('div', { class: 'cs-row cs-row--wrap cs-small cs-soft' }, result.models?.length ? `Answered by ${result.models.join(', ')}` : null, result.ms ? `${(result.ms / 1000).toFixed(0)} s` : null, result.file.masked ? `${result.file.masked} secret-like value(s) were masked before sending` : null)),
      h('div', { class: 'cs-row cs-row--wrap' }, h('label', { class: 'cs-small', for: 'pin-project' }, 'Pins go to the plan of'), projSel),
      h('div', { class: 'cs-cols' }, column('Keep', 'keep', result.keep, 'check'), column('Build', 'build', result.build, 'plus'), column('Issues', 'issue', result.issues, 'warning')));
  }

  async function ask(redact) {
    errorEl.replaceChildren();
    let src = source;
    if (!src) {
      if (!pathInput.value.trim()) { toast('Choose a file first: paste a path, pick one, or drop it here.', { kind: 'warn' }); return; }
      src = { type: 'path', path: pathInput.value.trim() };
    }
    run.disabled = true;
    run.replaceChildren(icon('spinner', 's'), 'Reading it...');
    out.replaceChildren(h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'The advisor is reading the file. This usually takes 20 to 60 seconds.'));
    try {
      result = await api.advise({ source: src, model: modelSel.value || undefined, redact: redact || undefined });
      pinned.clear();
      drawResult();
    } catch (e) {
      out.replaceChildren();
      const box = h('div', { class: 'cs-banner cs-banner--danger' }, icon('danger', 's'), h('div', { class: 'cs-stack cs-stack--tight' }, h('span', {}, e.message)));
      if (e.detail?.secrets) {
        box.lastChild.append(h('ul', { class: 'cs-mono' }, e.detail.secrets.map((s) => h('li', {}, `line ${s.line}: ${s.kind} ${s.preview}`))),
          h('button', { class: 'cs-btn', type: 'button', onclick: () => ask(true) }, icon('shield', 's'), 'Send with those values masked'));
      }
      errorEl.append(box);
    } finally {
      run.disabled = false;
      run.replaceChildren(icon('advisor', 's'), 'Ask the advisor');
    }
  }
  run.addEventListener('click', () => ask(false));
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) { e.preventDefault(); ask(false); } });

  el.append(h('div', { class: 'cs-stack cs-stack--loose' },
    h('div', {}, h('h1', { class: 'cs-h1', id: 'main-title' }, 'Advisor'), h('p', { class: 'cs-soft' }, 'A second opinion on one document: a plan, a brief, a spec, notes, a README. Claude reads it and answers in three lists: what to keep, what to build, and what is wrong (with how serious). Pin any item to a stage of a workflow so it lands in the notes of that stage, where the agents read it. It reads only the file you give it, and masks anything that looks like a secret first.')),
    h('div', { class: 'cs-banner cs-banner--info' }, icon('shield', 's'), 'Sent to Claude through your login. Secret-like values are masked first.'),
    h('div', { class: 'cs-card cs-stack' },
      h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'adv-path' }, 'File path'), pathInput),
      h('div', { class: 'cs-row cs-row--wrap' }, h('label', { class: 'cs-btn', for: 'adv-file' }, icon('upload', 's'), 'Choose a file...'), fileInput, picked),
      h('div', { class: 'cs-row cs-row--wrap' }, modelSel, h('span', { class: 'cs-grow' }), run)),
    errorEl, out));
  return { destroy: offDrop };
}
