import { api } from '../api.js';
import { h } from '../dom.js';
import { openModal, toast } from './overlay.js';

export async function reviewHandoff({ projectId, nodeId, engine, conversationId, onPrepared }) {
  try {
    if (!conversationId || conversationId === 'active') throw new Error('Save a conversation before preparing a handoff.');
    const options = { engine, nodeId: nodeId || '', source: 'circle' };
    const [first, available] = await Promise.all([api.historyOne(projectId, conversationId, '', options), api.engines()]);
    const source = await api.historyOne(projectId, conversationId, '', { ...options, offset: Math.max(0, first.totalMessages - 12) });
    const recent = source.messages.map((m) => `${m.role}: ${m.text || ''}`).join('\n\n');
    const target = h('select', { class: 'cs-select', 'aria-label': 'Handoff target engine' }, available.engines.filter((e) => e.usable).map((e) => h('option', { value: e.id, selected: e.id === engine || undefined }, e.label)));
    const summary = h('textarea', { class: 'cs-textarea', rows: 12, maxlength: 12000, 'aria-label': 'Reviewed handoff summary', value: `Reviewed handoff from ${engine}, conversation ${conversationId}.\n\nGoal and decisions:\n\nRemaining work and checks:\n\nRecent conversation excerpts (review and shorten these):\n${recent.slice(-9000)}` });
    const measure = h('p', { class: 'cs-soft cs-small', role: 'status' });
    const update = () => { measure.textContent = `${first.totalMessages} messages remain in the original. Recent excerpt: ${recent.length.toLocaleString()} characters; draft: ${summary.value.length.toLocaleString()} characters. These are text lengths, not model context or cost measurements.`; };
    summary.addEventListener('input', update); update();
    const body = h('div', { class: 'cs-stack' }, h('p', {}, 'Review the text that the next engine will receive. The original chat stays intact. This creates a new conversation draft; it does not send a model request or transfer hidden context.'), h('label', { class: 'cs-field' }, 'Continue with', target), summary, measure);
    openModal({ title: 'Review context handoff', body, size: 'wide', actions: [{ label: 'Cancel', kind: 'quiet' }, { label: 'Save handoff draft', kind: 'primary', onClick: async (ctrl) => {
      ctrl.setBusy(true);
      try {
        const record = await api.saveTask(projectId, { action: 'record-handoff', sourceEngine: engine, targetEngine: target.value, nodeId, conversationId, summary: summary.value, reviewed: true });
        await onPrepared(target.value, record.handoff.summary);
        ctrl.close(); toast('Reviewed handoff saved as a draft. Read it and press Send when ready.');
      } catch (error) { toast(error.message, { kind: 'danger' }); } finally { ctrl.setBusy(false); }
    } }] });
  } catch (error) { toast(error.message, { kind: 'danger' }); }
}
