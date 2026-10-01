// The one place that applies a change set: show the diff, the commands that will run and the
// warnings; write only when the human presses Apply. Cancel writes nothing.
import { api } from '../api.js';
import { h, icon, plural, statusPill } from '../dom.js';
import { openModal, toast } from './overlay.js';

const VIA = { 'apply-models.mjs': 'written by apply-models.mjs' };

export function renderFile(f) {
  const total = f.diff.added + f.diff.removed;
  const body = h('div', { class: 'cs-diff__body' });
  if (f.binary) body.append(h('div', { class: 'cs-diff__hunk' }, `Binary file, ${f.bytes} bytes`));
  else if (!f.diff.hunks.length) body.append(h('div', { class: 'cs-diff__hunk' }, 'No visible change'));
  for (const hunk of f.diff.hunks) {
    body.append(h('div', { class: 'cs-diff__hunk' }, `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`));
    for (const l of hunk.lines) {
      const cls = l.t === '+' ? 'cs-diff__line--add' : l.t === '-' ? 'cs-diff__line--del' : '';
      body.append(h('div', { class: ['cs-diff__line', cls] }, h('span', { class: 'cs-diff__mark', 'aria-hidden': 'true' }, l.t === ' ' ? '' : l.t),
        h('span', { class: 'cs-sr' }, l.t === '+' ? 'added: ' : l.t === '-' ? 'removed: ' : ''), l.text || ' '));
    }
  }
  return h('details', { class: 'cs-diff__file', open: total <= 80 || undefined },
    h('summary', { class: 'cs-diff__head' },
      h('strong', {}, f.path),
      h('span', { class: `cs-pill ${f.status === 'added' ? 'cs-pill--ok' : 'cs-pill--info'}` }, f.status === 'added' ? 'new file' : 'changed'),
      f.via !== 'app' ? h('span', { class: 'cs-pill cs-pill--quiet' }, VIA[f.via] || f.via) : null,
      f.eol === 'crlf' ? h('span', { class: 'cs-pill cs-pill--quiet', title: 'This file uses Windows line endings; they are kept.' }, 'CRLF kept') : null,
      h('span', { class: 'cs-grow' }),
      h('span', { class: 'cs-diff__count' }, `+${f.diff.added} -${f.diff.removed}`)),
    f.redacted ? h('div', { class: 'cs-banner cs-banner--info' }, icon('shield', 's'), 'Secret values are hidden in this view. The file is written with its real text.') : null,
    body);
}

function warningList(warnings) {
  if (!warnings?.length) return null;
  return h('div', { class: 'cs-stack cs-stack--tight' }, warnings.map((w) => h('div', { class: 'cs-banner cs-banner--warn' }, h('span', { class: 'cs-banner__icon' }, icon('warning', 's')), h('span', {}, w))));
}

function resultView(r, applied) {
  return h('div', { class: 'cs-stack' },
    h('div', { class: 'cs-banner cs-banner--ok' }, h('span', { class: 'cs-banner__icon' }, icon('check', 's')),
      h('span', {}, `Written: ${[...r.applied, ...r.viaScript].length ? plural(r.applied.length + r.viaScript.length, 'file') : 'nothing'}.`, r.backup ? ` The previous versions are in data/${r.backup}.` : '')),
    r.applied.length ? h('div', {}, h('div', { class: 'cs-eyebrow' }, 'Circle Studio wrote'), h('ul', { class: 'cs-mono' }, r.applied.map((p) => h('li', {}, p)))) : null,
    r.viaScript.length ? h('div', {}, h('div', { class: 'cs-eyebrow' }, 'Written by the project\'s own script'), h('ul', { class: 'cs-mono' }, r.viaScript.map((p) => h('li', {}, p)))) : null,
    ...r.commands.map((c) => h('div', { class: 'cs-stack cs-stack--tight' },
      h('div', { class: 'cs-row' }, statusPill(c.ok ? 'ok' : 'danger', c.ok ? 'Ran' : 'Failed'), h('strong', {}, c.label)),
      c.output ? h('pre', { class: 'cs-cmd' }, c.output) : null)),
    warningList(r.warnings),
    applied ? null : null);
}

/**
 * Preview `ops` for a project, let the human read the diff, and apply on confirmation.
 * Resolves with the apply result, or null when nothing was written.
 */
export async function reviewChanges({ projectId, ops, title = 'Review changes', applyLabel = 'Apply changes' }) {
  let cs;
  try {
    cs = await api.previewChanges(projectId, ops);
  } catch (e) {
    toast(e.message, { kind: 'danger', ms: 9000 });
    return null;
  }
  if (!cs.files.length) {
    toast(cs.warnings.find((w) => w === 'Nothing would change.') || 'Nothing would change.', { kind: 'info' });
    return null;
  }
  return new Promise((resolve) => {
    const added = cs.files.reduce((n, f) => n + f.diff.added, 0);
    const removed = cs.files.reduce((n, f) => n + f.diff.removed, 0);
    const body = h('div', { class: 'cs-stack' },
      h('p', { class: 'cs-soft' }, `${plural(cs.files.length, 'file')} would change (+${added} -${removed}). Nothing is written until you press ${applyLabel}.`),
      warningList(cs.warnings),
      h('div', {}, cs.files.map(renderFile)),
      cs.commands.length ? h('div', { class: 'cs-stack cs-stack--tight' }, h('div', { class: 'cs-eyebrow' }, 'Commands that will run afterwards'),
        cs.commands.map((c) => h('div', {}, h('div', { class: 'cs-cmd' }, `${c.cmd} ${c.args.join(' ')}`), h('div', { class: 'cs-soft cs-small' }, `${c.label}. Runs in the project folder, no shell.`)))) : null);
    let result = null;
    const ctrl = openModal({
      title,
      size: 'wide',
      body,
      actions: [
        { id: 'cancel', label: 'Cancel', kind: 'quiet', onClick: (c) => c.close(null) },
        {
          id: 'apply',
          label: applyLabel,
          kind: 'primary',
          onClick: async (c) => {
            c.setBusy(true);
            try {
              result = await api.applyChanges(cs.id);
              body.replaceChildren(resultView(result, true));
              c.button('cancel').remove();
              c.button('apply').replaceWith(h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: () => c.close(result) }, 'Done'));
              c.el.querySelector('.cs-modal__foot .cs-btn')?.focus();
              const failed = result.commands.some((x) => !x.ok);
              toast(failed ? 'Written, but a command failed. See the details.' : 'Changes written.', { kind: failed ? 'warn' : 'ok' });
            } catch (e) {
              c.setBusy(false);
              c.button('apply').disabled = true;
              body.replaceChildren(h('div', { class: 'cs-banner cs-banner--danger' }, h('span', { class: 'cs-banner__icon' }, icon('danger', 's')), h('span', {}, e.message, e.code === 'conflict' ? ' Close this and open the review again to see the current diff.' : '')));
            }
          },
        },
      ],
      onClose: (r) => resolve(r && r.applied ? r : result),
      initialFocus: '.cs-btn--primary',
    });
    return ctrl;
  });
}
