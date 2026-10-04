// The workflow helper: Circle Studio's own agent beside the graph. It reads the current workflow, the brief and
// what is installed, and proposes a better workflow for this project. It never writes anything: the proposal comes
// back as a normal workflow the human can apply to the graph, then save as a version like any other edit.
import { ENGINE_IDS, GATE_BY, KINDS, normalizeWorkflow, diffWorkflows, lintWorkflow } from './workflow.mjs';
import { redact } from './secrets.mjs';

export const HELPER_MARK = 'CIRCLE-WORKFLOW-HELPER';

const gateSchema = {
  type: 'object',
  required: ['on', 'by', 'label'],
  properties: { on: { type: 'boolean' }, by: { type: 'string', enum: GATE_BY }, engine: { type: 'string', enum: ENGINE_IDS }, label: { type: 'string' } },
  additionalProperties: false,
};

export const HELPER_SCHEMA = {
  type: 'object',
  required: ['reply', 'changed'],
  properties: {
    reply: { type: 'string' },
    changed: { type: 'boolean' },
    workflow: {
      type: 'object',
      required: ['nodes', 'edges'],
      properties: {
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'kind', 'title'],
            properties: {
              id: { type: 'string' }, kind: { type: 'string', enum: KINDS }, title: { type: 'string' }, parent: { type: 'string' },
              does: { type: 'string' }, engine: { type: 'string', enum: ENGINE_IDS }, model: { type: 'string' },
              consult: { type: 'array', items: { type: 'string', enum: ENGINE_IDS } }, skills: { type: 'array', items: { type: 'string' } },
              optional: { type: 'boolean' }, reader: { type: 'boolean' }, condense: { type: 'integer', minimum: 30, maximum: 95 }, gate: gateSchema,
            },
            additionalProperties: false,
          },
        },
        edges: { type: 'array', items: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } }, additionalProperties: false } },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/** The workflow as the helper sees it: structure and roles, without positions, links, notes or long prompts. */
export function compactWorkflow(wf) {
  return {
    name: wf.name,
    nodes: wf.nodes.map((n) => {
      const o = { id: n.id, kind: n.kind, title: n.title };
      if (n.parent) o.parent = n.parent;
      if (n.does) o.does = n.does.slice(0, 400);
      if (n.kind === 'agent') Object.assign(o, { engine: n.engine, model: n.model || '', consult: n.consult, optional: n.optional, ...(n.reader ? { reader: true } : {}), ...(n.condense ? { condense: n.condense } : {}) });
      if (n.kind === 'stage') o.gate = n.gate;
      if (n.skills?.length) o.skills = n.skills;
      return o;
    }),
    edges: wf.edges.map((e) => ({ from: e.from, to: e.to })),
  };
}

const briefLines = (plan) => {
  const b = plan?.brief || {};
  const out = [];
  if (plan?.idea) out.push(`Idea: ${plan.idea}`);
  if (b.what) out.push(`What it is: ${b.what}`);
  if (b.who) out.push(`Who uses it: ${b.who}`);
  if (b.mustHave?.length) out.push(`Must have: ${b.mustHave.join('; ')}`);
  if (b.notDoing?.length) out.push(`Not doing: ${b.notDoing.join('; ')}`);
  if (b.howFar) out.push(`How far now: ${b.howFar}`);
  return out.length ? out.join('\n') : '(the brief is empty)';
};

/**
 * The prompt for one helper turn. `engines` = [{ id, usable }], `skills` = [name], `history` = [{ role:'you'|'helper', text }].
 */
export function helperPrompt({ workflow, plan, lanes, engines = [], skills = [], history = [], message, digest = '', blocks = [], passages = [], patterns = '' }) {
  const usable = engines.filter((e) => e.usable).map((e) => e.id);
  const past = history.slice(-6).map((m) => `${m.role === 'helper' ? 'Helper' : 'Human'}: ${String(m.text).slice(0, 2000)}`).join('\n');
  return redact([
    HELPER_MARK,
    'You are the workflow helper inside Circle Studio, a control room for a team of AI coding agents on one project.',
    'The human describes what they want; you design the best workflow (stages, agents, checkpoints) for THIS project and explain it briefly.',
    '',
    'How a workflow works:',
    '- One node of kind "human" (id "you") starts the flow. Stages are the steps of the work, connected by edges from stage to stage in order.',
    '- An agent (kind "agent") belongs to one stage through "parent". It runs on one engine: claude, codex, gemini or copilot. Prefer engines that are usable now.',
    '- "consult" lists the other engines an agent may ask for a second opinion. Leave it empty when a second opinion is not worth the cost; it is optional, not required.',
    '- Each stage has a checkpoint "gate": on=false means the next stage starts straight away. by="you": the human approves. by="engine": another engine reviews and the work goes on. by="both": an engine reviews, then the human approves. Put the human only where a real decision is needed; use an engine review for routine checks.',
    '- Keep ids lowercase letters, digits and hyphens. Keep the ids of nodes you keep, so their settings survive. Use only skills from the list below.',
    '- Be lean: a small project needs few stages and agents. Do not add stages the brief does not need.',
    '- Models: haiku for searching, scanning, formatting and routine steps; sonnet for most building and reviewing; opus only where hard reasoning pays off.',
    '- "reader": true gives a claude agent a Haiku reader that reads long files, logs and pages for it and answers briefly. Use it only for an expensive agent (opus or sonnet) that reads a lot it does not change (reviewers, researchers, debuggers on long logs). Do not use it for agents that edit the code they read: they need the exact text.',
    '- "condense": a percentage (30 to 95) makes a hook shorten a claude agent\'s long command output, web pages, searches and MCP results with Haiku once its context is fuller than that; the full output is kept in a file it can read, and files it reads are never shortened. Good for agents that run tests, builds or fetch pages in long sessions (60 is a sensible start). It is automatic, unlike "reader", which the agent decides to use. Never both on one agent unless asked.',
    '- Use the patterns under "Patterns that fit this team" when they help, say why in plain words, and respect their "avoid when". Do not add one just because it is listed.',
    '- Design for the real project described under "The project folder": its language, size, tests and what the team already has. Reuse existing agents, skills and connectors from "Building blocks" before inventing new ones; name the ones you use in your reply.',
    '',
    `Engines usable now: ${usable.join(', ') || 'none detected'}. All engines: ${ENGINE_IDS.join(', ')}.`,
    `Skills in the library: ${skills.join(', ') || 'none'}.`,
    `Lanes: ${Object.entries(lanes || {}).filter(([, on]) => on).map(([k]) => k).join(', ') || 'none'}.`,
    '',
    'The brief:',
    briefLines(plan),
    ...(digest ? ['', 'The project folder (read just now):', digest] : []),
    ...(blocks.length ? ['', 'Building blocks the human already has that fit this request (from their catalog):', ...blocks.map((b) => `- ${b.type} "${b.name}"${b.model ? ` (${b.model})` : ''}${b.where ? ` in ${b.where}` : ''}: ${b.summary}`)] : []),
    ...(passages.length ? ['', 'From the reading links (indexed pages), the passages that match:', ...passages.map((p) => `[${p.title}] ${String(p.text).slice(0, 700)}`)] : []),
    ...(patterns ? ['', patterns] : []),
    '',
    'The current workflow (JSON):',
    '<workflow>',
    JSON.stringify(compactWorkflow(workflow)),
    '</workflow>',
    ...(past ? ['', 'The conversation so far:', past] : []),
    '',
    `The human now says: ${String(message).slice(0, 4000)}`,
    '',
    'Answer with "reply" (a few plain sentences: what you changed and why, or your answer). Set "changed" to true and give the complete new "workflow" (every node and edge) only when you propose a change; otherwise set it to false and leave "workflow" out.',
  ].join('\n'));
}

/**
 * Turn the helper's workflow into a full workflow, keeping what the helper does not see (positions, links, notes,
 * prompts, skip rules, lanes, flags) from the current one for nodes it kept. Throws bad_request when it is invalid.
 */
export function mergeProposal(current, proposed, { skills = [] } = {}) {
  const byId = new Map(current.nodes.map((n) => [n.id, n]));
  const known = new Set(skills);
  const nodes = (proposed.nodes || []).map((n) => {
    const old = byId.get(n.id);
    const merged = { ...(old || {}), ...n };
    if (Array.isArray(merged.skills)) merged.skills = merged.skills.filter((s) => known.has(s) || old?.skills?.includes(s));
    if (old?.kind !== merged.kind) delete merged.position;
    return merged;
  });
  if (!nodes.some((n) => n.kind === 'human')) nodes.unshift(current.nodes.find((n) => n.kind === 'human') || { id: 'you', kind: 'human', title: 'You' });
  // agents left under a stage the proposal removed go to one visible stage instead of floating unseen
  const stages = new Set(nodes.filter((n) => n.kind === 'stage').map((n) => n.id));
  const orphans = nodes.filter((n) => n.kind === 'agent' && (!n.parent || !stages.has(n.parent)));
  if (orphans.length) {
    let park = 'not-placed';
    for (let i = 2; nodes.some((n) => n.id === park); i++) park = `not-placed-${i}`;
    nodes.push({ id: park, kind: 'stage', title: 'Not placed yet', does: 'Agents the helper did not put in a stage. Move them, or remove the ones you do not need.', gate: { on: false, by: 'you', label: '' } });
    for (const a of orphans) { a.parent = park; delete a.position; }
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) if (Array.isArray(n.needs)) n.needs = n.needs.filter((x) => ids.has(x));
  return normalizeWorkflow({ ...current, nodes, edges: proposed.edges || [] });
}

/** What the route returns for one helper answer. */
export function helperResult(current, data, { skills, usable }) {
  const reply = redact(String(data?.reply || '')).slice(0, 4000) || 'No answer.';
  if (!data?.changed || !data.workflow) return { reply, proposal: null, changes: [], warnings: [] };
  const proposal = mergeProposal(current, data.workflow, { skills });
  const diff = diffWorkflows(current, proposal);
  if (diff.empty) return { reply, proposal: null, changes: [], warnings: [] };
  const parked = proposal.nodes.find((n) => n.kind === 'stage' && n.title === 'Not placed yet' && !current.nodes.some((c) => c.id === n.id));
  const parkedCount = parked ? proposal.nodes.filter((n) => n.parent === parked.id).length : 0;
  return {
    reply,
    proposal,
    changes: diff.changes.filter((c) => c.kind !== 'meta').map((c) => c.text),
    warnings: [
      ...(parkedCount ? [`${parkedCount} agent${parkedCount === 1 ? ' was' : 's were'} not put in any stage, so ${parkedCount === 1 ? 'it is' : 'they are'} in "Not placed yet".`] : []),
      ...lintWorkflow(proposal, { usable }).map((w) => w.message),
    ],
  };
}
