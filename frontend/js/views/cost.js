// The project's Cost tab: what it used (30 days of Claude Code transcripts, priced at API rates), what loads before you
// type, the model of every agent, and ways to spend less. Every change goes through a new workflow version and the
// usual file review; the AI rearrangement is the workflow helper asked to cut cost.
import { api } from '../api.js';
import { h, icon, plural } from '../dom.js';
import { stackedBar, barSeries } from '../components/charts.js';
import { reviewChanges } from '../components/diffreview.js';
import { confirmDialog, openModal, toast } from '../components/overlay.js';

const usd = (n) => (n == null ? '-' : n >= 100 ? `$${Math.round(n)}` : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.001 ? `$${n.toFixed(3)}` : n > 0 ? 'under $0.001' : '$0');
const kTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
const TONES = ['a', 'info', 'gate', 'ok', 'warn'];
const MODELS = ['haiku', 'sonnet', 'opus'];

export async function mount(el, pctx) {
  const { project } = pctx;
  el.append(h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Reading the project and its Claude Code history...'));
  let data;
  try { data = await api.cost(project.id); } catch (e) { el.replaceChildren(h('div', { class: 'cs-empty' }, icon('danger', 'l'), h('div', { class: 'cs-empty__title' }, 'Could not work out the cost'), h('p', {}, e.message))); return {}; }

  async function applyModels(changes, note) {
    let wf;
    try { wf = (await api.workflow(project.id)).workflow; } catch (e) { toast(e.message, { kind: 'danger' }); return; }
    const inWf = changes.filter((c) => wf.nodes.some((n) => n.id === c.agent && n.kind === 'agent'));
    const outside = changes.filter((c) => !inWf.includes(c) && c.model);
    if (inWf.length) {
      const next = structuredClone(wf);
      for (const c of inWf) { const n = next.nodes.find((x) => x.id === c.agent); if (c.model) n.model = c.model; if (c.reader) n.reader = true; if (!n.engine) n.engine = 'claude'; }
      try { await api.saveWorkflow(project.id, { workflow: next, note, bump: 'patch' }); } catch (e) { toast(e.message, { kind: 'danger' }); return; }
      toast('Saved as a new workflow version. Now review the agent files.', { kind: 'ok' });
      await reviewChanges({ projectId: project.id, ops: [{ op: 'workflow-write' }], title: 'Write the new models into the agent files', applyLabel: 'Write files' });
    }
    if (outside.length) {
      const inModels = (c) => pctx.team?.roles?.some((r) => (r.role ?? r.name) === c.agent && !r.missingModelsEntry);
      const viaModels = outside.filter(inModels);
      const byHand = outside.filter((c) => !inModels(c));
      if (viaModels.length) await reviewChanges({ projectId: project.id, ops: viaModels.map((c) => ({ op: 'model', role: c.agent, model: c.model })), title: 'Change the models in models.json' });
      if (byHand.length) toast(`${byHand.map((c) => c.agent).join(', ')}: not in the workflow. Add it to the workflow, or change "model:" in its file in .claude/agents.`, { kind: 'warn', ms: 9000 });
    }
    reload();
  }

  async function reload() { try { data = await api.cost(project.id); draw(); } catch (e) { toast(e.message, { kind: 'danger' }); } }

  async function askAi() {
    if (!project.permissions.claude) { toast('Allow this project to send text to an engine first (Permissions).', { kind: 'warn' }); return; }
    const facts = [
      `Agents and models now: ${data.agents.map((a) => `${a.id}=${a.engine}/${a.model || 'inherits'}`).join(', ')}.`,
      data.usage.found ? `Last 30 days at API prices: ${usd(data.usage.total.usd)}; by agent: ${data.usage.byAgent.map((a) => `${a.name} ${usd(a.usd)}`).join(', ')}.` : '',
      `Problems found: ${data.issues.map((i) => i.title).join('; ') || 'none'}.`,
    ].join(' ');
    const message = `Rearrange this workflow so it costs less without losing quality. Use the cheapest model that can do each agent's job well (haiku for searching, scanning, formatting and routine steps; sonnet for most building and reviewing; opus only where hard reasoning pays off), drop or merge agents that duplicate work, and keep the checkpoints. Say in plain words what you changed and roughly how much it saves. ${facts}`;
    const body = h('div', { class: 'cs-stack' }, h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Asking Claude to rearrange the workflow for cost...'));
    const ctrl = openModal({ title: 'Rearrange for cost', body, size: 'wide', actions: [{ label: 'Close', kind: 'quiet' }] });
    let r;
    try { r = await api.suggestWorkflow(project.id, { message, model: 'sonnet' }); } catch (e) { body.replaceChildren(h('p', {}, e.message)); return; }
    if (!r.proposal) { body.replaceChildren(h('p', {}, r.reply), h('p', { class: 'cs-soft' }, 'No changes proposed.')); return; }
    body.replaceChildren(h('p', {}, r.reply),
      h('div', { class: 'cs-eyebrow' }, 'What would change'), h('ul', { class: 'cs-prose' }, r.changes.map((c) => h('li', {}, c))),
      r.warnings.length ? h('div', { class: 'cs-banner cs-banner--warn' }, icon('warning', 's'), h('span', {}, r.warnings.join(' '))) : null,
      h('div', { class: 'cs-row' }, h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: async () => {
        ctrl.close(null);
        try { await api.saveWorkflow(project.id, { workflow: r.proposal, note: 'Rearranged for cost by the workflow helper', bump: 'minor' }); } catch (e) { toast(e.message, { kind: 'danger' }); return; }
        toast('Saved as a new workflow version (you can restore the old one under Versions).', { kind: 'ok' });
        await reviewChanges({ projectId: project.id, ops: [{ op: 'workflow-write' }], title: 'Write the rearranged workflow into the project', applyLabel: 'Write files' });
        reload();
      } }, icon('check', 's'), 'Use this workflow'), h('span', { class: 'cs-soft cs-small' }, 'Saved as a new version first; files are written only after you review them.')));
  }

  function hero() {
    const u = data.usage;
    if (!u.found || !u.total.answers) {
      return h('section', { class: 'cs-card cs-cost__hero' }, h('div', { class: 'cs-stack cs-stack--tight' }, h('h2', { class: 'cs-h2' }, 'No Claude Code use here in the last 30 days'),
        h('p', { class: 'cs-soft' }, 'When you or your team use Claude Code in this folder, its tokens and their price show here.')));
    }
    const models = u.byModel.slice(0, 5);
    const bar = stackedBar(models.map((m, i) => ({ label: m.name, value: Math.max(m.usd, 0.0001), tone: TONES[i % TONES.length] })));
    bar.legend.replaceChildren(...models.map((m, i) => h('li', {}, h('span', { class: `cs-chart__dot cs-chart__dot--${TONES[i % TONES.length]}`, 'aria-hidden': 'true' }), `${m.name}: ${usd(m.usd)} (${plural(m.answers, 'answer')})`)));
    const days = barSeries(u.byDay.map((d) => ({ label: d.date.slice(5), value: Math.round(d.usd * 100) / 100 })), { unit: 'dollars' });
    return h('section', { class: 'cs-card cs-cost__hero', 'aria-labelledby': 'cost-hero' },
      h('div', { class: 'cs-cost__big' },
        h('span', { class: 'cs-eyebrow', id: 'cost-hero' }, 'Last 30 days, at API prices'),
        h('span', { class: 'cs-cost__num' }, usd(u.total.usd)),
        h('span', { class: 'cs-soft cs-small' }, `${plural(u.sessions, 'session')} · ${plural(u.total.answers, 'answer')} · ${kTok(u.total.input + u.total.cacheRead + u.total.cacheWrite5m + u.total.cacheWrite1h)} tokens in, ${kTok(u.total.output)} out`),
        u.cacheShare != null ? h('span', { class: 'cs-soft cs-small' }, `${Math.round(u.cacheShare * 100)}% of what it read came from the cache (a tenth of the price).`) : null),
      h('div', { class: 'cs-chart' }, h('span', { class: 'cs-eyebrow' }, 'By model'), bar.svg, bar.legend),
      h('div', { class: 'cs-chart' }, h('span', { class: 'cs-eyebrow' }, 'Per day'), days),
      h('p', { class: 'cs-soft cs-small cs-cost__plan' }, `On a Pro or Max plan you pay the subscription, not this: read it as how much work it was, and how fast it uses your limits. Prices as of ${data.pricesAsOf}.`));
  }

  function byAgent() {
    const u = data.usage;
    if (!u.found || !u.byAgent.length) return null;
    const max = Math.max(...u.byAgent.map((a) => a.usd), 0.0001);
    return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cost-who' }, h('h2', { class: 'cs-h2', id: 'cost-who' }, 'Who used it'),
      h('ul', { class: 'cs-cost__rows' }, u.byAgent.map((a) => h('li', { class: 'cs-cost__row' }, h('span', { class: 'cs-cost__name' }, a.name), h('span', { class: 'cs-cost__meter', style: { '--pct': `${Math.max(2, (a.usd / max) * 100)}%` }, 'aria-hidden': 'true' }), h('span', { class: 'cs-cost__val' }, usd(a.usd)), h('span', { class: 'cs-soft cs-small' }, plural(a.answers, 'answer'))))),
      h('p', { class: 'cs-soft cs-small' }, '"main session" is you talking to Claude Code; the others are agents it handed work to.'));
  }

  /** What automatic condensing (an agent's Haiku reader, "automatically") did, read from the transcripts. */
  function condensed() {
    const c = data.usage?.condensed;
    if (!c?.count) return null;
    const kept = Math.max(0, c.was - c.now);
    const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
    return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cost-cond' }, h('h2', { class: 'cs-h2', id: 'cost-cond' }, 'Condensed by Haiku'),
      h('p', {}, `${plural(c.count, 'long output')} shortened: about ${k(c.was)} tokens became ${k(c.now)}, so about ${k(kept)} tokens stayed out of the agents' context.`),
      h('ul', { class: 'cs-cost__rows' }, Object.entries(c.byAgent).map(([name, a]) => h('li', { class: 'cs-cost__row' }, h('span', { class: 'cs-cost__name' }, name), h('span', { class: 'cs-cost__val' }, `${k(a.saved)} tokens kept out`), h('span', { class: 'cs-soft cs-small' }, plural(a.count, 'output'))))),
      h('p', { class: 'cs-soft cs-small' }, 'Each one cost a short Haiku call. The full outputs were kept in files the agents could read.'));
  }

  function before() {
    const w = data.weight;
    const max = Math.max(...w.always.map((x) => x.tokens), 1);
    const row = (x) => h('li', { class: 'cs-cost__row', title: x.note }, h('span', { class: 'cs-cost__name cs-mono' }, x.path), h('span', { class: 'cs-cost__meter', style: { '--pct': `${Math.max(2, (x.tokens / max) * 100)}%` }, 'aria-hidden': 'true' }), h('span', { class: 'cs-cost__val' }, `${kTok(x.tokens)} tok`), h('span', { class: 'cs-soft cs-small cs-cost__note' }, x.note));
    return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cost-before' },
      h('div', { class: 'cs-row cs-row--between cs-row--wrap' }, h('h2', { class: 'cs-h2', id: 'cost-before' }, 'Before you type'), h('span', { class: 'cs-pill cs-pill--info' }, `about ${kTok(w.alwaysTokens)} tokens per session`)),
      h('p', { class: 'cs-soft' }, `Every new session reads these first: about ${usd(w.startUsd)} on Sonnet for the first answer, then about ${usd(w.startUsdCached)} per answer while they stay cached.`),
      w.always.length ? h('ul', { class: 'cs-cost__rows' }, w.always.map(row)) : h('p', { class: 'cs-soft' }, 'Nothing: no CLAUDE.md, agents or skills.'),
      w.onUse.length ? h('details', { class: 'cs-details' }, h('summary', {}, `Loaded only when used (${w.onUse.length})`), h('ul', { class: 'cs-cost__rows' }, w.onUse.map(row))) : null,
      w.others.length ? h('details', { class: 'cs-details' }, h('summary', {}, 'For the other engines'), h('ul', { class: 'cs-cost__rows' }, w.others.map(row))) : null,
      w.mcp.length || w.hooks.length ? h('p', { class: 'cs-soft cs-small' }, [w.mcp.length ? `MCP servers: ${w.mcp.join(', ')} (each adds its tools to the context).` : '', w.hooks.length ? `Hooks: ${w.hooks.map((x) => `${x.event} (${x.count})`).join(', ')}; their output can add to the context too.` : ''].filter(Boolean).join(' ')) : null);
  }

  function agentsTable() {
    const rows = data.agents;
    if (!rows.length) return h('section', { class: 'cs-card' }, h('h2', { class: 'cs-h2' }, 'Agents and their models'), h('p', { class: 'cs-soft' }, 'This project has no agents yet.'));
    const pending = new Map();
    const applyBtn = h('button', { class: 'cs-btn cs-btn--primary', type: 'button', disabled: true, onclick: () => applyModels([...pending.entries()].map(([agent, model]) => ({ agent, model })), `Models changed on the Cost tab: ${[...pending.entries()].map(([a, m]) => `${a} to ${m}`).join(', ')}`) }, icon('diff', 's'), 'Review and apply');
    const body = rows.map((a) => {
      const cur = MODELS.find((m) => String(a.model || '').toLowerCase().includes(m)) || '';
      const sel = a.engine === 'claude' ? h('select', { class: 'cs-select cs-select--small', 'aria-label': `Model for ${a.title}`, onchange: (e) => { if (e.target.value === cur) pending.delete(a.id); else pending.set(a.id, e.target.value); applyBtn.disabled = !pending.size; applyBtn.lastChild.textContent = pending.size ? `Review and apply (${pending.size})` : 'Review and apply'; } },
        !cur ? h('option', { value: '' }, a.model ? a.model : 'inherits') : null, MODELS.map((m) => h('option', { value: m, selected: m === cur || undefined }, m))) : h('span', { class: 'cs-soft' }, a.model || 'its default');
      return h('tr', {}, h('td', {}, h('strong', {}, a.title), a.inWorkflow ? null : h('span', { class: 'cs-soft cs-small' }, ' (file only)')), h('td', {}, a.engine), h('td', {}, sel),
        h('td', { class: 'cs-num' }, a.price ? `$${a.price.input} / $${a.price.output}` : h('span', { class: 'cs-soft' }, a.engine === 'claude' ? '?' : 'billed by its service')),
        h('td', { class: 'cs-num cs-soft' }, a.bodyTokens != null ? `${kTok(a.bodyTokens)} tok` : '-'));
    });
    return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cost-agents' },
      h('div', { class: 'cs-row cs-row--between cs-row--wrap' }, h('h2', { class: 'cs-h2', id: 'cost-agents' }, 'Agents and their models'), applyBtn),
      h('div', { class: 'cs-tablewrap' }, h('table', { class: 'cs-table' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Agent'), h('th', { scope: 'col' }, 'Engine'), h('th', { scope: 'col' }, 'Model'), h('th', { scope: 'col', class: 'cs-num' }, 'In / out per 1M tokens'), h('th', { scope: 'col', class: 'cs-num' }, 'Its instructions'))), h('tbody', {}, body))),
      h('p', { class: 'cs-soft cs-small' }, `haiku is ${data.aliases.haiku}, sonnet ${data.aliases.sonnet}, opus ${data.aliases.opus}. A change is saved as a new workflow version, then you review the files before anything is written.`));
  }

  function savings() {
    const fixes = data.issues.filter((i) => i.fix);
    return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cost-less' },
      h('div', { class: 'cs-row cs-row--between cs-row--wrap' }, h('h2', { class: 'cs-h2', id: 'cost-less' }, 'Ways to spend less'),
        h('div', { class: 'cs-row cs-row--wrap' },
          fixes.length > 1 ? h('button', { class: 'cs-btn', type: 'button', onclick: async () => { if (await confirmDialog({ title: `Apply ${fixes.length} changes?`, message: fixes.map((f) => (f.fix.reader ? `${f.fix.agent}: a Haiku reader` : `${f.fix.agent} to ${f.fix.model}`)).join(', '), confirmLabel: 'Review them' })) applyModels(fixes.map((f) => f.fix), 'Cheaper models suggested on the Cost tab'); } }, icon('check', 's'), `Apply all ${fixes.length}`) : null,
          h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: askAi }, icon('sparkle', 's'), 'Let AI rearrange for cost'))),
      data.issues.length ? h('ul', { class: 'cs-cost__issues' }, data.issues.map((i) => h('li', { class: `cs-cost__issue cs-cost__issue--${i.severity}` },
        h('span', { class: `cs-pill cs-pill--${i.severity === 'warn' ? 'warn' : 'info'}` }, icon(i.severity === 'warn' ? 'warning' : 'info', 's')),
        h('div', { class: 'cs-grow' }, h('strong', {}, i.title), h('p', { class: 'cs-soft cs-small' }, i.detail), i.tech ? h('p', { class: 'cs-soft cs-small cs-mono' }, i.tech) : null),
        i.fix ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => applyModels([i.fix], i.fix.reader ? `Cost: a Haiku reader for ${i.fix.agent}` : `Cost: ${i.fix.agent} to ${i.fix.model}`) }, i.fix.reader ? 'Add a Haiku reader' : `Use ${i.fix.model}`) : null)))
        : h('p', { class: 'cs-soft' }, 'Nothing obvious. The AI can still look at the whole workflow for you.'));
  }

  function circleSpend() {
    if (!data.circle.answers) return null;
    return h('p', { class: 'cs-soft cs-small' }, `Chats from Circle Studio in this project: ${plural(data.circle.answers, 'answer')}, ${usd(data.circle.usd)} as reported by the engine.`);
  }

  function draw() {
    el.replaceChildren(h('div', { class: 'cs-stack cs-stack--loose cs-cost' }, hero(), savings(), agentsTable(), before(), byAgent(), condensed(), circleSpend()));
  }
  draw();
  return {};
}
