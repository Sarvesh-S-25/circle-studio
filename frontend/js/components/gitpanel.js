// Git and GitHub for one project: a header chip (branch and sync) and a panel with the last commit, GitHub Actions runs
// and open pull requests. GitHub is read only after the human turns it on for the project. Read only: the human does git.
import { api } from '../api.js';
import { h, icon, timeAgo } from '../dom.js';
import { openModal, openMenu, confirmDialog, toast } from './overlay.js';

const RUN_ICON = (r) => (r.status !== 'completed' ? 'spinner' : r.conclusion === 'success' ? 'check' : r.conclusion === 'skipped' || r.conclusion === 'cancelled' ? 'minus' : 'danger');
const RUN_WORD = (r) => (r.status !== 'completed' ? (r.status === 'queued' ? 'queued' : 'running') : r.conclusion || 'done');

/** The header chip: "main · 2 to push". Empty when the folder is not a git repository. */
export function gitChip(project) {
  const chip = h('button', { class: 'cs-chip cs-gitchip', type: 'button', hidden: true, onclick: () => openGitPanel(project) });
  api.git(project.id).then((g) => {
    const r = g.repo;
    if (!r.isRepo) return;
    const bits = [r.branch || 'detached'];
    if (r.ahead) bits.push(`${r.ahead} to push`);
    if (r.behind) bits.push(`${r.behind} to pull`);
    if (r.changed) bits.push(`${r.changed} changed`);
    const run = g.github?.runs?.[0];
    chip.replaceChildren(icon('git', 's'), bits.join(' · '), run ? h('span', { class: `cs-gitchip__ci cs-gitchip__ci--${run.status !== 'completed' ? 'run' : run.conclusion === 'success' ? 'ok' : 'bad'}`, title: `${run.name}: ${RUN_WORD(run)}` }, icon(RUN_ICON(run), 's')) : null);
    chip.title = 'Git and GitHub for this project';
    chip.hidden = false;
  }).catch(() => {});
  return chip;
}

export function openGitPanel(project) {
  const body = h('div', { class: 'cs-stack' }, h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Reading git...'));
  const ctrl = openModal({ title: `Git · ${project.name}`, body, size: 'wide', actions: [{ label: 'Close', value: null }] });

  async function draw(fresh = false) {
    let g;
    try { g = await api.git(project.id, fresh); } catch (e) { body.replaceChildren(h('p', { class: 'cs-soft' }, e.message)); return; }
    const r = g.repo;
    if (!r.isRepo) { body.replaceChildren(h('p', {}, 'This folder is not a git repository.')); return; }
    const sync = !r.upstream ? 'No upstream branch: nothing to compare with.'
      : !r.ahead && !r.behind ? `In sync with ${r.upstream}.`
        : [r.ahead ? `${r.ahead} commit${r.ahead === 1 ? '' : 's'} to push` : '', r.behind ? `${r.behind} to pull` : ''].filter(Boolean).join(', ') + ` (${r.upstream}).`;
    const parts = [
      h('dl', { class: 'cs-kv' },
        h('dt', {}, 'Branch'), h('dd', {}, h('span', { class: 'cs-mono' }, r.branch || 'detached')),
        h('dt', {}, 'Sync'), h('dd', {}, sync),
        h('dt', {}, 'Changes'), h('dd', {}, r.changed ? `${r.changed} file${r.changed === 1 ? '' : 's'} not committed${r.untracked ? ` (${r.untracked} new)` : ''}` : 'Nothing uncommitted'),
        r.lastCommit ? h('dt', {}, 'Last commit') : null, r.lastCommit ? h('dd', {}, h('span', { class: 'cs-mono' }, r.lastCommit.hash), ` ${r.lastCommit.subject} · ${timeAgo(r.lastCommit.at)}`) : null,
        r.remote ? h('dt', {}, 'Remote') : null, r.remote ? h('dd', {}, r.remote.url ? h('a', { href: r.remote.url, target: '_blank', rel: 'noreferrer' }, r.remote.url.replace('https://', '')) : r.remote.name) : null),
      h('p', { class: 'cs-soft cs-small' }, 'You do git yourself: Circle Studio only reads it.'),
    ];
    if (r.remote?.github) {
      if (!g.githubEnabled) {
        parts.push(h('div', { class: 'cs-card cs-stack cs-stack--tight' }, h('strong', {}, 'GitHub Actions and pull requests'),
          h('p', { class: 'cs-soft cs-small' }, `Reads ${r.remote.github.owner}/${r.remote.github.repo} from GitHub every time you look (cached for a minute). Uses the gh CLI when installed, else GitHub's public API.`),
          h('div', {}, h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button', onclick: async () => { await api.setGithub(project.id, true); draw(true); } }, icon('github', 's'), 'Show GitHub status'))));
      } else {
        const gh = g.github;
        const runs = gh?.runs || [];
        const prs = gh?.prs || [];
        parts.push(h('div', { class: 'cs-stack cs-stack--tight' },
          h('div', { class: 'cs-row cs-row--between' }, h('strong', {}, 'GitHub'), h('div', { class: 'cs-row' },
            h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: () => draw(true) }, icon('refresh', 's'), 'Refresh'),
            h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: async () => { await api.setGithub(project.id, false); draw(); } }, 'Stop reading GitHub'))),
          gh?.error ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, gh.error)) : null,
          !gh?.error ? h('div', { class: 'cs-eyebrow' }, 'Actions') : null,
          !gh?.error && !runs.length ? h('p', { class: 'cs-soft cs-small' }, 'No workflow runs.') : null,
          runs.length ? h('ul', { class: 'cs-gitlist' }, runs.map((x) => h('li', {}, h('span', { class: `cs-gitlist__ic cs-gitlist__ic--${x.status !== 'completed' ? 'run' : x.conclusion === 'success' ? 'ok' : 'bad'}` }, icon(RUN_ICON(x), 's')),
            h('a', { href: x.url, target: '_blank', rel: 'noreferrer', class: 'cs-grow' }, x.title || x.name), h('span', { class: 'cs-soft cs-small' }, `${x.name} · ${x.branch || ''} · ${RUN_WORD(x)} · ${timeAgo(x.at)}`)))) : null,
          !gh?.error ? h('div', { class: 'cs-eyebrow' }, 'Open pull requests') : null,
          !gh?.error && !prs.length ? h('p', { class: 'cs-soft cs-small' }, 'None open.') : null,
          prs.length ? h('ul', { class: 'cs-gitlist' }, prs.map((p) => h('li', {}, h('span', { class: 'cs-mono cs-soft' }, `#${p.number}`), h('a', { href: p.url, target: '_blank', rel: 'noreferrer', class: 'cs-grow' }, p.title), p.draft ? h('span', { class: 'cs-pill cs-pill--quiet' }, 'draft') : null))) : null,
          gh?.source ? h('p', { class: 'cs-soft cs-small' }, gh.source === 'gh' ? 'Read with the gh CLI.' : 'Read from the public GitHub API. Install the gh CLI (and run gh auth login) for private repositories.') : null));
      }
    }
    body.replaceChildren(...parts);
  }
  draw();
  return ctrl;
}

/** The "Widget" menu of a project: open its widget window, or pin it to the Desktop or Start menu. */
export async function widgetMenu(anchor, project) {
  let sc = null;
  try { sc = (await api.desktopStatus(project.id)).shortcuts; } catch { /* not Windows */ }
  const pin = (where, label) => ({
    label: where === 'desktop' ? (sc?.[where] ? 'Remove the Desktop shortcut' : 'Add a Desktop shortcut (opens a window)') : sc?.[where] ? `Remove from ${label}` : `Pin to ${label}`,
    icon: sc?.[where] ? 'unlock' : 'pin',
    onSelect: async () => {
      if (!sc?.[where] && !(await confirmDialog({ title: `Pin ${project.name} to ${label}?`, message: `Adds a "${project.name} - Circle Studio" shortcut to ${label}. It opens this project's widget, and starts Circle Studio first if it is not running.`, confirmLabel: 'Pin it' }))) return;
      try {
        await api.shortcut({ where, projectId: project.id, remove: Boolean(sc?.[where]) });
        toast(sc?.[where] ? `Removed from ${label}.` : `Pinned to ${label}.`, { kind: 'ok' });
      } catch (e) { toast(e.message, { kind: 'danger' }); }
    },
  });
  openMenu({ anchor, label: 'Widget', items: [
    { group: 'On the desktop' },
    { label: 'Put its agents and workflow on the desktop', icon: 'pin', onSelect: async () => {
      try {
        const cur = (await api.settings()).settings.widgets || [];
        const has = (k) => cur.some((t) => t.kind === k && t.projectId === project.id);
        const add = [...(has('status') ? [] : [{ kind: 'status', size: 'm', projectId: project.id }]), ...(has('workflow') ? [] : [{ kind: 'workflow', size: 'm', projectId: project.id }])];
        await api.saveSettings({ widgets: [...cur, ...add].slice(-16) });
        await api.desktopWidgets('start');
        toast(`${project.name} is on your desktop. Drag the tiles where you like; right-click one for options.`, { kind: 'ok' });
      } catch (e) { toast(e.message, { kind: 'danger' }); }
    } },
    { label: 'Choose desktop widgets...', icon: 'edit', onSelect: () => api.openWindow('widget').catch((e) => toast(e.message, { kind: 'danger' })) },
    { group: 'Windows' },
    { label: 'Open its widget window', icon: 'external', onSelect: () => api.openWindow('widget', project.id).catch((e) => toast(e.message, { kind: 'danger' })) },
    ...(sc ? [pin('desktop', 'a Desktop shortcut'), pin('startmenu', 'the Start menu')] : []),
  ] });
}
