// The inspector drawer: pick an agent's or skill's model, and which engine answers first (Main) and
// which takes over if it cannot (Backup). Every change goes through the diff review.
import { h, icon, chainView } from '../dom.js';
import { reviewChanges } from './diffreview.js';
import { buildChain } from '../chain.js';
import { toast } from './overlay.js';

const TIERS = ['haiku', 'sonnet', 'opus'];
const TIER_HINT = { haiku: 'Cheapest', sonnet: 'Everyday', opus: 'Strongest', inherit: 'Same as the session' };
const NAMES = { gemini: 'Gemini', copilot: 'Copilot', codex: 'Codex', self: 'Claude itself' };
const MAIN_CHOICES = ['gemini', 'copilot', 'codex', 'self'];

export function renderInspector({ project, team, target, onClose, onApplied }) {
  const isAgent = target.kind === 'agent';
  const role = isAgent ? team.roles.find((r) => r.role === target.name) : null;
  const skill = !isAgent ? team.skills.find((s) => s.name === target.name) : null;
  const subject = role || skill;
  if (!subject) return h('aside', { class: 'cs-inspector' }, h('p', {}, 'That item no longer exists.'));

  const tiers = isAgent ? TIERS : [...TIERS, 'inherit'];
  const eng = isAgent ? role.engine : skill.engine;
  const chain0 = eng ? [eng.engine, ...eng.failover] : [];
  const start = {
    tier: isAgent ? role.configModel : skill.model || 'inherit',
    note: isAgent ? role.note : '',
    main: chain0[0] || '',
    backup: chain0[1] || '',
    selfEnd: chain0.includes('self'),
    web: eng?.web === true,
    enabled: isAgent ? role.enabled : null,
  };
  const cur = { ...start };
  const extrasOf = () => chain0.filter((e) => e !== 'self' && e !== cur.main && e !== cur.backup);
  const chainNow = () => (cur.main ? buildChain({ main: cur.main, backup: cur.backup, extras: extrasOf(), selfEnd: start.selfEnd }) : []);
  const chainChanged = () => chainNow().join() !== chain0.join() || cur.web !== start.web;
  const dirty = () => cur.tier !== start.tier || cur.note !== start.note || chainChanged() || cur.enabled !== start.enabled;

  const root = h('aside', { class: 'cs-inspector', 'aria-label': `${target.name} settings` });
  const review = h('button', { class: 'cs-btn cs-btn--primary', type: 'button', disabled: true }, icon('diff', 's'), 'Review changes');
  const refresh = () => { review.disabled = !dirty(); };

  const select = (id, value, options, onChange) => h('select', { class: 'cs-select', id, onchange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value || undefined }, label)));

  function draw() {
    const chain = chainNow();
    root.replaceChildren(
      h('div', { class: 'cs-row' }, icon(isAgent ? 'agent' : 'skill', 'm'), h('h2', { class: 'cs-h2 cs-grow', id: 'insp-title' }, target.name),
        h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Close', onclick: onClose }, icon('close', 'm'))),
      subject.description ? h('p', { class: 'cs-soft cs-small cs-clamp' }, subject.description) : null,
      isAgent && role.drift ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, `Agent file says ${role.agentModel}, models.json says ${role.configModel}. Saving syncs them.`)) : null,

      h('fieldset', { class: 'cs-fieldset' }, h('legend', { class: 'cs-h3' }, 'Model'),
        h('div', { class: 'cs-radios', role: 'radiogroup', 'aria-label': 'Model' }, tiers.map((t) => h('label', { class: 'cs-radio', dataset: { checked: String(cur.tier === t) } },
          h('input', { type: 'radio', name: 'tier', value: t, checked: cur.tier === t || undefined, onchange: () => { cur.tier = t; draw(); } }),
          icon(t === 'inherit' ? 'minus' : `tier-${t}`, 's'), h('span', { class: 'cs-grow' }, t), h('span', { class: 'cs-soft cs-small' }, TIER_HINT[t]))))),

      h('fieldset', { class: 'cs-fieldset' }, h('legend', { class: 'cs-h3' }, 'Who answers'),
        h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'insp-main' }, 'Main'),
          select('insp-main', cur.main, [['', eng ? 'Default' : 'Default (not set)'], ...MAIN_CHOICES.map((e) => [e, NAMES[e]])], (v) => { cur.main = v; if (v === 'self' || v === cur.backup) cur.backup = ''; draw(); })),
        h('div', { class: 'cs-field' }, h('label', { class: 'cs-field__label', for: 'insp-backup' }, 'Backup'),
          h('div', {}, (() => {
            const s = select('insp-backup', cur.backup, [['', 'None'], ...MAIN_CHOICES.filter((e) => e !== cur.main).map((e) => [e, NAMES[e]])], (v) => { cur.backup = v; draw(); });
            if (!cur.main || cur.main === 'self') s.disabled = true;
            return s;
          })())),
        chain.length ? h('p', { class: 'cs-small cs-soft' }, 'Order: ', chainView({ engine: chain[0], failover: chain.slice(1), web: cur.web, source: 'role' })) : null,
        h('label', { class: 'cs-switch' }, h('input', { class: 'cs-switch__input', type: 'checkbox', checked: cur.web || undefined, onchange: (e) => { cur.web = e.target.checked; refresh(); } }), h('span', { class: 'cs-switch__track' }), 'Web search'),
        !isAgent ? h('p', { class: 'cs-small cs-soft' }, `Applies when the skill calls consult.mjs --role ${target.name}.`) : null),

      isAgent && role.optional ? h('label', { class: 'cs-switch' }, h('input', { class: 'cs-switch__input', type: 'checkbox', checked: cur.enabled || undefined, onchange: (e) => { cur.enabled = e.target.checked; refresh(); } }), h('span', { class: 'cs-switch__track' }), 'Agent is on') : null,

      isAgent ? h('details', {}, h('summary', { class: 'cs-small cs-soft' }, 'Why this model (note)'),
        (() => { const ta = h('textarea', { class: 'cs-textarea', rows: 3, 'aria-label': 'Why this model', oninput: () => { cur.note = ta.value; refresh(); } }, cur.note); return ta; })()) : null,

      h('div', { class: 'cs-row cs-row--between' }, h('button', { class: 'cs-btn cs-btn--quiet', type: 'button', onclick: onClose }, 'Close'), review));
    refresh();
  }

  review.addEventListener('click', async () => {
    const ops = [];
    const key = target.name;
    if (isAgent && (cur.tier !== start.tier || cur.note !== start.note || role.drift)) ops.push({ op: 'model', role: key, model: cur.tier, ...(cur.note !== start.note ? { note: cur.note } : {}) });
    if (!isAgent && cur.tier !== start.tier) ops.push({ op: 'skill-model', name: key, model: cur.tier });
    if (chainChanged()) {
      const full = chainNow();
      if (!full.length) { toast('Choose a main first.', { kind: 'warn' }); return; }
      ops.push({ op: 'engines', role: key, engine: full[0], failover: full.slice(1), web: cur.web });
    }
    if (isAgent && cur.enabled !== start.enabled && role.optional) ops.push({ op: 'roster', key, value: cur.enabled === true });
    if (!ops.length) return;
    const r = await reviewChanges({ projectId: project.id, ops, title: `Change ${key}` });
    if (r) onApplied(r);
  });

  draw();
  return root;
}
