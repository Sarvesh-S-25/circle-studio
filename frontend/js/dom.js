// Tiny DOM helpers. Text always goes in as text nodes (never innerHTML), so nothing typed or
// received can become markup. Icons are the one exception: they come from icons.js, not from data.
import { iconSvg, sigilSvg } from './icons.js';

// Native append()/replaceChildren() turn null into the text "null". Conditional children (cond ? node : null)
// are used everywhere, so make both skip null, undefined and false.
for (const name of ['append', 'prepend', 'replaceChildren']) {
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    const native = proto[name];
    proto[name] = function (...kids) { return native.apply(this, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
  }
}

/**
 * h('button', { class: 'cs-btn', onclick: fn, 'aria-label': 'x', dataset: { a: 1 }, style: { '--x': 2 } }, 'Text', child)
 * Style values may only set custom properties (docs/design-rules.md rule 3).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') {
      for (const [k, v] of Object.entries(value)) {
        if (!k.startsWith('--')) throw new Error(`Inline style may only set custom properties, got "${k}"`);
        el.style.setProperty(k, String(v));
      }
    } else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'text') el.textContent = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

const tpl = document.createElement('template');
export function icon(name, size = 'm', opts) {
  tpl.innerHTML = iconSvg(name, size, opts);
  return tpl.content.firstElementChild.cloneNode(true);
}
export function sigil(seed, size = 'm') {
  tpl.innerHTML = sigilSvg(seed, size);
  return tpl.content.firstElementChild.cloneNode(true);
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return plural(Math.floor(s / 60), 'minute') + ' ago';
  if (s < 86400) return plural(Math.floor(s / 3600), 'hour') + ' ago';
  if (s < 86400 * 30) return plural(Math.floor(s / 86400), 'day') + ' ago';
  return new Date(iso).toLocaleDateString();
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const SEVERITY_ICON = { ok: 'check', info: 'info', warn: 'warning', danger: 'danger' };
export const SEVERITY_WORD = { ok: 'OK', info: 'Note', warn: 'Attention', danger: 'Blocked' };

/** A status pill: icon plus a word, so colour is never the only signal. */
export function statusPill(severity, label) {
  return h('span', { class: `cs-pill cs-pill--${severity}` }, icon(SEVERITY_ICON[severity] || 'info', 's'), label ?? SEVERITY_WORD[severity]);
}

export function tierChip(tier) {
  const t = ['haiku', 'sonnet', 'opus'].includes(tier) ? tier : null;
  return h('span', { class: 'cs-tier' }, icon(t ? `tier-${t}` : 'minus', 's'), t || tier || 'inherit');
}

export function chainView(engine) {
  if (!engine) return h('span', { class: 'cs-chain' }, '-');
  const parts = [engine.engine, ...engine.failover];
  const out = h('span', { class: 'cs-chain', title: engine.source === 'default' ? 'Default order (no entry for this role)' : 'Order set for this role' });
  parts.forEach((p, i) => {
    if (i) out.append(h('span', { class: 'cs-chain__sep', 'aria-hidden': 'true' }, '>'));
    out.append(p);
  });
  if (engine.web) out.append(h('span', { class: 'cs-chain__web', title: 'Web search on' }, icon('globe', 's')));
  return out;
}
