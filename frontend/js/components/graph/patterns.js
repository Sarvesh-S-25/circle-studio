// Patterns beside the graph: ways to shape the team (helpers, checkpoints, models, skills), each with when it pays off,
// when it does not and what it costs; which ones fit this team and why (from what each agent does and how much context
// it really carries); and "Try on" an agent, which puts the pattern on the graph unsaved (Undo, or Save version).
import { api } from '../../api.js';
import { h, icon, plural } from '../../dom.js';
import { toast } from '../overlay.js';

const KIND_WORD = { helper: 'Helper', checkpoint: 'Checkpoint', model: 'Model', knowledge: 'Knowledge', team: 'Team' };
const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** mountPatterns(side, { project, getWorkflow, onApply(wf), onOpenNode(node), onClose }) -> { destroy, refresh } */
export function mountPatterns(side, { project, getWorkflow, onApply, onOpenNode, onClose }) {
  const body = h('div', { class: 'cs-stack', 'aria-live': 'polite' }, h('div', { class: 'cs-loading' }, icon('spinner', 's'), 'Reading your team...'));
  let data = null;
  const tried = new Map(); // agent id + pattern -> the agent's settings before, for Undo

  const agentById = (id) => getWorkflow().nodes.find((n) => n.id === id && n.kind === 'agent');
  const agentsFor = (p) => getWorkflow().nodes.filter((n) => n.kind === 'agent' && (n.engine || 'claude') === 'claude' && !(p.id === 'reader' && n.reader) && !(p.id === 'condense' && n.condense));

  function tryOn(p, agentId) {
    const wf = structuredClone(getWorkflow());
    const n = wf.nodes.find((x) => x.id === agentId);
    if (!n || !p.apply) return;
    const before = { reader: n.reader, condense: n.condense };
    if (p.apply.reader) { n.reader = true; delete n.condense; }
    if (p.apply.condense) { n.condense = p.apply.condense; delete n.reader; }
    tried.set(`${agentId}:${p.id}`, before);
    onApply(wf);
    toast(`${p.name} for ${n.title}: on the graph, not saved. Press Save version to keep it, or Undo here.`, { kind: 'ok', ms: 6000 });
    draw();
  }
  function undo(p, agentId) {
    const before = tried.get(`${agentId}:${p.id}`);
    const wf = structuredClone(getWorkflow());
    const n = wf.nodes.find((x) => x.id === agentId);
    if (!n || !before) return;
    if (before.reader) n.reader = true; else delete n.reader;
    if (before.condense) n.condense = before.condense; else delete n.condense;
    tried.delete(`${agentId}:${p.id}`);
    onApply(wf);
    draw();
  }

  const details = (p) => h('div', { class: 'cs-stack cs-stack--tight cs-small' },
    h('p', {}, p.summary),
    h('div', {}, h('strong', {}, 'Use it when'), h('ul', { class: 'cs-prose' }, p.useWhen.map((x) => h('li', {}, x)))),
    h('div', {}, h('strong', {}, 'Not when'), h('ul', { class: 'cs-prose' }, p.avoidWhen.map((x) => h('li', {}, x)))),
    h('p', {}, h('strong', {}, 'What it costs: '), p.costs),
    h('p', { class: 'cs-soft' }, h('strong', {}, 'How here: '), p.howHere),
    p.relatesTo?.length ? h('p', { class: 'cs-soft' }, `Goes with: ${p.relatesTo.map((id) => data.patterns.find((x) => x.id === id)?.name || id).join('; ')}.`) : null);

  function fitCard(f) {
    const p = data.patterns.find((x) => x.id === f.pattern);
    if (!p) return null;
    const key = `${f.agent}:${f.pattern}`;
    const node = f.agent ? agentById(f.agent) : null;
    const on = node && ((p.id === 'reader' && node.reader) || (p.id === 'condense' && node.condense));
    return h('li', { class: 'cs-pat__fit' },
      h('div', { class: 'cs-row cs-row--wrap' }, h('strong', {}, p.name), h('span', { class: 'cs-pill cs-pill--quiet' }, f.agent ? `for ${f.title}` : `stage ${f.title}`),
        f.strength >= 3 ? h('span', { class: 'cs-pill cs-pill--ok' }, 'measured') : null),
      h('p', { class: 'cs-small' }, f.why),
      h('div', { class: 'cs-row cs-row--wrap' },
        p.apply && f.agent && !on ? h('button', { class: 'cs-btn cs-btn--small cs-btn--primary', type: 'button', onclick: () => tryOn(p, f.agent) }, icon('sparkle', 's'), `Try on ${f.title}`) : null,
        tried.has(key) ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => undo(p, f.agent) }, 'Undo') : null,
        !p.apply ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => { const n = getWorkflow().nodes.find((x) => x.id === (f.agent || f.stage)); if (n) onOpenNode(n); } }, `Open ${f.title}`) : null,
        h('details', { class: 'cs-details cs-small' }, h('summary', {}, 'Why, and the trade-offs'), details(p))));
  }

  function patternItem(p) {
    const targets = p.apply ? agentsFor(p) : [];
    const pick = targets.length ? h('select', { class: 'cs-select cs-select--small', 'aria-label': `Try ${p.name} on`, onchange: (e) => { if (e.target.value) tryOn(p, e.target.value); } },
      h('option', { value: '' }, 'Try on an agent...'), targets.map((a) => h('option', { value: a.id }, a.title))) : null;
    return h('details', { class: 'cs-pat__item' },
      h('summary', {}, h('span', { class: 'cs-pill cs-pill--quiet' }, KIND_WORD[p.kind] || p.kind), ' ', h('strong', {}, p.name)),
      details(p), pick);
  }

  function draw() {
    if (!data) return;
    const fits = data.fits.filter((f) => data.patterns.some((p) => p.id === f.pattern));
    const c = data.condensed;
    body.replaceChildren(
      h('p', { class: 'cs-soft cs-small' }, 'Ways to shape your team, each with when it pays off and when it does not. Try one: it goes on the graph unsaved, so you can look, undo, or keep it with Save version.'),
      c?.count ? h('div', { class: 'cs-banner cs-banner--ok' }, icon('check', 's'), h('span', {}, `Condensing so far (30 days): ${plural(c.count, 'long output')} shortened, about ${kTok(Math.max(0, c.was - c.now))} tokens kept out of the agents' context.`)) : null,
      h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'pat-fit' }, h('h3', { class: 'cs-h3', id: 'pat-fit' }, fits.length ? `Fits your team (${fits.length})` : 'Fits your team'),
        fits.length ? h('ul', { class: 'cs-pat__fits' }, fits.slice(0, 12).map(fitCard)) : h('p', { class: 'cs-soft cs-small' }, 'Nothing stands out for this team. Browse them below; the helper can also suggest one when you describe what you want.')),
      h('section', { class: 'cs-stack cs-stack--tight', 'aria-labelledby': 'pat-all' }, h('h3', { class: 'cs-h3', id: 'pat-all' }, 'All patterns'), h('div', { class: 'cs-stack cs-stack--tight' }, data.patterns.map(patternItem))));
  }

  async function refresh() {
    try { data = await api.patterns(project.id, getWorkflow()); draw(); } catch (e) { body.replaceChildren(h('div', { class: 'cs-banner cs-banner--danger' }, icon('danger', 's'), h('span', {}, e.message))); }
  }

  side.replaceChildren(h('aside', { class: 'cs-inspector cs-pat', 'aria-label': 'Patterns' },
    h('div', { class: 'cs-inspector__head' }, icon('library', 'm'), h('h2', { class: 'cs-h3 cs-grow' }, 'Patterns'),
      h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', title: 'Look again at the team as it is now', onclick: refresh }, icon('refresh', 's'), 'Again'),
      h('button', { class: 'cs-btn cs-btn--quiet cs-btn--icon', type: 'button', 'aria-label': 'Close the patterns', onclick: onClose }, icon('close', 'm'))),
    body));
  refresh();
  return { destroy() { side.replaceChildren(); }, refresh };
}
