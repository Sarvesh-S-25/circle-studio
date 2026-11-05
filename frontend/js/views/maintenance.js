import { api } from '../api.js';
import { h, fmtBytes } from '../dom.js';
import { confirmDialog, toast } from '../components/overlay.js';

export async function mount(el) {
  let alive = true;
  const memory = h('div', { class: 'cs-stack' });
  const processSample = h('div', { class: 'cs-stack' });
  const storage = h('div', { class: 'cs-stack' });
  const policy = h('div', { class: 'cs-stack' });
  const restore = h('div', { class: 'cs-stack' });
  const backupLink = h('div', { class: 'cs-stack' });
  const cleanup = h('div', { class: 'cs-stack' });
  const previewCleanup = async () => {
    try {
      const p = await api.cleanup(); if (!alive) return;
      cleanup.replaceChildren(h('p', {}, `${p.files.length} generated files · ${fmtBytes(p.bytes)}. ${p.note}`), h('details', {}, h('summary', {}, 'Files to remove'), h('ul', {}, p.files.map((f) => h('li', {}, `${f.path} · ${fmtBytes(f.bytes)}`)))), p.files.length ? h('button', { class: 'cs-btn', onclick: async () => {
        if (!await confirmDialog({ title: 'Remove these generated files?', message: p.note, confirmLabel: 'Remove previewed files' })) return;
        try { const r = await api.cleanup({ id: p.id }); cleanup.replaceChildren(h('p', {}, `Removed ${r.removed} files, freeing ${fmtBytes(r.bytes)}.`)); await refreshStorage(); } catch (error) { toast(error.message, { kind: 'danger' }); }
      } }, 'Remove previewed files') : null);
    } catch (error) { toast(error.message, { kind: 'danger' }); }
  };
  const file = h('input', { type: 'file', accept: '.json', 'aria-label': 'Choose a Circle backup', onchange: async () => {
    try {
      if (!file.files?.[0]) return;
      if (file.files[0].size > 40 * 1024 * 1024) throw new Error('The backup is larger than 40 MiB.');
      const preview = await api.restore({ backup: JSON.parse((await file.files[0].text()).replace(/^\uFEFF/, '')) });
      if (!alive) return;
      restore.replaceChildren(h('p', {}, `${preview.files.length} files · ${fmtBytes(preview.bytes)}. ${preview.note}`), h('details', { class: 'cs-details' }, h('summary', {}, 'Files to restore'), h('ul', {}, preview.files.map((f) => h('li', {}, `${f.path} · ${fmtBytes(f.bytes)}`)))), h('button', { class: 'cs-btn cs-btn--primary', onclick: async () => {
        if (!await confirmDialog({ title: 'Restore into a separate folder?', message: preview.note, confirmLabel: 'Restore and verify' })) return;
        try { const result = await api.restore({ id: preview.id }); restore.replaceChildren(h('p', {}, `${result.verified ? 'Verified restore' : 'Restore'}: ${result.files} files`), h('code', {}, result.dataDir), h('p', { class: 'cs-soft' }, result.note)); } catch (error) { toast(error.message, { kind: 'danger' }); }
      } }, 'Restore and verify'));
    } catch (error) { toast(error.message, { kind: 'danger' }); }
  } });
  const download = async () => {
    try {
      const result = await api.backup({ download: true });
      const link = h('a', { class: 'cs-btn cs-btn--primary', href: api.backupDownload(result.token), download: `circle-backup-${new Date().toISOString().slice(0, 10)}.json` }, `Download backup (${result.files} files)`);
      backupLink.replaceChildren(link, h('p', { class: 'cs-soft cs-small' }, 'The backup is ready. The download expires in two minutes; preparing another backup replaces it.'));
      if (result.skipped.length) toast(`${result.skipped.length} files were omitted. The backup records why.`, { kind: 'warn' });
    } catch (error) { toast(error.message, { kind: 'danger' }); }
  };
  async function refreshMemory() {
    if (!alive || document.hidden) return;
    try { const d = await api.diagnostics(); if (!alive) return; memory.replaceChildren(h('p', {}, `Resident memory: ${fmtBytes(d.memory.rss)} · JavaScript heap: ${fmtBytes(d.memory.heapUsed)} · external: ${fmtBytes(d.memory.external)}`), h('p', {}, `${d.engineRuns} chat runs · ${d.adviceRuns} advisory tasks · ${d.pendingRequests} pending requests · ${d.node}`), h('p', { class: 'cs-soft cs-small' }, d.rpcNote)); } catch (error) { if (alive) memory.replaceChildren(h('p', {}, error.message)); }
  }
  async function refreshStorage() {
    try { const d = await api.storage(); if (!alive) return; storage.replaceChildren(h('p', {}, `${fmtBytes(d.totalBytes)} in Circle data`), h('table', { class: 'cs-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Category'), h('th', {}, 'Files'), h('th', {}, 'Size'))), h('tbody', {}, d.categories.map((c) => h('tr', {}, h('td', {}, c.category), h('td', {}, c.files), h('td', {}, fmtBytes(c.bytes)))))), h('p', { class: 'cs-soft cs-small' }, d.owns));
      const r = d.retention;
      if (r) {
        const days = h('input', { class: 'cs-input', type: 'number', min: 1, max: 365, value: r.generatedDays, 'aria-label': 'Generated file age in days' });
        const cap = h('input', { class: 'cs-input', type: 'number', min: 1, max: 5000, value: r.generatedMaxMiB, 'aria-label': 'Generated storage budget in MiB' });
        policy.replaceChildren(h('h3', { class: 'cs-h3' }, 'Retention rules'), h('p', {}, r.chats), h('p', {}, r.audit), h('p', {}, r.workflows), h('p', { class: 'cs-soft cs-small' }, 'Cleanup applies only to generated files and always requires a file preview and confirmation.'), h('label', { class: 'cs-field' }, 'Generated file age (days)', days), h('label', { class: 'cs-field' }, 'Generated file budget (MiB)', cap), h('button', { class: 'cs-btn', onclick: async () => { try { await api.saveSettings({ retention: { generatedDays: Number(days.value), generatedMaxMiB: Number(cap.value) } }); toast('Cleanup policy saved. Preview cleanup to review its effect.'); } catch (error) { toast(error.message, { kind: 'danger' }); } } }, 'Save cleanup policy'));
      } } catch (error) { if (alive) storage.replaceChildren(h('p', {}, error.message)); }
  }
  el.append(h('div', { class: 'cs-stack cs-stack--loose' }, h('header', {}, h('h1', { class: 'cs-h1', id: 'main-title' }, 'Storage & diagnostics'), h('a', { class: 'cs-btn', href: '#/settings' }, 'Back to settings')), h('section', { class: 'cs-card cs-stack' }, h('h2', { class: 'cs-h2' }, 'Server memory'), memory), h('section', { class: 'cs-card cs-stack' }, h('div', { class: 'cs-row cs-row--between' }, h('h2', { class: 'cs-h2' }, 'Local storage'), h('button', { class: 'cs-btn', onclick: refreshStorage }, 'Refresh')), storage), h('section', { class: 'cs-card cs-stack' }, h('h2', { class: 'cs-h2' }, 'Backup & restore'), h('p', {}, 'Export chats, workflows, tasks, skills and settings. Provider sign-ins and vault keys are excluded. Restores are verified in a separate folder.'), h('button', { class: 'cs-btn cs-btn--primary', onclick: download }, 'Prepare backup'), h('label', { class: 'cs-field' }, 'Preview a backup to restore', file), restore)));
  await Promise.all([refreshMemory(), refreshStorage()]);
  memory.after(h('button', { class: 'cs-btn', onclick: async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try { const d = await api.diagnostics(true); if (!alive) return; const sample = d.owned; processSample.replaceChildren(h('p', { class: 'cs-soft cs-small' }, sample?.note || 'Unavailable'), sample?.available ? h('div', { class: 'cs-stack' }, h('p', {}, `${fmtBytes(sample.privateBytes)} total private committed across ${sample.processes.length} owned processes · ${new Date(sample.at).toLocaleTimeString()}`), h('table', { class: 'cs-table' }, h('thead', {}, h('tr', {}, ['Process', 'Resident', 'Private', 'CPU seconds'].map((s) => h('th', {}, s)))), h('tbody', {}, sample.processes.map((p) => h('tr', {}, h('td', {}, `${p.name} (${p.pid})`), h('td', {}, fmtBytes(p.workingSet)), h('td', {}, fmtBytes(p.privateBytes)), h('td', {}, p.cpuSeconds.toFixed(2))))))) : null); } catch (error) { toast(error.message, { kind: 'danger' }); } finally { button.disabled = false; }
  } }, 'Measure owned processes'), processSample);
  file.parentElement.before(backupLink);
  storage.after(policy);
  storage.after(h('button', { class: 'cs-btn', onclick: previewCleanup }, 'Preview cleanup'), cleanup);
  cleanup.after(h('button', { class: 'cs-btn', onclick: async (event) => { const button = event.currentTarget; button.disabled = true; try { const r = await api.reindexHistory(); toast(`${r.conversations} conversation indexes rebuilt; ${r.skipped.length} invalid records skipped. Transcripts and selection preserved.`, { kind: r.skipped.length ? 'warn' : 'ok' }); await refreshStorage(); } catch (error) { toast(error.message, { kind: 'danger' }); } finally { button.disabled = false; } } }, 'Rebuild saved-history indexes'));
  const timer = setInterval(refreshMemory, 5000);
  return { destroy() { alive = false; clearInterval(timer); } };
}
