// Finding secrets and making sure their values never leave this process. Only the first four
// characters and an ellipsis are ever shown.

const KEY_PATTERNS = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{16,}/g],
  ['openai-key', /sk-(?:proj-)?[A-Za-z0-9_-]{24,}/g],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{30,}/g],
  ['github-token', /github_pat_[A-Za-z0-9_]{30,}/g],
  ['aws-key', /AKIA[0-9A-Z]{16}/g],
  ['slack-token', /xox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['google-key', /AIza[0-9A-Za-z_-]{35}/g],
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g],
];

// ${VAR:-something}: a non-empty default is a secret waiting to be committed.
const DEFAULT_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]+)\}/g;
// "api_key": "literal value" in JSON-ish text (value not a ${...} placeholder).
const ASSIGN_RE = /(["']?)([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|authorization|bearer)[A-Za-z0-9_-]*)\1\s*[:=]\s*["']([^"'\s$][^"']{7,})["']/gi;

export const mask = (value) => `${String(value).slice(0, 4)}…`;

function lineOf(text, index) {
  let n = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

/** Scan text. Returns [{ kind, line, index, length, preview }] and never the secret itself. */
export function scanSecrets(text) {
  const found = [];
  const taken = [];
  const push = (kind, index, length, value, extra = {}) => {
    if (taken.some(([a, b]) => index < b && index + length > a)) return;
    taken.push([index, index + length]);
    found.push({ kind, line: lineOf(text, index), index, length, preview: mask(value), ...extra });
  };
  for (const m of text.matchAll(DEFAULT_RE)) {
    push('default-value', m.index, m[0].length, m[2], { variable: m[1] });
  }
  for (const [kind, re] of KEY_PATTERNS) {
    for (const m of text.matchAll(re)) push(kind, m.index, m[0].length, m[0]);
  }
  for (const m of text.matchAll(ASSIGN_RE)) {
    const value = m[3];
    if (/^(true|false|null|none|changeme|example|your[-_ ]|<|\$\{)/i.test(value) || value.includes('${')) continue;
    const valueIndex = m.index + m[0].lastIndexOf(value);
    push('literal-assignment', valueIndex, value.length, value, { key: m[2] });
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Replace every finding with its masked form. */
export function redact(text) {
  if (typeof text !== 'string' || text === '') return text;
  const found = scanSecrets(text);
  if (!found.length) return text;
  let out = '';
  let at = 0;
  for (const f of found) {
    out += text.slice(at, f.index) + f.preview;
    at = f.index + f.length;
  }
  return out + text.slice(at);
}

/**
 * Redaction for streamed text: holds back the trailing partial word so a secret split across two
 * chunks is still caught. push() returns text that is safe to emit; flush() returns the rest.
 */
export class StreamRedactor {
  constructor() { this.tail = ''; }
  push(chunk) {
    const buf = this.tail + chunk;
    const cut = Math.max(buf.lastIndexOf(' '), buf.lastIndexOf('\n'), buf.lastIndexOf('\t'));
    if (cut < 0) {
      if (buf.length > 400) { this.tail = ''; return redact(buf); }
      this.tail = buf;
      return '';
    }
    this.tail = buf.slice(cut + 1);
    return redact(buf.slice(0, cut + 1));
  }
  flush() {
    const out = redact(this.tail);
    this.tail = '';
    return out;
  }
}
