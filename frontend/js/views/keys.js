// Keys: the API keys your tools need (a design tool, a database, GitHub...), pasted once, kept on this PC encrypted
// for your Windows account. Which project uses which tool is chosen in each project's Connections tab. Every
// connection on this PC, the manager and the security check are under "Everything on this PC".
import { api } from '../api.js';
import { h, icon, timeAgo } from '../dom.js';
import { state } from '../state.js';
import { confirmDialog, openModal, toast } from '../components/overlay.js';

const nameFor = (what) => {
  const base = String(what || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'K_$1').slice(0, 50);
  return base ? (/(KEY|TOKEN|SECRET)$/.test(base) ? base : `${base}_API_KEY`) : '';
};

export async function mount(el, ctx) {
  let keys = [];
  const list = h('div', { class: 'cs-stack cs-stack--tight' });
  const projects = () => state.projects.filter((p) => p.exists);
  const whereText = (k) => (k.projects === 'all' ? 'every project' : k.projects.map((id) => state.projects.find((p) => p.id === id)?.name || id).join(', ') || 'no project yet');

  async function load() {
    try { keys = (await api.vault()).keys; } catch (e) { list.replaceChildren(h('p', { class: 'cs-soft' }, e.message)); return; }
    list.replaceChildren(...(keys.length ? keys.map((k) => h('div', { class: 'cs-cx__key' }, icon('lock', 's'),
      h('div', { class: 'cs-grow' }, h('strong', { class: 'cs-mono' }, k.name), h('div', { class: 'cs-soft cs-small' }, `For ${whereText(k)} · saved ${timeAgo(k.updatedAt)}${k.note ? ` · ${k.note}` : ''}`)),
      h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', onclick: () => editKey(k) }, 'Where'),
      h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', onclick: () => replaceKey(k) }, 'Replace'),
      h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet cs-btn--danger', type: 'button', 'aria-label': `Delete ${k.name}`, onclick: async () => { if (await confirmDialog({ title: `Delete ${k.name}?`, message: 'Tools that read it stop working until you add it again.', confirmLabel: 'Delete', danger: true })) { await api.vaultRemove(k.name); load(); } } }, icon('trash', 's'))))
      : [h('p', { class: 'cs-soft' }, 'No keys yet. Paste the first one above.')]));
  }

  // add a key: say what it is for, paste it, choose where it may be used
  const what = h('input', { class: 'cs-input', id: 'key-what', placeholder: 'What is it for? For example Stitch', autocomplete: 'off' });
  const name = h('input', { class: 'cs-input cs-mono', placeholder: 'STITCH_API_KEY', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Its name' });
  const value = h('input', { class: 'cs-input', type: 'password', placeholder: 'Paste the key', autocomplete: 'off', 'aria-label': 'The key' });
  const where = h('select', { class: 'cs-select', 'aria-label': 'Where it may be used' }, h('option', { value: 'all' }, 'Every project'), projects().map((p) => h('option', { value: p.id }, `Only ${p.name}`)));
  let named = false;
  what.addEventListener('input', () => { if (!named) name.value = nameFor(what.value); });
  name.addEventListener('input', () => { named = Boolean(name.value); });
  const save = async () => {
    const n = (name.value || nameFor(what.value)).trim().toUpperCase();
    if (!n) { toast('Say what the key is for.', { kind: 'warn' }); what.focus(); return; }
    if (!value.value.trim()) { toast('Paste the key.', { kind: 'warn' }); value.focus(); return; }
    try {
      await api.vaultSet(n, { value: value.value, projects: where.value === 'all' ? 'all' : [where.value], note: what.value.trim() ? `For ${what.value.trim().slice(0, 80)}` : undefined });
      value.value = ''; what.value = ''; name.value = ''; named = false;
      toast(`${n} is saved. Give it to a tool in a project's Connections tab.`, { kind: 'ok', ms: 6000 });
      load();
    } catch (e) { toast(e.message, { kind: 'danger' }); }
  };
  value.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });

  function replaceKey(k) {
    const box = h('input', { class: 'cs-input', type: 'password', placeholder: 'Paste the new key', autocomplete: 'off', 'aria-label': 'The new key' });
    openModal({ title: `Replace ${k.name}`, body: h('div', { class: 'cs-stack cs-stack--tight' }, h('p', { class: 'cs-soft cs-small' }, 'Tools that read this key use the new one from their next start.'), box), initialFocus: 'input', actions: [{ label: 'Cancel', kind: 'quiet' }, { label: 'Replace', kind: 'primary', onClick: async (c) => {
      try { await api.vaultSet(k.name, { value: box.value }); c.close(null); toast(`${k.name} replaced.`, { kind: 'ok' }); load(); } catch (e) { toast(e.message, { kind: 'danger' }); }
    } }] });
  }

  function editKey(k) {
    const boxes = projects().map((p) => h('label', { class: 'cs-check' }, h('input', { type: 'checkbox', value: p.id, checked: (k.projects === 'all' || k.projects.includes(p.id)) || undefined }), h('span', {}, p.name)));
    const all = h('label', { class: 'cs-check' }, h('input', { type: 'checkbox', checked: k.projects === 'all' || undefined }), h('span', {}, h('strong', {}, 'Every project')));
    openModal({ title: `Where ${k.name} may be used`, body: h('div', { class: 'cs-stack cs-stack--tight' }, all, ...boxes), actions: [{ label: 'Cancel', kind: 'quiet' }, { label: 'Save', kind: 'primary', onClick: async (c) => {
      const p = all.querySelector('input').checked ? 'all' : boxes.filter((b) => b.querySelector('input').checked).map((b) => b.querySelector('input').value);
      try { await api.vaultSet(k.name, { projects: p }); c.close(null); load(); } catch (e) { toast(e.message, { kind: 'danger' }); }
    } }] });
  }

  // everything on this PC (the manager, the security check, every engine's connections): only when asked for
  const pcBox = h('div', {});
  const advanced = h('details', { class: 'cs-details cs-card', open: ctx.params?.advanced || undefined },
    h('summary', {}, h('span', { class: 'cs-h3' }, 'Everything on this PC'), h('span', { class: 'cs-soft cs-small' }, ' Every connection of every engine, duplicates and fixes, the security check')),
    pcBox);
  let pcView = null;
  const openPc = async () => { if (pcView || !advanced.open) return; pcView = await (await import('./connections.js')).mount(pcBox, { params: {} }); };
  advanced.addEventListener('toggle', openPc);

  el.append(h('div', { class: 'cs-stack cs-stack--loose cs-page' },
    h('header', { class: 'cs-stack cs-stack--tight' }, h('h1', { class: 'cs-h1', id: 'main-title' }, 'Keys'),
      h('p', { class: 'cs-soft' }, 'Paste the API keys your tools need here, once. They stay on this PC, encrypted for your Windows account, and are never shown again. Then, in a project\'s Connections tab, choose which tools that project uses.')),
    h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'key-add' },
      h('h2', { class: 'cs-h3', id: 'key-add' }, 'Add a key'),
      h('div', { class: 'cs-keys__form' },
        h('label', { class: 'cs-field' }, h('span', { class: 'cs-field__label' }, 'What it is for'), what),
        h('label', { class: 'cs-field' }, h('span', { class: 'cs-field__label' }, 'The key'), value),
        h('label', { class: 'cs-field' }, h('span', { class: 'cs-field__label' }, 'Use it in'), where),
        h('label', { class: 'cs-field' }, h('span', { class: 'cs-field__label' }, 'Its name (tools read it by this)'), name)),
      h('div', { class: 'cs-row cs-row--wrap' }, h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: save }, icon('plus', 's'), 'Save the key'),
        h('span', { class: 'cs-soft cs-small' }, 'Anthropic keys are refused: Claude runs through your own sign-in.'))),
    h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'key-list' }, h('h2', { class: 'cs-h3', id: 'key-list' }, 'Your keys'), list),
    projects().length ? h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'key-proj' }, h('h2', { class: 'cs-h3', id: 'key-proj' }, 'Choose the tools for a project'),
      h('div', { class: 'cs-row cs-row--wrap' }, projects().map((p) => h('a', { class: 'cs-btn cs-btn--small', href: `#/projects/${p.id}/connections` }, icon('link', 's'), p.name)))) : null,
    advanced));
  await load();
  if (advanced.open) openPc();
  return { destroy: () => pcView?.destroy?.() };
}
