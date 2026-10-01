// What may Circle Studio do in this folder? Asked when a folder is added, changeable any time.
import { h, icon } from '../dom.js';
import { openModal } from './overlay.js';

const ROWS = [
  ['write', 'Change files', 'Only after you approve a diff.', 'edit'],
  ['run', 'Run its scripts', 'The project\'s own apply-models.mjs, after a model change. Chat commands are asked one by one.', 'terminal'],
  ['claude', 'Send text to Claude', 'Chat and the advisor, through your Claude login.', 'chat'],
];

/** Resolves with { write, run, claude } or null when cancelled. */
export function askPermissions({ name, path, current, confirmLabel = 'Allow' }) {
  const value = { write: true, run: true, claude: true, ...(current || {}) };
  const rows = ROWS.map(([key, title, hint, ic]) => h('label', { class: 'cs-perm' },
    h('input', { class: 'cs-switch__input', type: 'checkbox', checked: value[key] || undefined, onchange: (e) => { value[key] = e.target.checked; } }),
    h('span', { class: 'cs-switch__track' }), icon(ic, 's'),
    h('span', { class: 'cs-grow' }, h('strong', {}, title), h('span', { class: 'cs-soft cs-small cs-perm__hint' }, hint))));
  return new Promise((resolve) => {
    openModal({
      title: `Allow Circle Studio in ${name}?`,
      size: 'narrow',
      body: h('div', { class: 'cs-stack' },
        h('p', { class: 'cs-mono cs-soft cs-perm__path' }, path),
        h('div', { class: 'cs-perm cs-perm--fixed' }, icon('check', 's'), h('span', { class: 'cs-grow' }, h('strong', {}, 'Read files'), h('span', { class: 'cs-soft cs-small cs-perm__hint' }, 'Always. Secrets are never shown.'))),
        ...rows),
      actions: [
        { label: 'Cancel', kind: 'quiet', onClick: (c) => c.close(null) },
        { label: confirmLabel, kind: 'primary', onClick: (c) => c.close({ ...value }) },
      ],
      onClose: (r) => resolve(r),
    });
  });
}

export const permissionSummary = (p) => [p.write && 'change files', p.run && 'run scripts', p.claude && 'Claude'].filter(Boolean);
