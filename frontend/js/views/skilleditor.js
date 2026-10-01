// Skill editor: SKILL.md source on one side, a preview on the other. Ctrl+Enter or Ctrl+S saves.
import { api } from '../api.js';
import { h, icon, fmtBytes } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { refreshSkills, refreshShell } from '../state.js';
import { toast } from '../components/overlay.js';

const TEMPLATE = (name) => `---\nname: ${name}\ndescription: Say what this skill does and when Claude should use it.\n---\n\n# ${name}\n\nWrite the instructions here.\n`;

export async function mount(el, ctx) {
  const isNew = ctx.params.name === 'new';
  let name = isNew ? '' : ctx.params.name;
  let skill = null;
  if (!isNew) {
    try { skill = (await api.skill(name)).skill; } catch (e) {
      el.append(h('div', { class: 'cs-empty' }, icon('skill', 'l'), h('div', { class: 'cs-empty__title' }, 'No such skill'), h('p', {}, e.message), h('a', { class: 'cs-btn', href: '#/library' }, 'Back to the library')));
      return {};
    }
  }
  const nameInput = h('input', { class: 'cs-input', id: 'sk-name', placeholder: 'my-skill', value: name, disabled: !isNew || undefined, autocomplete: 'off', spellcheck: 'false' });
  const editor = h('textarea', { class: 'cs-textarea cs-textarea--code cs-editor', id: 'sk-text', spellcheck: 'false', 'aria-label': 'SKILL.md' }, skill ? skill.skillMd : '');
  const preview = h('div', { class: 'cs-editor__preview', 'aria-label': 'Preview' });
  const notes = h('div', { class: 'cs-stack cs-stack--tight' });
  const ENGINES = [['claude', 'Claude'], ['codex', 'Codex'], ['copilot', 'Copilot'], ['gemini', 'Gemini']];
  let part = skill?.partition || 'shared';
  const engineBoxes = ENGINES.map(([id, label]) => h('label', { class: 'cs-radio' }, h('input', { type: 'checkbox', value: id, checked: !skill?.engines || skill.engines.includes(id) || undefined }), h('span', {}, label)));
  const partSel = h('select', { class: 'cs-select', id: 'sk-part', 'aria-label': 'Partition', onchange: (e) => { part = e.target.value; } },
    [['shared', 'Shared: every engine that reads skills'], ['claude', 'Claude only'], ['copilot', 'Copilot only'], ['gemini', 'Gemini only (folder not verified)']].map(([v, l]) => h('option', { value: v, selected: part === v || undefined }, l)));
  const status = h('span', { class: 'cs-soft cs-small', role: 'status' });
  let saved = skill ? skill.skillMd : '';

  const drawPreview = () => {
    const t = editor.value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    preview.replaceChildren(renderMarkdown(t || '*Nothing to preview yet.*'));
    status.textContent = editor.value === saved ? (isNew && !saved ? 'Not saved yet' : 'Saved') : 'Unsaved changes';
  };
  editor.addEventListener('input', drawPreview);
  if (isNew) {
    nameInput.addEventListener('input', () => { if (editor.value === '' || editor.value === TEMPLATE(name)) { name = nameInput.value; editor.value = name ? TEMPLATE(name) : ''; drawPreview(); } name = nameInput.value; });
  }

  async function save() {
    const n = (isNew ? nameInput.value : name).trim();
    if (!n) { toast('Give the skill a name first.', { kind: 'warn' }); nameInput.focus(); return; }
    try {
      const engines = engineBoxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
      const r = await api.saveSkill(n, editor.value, { partition: part, engines });
      saved = editor.value;
      notes.replaceChildren(...r.warnings.map((w) => h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), w)));
      await Promise.all([refreshSkills(), refreshShell()]);
      toast(r.created ? `Created ${n}.` : `Saved ${n}.`, { kind: 'ok', ms: 2500 });
      if (isNew) { ctx.navigate(`#/library/${n}`); return; }
      drawPreview();
    } catch (e) {
      notes.replaceChildren(h('div', { class: 'cs-banner cs-banner--danger', role: 'alert' }, icon('danger', 's'), e.message));
    }
  }
  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key.toLowerCase() === 's')) { e.preventDefault(); save(); } };
  editor.addEventListener('keydown', onKey);
  nameInput.addEventListener('keydown', onKey);

  const others = skill ? skill.files.filter((f) => f.path !== 'SKILL.md') : [];
  el.append(h('div', { class: 'cs-stack' },
    h('div', { class: 'cs-row cs-row--wrap cs-row--between' },
      h('div', {}, h('a', { class: 'cs-small', href: '#/library' }, 'Library'), h('h1', { class: 'cs-h1', id: 'main-title' }, isNew ? 'New skill' : skill.name)),
      h('div', { class: 'cs-row' }, status, h('kbd', {}, 'Ctrl+Enter'), h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: save }, icon('check', 's'), 'Save'))),
    isNew ? h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'sk-name' }, 'Name (the folder)'), nameInput, h('span', { class: 'cs-field__hint' }, 'Lowercase letters, digits and single hyphens.')) : null,
    notes,
    h('div', { class: 'cs-card cs-stack cs-stack--tight' }, h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'sk-part' }, 'Partition'), partSel), h('div', { class: 'cs-row cs-row--wrap' }, h('span', { class: 'cs-field__label' }, 'Works with'), engineBoxes)),
    h('div', { class: 'cs-editor__split' },
      h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'sk-text' }, 'SKILL.md'), editor),
      h('div', { class: 'cs-field' }, h('span', { class: 'cs-field__label' }, 'Preview'), preview)),
    others.length ? h('details', {}, h('summary', { class: 'cs-h3' }, `${others.length} other file${others.length === 1 ? '' : 's'} in this skill`), h('ul', { class: 'cs-mono' }, others.map((f) => h('li', {}, `${f.path} (${fmtBytes(f.bytes)})`)))) : null,
    skill?.source?.type === 'github' ? h('p', { class: 'cs-soft cs-small' }, `Imported from ${skill.source.url}${skill.source.path ? ` (${skill.source.path})` : ''}. Editing here changes only your local copy.`) : null));
  if (isNew && !editor.value) editor.placeholder = 'Name the skill above and a starting point appears here.';
  drawPreview();
  return {};
}
