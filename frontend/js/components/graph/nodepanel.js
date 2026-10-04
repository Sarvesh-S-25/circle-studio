// The panel beside the graph for one node: its settings (engine, model, skills, engine access, checkpoint, links,
// notes) and a chat with it.
import { api } from '../../api.js';
import { h, icon } from '../../dom.js';
import { state } from '../../state.js';
import { openMenu } from '../overlay.js';
import { capabilityNote } from '../../views/chat.js';

const MODELS = { claude: ['haiku', 'sonnet', 'opus'] };
const ENGINE_NAME = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', copilot: 'Copilot' };
const CHECK_CHOICES = [
  ['off', 'Go on', 'The next stage starts straight away.'],
  ['you', 'You decide', 'The work stops until you approve.'],
  ['engine', 'An engine checks', 'Another engine reviews the result, then the work goes on.'],
  ['both', 'Engine, then you', 'An engine reviews first, then you approve.'],
];
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

/**
 * openNodePanel(side, { node, workflow, graph, project, tab, focus }) fills `side` for one node.
 * Changes go to graph.updateNode(id, patch), which redraws the graph and reports the new workflow to its owner.
 * focus: 'checkpoint' scrolls to and focuses the stage's checkpoint section.
 */
export function openNodePanel(side, { node, workflow, graph, project, tab = 'settings', focus }) {
  if (!node) { side.replaceChildren(); return { destroy() {} }; }
  let current = tab;
  let chat = null;
  const body = h('div', { class: 'cs-npanel' });
  const tabs = h('div', { class: 'cs-tabs', role: 'tablist', 'aria-label': `${node.title}` });
  // "You" talks to the project's main session (the one that runs the team, and where your Claude Code conversations are).
  const canChat = Boolean(project);
  const chatLabel = node.kind === 'human' ? 'Main session' : 'Chat';
  let timer = null;

  const patch = (p, { soon = false } = {}) => {
    Object.assign(node, p);
    clearTimeout(timer);
    if (soon) timer = setTimeout(() => graph.updateNode(node.id, p), 250); else graph.updateNode(node.id, p);
  };

  const field = (label, control, hint) => h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label' }, label), control, hint ? h('span', { class: 'cs-field__hint' }, hint) : null);
  const text = (value, on, { area = false, rows = 3, placeholder = '' } = {}) => {
    const c = area ? h('textarea', { class: 'cs-textarea', rows, placeholder }, value ?? '') : h('input', { class: 'cs-input', value: value ?? '', placeholder });
    c.addEventListener('input', () => on(c.value));
    return c;
  };
  const sw = (label, checked, on, extra = {}) => h('label', { class: 'cs-switch' }, h('input', { class: 'cs-switch__input', type: 'checkbox', checked: checked || undefined, onchange: (e) => on(e.target.checked), ...extra }), h('span', { class: 'cs-switch__track' }), h('span', {}, label));
  const engineLabel = (e) => `${e.label}${e.usable ? '' : e.installed ? ' (not signed in)' : ' (not installed)'}`;

  function skillsRow() {
    const row = h('div', { class: 'cs-npanel__chips' }, (node.skills || []).map((n) => h('span', { class: 'cs-chip' }, icon('skill', 's'), n,
      h('button', { class: 'cs-chip__x', type: 'button', 'aria-label': `Remove ${n}`, onclick: () => { patch({ skills: node.skills.filter((x) => x !== n) }); drawSettings(); } }, icon('close', 's')))));
    const pool = state.skills.map((s) => s.name).filter((n) => !(node.skills || []).includes(n));
    const add = h('button', { class: 'cs-btn cs-btn--small cs-btn--quiet', type: 'button', disabled: !pool.length || undefined, onclick: () => openMenu({ anchor: add, label: 'Add a skill', items: [{ group: 'Add a skill' }, ...pool.map((n) => ({ label: n, icon: 'skill', onSelect: () => { patch({ skills: [...(node.skills || []), n] }); drawSettings(); } }))] }) }, icon('plus', 's'), pool.length ? 'Add skill' : 'No skills in the library');
    row.append(add);
    return row;
  }

  function engineField() {
    const sel = h('select', { class: 'cs-select', onchange: (e) => { patch({ engine: e.target.value, consult: (node.consult || []).filter((x) => x !== e.target.value) }); drawSettings(); } },
      h('option', { value: '' }, 'Not set'),
      state.engines.map((e) => h('option', { value: e.id, selected: node.engine === e.id || undefined }, engineLabel(e))));
    const cur = state.engines.find((e) => e.id === node.engine);
    return field('Engine', sel, cur ? capabilityNote(cur) : 'Which engine runs this agent.');
  }

  /**
   * The helper beside this agent: a Haiku reader. Off; when the agent decides (it is told to hand long reads over);
   * or automatic above a share of its context (a hook shortens long command output, pages and searches).
   */
  const HELPER_CHOICES = [
    ['off', 'Off', 'It reads everything itself, in full.'],
    ['ask', 'When it decides', 'It hands long files, logs and pages to Haiku and works from a short answer. Good for reviewers and researchers; skip it for agents that edit what they read.'],
    ['auto', 'Automatically', 'Once its context is fuller than the limit below, long command output, web pages and searches are shortened by Haiku before it sees them. The full output stays in a file it can read; files it reads are never shortened.'],
  ];
  function helperSection() {
    const mode = node.condense ? 'auto' : node.reader ? 'ask' : 'off';
    const set = (next) => {
      if (next === 'off') patch({ reader: undefined, condense: undefined });
      else if (next === 'ask') patch({ reader: true, condense: undefined });
      else patch({ reader: undefined, condense: node.condense || 60 });
      drawSettings();
      root.querySelector('#npanel-helper')?.querySelector(`[data-choice="${next}"]`)?.focus();
    };
    const radios = h('div', { class: 'cs-radios', role: 'radiogroup', 'aria-label': 'Haiku reader' },
      HELPER_CHOICES.map(([v, label, hint]) => h('label', { class: 'cs-radio', dataset: { checked: String(mode === v) } },
        h('input', { type: 'radio', name: `helper-${node.id}`, value: v, checked: mode === v || undefined, dataset: { choice: v }, onchange: () => set(v) }),
        h('span', { class: 'cs-grow' }, h('strong', {}, label), h('span', { class: 'cs-radio__hint' }, hint)))));
    let limit = null;
    if (mode === 'auto') {
      const out = h('output', { class: 'cs-mono' }, `${node.condense}%`);
      const range = h('input', { type: 'range', class: 'cs-range', min: 30, max: 95, step: 5, value: node.condense, 'aria-label': 'Context limit', oninput: (e) => { out.textContent = `${e.target.value}%`; patch({ condense: Number(e.target.value) }, { soon: true }); } });
      limit = field('Start when its context is fuller than', h('div', { class: 'cs-row' }, range, out), 'Lower starts sooner (smaller context, more Haiku calls); higher keeps outputs whole for longer. 60% is a good start. Takes effect when you write the files (Review and write files), for this agent when your team runs in Claude Code. Circle Studio\'s own Chat keeps project hooks off for safety, so it does not condense there.');
    }
    return h('fieldset', { class: 'cs-fieldset cs-npanel__check', id: 'npanel-helper', tabindex: '-1' }, h('legend', { class: 'cs-h3' }, 'Helper: Haiku reader'), radios, limit);
  }

  function consultRow() {
    const others = (state.engines.length ? state.engines.map((e) => e.id) : Object.keys(ENGINE_NAME)).filter((id) => id !== node.engine);
    const on = new Set(node.consult || []);
    return h('fieldset', { class: 'cs-fieldset' }, h('legend', { class: 'cs-field__label' }, 'Can ask other engines'),
      h('div', { class: 'cs-npanel__switches' }, others.map((id) => {
        const e = state.engines.find((x) => x.id === id);
        return sw(e ? engineLabel(e) : ENGINE_NAME[id] || id, on.has(id), (v) => {
          const next = v ? [...on, id] : [...on].filter((x) => x !== id);
          patch({ consult: next });
          drawSettings();
        });
      })),
      h('span', { class: 'cs-field__hint' }, on.size ? 'Only for a second opinion; it still does the work itself.' : 'Off for every engine: this agent works on its own.'));
  }

  /** What happens when this stage is done: go on, you decide, an engine checks, or an engine then you. */
  function checkpointSection() {
    const g = node.gate || { on: false, by: 'you', label: '' };
    const choice = g.on ? g.by || 'you' : 'off';
    const set = (next) => {
      const on = next !== 'off';
      const by = on ? next : g.by || 'you';
      const engine = by === 'you' ? undefined : g.engine || state.engines.find((e) => e.usable && e.id !== 'gemini')?.id || 'claude';
      patch({ gate: { on, by, label: g.label || '', ...(engine ? { engine } : {}) } });
      drawSettings();
      root.querySelector('#npanel-check')?.querySelector(`[data-choice="${next}"]`)?.focus();
    };
    const radios = h('div', { class: 'cs-radios', role: 'radiogroup', 'aria-label': 'When this stage is done' },
      CHECK_CHOICES.map(([v, label, hint]) => h('label', { class: 'cs-radio', dataset: { checked: String(choice === v) } },
        h('input', { type: 'radio', name: `check-${node.id}`, value: v, checked: choice === v || undefined, dataset: { choice: v }, onchange: () => set(v) }),
        h('span', { class: 'cs-grow' }, h('strong', {}, label), h('span', { class: 'cs-radio__hint' }, hint)))));
    const engineSel = g.on && g.by !== 'you'
      ? field('Which engine checks', h('select', { class: 'cs-select', onchange: (e) => { patch({ gate: { ...g, engine: e.target.value } }); drawSettings(); } },
        (state.engines.length ? state.engines : Object.keys(ENGINE_NAME).map((id) => ({ id, label: ENGINE_NAME[id], usable: true, installed: true })))
          .map((e) => h('option', { value: e.id, selected: g.engine === e.id || undefined }, engineLabel(e)))),
        'It reviews in its own read-only session. An engine that is not signed in cannot check anything.')
      : null;
    const label = g.on ? field(g.by === 'engine' ? 'What it looks at' : 'What you check', text(g.label, (v) => patch({ gate: { ...node.gate, label: v } }, { soon: true }),
      { placeholder: g.by === 'engine' ? 'For example: the plan has no gaps' : 'For example: accept the stack choice' })) : null;
    return h('fieldset', { class: 'cs-fieldset cs-npanel__check', id: 'npanel-check', tabindex: '-1' }, h('legend', { class: 'cs-h3' }, 'When this stage is done'), radios, engineSel, label);
  }

  /** Links in and out of this card: remove any, add one without dragging. */
  function linksSection() {
    const wf = workflow();
    const title = (id) => wf.nodes.find((n) => n.id === id)?.title || id;
    const { out, in: inc } = graph.links(node.id);
    const row = (from, to, label) => h('li', { class: 'cs-npanel__link' }, h('span', { class: 'cs-grow' }, label),
      h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon cs-btn--small', type: 'button', 'aria-label': `Remove the link ${title(from)} to ${title(to)}`, title: 'Remove this link', onclick: () => { graph.removeEdge(from, to); drawSettings(); } }, icon('close', 's')));
    const targets = wf.nodes.filter((n) => graph.canLink(node.id, n.id));
    const add = h('select', { class: 'cs-select', 'aria-label': `Link ${node.title} to`, onchange: (e) => { if (e.target.value && graph.connect(node.id, e.target.value)) drawSettings(); } },
      h('option', { value: '' }, targets.length ? 'Link to...' : 'Nothing left to link to'),
      targets.map((n) => h('option', { value: n.id }, `${n.title}${n.kind === 'agent' ? ` (agent${n.parent ? ` in ${title(n.parent)}` : ''})` : n.kind === 'stage' ? ' (stage)' : ''}`)));
    return h('fieldset', { class: 'cs-fieldset' }, h('legend', { class: 'cs-field__label' }, 'Links'),
      out.length || inc.length
        ? h('ul', { class: 'cs-npanel__links' }, out.map((to) => row(node.id, to, `→ ${title(to)}`)), inc.map((from) => row(from, node.id, `← from ${title(from)}`)))
        : h('p', { class: 'cs-soft cs-small' }, 'No links yet.'),
      add,
      h('span', { class: 'cs-field__hint' }, 'Or drag the dot on the right of a card onto another card. Click a line on the graph to remove it.'));
  }

  function drawSettings() {
    const stages = workflow().nodes.filter((n) => n.kind === 'stage' && n.id !== node.id);
    body.replaceChildren(
      field('Name', text(node.title, (v) => patch({ title: v || node.id }, { soon: true }))),
      field(node.kind === 'stage' ? 'What happens here' : node.kind === 'human' ? 'Your part' : 'What it does', text(node.does, (v) => patch({ does: v }, { soon: true }), { area: true, rows: 2 })),
      node.kind === 'stage' ? checkpointSection() : null,
      node.kind === 'agent' ? h('div', { class: 'cs-stack' },
        engineField(),
        field('Model', (() => {
          const list = MODELS[node.engine] || [];
          const i = h('input', { class: 'cs-input', value: node.model || '', list: 'node-models', placeholder: 'Engine default' });
          i.addEventListener('input', () => patch({ model: i.value.trim() }, { soon: true }));
          return h('div', {}, i, h('datalist', { id: 'node-models' }, list.map((m) => h('option', { value: m }))));
        })()),
        consultRow(),
        node.engine === 'claude' ? helperSection() : null,
        stages.length ? field('Belongs to stage', h('select', { class: 'cs-select', onchange: (e) => patch({ parent: e.target.value }) }, stages.map((s) => h('option', { value: s.id, selected: node.parent === s.id || undefined }, s.title)))) : null,
        sw('Optional (can be switched off)', node.optional, (v) => patch({ optional: v })),
        field('Instructions', text(node.prompt, (v) => patch({ prompt: v }, { soon: true }), { area: true, rows: 3, placeholder: 'How this agent should work (added to its system prompt).' }))) : null,
      node.kind === 'stage' ? field('Skip when', text(node.skipWhen, (v) => patch({ skipWhen: v }, { soon: true }), { placeholder: 'For example: the project has no frontend' })) : null,
      linksSection(),
      node.kind !== 'human' ? field('Skills', skillsRow()) : null,
      node.kind !== 'human' ? field('Reading links', text((node.links || []).join('\n'), (v) => patch({ links: lines(v).filter((l) => /^https:\/\//i.test(l)) }, { soon: true }), { area: true, rows: 3, placeholder: 'One https:// link per line. The agent reads these first.' }), 'Only https links are kept.') : null,
      field('Notes', text(node.notes, (v) => patch({ notes: v }, { soon: true }), { area: true, rows: 2 })),
      node.kind !== 'human' ? h('div', {}, h('button', { class: 'cs-btn cs-btn--small cs-btn--danger', type: 'button', onclick: () => graph.remove(node.id) }, icon('trash', 's'), `Remove ${node.kind === 'stage' ? 'this stage' : 'this agent'}`)) : null);
  }

  async function drawChat() {
    body.replaceChildren(h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Loading...'));
    const m = await import('../../views/chat.js');
    if (!state.engines.length) { try { state.engines = (await api.engines()).engines; } catch { /* shown below */ } }
    if (!state.engines.length) { body.replaceChildren(h('p', { class: 'cs-soft' }, 'Could not check the engines. Open Settings to see why.')); return; }
    const host = h('div', { class: 'cs-npanel__chat' });
    body.replaceChildren(host);
    chat = m.mountChat(host, { project, nodeId: node.kind === 'human' ? null : node.id });
  }

  function draw() {
    chat?.destroy();
    chat = null;
    tabs.replaceChildren(...[['settings', 'Settings', 'settings'], ...(canChat ? [['chat', chatLabel, 'chat']] : [])].map(([k, label, ic]) => h('button', { class: 'cs-tab', type: 'button', role: 'tab', 'aria-selected': String(current === k), tabindex: current === k ? '0' : '-1', onclick: () => { current = k; draw(); } }, icon(ic, 's'), label)));
    if (current === 'chat' && canChat) drawChat(); else drawSettings();
  }

  const root = h('aside', { class: 'cs-inspector', 'aria-label': `${node.title} settings` },
    h('div', { class: 'cs-inspector__head' }, h('h2', { class: 'cs-h3 cs-grow' }, node.title), h('span', { class: 'cs-pill cs-pill--quiet' }, node.kind),
      h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Close the panel', onclick: () => { side.replaceChildren(); graph.select(null, { open: false }); } }, icon('close', 'm'))),
    tabs, h('div', { class: 'cs-inspector__body' }, body));
  side.replaceChildren(root);
  draw();
  if ((focus === 'checkpoint' && node.kind === 'stage') || (focus === 'helper' && node.kind === 'agent')) {
    requestAnimationFrame(() => {
      const sec = root.querySelector(focus === 'helper' ? '#npanel-helper' : '#npanel-check');
      sec?.scrollIntoView({ block: 'nearest' });
      (sec?.querySelector('input:checked') || sec)?.focus({ preventScroll: true });
    });
  }
  return { destroy() { chat?.destroy(); clearTimeout(timer); side.replaceChildren(); } };
}
