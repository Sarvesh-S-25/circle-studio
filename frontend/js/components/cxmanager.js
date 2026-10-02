// The connection manager on Connections: each server grouped across projects and engines, what is redundant or
// broken, and one-click fixes. Every fix is previewed as plain steps first, runs only on Apply (Claude Code's config is
// backed up and put back if a step fails), and is followed by a test of what it touched.
import { api } from '../api.js';
import { h, icon, plural } from '../dom.js';
import { reviewChanges } from './diffreview.js';
import { openModal, toast } from './overlay.js';

const TONE = { danger: 'danger', warn: 'warn', info: 'info' };

/** Preview a fix, apply it on the human's click, show what happened and the tests. Resolves true when it ran. */
export async function runAction(action, { projectId = null, title } = {}) {
  let plan;
  try { plan = await api.planConnection(action, projectId || undefined); } catch (e) { toast(e.message, { kind: 'danger' }); return false; }
  return new Promise((resolve) => {
    const body = h('div', { class: 'cs-stack' },
      plan.note ? h('div', { class: 'cs-banner cs-banner--info' }, icon('info', 's'), h('span', {}, plan.note)) : null,
      h('ol', { class: 'cs-cxm__steps' }, plan.steps.map((s) => h('li', {}, h('span', {}, s.text), s.cmd ? h('code', { class: 'cs-mono cs-small' }, s.cmd) : null))),
      plan.ops ? h('p', { class: 'cs-soft cs-small' }, 'Then you review the change to the project\'s .mcp.json before it is written.') : null,
      h('p', { class: 'cs-soft cs-small' }, 'Claude Code\'s config is backed up first and put back if a step fails. Afterwards the server is started once to check it works.'));
    openModal({ title: title || plan.title, body, size: 'wide', actions: [{ label: 'Cancel', kind: 'quiet', onClick: (c) => { c.close(null); resolve(false); } }, { label: 'Apply', kind: 'primary', onClick: async (first) => {
      first.close(null);
      const out = h('div', { class: 'cs-stack' });
      const c = openModal({ title: title || plan.title, body: out, size: 'wide', dismissable: false, actions: [{ label: 'Done', kind: 'primary', onClick: (cc) => cc.close(null) }] });
      c.setBusy(true);
      out.replaceChildren(h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Working: changing the config and testing the server...'));
      let r;
      try { r = await api.applyConnection(plan.id); } catch (e) { c.setBusy(false); out.replaceChildren(h('div', { class: 'cs-banner cs-banner--danger' }, icon('danger', 's'), h('span', {}, e.message))); resolve(false); return; }
      if (r.ok && r.ops) {
        c.close(null);
        const done = await reviewChanges({ projectId: r.projectId, ops: r.ops, title: 'The change to .mcp.json', applyLabel: 'Write it' });
        if (done) for (const id of r.retest) { try { const t = await api.testConnection({ id, projectId: r.projectId }); toast(t.result.ok ? `Works now: ${plural(t.result.tools.length, 'tool')}.` : 'Saved, but it still does not start. Press Test on it to see why.', { kind: t.result.ok ? 'ok' : 'warn', ms: 8000 }); } catch { /* shown on the page */ } }
        resolve(true);
        return;
      }
      out.replaceChildren(
        h('ul', { class: 'cs-cxm__results' }, r.results.map((x) => h('li', { class: x.ok ? 'cs-cxm__ok' : 'cs-cxm__bad' }, icon(x.ok ? 'check' : 'danger', 's'), h('div', {}, h('span', {}, x.text), x.detail ? h('div', { class: 'cs-soft cs-small' }, x.detail) : null)))),
        ...r.tests.map((t) => h('div', { class: `cs-banner cs-banner--${t.result.ok ? 'ok' : 'danger'}` }, icon(t.result.ok ? 'check' : 'danger', 's'),
          h('span', {}, t.result.ok ? `It works: answered with ${plural(t.result.tools.length, 'tool')}${t.result.tools.length ? ` (${t.result.tools.slice(0, 8).join(', ')})` : ''}.` : `Still not working: ${(t.diagnosis?.[0]?.cause) || t.result.error}. Open it below for the details.`))));
      c.setBusy(false);
      toast(r.ok ? 'Done.' : 'It did not work; nothing was left half changed.', { kind: r.ok ? 'ok' : 'warn' });
      resolve(r.ok);
    } }] });
  });
}

/**
 * Give one server its key: one of your saved keys (Keys page), or paste a new one into the Windows environment
 * (recommended) or straight into its config. `saved` = the saved key names.
 */
export function keyForm(server, { projectId = null, onDone, saved = [] } = {}) {
  const fields = [...server.envNames.map((n) => ['env', n]), ...server.headerNames.map((n) => ['headers', n])];
  const pick = h('select', { class: 'cs-select cs-select--small', 'aria-label': 'Which setting the key is for' },
    fields.length ? fields.map(([f, n]) => h('option', { value: `${f}:${n}` }, f === 'env' ? `Variable ${n}` : `Header ${n}`)) : h('option', { value: 'env:API_KEY' }, 'Variable API_KEY'));
  const value = h('input', { class: 'cs-input', type: 'password', placeholder: 'Paste the key', autocomplete: 'off', 'aria-label': 'The key' });
  const source = h('select', { class: 'cs-select cs-select--small', 'aria-label': 'Which key', onchange: () => sync() },
    saved.map((n) => h('option', { value: n }, `Saved key ${n}`)), h('option', { value: '' }, 'Paste a new key'));
  // pick the saved key whose name matches the setting, when there is one
  const want = fields.map(([, n]) => n.toUpperCase());
  const match = saved.find((n) => want.includes(n)) || saved.find((n) => want.some((w) => n.includes(w) || w.includes(n)));
  if (match) source.value = match; else source.value = '';
  const target = (v, label, hint, checked) => h('label', { class: 'cs-radio' }, h('input', { type: 'radio', name: `kt-${server.id}`, value: v, checked: checked || undefined }), h('span', {}, h('strong', {}, label), h('span', { class: 'cs-soft' }, ` ${hint}`)));
  const pasteBits = h('div', { class: 'cs-stack cs-stack--tight' }, value,
    target('env', 'Save it in my Windows environment (recommended)', 'The config only names it, so it is never in a file you might share; every terminal and app sees it.', true),
    target('config', 'Write it into the config file', 'Simplest, but the key sits in plain text in that file.'));
  function sync() { pasteBits.hidden = Boolean(source.value); }
  const box = h('div', { class: 'cs-cxm__key' },
    h('strong', { class: 'cs-small' }, 'Give it its key'),
    h('div', { class: 'cs-row cs-row--wrap' }, pick, saved.length ? source : null),
    pasteBits,
    h('div', {}, h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button', onclick: async () => {
      const [field, key] = pick.value.split(':');
      let action;
      if (source.value) action = { kind: 'key', id: server.id, field, key, fromVault: source.value };
      else {
        if (!value.value.trim()) { toast('Paste the key first.', { kind: 'warn' }); return; }
        action = { kind: 'key', id: server.id, field, key, value: value.value, target: box.querySelector(`input[name="kt-${server.id}"]:checked`).value };
      }
      const ok = await runAction(action, { projectId });
      value.value = '';
      if (ok) onDone?.();
    } }, icon('key', 's'), 'Give it the key and test')));
  sync();
  return box;
}

/** The Manager card: one row per server name, its copies and the fixes. */
export function managerCard({ onChanged } = {}) {
  const box = h('div', { class: 'cs-stack' }, h('div', { class: 'cs-loading' }, icon('spinner', 's'), 'Looking at every connection...'));
  async function load() {
    let groups;
    try { groups = (await api.manageConnections()).groups; } catch (e) { box.replaceChildren(h('p', { class: 'cs-soft' }, e.message)); return; }
    const todo = groups.reduce((n, g) => n + g.findings.filter((f) => f.action).length, 0);
    box.replaceChildren(
      h('p', { class: 'cs-soft' }, groups.length ? (todo ? `${plural(todo, 'fix')} ready. Each one shows its steps first.` : 'Nothing to tidy up: every connection is set up once and works.') : 'No connections yet.'),
      ...groups.map((g) => h('div', { class: 'cs-cxm__group' },
        h('div', { class: 'cs-row cs-row--wrap' }, h('strong', {}, g.name), h('span', { class: 'cs-soft cs-small' }, plural(g.copies.length, 'copy', 'copies')),
          ...g.copies.map((c) => h('span', { class: `cs-pill cs-pill--${c.stale ? 'warn' : c.broken ? 'danger' : 'quiet'}`, title: c.setup }, c.where, c.broken ? ' (broken)' : c.stale ? ' (folder gone)' : ''))),
        g.findings.length ? h('ul', { class: 'cs-cxm__findings' }, g.findings.map((f) => h('li', { class: `cs-cxm__finding cs-cxm__finding--${TONE[f.severity]}` },
          h('div', { class: 'cs-grow' }, h('strong', {}, f.title), f.detail ? h('div', { class: 'cs-soft cs-small' }, f.detail) : null),
          f.action ? h('button', { class: `cs-btn cs-btn--small ${f.severity === 'danger' ? 'cs-btn--primary' : ''}`, type: 'button', onclick: async () => { if (await runAction(f.action)) { load(); onChanged?.(); } } }, icon(f.kind === 'broken' ? 'sparkle' : f.kind === 'plain' ? 'key' : f.kind === 'stale' || f.kind === 'covered' ? 'trash' : 'link', 's'), f.action.label) : null)))
          : h('p', { class: 'cs-soft cs-small' }, 'Fine.'))));
  }
  load();
  return { el: h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cx-man' }, h('div', { class: 'cs-row cs-row--between cs-row--wrap' }, h('h2', { class: 'cs-h2', id: 'cx-man' }, 'Manager'), h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', onclick: () => load() }, icon('refresh', 's'), 'Look again')), box), reload: load };
}
