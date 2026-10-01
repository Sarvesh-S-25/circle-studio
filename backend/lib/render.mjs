// Turning a workflow into the files a project needs: workflow.json, AGENTS.md (for every engine), a CLAUDE.md
// line that imports it, one agent file per Claude agent, the brief, and the skills its nodes list.
// Pure: it returns the file list; projects.create and the workflow-write op decide how it reaches the disk.
import { badRequest } from './errors.mjs';
import { yamlScalar } from './frontmatter.mjs';
import { scanSecrets } from './secrets.mjs';
import { buildBrief } from './plan.mjs';
import { agentsOf, stageOrder, stagesOf, ENGINE_LABEL } from './workflow.mjs';

/** Where each engine looks for skills. Codex and Copilot share .agents/skills; the Gemini folder is unverified. */
export const SKILL_DIRS = { claude: '.claude/skills', codex: '.agents/skills', copilot: '.agents/skills', gemini: '.gemini/skills' };
export const GEMINI_SKILLS_NOTE = '.gemini/skills is not verified for agy (the Gemini engine): it may not read that folder.';

/** The folders to install a skill in for the engines that want it and the ones its partition allows. */
export function skillTargets(wanted, allowed) {
  const ok = wanted.filter((e) => allowed.includes(e));
  return { dirs: [...new Set(ok.map((e) => SKILL_DIRS[e]))], engines: ok, skipped: wanted.filter((e) => !allowed.includes(e)) };
}

/** skill name -> the engines that will use it. A stage's skills go to its agents; a stage with none uses every engine in the graph. */
export function skillEngineMap(workflow) {
  const map = new Map();
  const add = (skills, engines) => { for (const s of skills) map.set(s, new Set([...(map.get(s) || []), ...engines])); };
  const everyone = new Set(agentsOf(workflow).map((a) => a.engine));
  for (const a of agentsOf(workflow)) add(a.skills, [a.engine]);
  for (const s of stagesOf(workflow)) {
    const own = agentsOf(workflow, s.id).map((a) => a.engine);
    add(s.skills, own.length ? own : everyone.size ? everyone : ['claude']);
  }
  return map;
}

const oneLine = (s, max) => String(s).replace(/\s+/g, ' ').trim().slice(0, max);
const engineName = (e) => ENGINE_LABEL[e] || e;

/** What happens when a stage is done, as one instruction the team can follow. */
export function checkpointText(gate) {
  if (!gate?.on) return 'When done: go straight on, nobody stops to check.';
  const what = oneLine(gate.label || '', 200);
  const review = `ask ${engineName(gate.engine)} to review the result in a separate, read-only session${what ? ` (${what})` : ''} and fix what it finds`;
  if (gate.by === 'engine') return `When done: ${review}, then go on. Do not wait for the human.`;
  if (gate.by === 'both') return `When done: ${review}, then stop and wait for the human to approve before the next stage.`;
  return `When done: stop and wait for the human to approve${what ? `: ${what}` : ''}. Never start the next stage before that.`;
}

/** "May ask Codex and Gemini for a second opinion (read-only)." or '' */
export function consultText(agent) {
  const list = (agent.consult || []).filter((e) => e !== agent.engine).map(engineName);
  if (!list.length) return '';
  return `May ask ${list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0]} for a second opinion (read-only).`;
}

/** The condenser pattern: an agent hands long reading to a Haiku "reader" and works from its short answer. */
export const READER_ID = 'reader';
export function readerText(agent) {
  if (!agent.reader) return '';
  return 'Before you read anything long (big files, logs, test output, web pages, search results), hand it to the reader agent (Haiku) with what you need to know, and work from its short answer. Read the exact lines yourself only where you will change or quote them.';
}

function readerAgentMd() {
  return [
    '---', `name: ${READER_ID}`,
    'description: Reads long files, logs, test output and web pages for another agent and answers with only what was asked, short and exact (file paths and line numbers kept).',
    'model: haiku', 'tools: Read, Grep, Glob, WebFetch', '---', '',
    'You are the reader. Another agent asks you a question about something long. Read only what you need, then answer in at most 15 lines: the facts asked for, with file paths and line numbers; quote exact text only when it matters. Never change anything. If the answer is not there, say so.', '',
  ].join('\n');
}

function agentsMd({ name, idea, workflow }) {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const lanes = Object.entries(workflow.lanes).filter(([, on]) => on).map(([k]) => k);
  const lines = [
    `# ${name}`,
    '',
    ...(idea || workflow.description ? [oneLine(idea || workflow.description, 600), ''] : []),
    '## How this project is run',
    '',
    'The plan is a workflow: `workflow.json` in this folder (schema `circle-workflow/1`). Read it before you start.',
    '',
    '- A **stage** is one step of the work, in the order listed below (the `edges` between stages, and each stage\'s `needs`).',
    '- An **agent** works inside one stage (its `parent`). `engine` is the tool that runs it and `model` the model to ask for. `does` is its role: stay inside it.',
    '- **Checkpoint:** each stage says what happens when it is done: go straight on, have another engine review the result, or stop and wait for the human. Follow it exactly.',
    '- An agent may ask another engine for a second opinion only when its line below says so (`consult` in `workflow.json`).',
    `- Lanes in use: ${lanes.join(', ') || 'none'}.`,
    ...(workflow.flags.localOnly ? ['- Local only: this project stays on this PC. Do not deploy or publish anything.'] : []),
    ...(workflow.flags.humanDoesGit ? ['- The human does git. Never run a git command that changes anything (add, commit, push, reset, checkout, and the like).'] : []),
    '',
    '## Stages',
  ];
  stageOrder(workflow).forEach((id, n) => {
    const stage = byId.get(id);
    lines.push('', `### ${n + 1}. ${oneLine(stage.title, 100)}`, '');
    lines.push(checkpointText(stage.gate));
    if (stage.needs.length) lines.push(`Needs: ${stage.needs.map((x) => byId.get(x)?.title || x).join(', ')}.`);
    if (stage.skipWhen) lines.push(`Skip when: ${stage.skipWhen}.`);
    if (stage.skills.length) lines.push(`Skills: ${stage.skills.join(', ')}.`);
    if (stage.notes.trim()) lines.push('', stage.notes.trim());
    const agents = agentsOf(workflow, id);
    if (agents.length) lines.push('');
    for (const a of agents) {
      const tags = [a.engine, a.model, a.optional && !a.defaultOn ? 'off by default' : ''].filter(Boolean).join(', ');
      lines.push(`- **${a.title}** (${tags}): ${oneLine(a.does || '', 600) || 'no role text'}${consultText(a) ? ` ${consultText(a)}` : ''}${a.reader ? ' Uses the Haiku reader for long reads.' : ''}`);
    }
  });
  return `${lines.join('\n')}\n`;
}

function claudeAgentMd(agent, stage) {
  const description = oneLine(agent.does || agent.title, 300);
  const front = ['---', `name: ${agent.id}`, `description: ${yamlScalar(description)}`];
  if (agent.model && /^[A-Za-z0-9._[\]-]+$/.test(agent.model)) front.push(`model: ${agent.model}`);
  if (agent.skills.length) front.push(`skills: [${agent.skills.join(', ')}]`);
  front.push('---', '');
  const body = [agent.does || agent.title, agent.prompt, agent.notes.trim()].filter(Boolean).join('\n\n');
  const where = stage ? `\n\nYou work in the "${oneLine(stage.title, 100)}" stage. ${checkpointText(stage.gate)}` : '';
  const consult = consultText(agent) ? `\n\n${consultText(agent)}` : '';
  const reader = readerText(agent) ? `\n\n${readerText(agent)}` : '';
  return `${front.join('\n')}\n${body}${where}${consult}${reader}\n`;
}

function skillFiles(workflow, library, warnings) {
  const out = [];
  for (const [name, engines] of skillEngineMap(workflow)) {
    const files = library.files(name);
    if (!files.length) { warnings.push(`Skill "${name}" is not in the library, so it was not installed.`); continue; }
    const { dirs, engines: used, skipped } = skillTargets([...engines], library.enginesFor(name));
    for (const e of skipped) warnings.push(`Skill "${name}" is not for ${e}, so it was not installed for it.`);
    if (used.includes('gemini') && !warnings.includes(GEMINI_SKILLS_NOTE)) warnings.push(GEMINI_SKILLS_NOTE);
    for (const dir of dirs) for (const f of files) out.push({ path: `${dir}/${name}/${f.path}`, content: f.buffer });
  }
  return out;
}

/**
 * The files for a project. `library` = { files(name), enginesFor(name) }. Set `brief` or `claudeMd` to false to leave
 * those out (an existing project keeps its own). Refuses text that looks like it holds a secret.
 */
export function renderProject({ name, idea = '', workflow, plan, library, brief = true, claudeMd = true, today }) {
  const warnings = [];
  const text = [
    { path: 'workflow.json', content: `${JSON.stringify(workflow, null, 2)}\n` },
    { path: 'AGENTS.md', content: agentsMd({ name, idea, workflow }) },
  ];
  if (claudeMd && agentsOf(workflow).some((a) => a.engine === 'claude')) text.push({ path: 'CLAUDE.md', content: '@AGENTS.md\n' });
  if (brief) text.push({ path: 'docs/brief.md', content: buildBrief(plan, workflow, null, { today }) });
  for (const a of agentsOf(workflow).filter((x) => x.engine === 'claude')) {
    text.push({ path: `.claude/agents/${a.id}.md`, content: claudeAgentMd(a, workflow.nodes.find((n) => n.id === a.parent)) });
  }
  if (agentsOf(workflow).some((a) => a.engine === 'claude' && a.reader) && !agentsOf(workflow).some((a) => a.id === READER_ID)) text.push({ path: `.claude/agents/${READER_ID}.md`, content: readerAgentMd() });
  for (const f of text) {
    const found = scanSecrets(f.content)[0];
    if (found) throw badRequest(`The text for ${f.path} looks like it holds a secret (${found.kind}, line ${found.line}). Remove it from the workflow or the brief first.`);
  }
  return { files: [...text, ...skillFiles(workflow, library, warnings)], warnings };
}
