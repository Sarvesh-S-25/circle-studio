// What a project folder already says about its workflow, so a project never shows a workflow it does not have.
// Order: the folder's own workflow.json; else the agents that really exist in .claude/agents; else a blank workflow.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWorkflow, blankWorkflow, SCHEMA } from './workflow.mjs';
import { NAME_RE } from './paths.mjs';
import { inspectTeam } from './team.mjs';

/** { workflow, origin: 'file'|'agents'|'blank', note } */
export function discoverWorkflow(root, name) {
  try {
    const raw = fs.readFileSync(path.join(root, 'workflow.json'), 'utf8');
    const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (j && j.schema === SCHEMA) return { workflow: normalizeWorkflow(j), origin: 'file', note: 'Read from workflow.json in the project folder' };
  } catch { /* no usable workflow.json: fall through */ }

  let roles = [];
  try { roles = inspectTeam(root).roles.filter((r) => r.file && NAME_RE.test(r.role)); } catch { roles = []; }
  if (roles.length) {
    const nodes = [
      { id: 'you', kind: 'human', title: 'You', does: 'Decides at every checkpoint that waits for you.' },
      { id: 'agents', kind: 'stage', title: 'Agents in this folder', does: 'Every agent found in .claude/agents. Arrange them into stages, or ask the workflow helper to.', gate: { on: false, by: 'you', label: '' } },
      ...roles.slice(0, 78).map((r) => ({
        id: r.role === 'you' || r.role === 'agents' ? `${r.role}-agent` : r.role,
        kind: 'agent', parent: 'agents', title: r.role, engine: 'claude',
        ...(r.configModel || r.agentModel ? { model: r.configModel || r.agentModel } : {}),
        does: r.description || '', optional: r.optional === true, defaultOn: r.enabled !== false,
      })),
    ];
    return { workflow: normalizeWorkflow({ name, nodes, edges: [{ from: 'you', to: 'agents' }] }), origin: 'agents', note: `Built from the ${roles.length} agent file${roles.length === 1 ? '' : 's'} in .claude/agents` };
  }
  return { workflow: blankWorkflow(name), origin: 'blank', note: 'Blank: this folder has no workflow and no agents yet' };
}

/** A record made by an older Circle Studio that copied the first template into a project and was never edited. */
export const isUntouchedTemplateCopy = (record) => Array.isArray(record?.versions) && record.versions.length === 1
  && typeof record.versions[0].note === 'string' && record.versions[0].note.startsWith('Started from the template');
