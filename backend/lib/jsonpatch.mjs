// Edit a JSON *text* in place: replace one value, add or remove one member, leave every other byte
// alone. models.json and the other team files are hand-formatted, so parse + stringify would rewrite
// dozens of lines. Every edit is verified by parsing the result.

const WS = ' \t\r\n';

/** Parse JSON text into a tree that remembers where every value starts and ends. */
export function parseSpans(text) {
  let i = 0;
  const literal = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  const fail = (what) => { throw new Error(`Invalid JSON: ${what} at offset ${i}`); };
  const ws = () => { while (i < text.length && WS.includes(text[i])) i++; };
  const str = () => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail('unterminated string');
    i++;
    return { start, end: i };
  };
  function value() {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const members = [];
      ws();
      if (text[i] === '}') { i++; return { type: 'object', start, end: i, members }; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('expected a key');
        const k = str();
        const key = JSON.parse(text.slice(k.start, k.end));
        ws();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        const v = value();
        members.push({ key, keyStart: k.start, keyEnd: k.end, value: v });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; break; }
        fail('expected "," or "}"');
      }
      return { type: 'object', start, end: i, members };
    }
    if (c === '[') {
      i++;
      const items = [];
      ws();
      if (text[i] === ']') { i++; return { type: 'array', start, end: i, items }; }
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; break; }
        fail('expected "," or "]"');
      }
      return { type: 'array', start, end: i, items };
    }
    if (c === '"') { const s = str(); return { type: 'string', start: s.start, end: s.end }; }
    literal.lastIndex = i;
    const m = literal.exec(text);
    if (!m) fail('unexpected character');
    i += m[0].length;
    return { type: 'literal', start, end: i };
  }
  const root = value();
  ws();
  if (i < text.length) fail('trailing characters');
  return root;
}

export const valueOf = (text, node) => JSON.parse(text.slice(node.start, node.end));

/** Walk `path` (keys and array indexes) from `node`. Returns the node or undefined. */
export function getNode(node, path) {
  let cur = node;
  for (const p of path) {
    if (!cur) return undefined;
    if (cur.type === 'object') cur = cur.members.find((m) => m.key === p)?.value;
    else if (cur.type === 'array') cur = cur.items[p];
    else return undefined;
  }
  return cur;
}

const lineStart = (text, idx) => text.lastIndexOf('\n', idx - 1) + 1;
const indentOfLine = (text, idx) => /^[ \t]*/.exec(text.slice(lineStart(text, idx)))[0];

function inlineJson(v) {
  if (Array.isArray(v)) return `[${v.map(inlineJson).join(', ')}]`;
  if (v && typeof v === 'object') {
    const parts = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inlineJson(x)}`);
    return parts.length ? `{ ${parts.join(', ')} }` : '{}';
  }
  return JSON.stringify(v);
}

/**
 * Serialise `value` to sit at a position whose line has indentation `indent`.
 * Objects and arrays are laid out multi-line with `unit` per level, or inline when `inline` is true.
 */
export function formatValue(value, { indent = '', unit = '  ', eol = '\n', inline = false } = {}) {
  if (value === null || typeof value !== 'object' || inline) return inlineJson(value);
  const body = JSON.stringify(value, null, unit);
  return body.split('\n').map((l, n) => (n === 0 ? l : indent + l)).join(eol);
}

function detectUnit(text, obj) {
  if (obj.members?.length) {
    const first = obj.members[0];
    const childIndent = indentOfLine(text, first.keyStart);
    const baseIndent = indentOfLine(text, obj.start);
    if (childIndent.length > baseIndent.length && text.slice(obj.start, first.keyStart).includes('\n')) {
      return childIndent.slice(baseIndent.length);
    }
  }
  return '  ';
}

const isMultiline = (text, node) => text.slice(node.start, node.end).includes('\n');

/** Replace a node's span with new text. */
export function replaceNode(text, node, newText) {
  return text.slice(0, node.start) + newText + text.slice(node.end);
}

function insertMember(text, obj, key, value, eol) {
  const unit = detectUnit(text, obj);
  if (obj.members.length === 0) {
    const base = indentOfLine(text, obj.start);
    const child = base + unit;
    const body = `{${eol}${child}${JSON.stringify(key)}: ${formatValue(value, { indent: child, unit, eol })}${eol}${base}}`;
    return replaceNode(text, obj, body);
  }
  const last = obj.members[obj.members.length - 1];
  const multi = text.slice(obj.start, obj.members[0].keyStart).includes('\n');
  if (multi) {
    const child = indentOfLine(text, obj.members[0].keyStart);
    const add = `,${eol}${child}${JSON.stringify(key)}: ${formatValue(value, { indent: child, unit, eol })}`;
    return text.slice(0, last.value.end) + add + text.slice(last.value.end);
  }
  const add = `, ${JSON.stringify(key)}: ${inlineJson(value)}`;
  return text.slice(0, last.value.end) + add + text.slice(last.value.end);
}

/**
 * Set the value at `path` to `value` (creating missing objects on the way). Only the bytes that must change change.
 */
export function setPath(text, path, value, { eol = '\n' } = {}) {
  const root = parseSpans(text);
  let cur = root;
  for (let n = 0; n < path.length; n++) {
    if (cur.type !== 'object') throw new Error(`Cannot set ${path.join('.')}: ${path.slice(0, n).join('.') || 'root'} is not an object`);
    const member = cur.members.find((m) => m.key === path[n]);
    if (!member) {
      // insert the remaining path as one nested value
      let v = value;
      for (let k = path.length - 1; k > n; k--) v = { [path[k]]: v };
      return insertMember(text, cur, path[n], v, eol);
    }
    if (n === path.length - 1) {
      const node = member.value;
      const inline = node.type === 'array' || node.type === 'object' ? !isMultiline(text, node) : true;
      const unit = detectUnit(text, cur);
      const indent = indentOfLine(text, member.keyStart);
      return replaceNode(text, node, formatValue(value, { indent, unit, eol, inline }));
    }
    cur = member.value;
  }
  throw new Error('setPath needs a non-empty path');
}

/** Remove the member at `path`. */
export function removePath(text, path) {
  const root = parseSpans(text);
  const parent = getNode(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (!parent || parent.type !== 'object') throw new Error(`Cannot remove ${path.join('.')}`);
  const idx = parent.members.findIndex((m) => m.key === key);
  if (idx < 0) return text;
  const ms = parent.members;
  if (ms.length === 1) return replaceNode(text, parent, '{}');
  if (idx < ms.length - 1) return text.slice(0, ms[idx].keyStart) + text.slice(ms[idx + 1].keyStart);
  return text.slice(0, ms[idx - 1].value.end) + text.slice(ms[idx].value.end);
}

/** Parse, apply an edit function to the text and check the result parses. Returns the new text. */
export function checked(text, edit) {
  const out = edit(text);
  JSON.parse(out);
  return out;
}
