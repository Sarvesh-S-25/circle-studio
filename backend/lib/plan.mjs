// The plan: the project's brief, lanes, flags and pinned advisor findings, and the brief text written into
// the project. The stages and who runs them live in the workflow (workflow.mjs), not here.
import crypto from 'node:crypto';
import { badRequest } from './errors.mjs';
import { NAME_RE } from './paths.mjs';
import { gateWho, agentsOf, stageOrder } from './workflow.mjs';

/* The advisor (claude.mjs, routes.engines.mjs) still names findings after the old phases. */
export const PHASE_META = {
  research: { title: 'Research' },
  plan: { title: 'Plan' },
  stack: { title: 'Stack' },
  security: { title: 'Security design review' },
  split: { title: 'Split' },
  design: { title: 'Design' },
  build: { title: 'Build' },
  deploy: { title: 'Deploy' },
};
export const PHASE_IDS = Object.keys(PHASE_META);

const str = (v, max, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback);
const strList = (v, max, each) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() !== '').slice(0, max).map((x) => x.slice(0, each)) : []);
const newId = () => `p_${crypto.randomBytes(4).toString('hex')}`;

export function defaultPlan(projectId, name = '') {
  return {
    version: 2,
    projectId,
    updatedAt: null,
    idea: '',
    brief: {
      name,
      what: '',
      who: 'Single user, this PC, local only.',
      mustHave: [],
      notDoing: [],
      constraints: { deadline: '', budget: '', stack: '', platforms: '', compliance: '' },
      existingCode: 'None',
      howFar: 'prototype',
      anythingElse: '',
    },
    lanes: { frontend: true, backend: true, migrations: false, contract: true },
    localOnly: true,
    humanDoesGit: false,
    pins: [],
  };
}

/** Validate and coerce a plan coming from the browser. Throws bad_request on structural problems. */
export function normalizePlan(input, projectId, previous) {
  if (!input || typeof input !== 'object') throw badRequest('The plan must be an object.');
  const base = previous || defaultPlan(projectId);
  const b = input.brief && typeof input.brief === 'object' ? input.brief : {};
  const c = b.constraints && typeof b.constraints === 'object' ? b.constraints : {};
  const l = input.lanes && typeof input.lanes === 'object' ? input.lanes : {};

  const pinIds = new Set();
  const pins = (Array.isArray(input.pins) ? input.pins : []).slice(0, 200).filter((p) => p && typeof p === 'object').map((p) => {
    let id = typeof p.id === 'string' && /^[a-z0-9_]{1,40}$/.test(p.id) && !pinIds.has(p.id) ? p.id : newId();
    while (pinIds.has(id)) id = newId();
    pinIds.add(id);
    return {
      id,
      kind: ['keep', 'build', 'issue'].includes(p.kind) ? p.kind : 'issue',
      title: str(p.title, 200),
      detail: str(p.detail, 2000),
      phaseId: typeof p.phaseId === 'string' && NAME_RE.test(p.phaseId) ? p.phaseId : null,
      done: p.done === true,
      source: { type: p.source?.type === 'advisor' ? 'advisor' : 'manual', file: str(p.source?.file, 260) || undefined, at: str(p.source?.at, 40) || new Date().toISOString() },
    };
  }).filter((p) => p.title !== '');

  return {
    version: 2,
    projectId,
    updatedAt: new Date().toISOString(),
    idea: str(input.idea, 4000),
    brief: {
      name: str(b.name, 100, base.brief.name),
      what: str(b.what, 4000),
      who: str(b.who, 2000),
      mustHave: strList(b.mustHave, 40, 300),
      notDoing: strList(b.notDoing, 40, 300),
      constraints: { deadline: str(c.deadline, 200), budget: str(c.budget, 200), stack: str(c.stack, 300), platforms: str(c.platforms, 300), compliance: str(c.compliance, 300) },
      existingCode: str(b.existingCode, 500, 'None'),
      howFar: b.howFar === 'production' ? 'production' : 'prototype',
      anythingElse: str(b.anythingElse, 4000),
    },
    lanes: { frontend: l.frontend !== false, backend: l.backend !== false, migrations: l.migrations === true, contract: l.contract !== false },
    localOnly: input.localOnly !== false,
    humanDoesGit: input.humanDoesGit === true,
    pins,
  };
}

/** Findings about the plan itself. Returns [{id, severity, message}]. */
export function lintPlan(plan) {
  const open = plan.pins.filter((p) => !p.done && p.kind === 'issue').length;
  return open ? [{ id: 'pins-open-high', severity: 'info', message: `${open} pinned issue${open === 1 ? '' : 's'} not yet resolved.` }] : [];
}

/**
 * Roster toggles the workflow implies: only for optional agents. An agent is on when it is in the graph and
 * not switched off; connector and migrator also follow their lanes.
 */
export function rosterFromWorkflow(workflow) {
  const lane = { connector: workflow.lanes.contract, migrator: workflow.lanes.migrations };
  return Object.fromEntries(agentsOf(workflow).filter((a) => a.optional).map((a) => [a.id, a.defaultOn !== false && lane[a.id] !== false]));
}

const yn = (b) => (b ? 'yes' : 'no');
export const BLOCK_START = '<!-- circle:plan:start -->';
export const BLOCK_END = '<!-- circle:plan:end -->';

const cell = (s) => String(s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

function planBlock(plan, workflow, today) {
  const rows = stageOrder(workflow).map((id, n) => {
    const stage = workflow.nodes.find((x) => x.id === id);
    const who = agentsOf(workflow, id).map((a) => `${a.title} (${a.engine})`).join(', ') || '-';
    const who2 = gateWho(stage.gate);
    const gate = who2 ? `${who2 === 'You' ? 'You approve' : `${who2} check${who2.endsWith('you') ? '' : 's'}`}${stage.gate.label ? `: ${stage.gate.label}` : ''}` : 'go on';
    return `| ${n + 1} | ${cell(stage.title)} | ${cell(who)} | ${cell(gate)} | ${stage.skills.join(', ') || '-'} |`;
  });
  const open = plan.pins.filter((p) => !p.done);
  const lines = [
    BLOCK_START,
    '## Plan (written by Circle Studio)',
    '',
    `Written ${today}. Edit the workflow in Circle Studio; this block is replaced on each write, everything outside it is yours.`,
    '',
    '| # | Stage | Who runs it | When done | Skills |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    `- **Local only:** ${yn(plan.localOnly)}`,
    `- **Human does git:** ${yn(plan.humanDoesGit)}`,
  ];
  if (open.length) {
    lines.push('', '### Pinned from the advisor', '');
    for (const p of open) lines.push(`- [${p.kind}] ${p.title.replace(/\r?\n/g, ' ')}${p.phaseId ? ` (${p.phaseId})` : ''}`);
  }
  lines.push(BLOCK_END);
  return lines;
}

const bullets = (arr, empty) => (arr.length ? arr.map((x) => `- ${x.replace(/\r?\n/g, ' ')}`) : [empty]);

/**
 * The brief text. With no existing file: the whole brief plus the plan block.
 * With an existing file: only the managed plan block is replaced (or appended); the human's sections are untouched.
 */
export function buildBrief(plan, workflow, existing, { eol = '\n', today = new Date().toISOString().slice(0, 10) } = {}) {
  const block = planBlock(plan, workflow, today).join('\n');
  if (existing != null && existing.trim() !== '') {
    const lf = existing.replace(/\r\n/g, '\n');
    const a = lf.indexOf(BLOCK_START);
    const b = lf.indexOf(BLOCK_END);
    let next;
    if (a >= 0 && b > a) next = lf.slice(0, a) + block + lf.slice(b + BLOCK_END.length);
    else next = `${lf.replace(/\n*$/, '')}\n\n${block}\n`;
    return eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next;
  }
  const br = plan.brief;
  const c = br.constraints;
  const out = [
    `# Brief: ${br.name || 'Untitled'}`,
    '',
    '## What it is',
    '',
    br.what || plan.idea || '(not written yet)',
    '',
    '## Who uses it',
    '',
    br.who || '(not written yet)',
    '',
    '## Must have',
    '',
    ...bullets(br.mustHave, '(not written yet)'),
    '',
    '## Explicitly not doing',
    '',
    ...bullets(br.notDoing, '(not written yet)'),
    '',
    '## Constraints',
    '',
    `- **Deadline:** ${c.deadline}`.trimEnd(),
    `- **Budget:** ${c.budget}`.trimEnd(),
    `- **Existing stack we must fit:** ${c.stack}`.trimEnd(),
    `- **Platforms / browsers / devices:** ${c.platforms}`.trimEnd(),
    `- **Compliance or data-residency:** ${c.compliance}`.trimEnd(),
    '',
    '## Lanes',
    '',
    `- **Frontend:** ${yn(plan.lanes.frontend)}`,
    `- **Backend:** ${yn(plan.lanes.backend)}`,
    `- **Database migrations:** ${yn(plan.lanes.migrations)}`,
    `- **Shared contract:** ${yn(plan.lanes.contract)}`,
    '',
    '## Existing code',
    '',
    br.existingCode || 'None',
    '',
    '## How far to go now',
    '',
    br.howFar === 'production' ? 'Production-shaped, with tests, monitoring and a deploy runbook.' : 'Prototype to see it working.',
    '',
    '## Anything else',
    '',
    br.anythingElse || '',
    '',
    ...planBlock(plan, workflow, today),
    '',
  ];
  const text = out.join('\n');
  return eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}
