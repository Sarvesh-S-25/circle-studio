// Small SVG charts drawn with tokens only (fills come from classes in views.css). Each chart has a text
// equivalent (aria-label and a legend with the numbers), so colour is never the only signal.

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/**
 * A stacked bar: segments = [{ label, value, tone }]. Returns { svg, legend } (legend is a list with the numbers).
 * tone is one of a, b, c, ok, warn, danger, info, quiet.
 */
export function stackedBar(segments, { emptyLabel = 'Nothing yet' } = {}) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const root = svg('svg', { viewBox: '0 0 100 6', preserveAspectRatio: 'none', role: 'img', class: 'cs-chart__bar' });
  root.setAttribute('aria-label', total ? segments.filter((s) => s.value).map((s) => `${s.value} ${s.label}`).join(', ') : emptyLabel);
  root.append(svg('rect', { x: 0, y: 0, width: 100, height: 6, class: 'cs-chart__track' }));
  let x = 0;
  for (const s of segments) {
    if (!s.value) continue;
    const w = (s.value / total) * 100;
    root.append(svg('rect', { x, y: 0, width: Math.max(w - 0.6, 0.4), height: 6, class: `cs-chart__seg cs-chart__seg--${s.tone}` }));
    x += w;
  }
  const legend = document.createElement('ul');
  legend.className = 'cs-chart__legend';
  for (const s of segments) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `cs-chart__dot cs-chart__dot--${s.tone}`;
    dot.setAttribute('aria-hidden', 'true');
    li.append(dot, `${s.value} ${s.label}`);
    legend.append(li);
  }
  if (!total) legend.replaceChildren(Object.assign(document.createElement('li'), { textContent: emptyLabel }));
  return { svg: root, legend };
}

/** Vertical bars, one per item: items = [{ label, value }]. */
export function barSeries(items, { tone = 'a', unit = 'events' } = {}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const step = 10;
  const root = svg('svg', { viewBox: `0 0 ${items.length * step} 30`, preserveAspectRatio: 'none', role: 'img', class: 'cs-chart__bars' });
  const total = items.reduce((n, i) => n + i.value, 0);
  root.setAttribute('aria-label', `${total} ${unit} in the last ${items.length} days`);
  root.append(svg('line', { x1: 0, x2: items.length * step, y1: 29.5, y2: 29.5, class: 'cs-chart__axis' }));
  items.forEach((it, n) => {
    const h = it.value ? Math.max(2, (it.value / max) * 27) : 0.8;
    const bar = svg('rect', { x: n * step + 1.5, y: 29 - h, width: step - 3, height: h, class: `cs-chart__seg cs-chart__seg--${it.value ? tone : 'quiet'}` });
    const t = svg('title');
    t.textContent = `${it.label}: ${it.value} ${unit}`;
    bar.append(t);
    root.append(bar);
  });
  return root;
}
