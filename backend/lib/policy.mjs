// The approval policy: what an agent may do on its own, what needs a human, and what is refused outright.
// Security critical. Bash is not sandboxed on Windows, so this file (and the human) are the only guard.
//   allow : Read, Grep and Glob inside the project on a path that is not a secret.
//   ask   : every command, every edit, every question, anything else. risk 'outside-project' when a path leaves the folder.
//   deny  : risk 'dangerous' (recorded as auto-denied, never a popup), anything the policy cannot read, and what the
//           project's permissions do not allow.
// Tool names are the ones Claude uses (Bash, Read, Grep, Glob, Edit, Write, AskUserQuestion); the other engines'
// adapters translate theirs before calling evaluate().
import { classifyPath, sensitiveReason, globNamesSecret, isGuardPath, isGitDir, displayPath } from './policy-paths.mjs';
import { analyzeShell, plainWords } from './policy-shell.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n... (${s.length - n} more characters)` : String(s ?? ''));

const result = (verdict, risk, reasons, extra = {}) => ({ verdict, risk, reasons, kind: 'approval', ...extra });
const refuse = (reason, risk = 'dangerous', extra = {}) => result('deny', risk, [reason], extra);

/* ---- questions -------------------------------------------------------------------------------------- */

/** The questions an agent asked, cleaned up, or null when the shape is wrong. */
export function normalizeQuestions(input) {
  const list = input?.questions;
  if (!Array.isArray(list) || !list.length || list.length > MAX_QUESTIONS) return null;
  const out = [];
  for (const q of list) {
    if (!q || typeof q.question !== 'string' || !q.question.trim()) return null;
    const options = Array.isArray(q.options) ? q.options.slice(0, MAX_OPTIONS) : [];
    if (options.some((o) => !o || typeof o.label !== 'string')) return null;
    out.push({
      question: clip(q.question, 1000),
      header: clip(q.header ?? '', 80),
      options: options.map((o) => ({ label: clip(o.label, 200), description: clip(o.description ?? '', 500) })),
      multiSelect: q.multiSelect === true,
      ...(q.secret === true ? { secret: true } : {}),
      ...(q.id !== undefined ? { id: String(q.id) } : {}),
    });
  }
  return out;
}

function evaluateQuestion(input) {
  const questions = normalizeQuestions(input);
  if (!questions) return refuse('The agent sent a question the app cannot read.', 'normal', { kind: 'question' });
  return result('ask', 'normal', [], {
    kind: 'question',
    questions,
    title: questions[0].header || 'The agent has a question',
    detail: questions.map((q) => q.question).join('\n'),
  });
}

/* ---- commands --------------------------------------------------------------------------------------- */

function evaluateBash(input, blockedPath, ctx) {
  const command = input?.command;
  const base = { title: 'Run a command', detail: typeof command === 'string' ? command : '' };
  if (typeof command !== 'string' || !command.trim()) return refuse('The agent sent a command the app cannot read.', 'dangerous', base);
  if (!ctx.permissions.shell) return refuse('Running commands is turned off for this project (Permissions).', 'normal', base);
  const found = analyzeShell(command, ctx);
  if (blockedPath) {
    const c = classifyPath(blockedPath, { root: ctx.root, cwd: ctx.root, protect: ctx.protect });
    if (sensitiveReason(blockedPath)) found.danger.push(`It touches ${sensitiveReason(blockedPath)}: ${blockedPath}.`);
    if (c.status !== 'inside') found.outside.push(`The agent's own check says it reaches outside the project: ${blockedPath}.`);
  }
  if (found.danger.length) return result('deny', 'dangerous', [...found.danger, ...found.outside], base);
  if (found.outside.length) return result('ask', 'outside-project', found.outside, base);
  return result('ask', 'normal', [], base);
}

/* ---- files ------------------------------------------------------------------------------------------ */

function targetsOf(tool, input) {
  if (tool === 'Read') return [{ raw: input.file_path, need: true }];
  if (tool === 'Grep') return [{ raw: input.path ?? '.', need: false }, { raw: input.glob, need: false, pattern: true }];
  if (tool === 'Glob') return [{ raw: input.path ?? '.', need: false }, { raw: input.pattern, need: true, pattern: true }];
  if (tool === 'NotebookEdit') return [{ raw: input.notebook_path, need: true }];
  return [{ raw: input.file_path ?? input.path, need: true }];
}

/** The folder part of a glob, up to its first wildcard: what the pattern is anchored to. */
const staticPrefix = (pattern) => {
  const parts = pattern.split(/[\\/]/);
  const i = parts.findIndex((s) => /[*?[{]/.test(s));
  return (i < 0 ? parts : parts.slice(0, i)).join('/') || '.';
};

function previewOf(tool, input) {
  if (tool === 'Write') return clip(input.content, 4000);
  if (tool === 'Edit') return `- ${clip(input.old_string, 2000).replace(/\n/g, '\n- ')}\n+ ${clip(input.new_string, 2000).replace(/\n/g, '\n+ ')}`;
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) return input.edits.slice(0, 20).map((e) => `- ${clip(e?.old_string, 500)}\n+ ${clip(e?.new_string, 500)}`).join('\n\n');
  if (tool === 'NotebookEdit') return clip(input.new_source, 4000);
  return '';
}

function checkTarget(t, write, ctx, found) {
  if (typeof t.raw !== 'string' || t.raw === '') {
    if (t.need) found.danger.push('The agent gave no path.');
    return;
  }
  const p = t.pattern ? staticPrefix(t.raw) : t.raw;
  const c = classifyPath(p, { root: ctx.root, cwd: ctx.root, protect: ctx.protect });
  const secret = sensitiveReason(t.raw) || (t.pattern && globNamesSecret(t.raw) ? 'a file that may hold secrets' : null);
  if (c.protectedDir) found.danger.push("It touches Circle Studio's own data folder.");
  if (secret) found.danger.push(`It touches ${secret}: ${t.raw}.`);
  if (write && isGuardPath(t.raw)) found.danger.push(`It changes a file that guards the agent (${t.raw}).`);
  if (write && isGitDir(t.raw)) found.danger.push(`It changes the git folder (${t.raw}). Git is yours to run.`);
  if (c.status !== 'inside') found.outside.push(`It reaches ${c.why}: ${t.raw}.`);
}

function evaluatePaths(tool, input, blockedPath, ctx) {
  const write = EDIT_TOOLS.has(tool);
  const shown = displayPath(input.file_path ?? input.path ?? input.notebook_path ?? input.pattern ?? '', ctx.root);
  const base = { title: write ? `${tool === 'Write' ? 'Write' : 'Edit'} ${shown}` : `${tool} ${shown}`, detail: write ? `${shown}\n\n${previewOf(tool, input)}` : shown };
  if (write && !ctx.permissions.write) return refuse('Changing files is turned off for this project (Permissions).', 'normal', base);
  const found = { danger: [], outside: [] };
  if (write && input.unknownPath === true) found.outside.push('The files it will change are not known yet. Check the details.');
  else for (const t of targetsOf(tool, input)) checkTarget(t, write, ctx, found);
  if (blockedPath) checkTarget({ raw: blockedPath, need: false }, write, ctx, found);
  if (found.danger.length) return result('deny', 'dangerous', [...found.danger, ...found.outside], base);
  if (found.outside.length) return result('ask', 'outside-project', found.outside, base);
  return result(write ? 'ask' : 'allow', 'normal', [], base);
}

/* ---- entry point ------------------------------------------------------------------------------------ */

/**
 * Decide what to do with one request from an agent.
 * ctx: { root, protect: [absolute folders that are off limits], permissions: { shell, write } }.
 * Returns { verdict:'allow'|'ask'|'deny', risk:'normal'|'outside-project'|'dangerous', reasons, kind, title, detail, questions? }.
 */
export function evaluate({ tool, input, blockedPath }, ctx) {
  const c = { root: ctx.root, protect: ctx.protect || [], permissions: { shell: ctx.permissions?.shell !== false, write: ctx.permissions?.write !== false } };
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (tool === 'AskUserQuestion') return evaluateQuestion(data);
  if (tool === 'Bash') return evaluateBash(data, blockedPath, c);
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob' || EDIT_TOOLS.has(tool)) return evaluatePaths(tool, data, blockedPath, c);
  return result('ask', 'normal', [], { title: `Use ${clip(tool, 60)}`, detail: clip(JSON.stringify(data, null, 2), 2000) });
}

/* ---- "allow this for the rest of the run" ----------------------------------------------------------- */

const EXACT_ONLY = new Set('sh bash zsh dash ksh fish ash powershell pwsh cmd python python3 py pypy node nodejs bun deno perl ruby php lua npx bunx pnpx uvx pipx'.split(' '));
const SUBCOMMAND = /^[a-z][a-z0-9:_-]*$/i;

/**
 * What a remembered approval covers, or null when this request may not be remembered.
 * A plain command is remembered by its program and subcommand ("npm test"); interpreters, runners and anything
 * unusual only by the exact command; an edit only by its file. Questions and anything with operators never.
 */
export function rememberRule(tool, input) {
  if (tool === 'Bash') {
    const words = plainWords(input?.command);
    if (!words) return null;
    const name = words[0].split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    const runner = EXACT_ONLY.has(name) || ['exec', 'dlx', 'x'].includes((words[1] || '').toLowerCase());
    if (runner || !words[1] || !SUBCOMMAND.test(words[1])) return { tool, kind: 'exact', words };
    return { tool, kind: 'prefix', words: words.slice(0, 2) };
  }
  if ((tool === 'Edit' || tool === 'Write') && typeof input?.file_path === 'string') return { tool, kind: 'file', value: input.file_path.replace(/\\/g, '/').toLowerCase() };
  return null;
}

/** Does an earlier remembered rule cover this new request? */
export function ruleCovers(rule, tool, input) {
  if (rule.tool !== tool) return false;
  if (rule.kind === 'file') return typeof input?.file_path === 'string' && input.file_path.replace(/\\/g, '/').toLowerCase() === rule.value;
  const words = plainWords(input?.command);
  if (!words) return false;
  if (rule.kind === 'exact') return words.length === rule.words.length && words.every((w, i) => w === rule.words[i]);
  return rule.words.every((w, i) => words[i] === w);
}
