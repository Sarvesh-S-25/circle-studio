// Mods: Claude Code mods and plugins, sorted into "for every project" and "only this project" (or, on the page of its
// own, only some projects), with what each one changes: the chat's look, the prompt and context, tool checks, skills...
// Used two ways: a project's Mods tab (ctx.id is the project) and the Mods page in the menu (no project).
// A change for this project only is a diff of .claude/settings.json you review; a change for every project runs
// `claude plugin enable|disable --scope user`, the command shown before it runs.
import { api } from '../api.js';
import { h, icon, plural } from '../dom.js';
import { confirmDialog, openModal, toast } from '../components/overlay.js';
import { reviewChanges } from '../components/diffreview.js';
import { state } from '../state.js';

// Ideas to start from when asking Claude for a mod: each one a sentence Claude can build from.
const IDEAS = [
  ['A tiny game while Claude works', 'a small game in a pane that opens while Claude works, with a best score kept between sessions'],
  ['Warn before deleting files', 'a check on every shell command that stops rm, del or Remove-Item on more than one file and asks me first'],
  ['Sound when Claude is done', 'a short sound and a toast when a turn that took longer than 30 seconds finishes'],
  ['Show what the turn changed', 'a line above the prompt after each turn listing the files Claude changed'],
];

/** The words Claude gets for "make a mod": where to write it, how to check it, and to keep it small. */
export function modPrompt(idea) {
  return [
    `Make a Claude Code mod for this project: ${idea.trim()}.`,
    '',
    'Write it as a plugin folder at .claude/skills/<short-name>/ (lowercase words joined by hyphens), so it loads in this project only:',
    '.claude-plugin/plugin.json, hooks/hooks.json ({ "modules": ["./register.tsx"] }) and hooks/register.tsx.',
    'Use the plugin-authoring skill for the API, but write the files in that folder, not in the dev-mods folder.',
    'Add a small hooks/<name>.test.ts for what it does. Then run claude plugin validate .claude/skills/<short-name> and claude plugin test .claude/skills/<short-name>, and fix what they report.',
    'Keep it small. When it works, tell me in two or three plain sentences what it does and how to use it.',
  ].join('\n');
}

const ORDER = ['look', 'context', 'checks', 'commands', 'skills', 'agents', 'tools', 'scripts', 'sound'];

export async function mount(el, ctx = {}) {
  const projectId = ctx.id || null;
  const projectName = ctx.project?.name || '';
  let filter = 'all';
  let data = null;

  const filters = h('div', { class: 'cs-mods__filters', role: 'group', 'aria-label': 'Show mods that change' });
  const makeEl = h('section', { class: 'cs-card cs-stack cs-mods__make', 'aria-labelledby': 'mods-make-h' });
  drawMake();

  /** Make your own: Circle Studio's ready-made mods, or a mod Claude builds from what you say. */
  async function drawMake() {
    const live = state.projects.filter((p) => p.exists);
    let target = projectId || live[0]?.id || '';
    const pickProject = projectId || live.length < 2 ? null : h('select', { class: 'cs-select', 'aria-label': 'Project', onchange: (e) => { target = e.target.value; } }, live.map((p) => h('option', { value: p.id }, p.name)));
    const idea = h('textarea', { class: 'cs-textarea', rows: 2, id: 'mod-idea', placeholder: 'For example: a tiny game while Claude works' });
    const ask = () => {
      const text = idea.value.trim();
      if (!text) { idea.focus(); toast('Say what the mod should do first.', { kind: 'warn' }); return; }
      if (!target) { toast('Add a project on Home first: a mod is made inside a project folder.', { kind: 'warn' }); return; }
      try { sessionStorage.setItem(`circle:prefill:${target}`, modPrompt(text)); } catch { /* storage off: the chat opens empty */ }
      location.hash = `#/projects/${target}/chat`;
    };
    let starters = [];
    try { starters = (await api.modStarters()).starters; } catch { /* the section still offers Claude */ }
    const add = async (st) => {
      if (!target) { toast('Add a project on Home first.', { kind: 'warn' }); return; }
      const done = await reviewChanges({ projectId: target, ops: [{ op: 'mod-add', starter: st.name }], title: `Add the ${st.name} mod to .claude/skills`, applyLabel: 'Add it' });
      if (done) { toast(`${st.name} is in the project. Start a new Claude Code session there to use it.`, { kind: 'ok', ms: 6000 }); load(); }
    };
    makeEl.replaceChildren(
      h('div', { class: 'cs-row cs-row--wrap' }, h('h3', { class: 'cs-h3 cs-grow', id: 'mods-make-h' }, 'Make your own'), pickProject ? h('span', { class: 'cs-soft cs-small' }, 'In') : null, pickProject),
      starters.length ? h('div', { class: 'cs-mods__starters' }, starters.map((st) => h('div', { class: 'cs-mods__starter' },
        h('div', { class: 'cs-mods__name' }, h('strong', {}, st.name), h('span', { class: 'cs-soft cs-small' }, ['Ready-made mod', st.tests ? `${st.tests} test file${st.tests === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · '))),
        h('p', { class: 'cs-small cs-mods__desc' }, st.description),
        h('div', { class: 'cs-mods__actions' }, h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => add(st) }, icon('plus', 's'), projectId ? 'Add to this project' : 'Add to project'))))) : null,
      h('div', { class: 'cs-stack cs-stack--tight' },
        h('label', { class: 'cs-field__label', for: 'mod-idea' }, 'Or ask Claude to build one. What should it do?'),
        h('div', { class: 'cs-row cs-row--wrap', role: 'group', 'aria-label': 'Ideas' }, IDEAS.map(([label, text]) => h('button', { class: 'cs-chipbtn', type: 'button', onclick: () => { idea.value = text; idea.focus(); } }, label))),
        idea,
        h('div', { class: 'cs-row cs-row--wrap' }, h('span', { class: 'cs-soft cs-small cs-grow' }, 'Opens the project\'s chat with the request written out. Every file Claude writes asks you first.'),
          h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: ask }, icon('sparkle', 's'), 'Ask Claude to build it'))));
  }
  const body = h('div', { class: 'cs-stack cs-stack--loose' }, h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Reading your mods...'));
  el.append(h('div', { class: 'cs-stack cs-stack--loose cs-mods' },
    h('header', { class: 'cs-stack cs-stack--tight' },
      projectId ? h('h2', { class: 'cs-h2' }, 'Mods') : h('h1', { class: 'cs-h1', id: 'main-title' }, 'Mods'),
      h('p', { class: 'cs-soft' }, projectId
        ? 'Mods change Claude Code itself: how the chat looks, what Claude reads, how commands are checked. Plugins add skills, agents and tools. Here is what this project gets from everywhere, and what is its own.'
        : 'Mods change Claude Code itself: how the chat looks, what Claude reads, how commands are checked. Plugins add skills, agents and tools. General ones work in every project; the rest only where a project turns them on.')),
    makeEl, filters, body));

  async function load() {
    try { data = await api.mods(projectId || ''); } catch (e) {
      body.replaceChildren(h('div', { class: 'cs-empty' }, icon('warning', 'l'), h('div', { class: 'cs-empty__title' }, 'Could not read your mods'), h('p', {}, e.message)));
      return;
    }
    draw();
  }

  function drawFilters() {
    const have = new Set(data.mods.flatMap((m) => m.categories));
    const opts = [['all', 'All', data.mods.length], ...(data.mods.some((m) => m.isMod) ? [['mods', 'Mods only', data.mods.filter((m) => m.isMod).length]] : []), ...ORDER.filter((c) => have.has(c)).map((c) => [c, data.categories[c].label, data.mods.filter((m) => m.categories.includes(c)).length])];
    if (!opts.some(([k]) => k === filter)) filter = 'all';
    filters.replaceChildren(...opts.map(([k, label, n]) => h('button', {
      class: 'cs-mods__filter', type: 'button', 'aria-pressed': String(filter === k), title: k in data.categories ? data.categories[k].means : '',
      onclick: () => { filter = k; draw(); },
    }, label, h('span', { class: 'cs-mods__count' }, String(n)))));
  }

  const shown = (m) => filter === 'all' || (filter === 'mods' ? m.isMod : m.categories.includes(filter));

  function draw() {
    drawFilters();
    if (!data.mods.length) {
      body.replaceChildren(h('div', { class: 'cs-empty' }, icon('sparkle', 'l'), h('div', { class: 'cs-empty__title' }, 'No mods or plugins yet'),
        h('p', {}, 'In Claude Code, type /plugin to browse and install one. Mods are a Claude Code feature: Codex, Gemini and Copilot do not use them.')));
      return;
    }
    const groups = projectId
      ? [['general', 'For every project', 'On everywhere, from your own Claude Code settings.'], ['project', `Only ${projectName || 'this project'}`, 'On here, from this project\'s own settings or folders.'], ['off', 'Off here', 'Installed on this PC, but not on in this project.']]
      : [['general', 'For every project', 'On in every project.'], ['project', 'Only some projects', 'Off in general; the projects named turn them on.'], ['off', 'Not on anywhere', 'Installed, but no project uses them.']];
    body.replaceChildren(...groups.map(([g, title, line]) => {
      const list = data.mods.filter((m) => m.group === g && shown(m));
      return h('section', { class: 'cs-stack', 'aria-label': title },
        h('div', { class: 'cs-mods__grouphead' }, h('h3', { class: 'cs-h3' }, title), h('span', { class: 'cs-pill cs-pill--quiet' }, String(list.length)), h('span', { class: 'cs-soft cs-small' }, line)),
        list.length ? h('div', { class: 'cs-mods__grid' }, ...list.map(card)) : h('p', { class: 'cs-soft cs-small' }, filter === 'all' ? 'None.' : 'None of this kind.'));
    }));
  }

  function card(m) {
    const st = m.state || {};
    const where = projectId
      ? (m.missing ? 'Named in this project\'s settings, but not installed on this PC.'
        : st.from === 'local' ? 'Set in .claude/settings.local.json (this PC only).'
          : st.from === 'project' ? (m.installScope === 'project-skills' ? 'Its folder is in this project (.claude/skills).' : 'Set in this project\'s .claude/settings.json.')
            : st.general ? 'From your Claude Code settings.' : '')
      : [m.onIn?.length ? `On in ${m.onIn.map((p) => p.name).join(', ')}` : '', m.offIn?.length ? `Off in ${m.offIn.map((p) => p.name).join(', ')}` : ''].filter(Boolean).join('. ');
    const counts = Object.entries(m.counts || {}).filter(([, n]) => n).map(([k, n]) => plural(n, { skills: 'skill', agents: 'agent', commands: 'command', tools: 'tool' }[k] || k));
    return h('article', { class: ['cs-mods__card', m.isMod && 'cs-mods__card--mod'] },
      h('div', { class: 'cs-mods__top' },
        h('span', { class: ['cs-mods__icon', m.isMod && 'cs-mods__icon--mod'], 'aria-hidden': 'true' }, icon(m.isMod ? 'sparkle' : 'skill', 's')),
        h('div', { class: 'cs-mods__name' }, h('strong', {}, m.name), h('span', { class: 'cs-soft cs-small' }, [m.isMod ? 'Mod' : 'Plugin', m.source && m.source !== 'skills-dir' ? `from ${m.source}` : m.installScope === 'project-skills' ? (projectId ? 'in this folder' : 'in a project folder') : m.source === 'skills-dir' ? 'in your skills folder' : '', m.version ? `v${m.version}` : ''].filter(Boolean).join(' · '))),
        h('span', { class: ['cs-pill', m.group === 'off' ? 'cs-pill--quiet' : m.group === 'general' ? 'cs-pill--ok' : 'cs-pill--info'] }, m.group === 'off' ? 'Off' : m.group === 'general' ? 'Everywhere' : projectId ? 'Here only' : 'Some projects')),
      m.description ? h('p', { class: 'cs-mods__desc cs-small' }, m.description) : null,
      m.categories.length ? h('div', { class: 'cs-mods__cats' }, ...m.categories.map((c) => h('span', { class: `cs-mods__cat cs-mods__cat--${c}`, title: data.categories[c]?.means }, data.categories[c]?.label || c))) : null,
      counts.length || where ? h('p', { class: 'cs-soft cs-small cs-mods__where' }, [counts.join(', '), where].filter(Boolean).join('. ')) : null,
      h('div', { class: 'cs-mods__actions' }, ...actions(m),
        m.isMod ? h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', title: 'Load it the way Claude Code will, and run its tests', onclick: () => check(m), disabled: m.missing || undefined }, icon('check', 's'), 'Check') : null,
        h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', onclick: () => details(m), disabled: m.missing || undefined }, icon('info', 's'), 'Details')));
  }

  function actions(m) {
    const btn = (label, ic, fn, kind = '') => h('button', { class: ['cs-btn', 'cs-btn--small', kind], type: 'button', onclick: fn }, icon(ic, 's'), label);
    const st = m.state || {};
    const out = [];
    if (!projectId) {
      if (m.installScope === 'project-skills') return out; // lives in a project folder: nothing general to switch
      out.push(m.general ? btn('Off for every project', 'close', () => general(m, false)) : btn('On for every project', 'check', () => general(m, true), 'cs-btn--primary'));
      return out;
    }
    if (m.missing) { out.push(btn('Remove the setting', 'trash', () => setHere(m, null))); return out; }
    if (m.group === 'general') {
      out.push(btn('Off in this project', 'close', () => setHere(m, false)));
    } else if (m.group === 'project') {
      if (m.installScope !== 'project-skills') {
        out.push(btn('Make it general', 'globe', () => general(m, true), 'cs-btn--primary'));
        if (st.from === 'project') out.push(btn('Off in this project', 'close', () => setHere(m, st.general ? false : null)));
      }
    } else {
      out.push(btn('On in this project only', 'check', () => setHere(m, true), 'cs-btn--primary'));
      if (st.from === 'project' && st.general) out.push(btn('Use the general setting', 'undo', () => setHere(m, null)));
      else if (m.installScope !== 'missing') out.push(btn('On for every project', 'globe', () => general(m, true)));
    }
    return out;
  }

  async function setHere(m, value) {
    const verb = value === true ? 'turn on' : value === false ? 'turn off' : 'stop setting';
    const done = await reviewChanges({ projectId, ops: [{ op: 'mod-set', plugin: m.id, value }], title: `.claude/settings.json: ${verb} ${m.name} in this project`, applyLabel: 'Change it' });
    if (done) { toast(`${m.name}: done. Start a new Claude Code session to use it.`, { kind: 'ok' }); load(); }
  }

  async function general(m, on) {
    const cmd = `claude plugin ${on ? 'enable' : 'disable'} ${m.id} --scope user`;
    const ok = await confirmDialog({
      title: `${on ? 'Turn on' : 'Turn off'} ${m.name} for every project?`,
      message: on ? 'It will be on in every project, except one that turns it off in its own settings.' : 'It will be off in every project, except one that turns it on in its own settings.',
      detail: `Circle Studio runs: ${cmd}`, confirmLabel: on ? 'Turn on' : 'Turn off', danger: !on,
    });
    if (!ok) return;
    try {
      const r = await api.modGeneral(m.id, on);
      toast(r.ok ? `${m.name} is ${on ? 'on' : 'off'} for every project. New Claude Code sessions use it.` : `Claude Code said no: ${r.output || 'no reason given'}`, { kind: r.ok ? 'ok' : 'danger', ms: r.ok ? 4000 : 9000 });
    } catch (e) { toast(e.message, { kind: 'danger' }); }
    load();
  }

  /** Check a mod with Claude Code's own validator and test runner, and say the result in plain words. */
  async function check(m) {
    const out = h('div', { class: 'cs-stack' }, h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Claude Code is loading the mod and running its tests...'));
    openModal({ title: `Check ${m.name}`, body: out, size: 'wide', actions: [{ label: 'Close', kind: 'quiet' }] });
    let r;
    try { r = await api.modCheck(m.id); } catch (e) { out.replaceChildren(h('p', {}, e.message)); return; }
    const line = (ok, text) => h('p', { class: 'cs-row' }, h('span', { class: `cs-pill ${ok ? 'cs-pill--ok' : 'cs-pill--warn'}` }, ok ? 'OK' : 'Look'), text);
    out.replaceChildren(
      line(r.validate.ok, r.validate.ok ? 'It loads: Claude Code accepts its files and hooks.' : 'Claude Code would refuse part of it.'),
      r.validate.problems.length ? h('ul', { class: 'cs-prose cs-small' }, r.validate.problems.map((p) => h('li', {}, p))) : null,
      r.validate.hooks ? h('p', { class: 'cs-soft cs-small' }, `Listens to: ${r.validate.hooks}`) : null,
      r.tests ? line(r.tests.ok, r.tests.fail ? `${r.tests.fail} of ${r.tests.pass + r.tests.fail} tests failed.` : `All ${r.tests.pass} of its tests pass.`) : h('p', { class: 'cs-soft cs-small' }, 'It has no tests. Ask Claude to add one (a *.test.ts beside the module).'),
      r.tests?.failed?.length ? h('ul', { class: 'cs-prose cs-small' }, r.tests.failed.map((p) => h('li', {}, p))) : null,
      h('details', {}, h('summary', { class: 'cs-small' }, 'What Claude Code said'), h('pre', { class: 'cs-mods__details cs-mono cs-small' }, r.output || '')));
  }

  async function details(m) {
    const out = h('pre', { class: 'cs-mods__details cs-mono cs-small' }, 'Asking Claude Code...');
    openModal({ title: m.name, body: h('div', { class: 'cs-stack' },
      m.description ? h('p', {}, m.description) : null,
      m.events?.length ? h('p', { class: 'cs-soft cs-small' }, `Listens to: ${m.events.join(', ')}`) : null,
      out), size: 'wide', actions: [{ label: 'Close', kind: 'quiet' }] });
    try {
      const r = await api.modDetails(m.id);
      out.textContent = r.output || (r.ok ? 'Nothing more to say.' : 'Claude Code could not describe it.');
    } catch (e) { out.textContent = `${e.message}\n\nClaude Code is needed for this. Run "claude plugin details ${m.id}" in a terminal to see the same.`; }
  }

  await load();
  return { destroy() {} };
}
