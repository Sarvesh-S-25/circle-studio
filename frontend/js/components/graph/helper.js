// The workflow helper beside the graph: Circle Studio's own agent. Ask it for the best workflow for this project;
// it answers and may propose a change, which you see as a list and apply to the graph. Nothing is saved until you
// save a version.
import { api } from '../../api.js';
import { h, icon, plural } from '../../dom.js';
import { renderMarkdown } from '../../markdown.js';
import { state, refreshSkills, refreshShell } from '../../state.js';
import { toast } from '../overlay.js';

const STARTERS = [
  'What is the best workflow for this project?',
  'Make it lighter: only what a small project needs',
  'Where should an engine check the work instead of me?',
  'Which agents do not need to ask other engines?',
];
const FIND_SKILLS = 'Find skills on GitHub for these agents';
const githubLinks = (t) => [...new Set((String(t).match(/https:\/\/(?:www\.)?github\.com\/[^\s)>"'?#]+/g) || []).map((u) => u.replace(/[.,;:!]+$/, '')))];
const kStars = (n) => (n == null ? '' : n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k stars` : `${n} stars`);

/**
 * mountHelper(side, { project, getWorkflow, onApply(workflow), onClose }) -> { destroy }
 * The conversation lives as long as the Workflow tab is open (`memory` keeps it across open/close).
 */
export function mountHelper(side, { project, getWorkflow, onApply, onClose, memory }) {
  const msgs = memory.messages;
  const log = h('div', { class: 'cs-helper__log', role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { class: 'cs-textarea', id: 'helper-input', rows: 3, placeholder: 'Describe the project or ask for a change' });
  const send = h('button', { class: 'cs-btn cs-btn--primary', type: 'button' }, icon('send', 's'), 'Ask');
  let busy = false;
  const allowed = project.permissions?.claude === true;
  const claudeOk = state.engines.find((e) => e.id === 'claude')?.usable !== false;

  function proposalCard(m) {
    const applied = m.applied;
    return h('div', { class: 'cs-helper__proposal' },
      h('div', { class: 'cs-eyebrow' }, `Proposed change${m.changes.length === 1 ? '' : 's'} (${m.changes.length})`),
      h('ul', { class: 'cs-helper__changes' }, m.changes.slice(0, 30).map((c) => h('li', {}, c)), m.changes.length > 30 ? h('li', { class: 'cs-soft' }, `and ${m.changes.length - 30} more`) : null),
      m.warnings.length ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, m.warnings.join(' '))) : null,
      applied
        ? h('p', { class: 'cs-soft cs-small' }, icon('check', 's'), ' Applied to the graph. Press Save version to keep it.')
        : h('div', { class: 'cs-row' },
          h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button', onclick: () => { onApply(m.proposal); m.applied = true; draw(); toast('Applied to the graph. Nothing is saved until you save a version.', { kind: 'ok' }); } }, icon('check', 's'), 'Apply to the graph'),
          h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: () => { m.proposal = null; m.changes = []; draw(); } }, 'Dismiss')));
  }

  /* ---- skills from GitHub: found, explained, ticked by the human, then imported and given to their agents ---- */
  const agentTitle = (id) => getWorkflow().nodes.find((n) => n.id === id)?.title || id;

  function skillsCard(m) {
    const r = m.skills;
    if (m.done) return h('div', { class: 'cs-helper__proposal' }, ...m.done);
    const boxes = new Map();
    const go = h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button' });
    const upd = () => { const n = [...boxes.values()].filter((b) => b.checked).length; go.disabled = !n || m.busy; go.replaceChildren(icon('download', 's'), m.busy ? 'Adding...' : n ? `Add ${plural(n, 'skill')}` : 'Tick the skills you want'); };
    const rows = r.suggestions.map((s) => {
      const cb = h('input', { type: 'checkbox', checked: true, 'aria-label': `Add ${s.key}`, onchange: upd });
      boxes.set(s.id, cb);
      return h('label', { class: 'cs-helper__skill' }, cb,
        h('span', { class: 'cs-stack cs-stack--tight cs-grow' },
          h('span', { class: 'cs-row cs-row--wrap' }, h('strong', {}, s.key), s.agents.length ? h('span', { class: 'cs-pill cs-pill--quiet' }, `for ${s.agents.map(agentTitle).join(', ')}`) : null),
          h('span', {}, s.plain || s.description),
          s.why ? h('span', { class: 'cs-soft cs-small' }, s.why) : null,
          h('span', { class: 'cs-soft cs-small' }, h('a', { href: `${s.repo.url}${s.dir ? `/tree/${encodeURIComponent(s.ref)}/${s.dir.split('/').map(encodeURIComponent).join('/')}` : ''}`, target: '_blank', rel: 'noopener noreferrer' }, s.repo.fullName), s.repo.official ? ' · official (Anthropic)' : s.repo.stars != null ? ` · ${kStars(s.repo.stars)}` : '')));
    });
    go.addEventListener('click', () => addSkills(m, r.suggestions.filter((s) => boxes.get(s.id)?.checked)));
    upd();
    return h('div', { class: 'cs-helper__proposal' },
      h('div', { class: 'cs-eyebrow' }, r.suggestions.length ? `Skills that would help (${r.suggestions.length})` : 'No skills to suggest'),
      r.note ? h('p', { class: 'cs-small' }, r.note) : null,
      r.suggestions.length ? [h('div', { class: 'cs-stack cs-stack--tight' }, rows),
        h('p', { class: 'cs-soft cs-small' }, 'A skill is a set of instructions an agent reads when a task needs it, like a how-to card. Add only what you trust: each one links to its source.'),
        h('div', { class: 'cs-row cs-row--wrap' }, go, h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: () => { m.done = [h('p', { class: 'cs-soft cs-small' }, 'Dismissed.')]; draw(); } }, 'No thanks'))] : null,
      r.alreadyHave.length || r.fromPlugins?.length ? h('p', { class: 'cs-soft cs-small' }, `You already have: ${[...new Set([...r.alreadyHave, ...(r.fromPlugins || [])])].slice(0, 12).join(', ')}.`) : null,
      h('details', { class: 'cs-details cs-small' }, h('summary', {}, `Where I looked (${plural(r.searched.length, 'collection')})`),
        r.needs.length ? h('p', {}, `What the team lacks: ${r.needs.map((n) => n.need).join('; ')}.`) : null,
        h('p', { class: 'cs-soft' }, r.searched.join(', ') || 'nowhere'),
        r.skipped.length ? h('ul', { class: 'cs-helper__changes' }, r.skipped.map((x) => h('li', {}, `${x.repo}: ${x.reason}`))) : null));
  }

  async function addSkills(m, picked) {
    if (!picked.length) return;
    m.busy = true;
    draw();
    const imported = [];
    const problems = [];
    const byRepo = new Map();
    for (const s of picked) { const k = `${s.repo.url}@${s.ref}`; if (!byRepo.has(k)) byRepo.set(k, []); byRepo.get(k).push(s); }
    for (const list of byRepo.values()) {
      try {
        const res = await api.fetchSkills({ url: list[0].repo.url, ref: list[0].ref, picks: list.map((s) => s.dir) });
        for (const key of res.imported) imported.push({ key, s: list.find((x) => x.key === key) || list[0] });
        for (const c of res.conflicts) { const s = list.find((x) => x.key === c.key); if (s) imported.push({ key: c.key, s }); } // already in the library: still give it to its agents
        for (const x of res.skipped) problems.push(`${x.dir}: ${x.reason}`);
      } catch (e) { problems.push(`${list[0].repo.fullName}: ${e.message}`); }
    }
    await Promise.all([refreshSkills(), refreshShell()]).catch(() => {});
    // give each skill to the agents it is for, on the graph (saved with the next version, like any other edit)
    const wf = structuredClone(getWorkflow());
    let given = 0;
    for (const { key, s } of imported) {
      for (const id of s.agents) {
        const n = wf.nodes.find((x) => x.id === id && x.kind === 'agent');
        if (n && !(n.skills || []).includes(key)) { n.skills = [...(n.skills || []), key]; given++; }
      }
    }
    if (given) onApply(wf);
    m.busy = false;
    m.done = [
      imported.length ? h('div', { class: 'cs-banner cs-banner--ok' }, icon('check', 's'), h('span', {}, `Added to your library: ${imported.map((x) => x.key).join(', ')}.${given ? ' Given to their agents on the graph: press Save version to keep it.' : ''}`)) : null,
      ...problems.map((p) => h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, p))),
    ].filter(Boolean);
    draw();
    if (imported.length) toast(`${plural(imported.length, 'skill')} added.`, { kind: 'ok' });
  }

  async function findSkills(text = '') {
    if (busy) return;
    if (!allowed) { toast('Allow "send text to an engine" for this project first (Permissions).', { kind: 'warn' }); return; }
    const links = githubLinks(text);
    msgs.push({ role: 'you', text: text || FIND_SKILLS });
    input.value = '';
    busy = links.length ? 'links' : 'skills';
    send.disabled = true;
    draw();
    try {
      const r = await api.discoverSkills(project.id, { workflow: getWorkflow(), message: text, links });
      msgs.push({ role: 'helper', text: '', skills: r, models: r.models });
    } catch (e) {
      msgs.push({ role: 'helper', text: '', error: e.detail?.resetAt ? `${e.message} Try again after ${new Date(e.detail.resetAt).toLocaleTimeString()}.` : e.message });
    } finally {
      busy = false;
      send.disabled = false;
      draw();
    }
  }

  function draw() {
    log.replaceChildren();
    if (!msgs.length) {
      log.append(h('div', { class: 'cs-helper__intro' },
        h('p', {}, 'I design the workflow for this project: which stages, which agents on which engine, and where the work stops for you or for an engine to check it.'),
        h('div', { class: 'cs-helper__starters' }, STARTERS.map((t) => h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => ask(t) }, t)),
          h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => findSkills() }, icon('github', 's'), FIND_SKILLS)),
        h('p', { class: 'cs-soft cs-small' }, 'Have a GitHub link with skills? Paste it below and I will show what is in it.')));
    }
    for (const m of msgs) {
      if (m.role === 'you') { log.append(h('div', { class: 'cs-helper__msg cs-helper__msg--you' }, m.text)); continue; }
      if (m.skills) { log.append(h('div', { class: 'cs-helper__msg' }, m.error ? null : skillsCard(m), m.models?.length ? h('div', { class: 'cs-soft cs-small' }, m.models.join(', ')) : null)); continue; }
      log.append(h('div', { class: 'cs-helper__msg' }, m.error ? h('div', { class: 'cs-banner cs-banner--danger' }, icon('danger', 's'), h('span', {}, m.error)) : renderMarkdown(m.text),
        m.proposal ? proposalCard(m) : null,
        m.read ? h('details', { class: 'cs-details cs-small' }, h('summary', {}, `Read: the project folder${m.read.blocks.length ? `, ${m.read.blocks.length} building blocks` : ''}${m.read.passages.length ? `, ${m.read.passages.length} passages from links` : ''}`),
          m.read.blocks.length ? h('ul', { class: 'cs-helper__changes' }, m.read.blocks.map((b) => h('li', {}, b))) : null,
          m.read.passages.length ? h('p', { class: 'cs-soft' }, `From: ${m.read.passages.join(', ')}`) : null) : null,
        m.models?.length ? h('div', { class: 'cs-soft cs-small' }, `${m.models.join(', ')}${m.ms ? `, ${(m.ms / 1000).toFixed(0)} s` : ''}`) : null));
    }
    if (busy) log.append(h('div', { class: 'cs-loading' }, icon('spinner', 'm'), busy === 'skills' ? 'Working out what your agents lack, then searching GitHub. This takes a minute or two.' : busy === 'links' ? 'Reading the skills at that link...' : 'Thinking about your workflow. This can take up to two minutes.'));
    log.scrollTop = log.scrollHeight;
  }

  async function ask(text) {
    const message = (text ?? input.value).trim();
    if (!message || busy) return;
    // a GitHub link: show the skills in it (with what each is for) instead of redesigning the workflow
    if (githubLinks(message).length) { findSkills(message); return; }
    if (!allowed) { toast('Allow "send text to an engine" for this project first (Permissions).', { kind: 'warn' }); return; }
    const history = msgs.filter((m) => m.text && !m.error).map((m) => ({ role: m.role, text: m.text })).slice(-6);
    msgs.push({ role: 'you', text: message });
    input.value = '';
    busy = true;
    send.disabled = true;
    draw();
    try {
      const r = await api.suggestWorkflow(project.id, { message, workflow: getWorkflow(), history });
      msgs.push({ role: 'helper', text: r.reply, proposal: r.proposal, changes: r.changes || [], warnings: r.warnings || [], models: r.models, ms: r.ms, read: r.read });
    } catch (e) {
      msgs.push({ role: 'helper', text: '', error: e.message });
    } finally {
      busy = false;
      send.disabled = false;
      draw();
      input.focus();
    }
  }

  send.addEventListener('click', () => ask());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ask(); } });

  side.replaceChildren(h('aside', { class: 'cs-inspector cs-helper', 'aria-label': 'Workflow helper' },
    h('div', { class: 'cs-inspector__head' }, icon('sparkle', 'm'), h('h2', { class: 'cs-h3 cs-grow' }, 'Workflow helper'),
      msgs.length ? h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: () => { msgs.length = 0; draw(); } }, 'Clear') : null,
      h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Close the helper', onclick: onClose }, icon('close', 'm'))),
    !allowed ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('lock', 's'), h('span', {}, 'This project does not allow sending text to an engine. Turn it on under Permissions to use the helper.'))
      : !claudeOk ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, 'The helper runs on Claude, which is not signed in.')) : null,
    log,
    h('div', { class: 'cs-stack cs-stack--tight' }, h('label', { class: 'cs-sr', for: 'helper-input' }, 'Ask the workflow helper'), input,
      h('div', { class: 'cs-row' }, h('span', { class: 'cs-soft cs-small cs-grow' }, 'Sent to Claude through your login. Ctrl+Enter'),
        h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', title: FIND_SKILLS, onclick: () => findSkills() }, icon('github', 's'), 'Find skills'), send))));
  draw();
  return { destroy() { side.replaceChildren(); }, ask };
}
