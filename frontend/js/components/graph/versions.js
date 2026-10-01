// Versions mode: the history of a workflow as a chain of semantic versions. Pick one to see what differs from the
// current version, and restore it (a restore is saved as a new version, so nothing is ever lost).
import { h, icon, timeAgo } from '../../dom.js';
import { confirmDialog } from '../overlay.js';

export function renderVersions(host, { versions = [], head, onRestore }) {
  const ordered = versions.slice().reverse();
  let picked = head || ordered[0]?.version;

  const chain = h('ol', { class: 'cs-gver__chain', 'aria-label': 'Versions, newest first' });
  const detail = h('section', { class: 'cs-gver__detail cs-card', 'aria-live': 'polite' });
  host.replaceChildren(h('div', { class: 'cs-gver' }, chain, detail));

  function summary(v) {
    const s = v.vsHead?.summary;
    if (!s || v.version === head) return null;
    return h('span', { class: 'cs-gver__delta cs-mono', title: 'Compared with the current version' },
      h('span', { class: 'cs-gver__add' }, `+${s.added}`), ' ', h('span', { class: 'cs-gver__del' }, `-${s.removed}`), ' ', h('span', { class: 'cs-gver__chg' }, `~${s.changed}`));
  }

  function draw() {
    chain.replaceChildren(...ordered.map((v) => h('li', { class: ['cs-gver__item', v.restoredFrom && 'cs-gver__item--branch'] },
      h('button', { class: ['cs-gver__node', false], type: 'button', 'aria-pressed': String(v.version === picked), onclick: () => { picked = v.version; draw(); } },
        h('span', { class: 'cs-gver__dot', 'aria-hidden': 'true' }),
        h('span', { class: 'cs-gver__body' },
          h('span', { class: 'cs-gver__row' }, h('strong', { class: 'cs-mono' }, `v${v.version}`), v.version === head ? h('span', { class: 'cs-pill cs-pill--ok' }, 'current') : null, v.restoredFrom ? h('span', { class: 'cs-pill cs-pill--quiet' }, `restored from v${v.restoredFrom}`) : null, summary(v)),
          h('span', { class: 'cs-soft cs-small' }, `${v.note || 'No note'} · ${timeAgo(v.at)}`))))));

    const v = ordered.find((x) => x.version === picked);
    if (!v) { detail.replaceChildren(h('p', { class: 'cs-soft' }, 'No versions yet.')); return; }
    const changes = v.vsHead?.changes || [];
    detail.replaceChildren(
      h('div', { class: 'cs-row cs-row--between' }, h('h3', { class: 'cs-h3' }, `Version ${v.version}`),
        v.version === head ? null : h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button', onclick: async () => {
          if (await confirmDialog({ title: `Restore version ${v.version}?`, message: 'The current workflow is kept in the history. The restored one is saved as a new version.', confirmLabel: 'Restore' })) onRestore?.(v.version);
        } }, icon('undo', 's'), 'Restore this version')),
      h('p', { class: 'cs-soft cs-small' }, `${new Date(v.at).toLocaleString()}${v.parent ? ` · after v${v.parent}` : ''}`),
      v.note ? h('p', {}, v.note) : null,
      v.version === head
        ? h('p', { class: 'cs-soft' }, 'This is the current version.')
        : changes.length
          ? h('div', {}, h('h4', { class: 'cs-eyebrow' }, 'Compared with the current version'), h('ul', { class: 'cs-gver__changes' }, changes.map((c) => h('li', {}, c.text))))
          : h('p', { class: 'cs-soft' }, 'Identical to the current version.'));
  }
  draw();
}
