// Project health: the six pains from improvement.md turned into checks, each with plain words and,
// where a safe fix exists, the operation that fixes it (which still goes through the diff review).
import fs from 'node:fs';
import path from 'node:path';
import { P, LANE_OF, inspectTeam, badConsultEntries, parseJson, readProjectText } from './team.mjs';
import { scanSecrets } from './secrets.mjs';
import { runCommand } from './run.mjs';
import { credentialRisk } from './claude.mjs';
import { gitignoreBlockPresent } from './gitblock.mjs';
import { parseAlerts } from './alerts.mjs';

const abs = (root, rel) => path.join(root, ...rel.split('/'));
const BLOCKED_BY = { frontend: ['fe-builder'], backend: ['be-builder', 'migrator'], both: ['connector'], all: ['fe-builder', 'be-builder', 'migrator', 'connector'] };

/* ---- freeze (improvement.md 2.5) ---------------------------------------------------------------- */

export function describeFreeze(text) {
  if (text == null) return { state: 'none', severity: 'ok', title: 'No lane is frozen', detail: 'There is no freeze file, so no builder is blocked.', frozen: [] };
  const j = parseJson(text);
  if (!j.ok) return { state: 'malformed', severity: 'warn', title: 'freeze.json is not valid JSON', detail: 'The guard treats a broken freeze file as no freeze at all (it fails open). Nobody is blocked, even if that is not what you meant.', frozen: [] };
  const v = j.value || {};
  const raw = Array.isArray(v.frozen) ? v.frozen : typeof v.frozen === 'string' ? [v.frozen] : [];
  const known = raw.filter((x) => typeof x === 'string' && BLOCKED_BY[x]);
  const unknown = raw.filter((x) => !known.includes(x));
  const paths = Array.isArray(v.paths) ? v.paths : [];
  if (!known.length) {
    return {
      state: unknown.length ? 'ignored' : 'none',
      severity: unknown.length ? 'warn' : 'ok',
      title: unknown.length ? 'The freeze names lanes the guard does not know' : 'No lane is frozen',
      detail: unknown.length ? `${unknown.map((u) => `"${u}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} ignored: the guard matches frontend, backend, both and all in lowercase. Nobody is blocked.` : 'The freeze list is empty, so no builder is blocked.',
      frozen: [],
    };
  }
  const roles = [...new Set(known.flatMap((l) => BLOCKED_BY[l]))];
  const who = roles.join(', ');
  const req = v.request_id ? ` for change ${v.request_id}` : '';
  let detail = `${known.join(' and ')} ${known.length === 1 ? 'is' : 'are'} frozen${req}. ${who} cannot write until it is lifted. The whole lane is frozen.`;
  if (paths.length) detail += ` The "paths" list (${paths.length} entr${paths.length === 1 ? 'y' : 'ies'}) is ignored by the guard, so it does not narrow the freeze.`;
  if (known.includes('both') && !known.includes('all')) detail += ' "both" blocks only the connector.';
  if (unknown.length) detail += ` Ignored: ${unknown.join(', ')}.`;
  return { state: 'frozen', severity: 'danger', title: `${known.join(' + ')} frozen`, detail, frozen: known, blocked: roles, requestId: v.request_id || null };
}

/* ---- ADRs (2.7) ---------------------------------------------------------------------------------- */

export function listAdrs(root) {
  const dir = abs(root, P.adrDir);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d{3}-[a-z0-9-]+\.md$/.test(f) && f !== '000-template.md').sort(); } catch { return []; }
  return files.map((file) => {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const cut = raw.search(/\r?\n## /);
    const head = cut < 0 ? raw : raw.slice(0, cut);
    const m = /^-\s*\*\*Status:\*\*[ \t]*(.*?)\r?$/m.exec(head);
    const status = m ? m[1].trim() : null;
    const word = status ? status.split(/[\s(]/)[0].toLowerCase() : '';
    return {
      file,
      title: (/^#\s+(.+?)\r?$/m.exec(head) || [, file])[1],
      status: status === null ? 'missing' : word || 'empty',
      statusText: status,
    };
  });
}

/* ---- board (2.10) -------------------------------------------------------------------------------- */

export function readBoard(root) {
  const text = readProjectText(root, P.board);
  if (text == null) return { exists: false, rows: [], dropped: [], nextId: 'TX-001', open: 0 };
  const rows = [];
  const dropped = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\|\s*TX-\d+/i.test(line)) continue;
    const cells = line.replace(/\\\|/g, '\u0001').split('|').slice(1, -1).map((c) => c.replace(/\u0001/g, '|').trim());
    if (cells.length !== 6) { dropped.push({ id: (/TX-\d+/i.exec(line) || [''])[0], cells: cells.length }); continue; }
    rows.push({ id: cells[0], owner: cells[1], status: cells[2], source: cells[3], summary: cells[4], updated: cells[5] });
  }
  const max = [...rows, ...dropped].reduce((m, r) => Math.max(m, Number(/\d+/.exec(r.id)?.[0] || 0)), 0);
  return {
    exists: true,
    rows: rows.slice(0, 8),
    total: rows.length,
    dropped,
    nextId: `TX-${String(max + 1).padStart(3, '0')}`,
    open: rows.filter((r) => !/^(done|closed|cancelled|superseded)/i.test(r.status)).length,
  };
}

/* ---- git (2.9), read-only ------------------------------------------------------------------------- */

export async function gitInfo(root) {
  if (!fs.existsSync(abs(root, '.git'))) return { present: false };
  const r = await runCommand('git', ['--no-optional-locks', 'status', '--porcelain', '-b'], { cwd: root, timeoutMs: 8000 });
  if (r.error) return { present: true, available: false };
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  const head = lines.find((l) => l.startsWith('## ')) || '';
  return { present: true, available: r.code === 0, branch: head.slice(3).split('...')[0] || null, dirty: lines.filter((l) => !l.startsWith('## ')).length };
}

/** A cheap version for the home screen: no git, no process. Returns [{ severity, title }]. */
export function quickAttention(root) {
  const out = [];
  const freeze = describeFreeze(readProjectText(root, P.freeze));
  // the same plain words as the Health tab
  const lanes = { frontend: 'Frontend', backend: 'Backend', both: 'Contract', all: 'All building' };
  if (freeze.state === 'frozen') out.push({ severity: 'danger', title: `${freeze.frozen.map((l) => lanes[l] || l).join(' and ')} work paused` });
  const proposed = listAdrs(root).filter((a) => a.status === 'proposed').length;
  if (proposed) out.push({ severity: 'warn', title: `${proposed} decision${proposed === 1 ? ' waits' : 's wait'} for your OK` });
  const questions = parseAlerts(readProjectText(root, P.alerts)).filter((a) => a.open).length;
  if (questions) out.push({ severity: 'warn', title: `${questions} team question${questions === 1 ? '' : 's'}` });
  let secrets = 0;
  for (const rel of [P.mcp, '.claude/settings.json']) {
    const t = readProjectText(root, rel);
    if (t != null) secrets += scanSecrets(t).length;
  }
  if (secrets) out.push({ severity: 'danger', title: `${secrets === 1 ? 'A key' : `${secrets} keys`} in a config file` });
  const drift = inspectTeam(root).roles.filter((r) => r.drift).length;
  if (drift) out.push({ severity: 'warn', title: `${drift} agent${drift === 1 ? '' : 's'} off the planned model` });
  return out;
}

/* ---- the whole picture --------------------------------------------------------------------------- */

const LANE_WORD = { frontend: 'Frontend', backend: 'Backend', both: 'Contract', all: 'All building' };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Every check, in plain words. Each item: { id, group:'now'|'look'|'fine', severity, title, detail, tech?, items?,
 * fix?:{label, ops}, link?:{label, href} }. `title` and `detail` avoid the team's jargon; `tech` keeps the exact
 * technical facts for the Details disclosure. `now` = work is stopped or a decision waits for you; `look` = worth
 * fixing or a suggestion; `fine` = nothing to do.
 */
export async function computeHealth(root, { projectId } = {}) {
  const items = [];
  const add = (i) => items.push(i);
  const team = inspectTeam(root);

  // work paused (freeze.json, improvement.md 2.5)
  const freeze = describeFreeze(readProjectText(root, P.freeze));
  if (freeze.state === 'frozen') {
    const lanes = freeze.frozen.map((l) => LANE_WORD[l] || l).join(' and ');
    add({ id: 'freeze', group: 'now', severity: 'danger', title: `${lanes} work is paused`,
      detail: `${freeze.requestId ? `Change ${freeze.requestId} paused it. ` : ''}${freeze.blocked.join(', ')} cannot change anything until you lift the pause.`,
      tech: freeze.detail, frozen: freeze.frozen, requestId: freeze.requestId,
      fix: { label: 'Lift the pause', ops: [{ op: 'freeze-set', frozen: [] }] } });
  } else if (freeze.state === 'malformed' || freeze.state === 'ignored') {
    add({ id: 'freeze', group: 'look', severity: 'warn', title: 'The pause file does not work', detail: 'Nobody is paused, even if a pause was meant. The team ignores a broken or misspelled pause.', tech: freeze.detail, frozen: [] });
  } else add({ id: 'freeze', group: 'fine', severity: 'ok', title: 'No work is paused', detail: 'Every builder can work.', frozen: [] });

  // questions the team asked you (docs/tasks/ALERTS.md)
  const questions = parseAlerts(readProjectText(root, P.alerts)).filter((a) => a.open);
  if (questions.length) {
    add({ id: 'questions', group: 'now', severity: 'warn', title: `The team asked you ${plural(questions.length, 'question')}`,
      detail: 'Work that depends on the answer waits. Answer them in the Inbox.', link: { label: 'Open the Inbox', href: '#/inbox' } });
  }

  // decisions still proposed (ADRs, 2.7)
  const adrs = listAdrs(root);
  const proposed = adrs.filter((a) => a.status === 'proposed');
  const adrItems = adrs.map((a) => ({ file: a.file, title: a.title, status: a.status, statusText: a.statusText }));
  if (proposed.length) {
    add({ id: 'adr', group: 'now', severity: 'warn', title: `${plural(proposed.length, 'decision')} ${proposed.length === 1 ? 'waits' : 'wait'} for your OK`,
      detail: 'The team wrote down a choice (a decision record, ADR) that nobody has accepted. It can build on a choice you never agreed to.', items: adrItems });
  } else add({ id: 'adr', group: 'fine', severity: adrs.length ? 'ok' : 'info', title: adrs.length ? 'Every written decision is agreed' : 'No decisions written down yet', detail: adrs.length ? `${plural(adrs.length, 'decision record')}, all accepted or replaced.` : 'The team records its big choices in docs/adr when it makes them.', items: adrItems });

  // keys in config files (2.8)
  const secretFindings = [];
  for (const rel of [P.mcp, '.claude/settings.json', '.claude/settings.local.json']) {
    const text = readProjectText(root, rel);
    if (text == null) continue;
    for (const f of scanSecrets(text)) secretFindings.push({ file: rel, line: f.line, kind: f.kind, preview: f.preview, variable: f.variable });
  }
  if (secretFindings.length) {
    const fixable = secretFindings.some((f) => f.kind === 'default-value' && f.file !== '.claude/settings.local.json');
    add({ id: 'secrets', group: 'now', severity: 'danger', title: `A key or password is written in ${secretFindings.length === 1 ? 'a config file' : 'config files'}`,
      detail: 'Anyone with this folder can read it, and it may already be in git history. Take it out, then make a new key.',
      tech: 'Values are never shown, only their first four characters.', items: secretFindings,
      fix: fixable ? { label: 'Take the key out of the file', ops: [{ op: 'secrets-fix' }] } : undefined });
  } else add({ id: 'secrets', group: 'fine', severity: 'ok', title: 'No keys in config files', detail: 'Checked .mcp.json and the Claude settings files.' });

  const risk = credentialRisk(root);
  if (risk.length) {
    add({ id: 'credentials', group: 'look', severity: 'warn', title: 'This project could send Claude to a different account',
      detail: 'Its settings change where Claude signs in. Chat ignores them for safety, so this project\'s CLAUDE.md is not used in chat.', tech: risk.join('; ') });
  }

  // models match the plan (1, 2.3)
  const drifted = team.roles.filter((r) => r.drift);
  const broken = team.roles.filter((r) => r.missingAgentFile || r.missingModelsEntry);
  if (team.files.modelsJson) {
    if (broken.length) {
      add({ id: 'tiers', group: 'now', severity: 'danger', title: 'The model list and the agents do not line up',
        detail: `${broken.map((r) => r.role).join(', ')} ${broken.length === 1 ? 'is' : 'are'} missing an agent file or a models.json entry. Model changes are refused until this is fixed by hand.`,
        tech: broken.map((r) => `${r.role}: ${r.missingAgentFile ? 'no agent file' : 'no models.json entry'}`).join('; '), items: broken.map((r) => ({ role: r.role, agentModel: r.agentModel, configModel: r.configModel })) });
    } else if (drifted.length) {
      add({ id: 'tiers', group: 'look', severity: 'warn', title: `${plural(drifted.length, 'agent')} ${drifted.length === 1 ? 'runs' : 'run'} a different model than planned`,
        detail: 'The plan (models.json) and the agent files disagree. Agents use what their file says.',
        tech: drifted.map((r) => `${r.role}: ${r.agentModel} in the agent file, ${r.configModel} in models.json`).join('; '),
        items: drifted.map((r) => ({ role: r.role, agentModel: r.agentModel, configModel: r.configModel })),
        fix: { label: 'Make the agent files match the plan', ops: [{ op: 'sync-agents' }] } });
    } else add({ id: 'tiers', group: 'fine', severity: 'ok', title: 'Every agent uses its planned model', detail: `${plural(team.roles.length, 'agent')} checked.` });
  }

  const cfgText = readProjectText(root, P.consult);
  const cfgJ = parseJson(cfgText);
  if (cfgJ.ok) {
    const bad = badConsultEntries(cfgJ.value);
    if (bad.length) add({ id: 'consult', group: 'look', severity: 'warn', title: 'The engine routing file has a broken entry', detail: 'The team\'s engine tool crashes on it. Fix it by hand.', tech: `roles ${bad.map((b) => `"${b}"`).join(', ')} in consult.config.json are null, empty, or not a string or object.` });
  } else if (!cfgJ.missing) {
    add({ id: 'consult', group: 'look', severity: 'warn', title: 'The engine routing file cannot be read', detail: 'It is not valid JSON, so the team falls back to its defaults.', tech: cfgJ.error });
  }

  const down = team.engineHealth.filter((e) => e.state !== 'ok' && e.state !== 'unknown');
  if (down.length) add({ id: 'engines', group: 'look', severity: 'info', title: `${plural(down.length, 'helper engine')} ${down.length === 1 ? 'is' : 'are'} unavailable to the team`, detail: 'The team skips them and asks the next engine.', tech: down.map((e) => `${e.name}: ${e.state}${e.reason ? ` (${e.reason})` : ''}`).join('; ') });

  // who does git (2.9)
  const git = await gitInfo(root);
  const humanGit = team.roster.humanDoesGit;
  const giText = readProjectText(root, '.gitignore');
  const blockOn = giText != null && gitignoreBlockPresent(giText);
  const gitFacts = git.present && git.available ? `Branch ${git.branch || '?'}, ${plural(git.dirty, 'changed file')}.` : git.present ? '' : 'This folder is not a git repository yet.';
  if (humanGit && blockOn) add({ id: 'git', group: 'fine', severity: 'ok', title: 'You handle git', detail: `The team is told not to commit or push. ${gitFacts}`.trim(), git });
  else if (humanGit) add({ id: 'git', group: 'look', severity: 'warn', title: 'You handle git, but private files could be committed', detail: 'The list of files that stay on this PC is missing from .gitignore.', git, fix: { label: 'Add the list to .gitignore', ops: [{ op: 'human-git', value: true }] } });
  else add({ id: 'git', group: 'look', severity: 'info', title: 'The team may commit and push by itself', detail: `Switch this on if you want to do git yourself. ${gitFacts}`.trim(), git, fix: { label: 'I will do git myself', ops: [{ op: 'human-git', value: true }] } });

  // the task board (2.10)
  const board = readBoard(root);
  if (board.exists && board.dropped.length) {
    add({ id: 'board', group: 'look', severity: 'warn', title: `${plural(board.dropped.length, 'task')} ${board.dropped.length === 1 ? 'is' : 'are'} invisible on the team's dashboard`, detail: 'A "|" inside the text broke the row. The team never sees it.', tech: `${board.dropped.map((d) => `${d.id} has ${d.cells} cells`).join('; ')}. The dashboard needs exactly six; write "\\|" for a pipe.` });
  } else if (board.exists) add({ id: 'board', group: 'fine', severity: 'info', title: `${plural(board.open, 'open task')} on the board`, detail: `${plural(board.total ?? 0, 'task')} in docs/tasks/BOARD.md.` });

  if (!team.files.brief) add({ id: 'brief', group: 'look', severity: 'info', title: 'The team has no brief to read', detail: 'Write it from the Workflow tab; it goes into docs/brief.md after you see the diff.', link: projectId ? { label: 'Open the Workflow tab', href: `#/projects/${projectId}/workflow` } : undefined });
  for (const p of team.problems) add({ id: 'problem', group: 'look', severity: 'warn', title: `${p.file} could not be read`, detail: 'The team may ignore this file until it is fixed by hand.', tech: p.message });

  const order = { now: 0, look: 1, fine: 2 };
  const sev = { danger: 0, warn: 1, info: 2, ok: 3 };
  items.sort((a, b) => order[a.group] - order[b.group] || sev[a.severity] - sev[b.severity]);
  const count = (g) => items.filter((i) => i.group === g).length;
  const now = count('now');
  const look = count('look');
  return {
    summary: now ? `${plural(now, 'thing')} ${now === 1 ? 'needs' : 'need'} you now` : look ? `Nothing is blocked. ${plural(look, 'thing')} worth a look.` : 'All good. Nothing needs you.',
    counts: { now, look, fine: count('fine'), danger: items.filter((i) => i.severity === 'danger').length, warn: items.filter((i) => i.severity === 'warn').length },
    items,
    board,
    freeze,
    lanes: LANE_OF,
  };
}
