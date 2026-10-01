// Health: is anything stopping the work, and what needs you. Plain words first; the technical facts sit behind
// "Details". Every fix still goes through the diff review.
import { api } from '../api.js';
import { h, icon, statusPill } from '../dom.js';
import { reviewChanges } from '../components/diffreview.js';
import { toast } from '../components/overlay.js';

const LANES = [['frontend', 'Frontend builders'], ['backend', 'Backend builders'], ['both', 'Contract (connector)'], ['all', 'All building']];
const GROUPS = [
  ['now', 'Needs you now', 'Work is stopped, or a decision waits for you.'],
  ['look', 'Worth a look', 'Nothing is stopped, but these are worth fixing or deciding.'],
];

export async function mount(el, pctx) {
  const { project } = pctx;
  const root = h('div', { class: 'cs-stack cs-stack--loose cs-health' });
  el.append(root);

  const run = async (ops, title, label) => {
    const r = await reviewChanges({ projectId: project.id, ops, title, applyLabel: label });
    if (r) await pctx.reload();
    return r;
  };

  function details(item) {
    const rows = [];
    if (item.tech) rows.push(h('p', { class: 'cs-small' }, item.tech));
    if (item.id === 'secrets' && item.items?.length) rows.push(h('ul', { class: 'cs-mono cs-small' }, item.items.map((f) => h('li', {}, `${f.file} line ${f.line}: ${f.kind}${f.variable ? ` (${f.variable})` : ''} ${f.preview}`))));
    if (item.id === 'tiers' && item.items?.length) rows.push(h('ul', { class: 'cs-small' }, item.items.map((f) => h('li', {}, `${f.role}: agent file ${f.agentModel || 'missing'}, plan ${f.configModel || 'missing'}`))));
    if (item.git?.present && item.git.available) rows.push(h('p', { class: 'cs-small' }, `Branch ${item.git.branch || '?'}, ${item.git.dirty} changed file${item.git.dirty === 1 ? '' : 's'}.`));
    return rows.length ? h('details', { class: 'cs-health__details' }, h('summary', { class: 'cs-small cs-soft' }, 'Details'), ...rows) : null;
  }

  function decisions(item) {
    const open = (item.items || []).filter((a) => a.status === 'proposed');
    if (!open.length) return null;
    return h('div', { class: 'cs-list' }, open.map((a) => h('div', { class: 'cs-list__item' }, icon('file', 's'),
      h('span', { class: 'cs-list__label', title: a.file }, a.title),
      h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => run([{ op: 'adr-status', file: a.file, status: 'accepted' }], `Agree to "${a.title}"`, 'Mark as agreed') }, icon('check', 's'), 'I agree...'))));
  }

  function card(item) {
    const actions = h('div', { class: 'cs-row cs-row--wrap' },
      item.fix ? h('button', { class: `cs-btn ${item.group === 'now' ? 'cs-btn--primary' : ''}`, type: 'button', onclick: () => run(item.fix.ops, item.fix.label, 'Apply') }, icon('diff', 's'), `${item.fix.label}...`) : null,
      item.link ? h('a', { class: 'cs-btn', href: item.link.href }, item.link.label) : null);
    return h('section', { class: ['cs-card', 'cs-health__card', `cs-health__card--${item.severity}`], 'aria-label': item.title },
      h('div', { class: 'cs-row cs-row--wrap' }, statusPill(item.severity === 'danger' ? 'danger' : item.severity === 'warn' ? 'warn' : 'info', item.severity === 'danger' ? (item.id === 'freeze' ? 'Stopped' : 'Urgent') : item.severity === 'warn' ? 'Needs you' : 'Suggestion'), h('h3', { class: 'cs-h3 cs-grow' }, item.title)),
      h('p', {}, item.detail),
      item.id === 'adr' ? decisions(item) : null,
      actions.children.length ? actions : null,
      details(item));
  }

  function tools(hl) {
    const freeze = hl.freeze;
    const checks = LANES.map(([v, label]) => h('label', { class: 'cs-check' }, h('input', { type: 'checkbox', value: v, checked: freeze.frozen?.includes(v) || undefined }), label));
    const req = h('input', { class: 'cs-input', 'aria-label': 'Change request id (optional)', placeholder: 'Change request id, e.g. CH-001 (optional)', value: freeze.requestId || '' });
    const pause = h('details', { class: 'cs-card' }, h('summary', { class: 'cs-h3' }, icon('snowflake', 's'), ' Pause or unpause building'),
      h('div', { class: 'cs-stack cs-stack--tight' },
        h('p', { class: 'cs-soft cs-small' }, 'A pause stops those builders from changing anything until you lift it, for example while a change request is decided.'),
        h('div', { class: 'cs-row cs-row--wrap' }, checks), req,
        h('div', { class: 'cs-row' }, h('button', { class: 'cs-btn', type: 'button', onclick: () => run([{ op: 'freeze-set', frozen: checks.map((c) => c.querySelector('input')).filter((i) => i.checked).map((i) => i.value), requestId: req.value.trim() || null }], 'Pause or unpause building', 'Write') }, 'Review...'))));

    const board = hl.board;
    const text = h('textarea', { class: 'cs-textarea', id: 'board-text', rows: 3, maxlength: 400, placeholder: 'What must the builders do differently, starting now?' });
    const to = h('input', { class: 'cs-input', id: 'board-to', value: 'lead' });
    const sup = h('input', { class: 'cs-input', id: 'board-sup', placeholder: 'e.g. 12, 14', autocomplete: 'off' });
    const urgent = h('input', { type: 'checkbox', checked: true });
    const message = h('details', { class: 'cs-card' }, h('summary', { class: 'cs-h3' }, icon('board', 's'), ' Message the builders'),
      h('div', { class: 'cs-stack cs-stack--tight' },
        h('p', { class: 'cs-soft cs-small' }, `Goes on the task board as ${board.nextId}, so a builder that is already running still sees it.`),
        h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'board-text' }, 'Message'), text),
        h('div', { class: 'cs-grid' },
          h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'board-to' }, 'For (an agent, lead or all)'), to),
          h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'board-sup' }, 'It replaces tasks (numbers)'), sup)),
        h('label', { class: 'cs-check' }, urgent, 'Urgent: put it at the top'),
        h('div', { class: 'cs-row' }, h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: async () => {
          const supersedes = sup.value.split(/[,\s]+/).map((x) => Number(x.replace(/\D/g, ''))).filter((n) => n > 0);
          if (!text.value.trim()) { toast('Write the message first.', { kind: 'warn' }); return; }
          const r = await run([{ op: 'board-post', text: text.value, to: to.value.trim() || 'lead', urgent: urgent.checked, supersedes }], `Post ${board.nextId} to the task board`, 'Post it');
          if (r) text.value = '';
        } }, 'Review the message...')),
        board.rows.length ? h('table', { class: 'cs-table' }, h('thead', {}, h('tr', {}, ['Task', 'For', 'Status', 'What'].map((c) => h('th', {}, c)))), h('tbody', {}, board.rows.slice(0, 5).map((r) => h('tr', {}, h('td', {}, r.id), h('td', {}, r.owner), h('td', {}, r.status), h('td', {}, r.summary))))) : null));

    const git = hl.items.find((i) => i.id === 'git');
    const gitOff = git && git.group === 'fine'
      ? h('details', { class: 'cs-card' }, h('summary', { class: 'cs-h3' }, icon('git', 's'), ' Let the team do git again'),
        h('div', { class: 'cs-stack cs-stack--tight' }, h('p', { class: 'cs-soft cs-small' }, 'Removes the list of private files from .gitignore and the note that you do git. push.md is kept.'),
          h('div', {}, h('button', { class: 'cs-btn', type: 'button', onclick: () => run([{ op: 'human-git', value: false }], 'Let the team do git', 'Apply') }, 'Review...'))))
      : null;
    return h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'health-tools' }, h('h3', { class: 'cs-eyebrow', id: 'health-tools' }, 'Tools'), pause, message, gitOff);
  }

  async function draw() {
    const hl = await api.health_of(project.id);
    const tone = hl.counts.now ? (hl.items.some((i) => i.group === 'now' && i.severity === 'danger') ? 'danger' : 'warn') : hl.counts.look ? 'info' : 'ok';
    root.replaceChildren(
      h('div', { class: 'cs-row cs-row--between cs-row--wrap' },
        h('div', { class: `cs-health__summary cs-health__summary--${tone}`, role: 'status' }, icon(tone === 'ok' ? 'check' : tone === 'info' ? 'info' : tone === 'danger' ? 'danger' : 'warning', 'l'),
          h('div', {}, h('h2', { class: 'cs-h2' }, hl.summary), h('p', { class: 'cs-soft cs-small' }, 'Read from this project\'s files just now. Fixes show you the change before anything is written.'))),
        h('button', { class: 'cs-btn', type: 'button', onclick: () => draw() }, icon('refresh', 's'), 'Check again')));
    for (const [g, title, hint] of GROUPS) {
      const list = hl.items.filter((i) => i.group === g);
      if (!list.length) continue;
      root.append(h('section', { class: 'cs-stack', 'aria-labelledby': `health-${g}` },
        h('div', {}, h('h3', { class: 'cs-h3', id: `health-${g}` }, `${title} (${list.length})`), h('p', { class: 'cs-soft cs-small' }, hint)),
        ...list.map(card)));
    }
    const fine = hl.items.filter((i) => i.group === 'fine');
    if (fine.length) {
      root.append(h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'health-fine' },
        h('h3', { class: 'cs-h3', id: 'health-fine' }, `All good (${fine.length})`),
        h('ul', { class: 'cs-health__fine' }, fine.map((i) => h('li', {}, h('span', { class: 'cs-health__ok' }, icon('check', 's')), h('span', {}, h('strong', {}, i.title), ' ', h('span', { class: 'cs-soft cs-small' }, i.detail)))))));
    }
    root.append(tools(hl));
  }

  await draw();
  return {};
}
