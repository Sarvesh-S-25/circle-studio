// The pattern store: ways to shape an agent team (backend/seed/patterns.json), each with when it pays off and when it
// does not, and `relate`, which matches them to a project's own agents using what each agent does and, when there are
// transcripts, how much context it really carries. The workflow helper reads both; the Patterns panel shows them.
import fs from 'node:fs';
import path from 'node:path';
import { tokens } from './catalog.mjs';

const FILE = path.resolve(import.meta.dirname, '..', 'seed', 'patterns.json');
let cached = null;

export function loadPatterns() {
  if (!cached) {
    try { cached = JSON.parse(fs.readFileSync(FILE, 'utf8')).patterns || []; } catch { cached = []; }
  }
  return cached;
}

const familyOf = (model) => (/opus/i.test(model || '') ? 'opus' : /sonnet/i.test(model || '') ? 'sonnet' : /haiku/i.test(model || '') ? 'haiku' : null);
const words = (s) => new Set(tokens(s));
const hits = (have, list) => list.filter((w) => tokens(w).some((t) => have.has(t)));

/**
 * Which patterns fit which agents. `usage` is the measured use per agent ({ name, answers, input, cacheRead, ... })
 * when there is any. Returns [{ pattern, agent, title, why, strength: 1..3, apply }], strongest first.
 */
export function relate(workflow, { usage = [], usableEngines = null } = {}) {
  const out = [];
  const agents = (workflow?.nodes || []).filter((n) => n.kind === 'agent');
  const stages = (workflow?.nodes || []).filter((n) => n.kind === 'stage');
  const measured = (a) => usage.find((u) => [a.id, a.title].map((x) => String(x).toLowerCase()).includes(String(u.name).toLowerCase()));
  for (const a of agents) {
    const have = words(`${a.id} ${a.title} ${a.does || ''}`);
    const claude = (a.engine || 'claude') === 'claude';
    const fam = familyOf(a.model);
    const u = measured(a);
    const perAnswer = u && u.answers >= 5 ? (u.input + u.cacheRead + (u.cacheWrite5m || 0) + (u.cacheWrite1h || 0)) / u.answers : null;
    const big = perAnswer !== null && perAnswer > 60_000;
    const evidence = perAnswer !== null ? ` Measured: about ${Math.round(perAnswer / 1000)}k tokens of context per answer over ${u.answers} answers.` : '';
    for (const p of loadPatterns()) {
      const yes = hits(have, p.signals || []);
      const no = hits(have, p.against || []);
      let strength = 0;
      let why = '';
      if (p.id === 'reader' && claude && !a.reader && !a.condense && fam !== 'haiku' && yes.length && !no.length) {
        strength = big ? 3 : 1;
        why = `${a.title} mostly reads (${yes.slice(0, 3).join(', ')}) and does not edit what it reads.${evidence}`;
      } else if (p.id === 'condense' && claude && !a.condense && !a.reader && yes.length) { // one helper per agent
        strength = big ? 3 : 2;
        why = `${a.title} works with long output (${yes.slice(0, 3).join(', ')}).${evidence || ' Condensing only starts above the limit, so short sessions are untouched.'}`;
      } else if (p.id === 'cheap-model' && claude && (fam === 'opus' || !a.model) && yes.length && !no.length) {
        strength = 2;
        why = `${a.title}'s job reads as routine (${yes.slice(0, 3).join(', ')}) but it runs on ${a.model || 'whatever the main session uses'}.`;
      } else if (p.id === 'consult' && !(a.consult || []).length && yes.length && !no.length && (!usableEngines || [...usableEngines].some((e) => e !== (a.engine || 'claude')))) {
        strength = 1;
        why = `${a.title} makes decisions that are costly to get wrong (${yes.slice(0, 3).join(', ')}).`;
      }
      if (strength) out.push({ pattern: p.id, name: p.name, agent: a.id, title: a.title, why, strength, apply: p.apply || null });
    }
  }
  for (const s of stages) {
    const kids = agents.filter((a) => a.parent === s.id);
    const have = words(`${s.title} ${s.does || ''} ${kids.map((k) => `${k.title} ${k.does || ''}`).join(' ')}`);
    const p = loadPatterns().find((x) => x.id === 'engine-check');
    const yes = p ? hits(have, p.signals) : [];
    if (p && s.gate?.on && s.gate.by === 'you' && yes.length) out.push({ pattern: p.id, name: p.name, agent: null, stage: s.id, title: s.title, why: `"${s.title}" stops for you on a routine check (${yes.slice(0, 2).join(', ')}); an engine could check it and you would be asked only where it matters.`, strength: 1, apply: null });
  }
  return out.sort((x, y) => y.strength - x.strength);
}

/** The pattern store as catalog sources (type "pattern"), so the helper's search finds them like any building block. */
export const patternSources = () => loadPatterns().map((p) => ({ type: 'pattern', key: `pattern:${p.id}`, name: p.name, text: `${p.summary} Use when: ${p.useWhen.join(' ')} Avoid when: ${p.avoidWhen.join(' ')}`, where: 'Circle Studio patterns' }));

/** A short text of the matching patterns and how they relate to this team, for the helper's prompt. */
export function patternsForPrompt(workflow, opts = {}) {
  const rel = relate(workflow, opts).slice(0, 8);
  const ids = new Set(rel.map((r) => r.pattern));
  const lines = loadPatterns().filter((p) => ids.has(p.id)).map((p) => `- ${p.id} "${p.name}": ${p.summary} Avoid when: ${p.avoidWhen[0]} Cost: ${p.costs}`);
  const fits = rel.map((r) => `- ${r.pattern} fits ${r.agent ? `agent ${r.agent}` : `stage ${r.stage}`}: ${r.why}`);
  return lines.length ? ['Patterns that fit this team (with their trade-offs):', ...lines, 'Where they fit, and why:', ...fits].join('\n') : '';
}
