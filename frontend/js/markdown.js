// A small, safe Markdown renderer for chat answers and skill previews. It builds DOM nodes, never
// HTML strings, and only lets http(s) links through.
import { h } from './dom.js';

function inline(text) {
  const out = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(h('code', {}, m[1].slice(1, -1)));
    else if (m[2]) out.push(h('strong', {}, m[2].slice(2, -2)));
    else if (m[3]) out.push(h('em', {}, m[3].slice(1, -1)));
    else if (m[4]) out.push(h('a', { href: m[5], target: '_blank', rel: 'noopener noreferrer' }, m[4].slice(1, m[4].indexOf(']'))));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function renderMarkdown(src) {
  const root = h('div', { class: 'cs-prose' });
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      root.append(h('pre', {}, h('code', {}, code.join('\n'))));
      continue;
    }
    const head = /^(#{1,3})\s+(.*)$/.exec(line);
    if (head) { root.append(h(`h${head[1].length + 1}`, {}, inline(head[2]))); i++; continue; }
    if (/^\s*([-*])\s+/.test(line)) {
      const ul = h('ul');
      while (i < lines.length && /^\s*([-*])\s+/.test(lines[i])) ul.append(h('li', {}, inline(lines[i++].replace(/^\s*[-*]\s+/, ''))));
      root.append(ul);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const ol = h('ol');
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) ol.append(h('li', {}, inline(lines[i++].replace(/^\s*\d+[.)]\s+/, ''))));
      root.append(ol);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      root.append(h('blockquote', {}, inline(q.join(' '))));
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { root.append(h('hr', { class: 'cs-sep' })); i++; continue; }
    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(```|#{1,3}\s|\s*[-*]\s+|\s*\d+[.)]\s+|>\s?)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]); // a line that looked like a block start but was not: keep it as text
    const p = h('p');
    para.forEach((l, n) => { if (n) p.append(h('br')); p.append(...inline(l)); });
    root.append(p);
  }
  return root;
}
