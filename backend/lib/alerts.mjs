// docs/tasks/ALERTS.md: the questions a team's texter raises for the human, one `## A-NNN - title` entry each.
// Read tolerantly (bold or plain field names, an em dash, hyphen or colon after the id) and answered by rewriting only
// the one entry, keeping every other byte and the file's line endings.
import { badRequest, conflict, notFound } from './errors.mjs';
import { detectEol } from './textfile.mjs';
import { scanSecrets } from './secrets.mjs';

const HEADING_RE = /^##[ \t]*(A-\d+)[ \t]*(?:[—\-:][ \t]*(.+?))?[ \t]*$/gim;
const ID_RE = /^A-\d+$/;
const CLOSED_RE = /^(answered|closed|resolved|done)\b/i;
export const ANSWER_MAX = 600;

// "- **Name:** value", "- Name: value" or "Name: value"; the colon may sit inside the bold markers.
const fieldRe = (name) => new RegExp(`^([ \\t]*-?[ \\t]*\\*{0,2}${name}[ \\t]*:\\*{0,2}[ \\t]*)(.*?)[ \\t]*$`, 'im');
const field = (block, name) => { const m = fieldRe(name).exec(block); return m ? m[2].trim() : null; };

export const isOpenStatus = (status) => !CLOSED_RE.test(String(status || 'open').trim());

/** The date in a "Raised" line ("2026-09-30 by texter, from ..."), as an ISO string, or null. */
export function raisedAt(raised) {
  const m = raised && /\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/.exec(raised);
  if (!m) return null;
  const d = new Date(m[0].replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function entries(text) {
  const heads = [...text.matchAll(HEADING_RE)];
  return heads.map((h, i) => {
    const start = h.index + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : text.length;
    return { id: h[1], title: (h[2] || '').trim(), start, end, block: text.slice(start, end) };
  });
}

export function parseAlerts(text) {
  if (typeof text !== 'string') return [];
  return entries(text.replace(/\r\n/g, '\n')).map((e) => {
    const status = (field(e.block, 'Status') || 'open').toLowerCase();
    const raised = field(e.block, 'Raised');
    return {
      id: e.id, title: e.title, status, open: isOpenStatus(status), raised, at: raisedAt(raised),
      question: field(e.block, 'Question for the human'), options: field(e.block, 'Options'), blocks: field(e.block, 'Blocks'),
      answer: field(e.block, 'Answer'),
    };
  });
}

/**
 * The file text with alert `id` marked answered and the answer written in. Throws if the entry is missing, is not
 * open any more, has no Status line to change, or the answer is empty, too long, or looks like a secret.
 */
export function answerAlertText(text, id, answer, today) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw badRequest('id must look like A-001.');
  const line = typeof answer === 'string' ? answer.replace(/\s*[\r\n]+\s*/g, ' ').trim() : '';
  if (!line || line.length > ANSWER_MAX) throw badRequest(`The answer must be between 1 and ${ANSWER_MAX} characters.`);
  if (scanSecrets(line).length) throw badRequest('The answer looks like it contains a secret. Circle Studio will not write it into ALERTS.md.');
  const eol = detectEol(text);
  const lf = text.replace(/\r\n/g, '\n');
  const e = entries(lf).find((x) => x.id === id);
  if (!e) throw notFound(`${id} is not in docs/tasks/ALERTS.md.`);
  const st = fieldRe('Status').exec(e.block);
  if (!st) throw conflict(`${id} has no Status line, so Circle Studio cannot mark it answered. Nothing was changed.`);
  if (!isOpenStatus(st[2])) throw conflict(`${id} is already ${st[2].trim()}. Nothing was changed.`);
  // An empty value ("- **Answer:**") has no space after the colon to keep, so make sure there is one.
  const spaced = (lead) => lead.replace(/[ \t]*$/, ' ');
  let block = e.block.replace(fieldRe('Status'), (_, lead) => `${spaced(lead)}answered`);
  const note = `${line} (human, via Circle Studio, ${today})`;
  if (fieldRe('Answer').test(block)) block = block.replace(fieldRe('Answer'), (_, lead) => `${spaced(lead)}${note}`);
  else {
    const trimmed = block.replace(/\s+$/, '');
    const bold = /\*\*/.test(st[1]);
    block = `${trimmed}\n- ${bold ? '**Answer:**' : 'Answer:'} ${note}${block.slice(trimmed.length)}`;
  }
  const out = lf.slice(0, e.start) + block + lf.slice(e.end);
  return eol === '\r\n' ? out.replace(/\n/g, '\r\n') : out;
}
