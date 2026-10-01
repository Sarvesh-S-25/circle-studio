// The left taskbar: the create box, most-used skills, recent projects, navigation, Claude status.
import { h, icon, sigil } from '../dom.js';
import { state, subscribe } from '../state.js';
import { openNewProject } from './newproject.js';
import { toggleTheme, openShortcuts } from './palette.js';
import { AGENT_TYPE, SKILL_TYPE, addKeyboardPath, dragSource, dropTarget, installAgent, installSkill } from './dnd.js';
import { currentTheme } from '../state.js';

const NAV = [['#/', 'Home', 'home'], ['#/inbox', 'Inbox', 'board'], ['#/library', 'Library', 'library'], ['#/connections', 'Connections', 'link'], ['#/advisor', 'Advisor', 'advisor'], ['#/settings', 'Settings', 'settings']];

export function buildRail() {
  const root = h('nav', { class: 'cs-rail', 'aria-label': 'Taskbar' });
  const create = h('textarea', { class: 'cs-textarea cs-create__input', id: 'create-box', rows: 2, placeholder: 'What do you want to create today?', 'aria-label': 'What do you want to create today?', spellcheck: 'true' });
  create.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const idea = create.value.trim();
      create.value = '';
      openNewProject({ idea });
    }
  });

  const skillList = h('div', { class: 'cs-list', role: 'list' });
  const projectList = h('div', { class: 'cs-list', role: 'list' });
  const status = h('div', { class: 'cs-row cs-row--wrap', role: 'status' });
  const themeBtn = h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', onclick: () => { toggleTheme(); draw(); } });
  const navList = h('div', { class: 'cs-list' });

  function draw() {
    // most used skills
    skillList.replaceChildren();
    if (!state.mostUsed.length) skillList.append(h('p', { class: 'cs-soft cs-small cs-rail__title' }, 'None yet.'));
    for (const s of state.mostUsed) {
      const a = h('a', { class: 'cs-list__item', href: `#/library/${s.name}`, role: 'listitem', title: s.description || s.name }, icon('skill', 's'), h('span', { class: 'cs-list__label' }, s.name), h('span', { class: 'cs-soft cs-small' }, String(s.uses)));
      dragSource(a, SKILL_TYPE, { name: s.name });
      addKeyboardPath(a, `Add ${s.name} to`, (p) => installSkill(p.id, s.name));
      skillList.append(a);
    }
    // recent projects: each is a drop target for skills and agents
    projectList.replaceChildren();
    if (!state.recent.length) projectList.append(h('p', { class: 'cs-soft cs-small cs-rail__title' }, 'None yet.'));
    for (const p of state.recent) {
      const attn = state.attention.find((a) => a.projectId === p.id);
      const a = h('a', { class: 'cs-list__item', href: `#/projects/${p.id}/workflow`, role: 'listitem', dataset: { project: p.id }, title: p.exists ? p.path : 'This folder no longer exists' },
        sigil(p.id, 's'), h('span', { class: 'cs-list__label' }, p.name),
        !p.exists ? h('span', { class: 'cs-pill cs-pill--warn' }, 'missing') : attn ? h('span', { class: `cs-dot cs-dot--${attn.items.some((i) => i.severity === 'danger') ? 'danger' : 'warn'}`, title: attn.items.map((i) => i.title).join(', ') }) : null,
        attn ? h('span', { class: 'cs-sr' }, `Needs attention: ${attn.items.map((i) => i.title).join(', ')}`) : null);
      dropTarget(a, [SKILL_TYPE, AGENT_TYPE], (payload, type) => {
        if (!p.exists) return;
        if (type === SKILL_TYPE) installSkill(p.id, payload.name);
        else if (payload.from) installAgent(p.id, payload.role, payload.from);
      });
      projectList.append(a);
    }
    // engines (and a newer Circle Studio, when there is one)
    const ready = state.engines.filter((e) => e.usable);
    status.replaceChildren(
      state.update?.available ? h('a', { class: 'cs-rail__update', href: '#/settings', title: 'A newer Circle Studio is ready: see Settings, Updates' }, icon('download', 's'), 'Update ready') : '',h('span', { class: `cs-dot cs-dot--${!state.engines.length ? '' : ready.length ? 'ok' : 'warn'}` }),
      h('span', { class: 'cs-small cs-soft', title: state.engines.map((e) => `${e.label}: ${e.usable ? 'ready' : e.installed ? 'not signed in' : 'not installed'}`).join('\n') },
        !state.engines.length ? 'Checking engines...' : `${ready.length} of ${state.engines.length} engines ready`));
    const dark = currentTheme() === 'dark';
    themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon', 'm'));
    themeBtn.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
    themeBtn.title = themeBtn.getAttribute('aria-label');
    // nav
    const waiting = state.pending.length + state.alerts.length;
    navList.replaceChildren(...NAV.map(([href, label, ic]) => h('a', { class: 'cs-navlink', href, 'aria-current': isCurrent(href) ? 'page' : undefined }, icon(ic, 's'), label,
      href === '#/inbox' && waiting ? h('span', { class: 'cs-pill cs-pill--warn cs-navlink__count', 'aria-label': `${waiting} waiting for you` }, String(waiting)) : null)));
  }

  const isCurrent = (href) => {
    const cur = location.hash || '#/';
    return href === '#/' ? cur === '#/' || cur === '' : cur.startsWith(href);
  };

  root.append(
    h('a', { class: 'cs-brand', href: '#/', 'aria-label': 'Circle Studio, home' }, h('span', { class: 'cs-brand__mark' }, icon('mark', 'l')), 'Circle Studio'),
    h('div', { class: 'cs-create' }, h('label', { class: 'cs-sr', for: 'create-box' }, 'What do you want to create today?'), create,
),
    h('section', { class: 'cs-rail__section', 'aria-labelledby': 'rail-skills' }, h('h2', { class: 'cs-eyebrow cs-rail__title', id: 'rail-skills' }, 'Most used skills'), skillList),
    h('section', { class: 'cs-rail__section', 'aria-labelledby': 'rail-projects' }, h('h2', { class: 'cs-eyebrow cs-rail__title', id: 'rail-projects' }, 'Recent projects'), projectList),
    h('div', { class: 'cs-rail__section' }, navList),
    h('div', { class: 'cs-rail__foot' }, status,
      h('button', { class: 'cs-btn cs-rail__ask', type: 'button', title: 'What to do next, and how do I... (Ctrl+J)', onclick: () => import('./guide.js').then((m) => m.toggleGuide()) }, icon('sparkle', 's'), 'Ask Circle', h('kbd', { class: 'cs-rail__kbd' }, 'Ctrl J')),
      h('div', { class: 'cs-row' }, themeBtn,
      h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts (?)', onclick: openShortcuts }, icon('keyboard', 'm')))));

  subscribe(draw);
  window.addEventListener('hashchange', draw);
  draw();
  return { el: root, focusCreate: () => create.focus() };
}
