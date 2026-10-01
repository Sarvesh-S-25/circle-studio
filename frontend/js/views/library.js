// Library: your local skills. Import from GitHub, drop a folder, or write your own.
import { api } from '../api.js';
import { h, icon, fmtBytes, plural } from '../dom.js';
import { state, refreshSkills, refreshShell } from '../state.js';
import { SKILL_TYPE, addKeyboardPath, dragSource, installSkill } from '../components/dnd.js';
import { confirmDialog, openMenu, openModal, toast } from '../components/overlay.js';
import { catalogSection } from '../components/catalog.js';

const PARTITIONS = [['all', 'All'], ['shared', 'Shared'], ['claude', 'Claude'], ['copilot', 'Copilot'], ['gemini', 'Gemini']];
const PART_NOTE = { shared: 'For every engine that supports skills', claude: 'Claude only', copilot: 'Copilot only', gemini: 'Gemini only (its skills folder is not verified)' };
let partition = 'all';

function sourceLabel(s) {
  const src = s.source || {};
  if (src.type === 'github') return `GitHub: ${String(src.url || '').replace('https://github.com/', '')}`;
  if (src.type === 'drop') return 'Dropped';
  if (src.type === 'created') return 'Written here';
  return 'Local';
}

export function openGithubImport(onDone) {
  let scan = null;
  const body = h('div', { class: 'cs-stack' });
  const urlInput = h('input', { class: 'cs-input', id: 'gh-url', placeholder: 'https://github.com/anthropics/skills', autocomplete: 'off', spellcheck: 'false' });
  const error = h('div', { class: 'cs-banner cs-banner--danger', hidden: true, role: 'alert' });
  const primary = h('button', { class: 'cs-btn cs-btn--primary', type: 'button' }, 'Find skills');
  const picks = new Set();
  const replace = h('input', { type: 'checkbox' });
  const fail = (e) => { error.hidden = false; error.replaceChildren(icon('danger', 's'), h('span', {}, e.message, e.detail?.resetAt ? ` Try again after ${new Date(e.detail.resetAt).toLocaleTimeString()}.` : '')); };

  function step1() {
    scan = null;
    body.replaceChildren(
      h('p', { class: 'cs-soft' }, 'Paste a public repository URL, or a /tree/<branch>/<folder> URL for one folder. Only github.com is contacted, and nothing you import is ever run.'),
      h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'gh-url' }, 'Repository URL'), urlInput), error);
    primary.textContent = 'Find skills';
  }

  function step2() {
    picks.clear();
    const list = h('div', { class: 'cs-list', role: 'group', 'aria-label': 'Skills found' });
    const count = h('span', { class: 'cs-soft cs-small' });
    const upd = () => { count.textContent = `${picks.size} selected`; primary.disabled = picks.size === 0; primary.textContent = picks.size ? `Import ${plural(picks.size, 'skill')}` : 'Pick skills'; };
    for (const s of scan.skills) {
      const cb = h('input', { type: 'checkbox', id: `pick-${s.key}`, disabled: s.skipped ? true : undefined, onchange: (e) => { if (e.target.checked) picks.add(s.dir); else picks.delete(s.dir); upd(); } });
      list.append(h('label', { class: 'cs-list__item cs-gh__row', for: `pick-${s.key}` }, cb,
        h('span', { class: 'cs-grow' }, h('strong', {}, s.key), s.declaredName ? h('span', { class: 'cs-soft cs-small' }, ` (declared name: ${s.declaredName})`) : null,
          h('div', { class: 'cs-soft cs-small' }, s.skipped ? `Skipped: ${s.skipped}` : s.description || (s.needsWrap ? 'No front matter; it will be wrapped with a name and description.' : 'No description')),
          h('div', { class: 'cs-soft cs-small' }, `${plural(s.files, 'file')}, ${fmtBytes(s.bytes)}`, s.exists ? ' - already in your library' : '')),
        s.exists ? h('span', { class: 'cs-pill cs-pill--warn' }, 'in library') : null));
    }
    const all = h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => { scan.skills.filter((s) => !s.skipped).forEach((s) => { picks.add(s.dir); const c = list.querySelector(`#pick-${s.key}`); if (c) c.checked = true; }); upd(); } }, 'Select all');
    body.replaceChildren(
      h('p', {}, `${plural(scan.skills.length, 'skill')} in ${scan.repo.owner}/${scan.repo.repo}`, h('span', { class: 'cs-soft' }, ` (${scan.repo.ref}${scan.repo.subpath ? `/${scan.repo.subpath}` : ''})`)),
      scan.hint ? h('div', { class: 'cs-banner cs-banner--info' }, icon('info', 's'), scan.hint) : null,
      scan.ignored.links || scan.ignored.submodules ? h('p', { class: 'cs-soft cs-small' }, `Ignored ${scan.ignored.links} symbolic links and ${scan.ignored.submodules} submodules.`) : null,
      h('div', { class: 'cs-row' }, all, count, h('span', { class: 'cs-grow' }), scan.rate.remaining != null ? h('span', { class: 'cs-soft cs-small' }, `GitHub requests left this hour: ${scan.rate.remaining}`) : null),
      list, h('label', { class: 'cs-check' }, replace, 'Replace skills that are already in the library'), error);
    upd();
  }

  const ctrl = openModal({ title: 'Import skills from GitHub', size: 'wide', body, actions: [{ label: 'Close', kind: 'quiet', onClick: (c) => c.close(null) }], initialFocus: '#gh-url' });
  ctrl.el.querySelector('.cs-modal__foot').append(primary);
  primary.addEventListener('click', async () => {
    error.hidden = true;
    primary.disabled = true;
    try {
      if (!scan) {
        primary.textContent = 'Looking...';
        scan = await api.scanRepo(urlInput.value);
        step2();
      } else {
        primary.textContent = 'Downloading...';
        const r = await api.fetchSkills({ url: urlInput.value, ref: scan.repo.ref, picks: [...picks], overwrite: replace.checked });
        await Promise.all([refreshSkills(), refreshShell()]);
        const lines = [];
        if (r.imported.length) lines.push(h('div', { class: 'cs-banner cs-banner--ok' }, icon('check', 's'), `Imported: ${r.imported.join(', ')}`));
        if (r.conflicts.length) lines.push(h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), `Already in the library (tick "replace" to overwrite): ${r.conflicts.map((c) => c.key).join(', ')}`));
        for (const s of r.skipped) lines.push(h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), `${s.dir}: ${s.reason}`));
        body.replaceChildren(...lines);
        primary.remove();
        onDone?.();
      }
    } catch (e) {
      fail(e);
      if (scan) { primary.textContent = 'Import'; primary.disabled = picks.size === 0; } else { primary.textContent = 'Find skills'; primary.disabled = false; }
    }
  });
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !scan) { e.preventDefault(); primary.click(); } });
  step1();
  return ctrl;
}

export async function mount(el, ctx) {
  await refreshSkills();
  const grid = h('div', { class: 'cs-grid' });
  const search = h('input', { class: 'cs-input cs-library__search', type: 'search', placeholder: 'Search skills', 'aria-label': 'Search skills' });

  function card(s) {
    const menuBtn = h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon cs-btn--small', type: 'button', 'aria-label': `More for ${s.name}`, onclick: (e) => {
      e.stopPropagation();
      openMenu({ anchor: menuBtn, label: s.name, items: [
        { label: 'Edit SKILL.md', icon: 'edit', onSelect: () => { location.hash = `#/library/${s.name}`; } },
        { label: 'Add to a project...', icon: 'plus', kbd: 'A', onSelect: () => addPick(menuBtn, s) },
        { label: 'Delete from library', icon: 'trash', onSelect: () => remove(s) },
      ] });
    } }, icon('more', 's'));
    const c = h('a', { class: 'cs-card cs-card--raised cs-skillcard', href: `#/library/${s.name}`, },
      h('div', { class: 'cs-card__head' }, icon('drag', 's'), icon('skill', 's'), h('span', { class: 'cs-card__title' }, s.name), h('span', { class: 'cs-grow' }), menuBtn),
      h('div', { class: 'cs-card__desc' }, s.description || (s.problem ? s.problem : 'No description')),
      h('div', { class: 'cs-card__meta' }, h('span', { class: 'cs-pill cs-pill--quiet', title: PART_NOTE[s.partition || 'shared'] }, s.partition || 'shared'), ...[plural(s.files, 'file'), fmtBytes(s.bytes), `${s.uses} use${s.uses === 1 ? '' : 's'}`, sourceLabel(s), s.declaredName ? `declared name: ${s.declaredName}` : null].filter(Boolean).map((x) => h('span', {}, x))));
    dragSource(c, SKILL_TYPE, { name: s.name });
    addKeyboardPath(c, `Add ${s.name} to`, (p) => installSkill(p.id, s.name));
    return c;
  }
  const addPick = (anchor, s) => {
    const ps = state.projects.filter((p) => p.exists);
    if (!ps.length) { toast('Add a project first.', { kind: 'info' }); return; }
    openMenu({ anchor, label: 'Add to project', items: [{ group: `Add ${s.name} to` }, ...ps.map((p) => ({ label: p.name, icon: 'project', onSelect: () => installSkill(p.id, s.name) }))] });
  };
  async function remove(s) {
    if (!(await confirmDialog({ title: `Delete "${s.name}"?`, message: 'It is removed from your library only. Projects that already installed it keep their copy.', confirmLabel: 'Delete', danger: true }))) return;
    await api.removeSkill(s.name);
    await Promise.all([refreshSkills(), refreshShell()]);
    draw();
  }

  function draw() {
    const q = search.value.trim().toLowerCase();
    const list = state.skills.filter((s) => (partition === 'all' || (s.partition || 'shared') === partition) && (!q || s.name.includes(q) || (s.description || '').toLowerCase().includes(q)));
    tabs.replaceChildren(...PARTITIONS.map(([k, label]) => h('button', { class: 'cs-btn cs-btn--small', type: 'button', 'aria-pressed': String(partition === k), onclick: () => { partition = k; draw(); } }, `${label} ${state.skills.filter((s) => k === 'all' || (s.partition || 'shared') === k).length}`)));
    grid.replaceChildren();
    if (!list.length) {
      grid.append(h('div', { class: 'cs-empty' }, icon('library', 'l'), h('div', { class: 'cs-empty__title' }, state.skills.length ? 'No skill matches' : 'Your library is empty'),
        state.skills.length ? null : h('p', {}, 'Import from GitHub, or write your own.')));
      return;
    }
    list.forEach((s) => grid.append(card(s)));
  }

  const tabs = h('div', { class: 'cs-partitions', role: 'group', 'aria-label': 'Skill partitions' });
  search.addEventListener('input', draw);
  el.append(h('div', { class: 'cs-stack' },
    h('div', { class: 'cs-row cs-row--wrap cs-row--between' }, h('h1', { class: 'cs-h1', id: 'main-title' }, 'Library'),
      h('div', { class: 'cs-row cs-row--wrap' }, search, h('button', { class: 'cs-btn', type: 'button', onclick: () => openGithubImport(draw) }, icon('github', 's'), 'Import from GitHub'), h('a', { class: 'cs-btn cs-btn--primary', href: '#/library/new' }, icon('plus', 's'), 'New skill'))),
    tabs, grid, catalogSection()));
  draw();
  if (ctx.params.importOpen) setTimeout(() => openGithubImport(draw), 0);
  return {};
}
