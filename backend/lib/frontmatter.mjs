// Reading and editing YAML front matter (the subset agents and skills really use) without
// reformatting anything else. See docs/research/github-skills.md section 3 for the shapes it must survive.

const KEY_LINE = /^([A-Za-z0-9_.-]+):(.*)$/;

function segments(raw) {
  return raw.match(/[^\n]*\n|[^\n]+$/g) || [];
}
const stripEol = (s) => s.replace(/\r?\n$/, '');
const eolOf = (s) => (/\r\n$/.test(s) ? '\r\n' : /\n$/.test(s) ? '\n' : '');

function unquoteDouble(s) {
  try { return JSON.parse(s); } catch { return s.slice(1, -1); }
}

function foldLines(lines) {
  let out = '';
  for (const l of lines) {
    if (l.trim() === '') out += '\n';
    else out += (out === '' || out.endsWith('\n') ? '' : ' ') + l.trim();
  }
  return out;
}

function parseQuoted(rest, cont) {
  const q = rest[0];
  const more = cont.map((l) => l.trim());
  const closeAt = (t) => {
    for (let i = 1; i < t.length; i++) {
      if (q === '"' && t[i] === '\\') { i++; continue; }
      if (t[i] === q) {
        if (q === "'" && t[i + 1] === "'") { i++; continue; }
        return i;
      }
    }
    return -1;
  };
  let text = rest;
  let c = closeAt(text);
  while (c < 0 && more.length) { text += ` ${more.shift()}`; c = closeAt(text); }
  const quoted = c < 0 ? text : text.slice(0, c + 1);
  return q === '"' ? unquoteDouble(quoted) : quoted.slice(1, -1).replace(/''/g, "'");
}

function parseFlowList(rest, cont) {
  let text = rest;
  const more = cont.map((l) => l.trim());
  while (!text.includes(']') && more.length) text += ` ${more.shift()}`;
  const inner = text.slice(1, text.lastIndexOf(']') < 0 ? undefined : text.lastIndexOf(']'));
  const items = [];
  let curr = '';
  let q = '';
  for (const ch of inner) {
    if (q) { if (ch === q) q = ''; else curr += ch; } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ',') { items.push(curr.trim()); curr = ''; } else curr += ch;
  }
  if (curr.trim() !== '') items.push(curr.trim());
  return items;
}

function parseValue(first, cont) {
  const rest = first.trim();
  if (rest === '' || rest.startsWith('#')) {
    const items = cont.filter((l) => l.trim() !== '');
    if (items.length && items.every((l) => /^\s*-\s+/.test(l))) return { value: items.map((l) => l.replace(/^\s*-\s+/, '').trim()), nested: false };
    return { value: items.length ? null : '', nested: items.length > 0 };
  }
  const block = /^([|>])([+-]?)(\d?)([+-]?)\s*(#.*)?$/.exec(rest);
  if (block) {
    const indents = cont.filter((l) => l.trim() !== '').map((l) => /^\s*/.exec(l)[0].length);
    const base = indents.length ? Math.min(...indents) : 0;
    const lines = cont.map((l) => (l.trim() === '' ? '' : l.slice(base)));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return { value: block[1] === '|' ? lines.join('\n') : foldLines(lines), nested: false };
  }
  if (rest.startsWith('"') || rest.startsWith("'")) return { value: parseQuoted(rest, cont), nested: false };
  if (rest.startsWith('[')) return { value: parseFlowList(rest, cont), nested: false };
  const plain = [rest.replace(/\s+#.*$/, ''), ...cont.filter((l) => l.trim() !== '').map((l) => l.trim())];
  return { value: plain.join(' '), nested: false };
}

/**
 * Parse the front matter of a file. Returns { ok:false, reason } or
 * { ok:true, bom, eol, segs, close, fields: Map(key -> {value, first, last, nested}), body }.
 * `first`/`last` are segment (line) indexes of the key's whole block.
 */
export function parseFrontMatter(raw) {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  const segs = segments(text);
  if (!segs.length || stripEol(segs[0]).trim() !== '---') return { ok: false, reason: 'no front matter', bom };
  let close = -1;
  for (let n = 1; n < segs.length; n++) {
    if (stripEol(segs[n]).trim() === '---') { close = n; break; }
  }
  if (close < 0) return { ok: false, reason: 'front matter is not closed', bom };
  const fields = new Map();
  const starts = [];
  for (let n = 1; n < close; n++) {
    const line = stripEol(segs[n]);
    const m = KEY_LINE.exec(line);
    if (m && !/^\s/.test(line)) starts.push({ key: m[1], first: n, rest: m[2] });
    else if (!starts.length && line.trim() !== '' && !line.trim().startsWith('#')) return { ok: false, reason: `unexpected line ${n + 1}`, bom };
  }
  starts.forEach((s, k) => {
    const last = (starts[k + 1] ? starts[k + 1].first : close) - 1;
    const cont = [];
    for (let n = s.first + 1; n <= last; n++) cont.push(stripEol(segs[n]));
    const { value, nested } = parseValue(s.rest, cont);
    fields.set(s.key, { value, first: s.first, last, nested });
  });
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return { ok: true, bom, eol, segs, close, fields, body: segs.slice(close + 1).join('') };
}

const RESERVED = /^(true|false|null|yes|no|on|off|~|-?\d[\d.e+-]*)$/i;

/** A YAML scalar for `value`: plain when that is safe, otherwise double-quoted. */
export function yamlScalar(value) {
  const s = String(value);
  const plainOk = s !== '' && !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(s) && !/\s$/.test(s) && !/: |:$| #|\n|\r|\t/.test(s) && !RESERVED.test(s);
  return plainOk ? s : JSON.stringify(s);
}

/** Set (or add) one top-level key. Replaces that key's whole block with a single line; touches nothing else. */
export function setFrontMatterField(raw, key, value) {
  const fm = parseFrontMatter(raw);
  if (!fm.ok) throw new Error(`Cannot edit front matter: ${fm.reason}`);
  const segs = fm.segs.slice();
  const line = `${key}: ${Array.isArray(value) ? `[${value.map(yamlScalar).join(', ')}]` : yamlScalar(value)}`;
  const f = fm.fields.get(key);
  if (f) {
    const term = eolOf(segs[f.first]) || fm.eol;
    segs.splice(f.first, f.last - f.first + 1, line + term);
  } else {
    segs.splice(fm.close, 0, line + fm.eol);
  }
  return (fm.bom ? '﻿' : '') + segs.join('');
}

export function fieldString(fm, key) {
  const f = fm.ok ? fm.fields.get(key) : undefined;
  if (!f || f.value == null) return '';
  return Array.isArray(f.value) ? f.value.join(', ') : String(f.value);
}
