#!/usr/bin/env node
/**
 * Circle Studio: WCAG contrast check for frontend/css/tokens.css.
 *
 * Parses the design tokens, resolves the light theme and the dark theme, prints the contrast
 * ratio of every foreground/background pair the interface relies on, and exits non-zero when a
 * required pair is below AA: 4.5:1 for text, 3:1 for large text and for UI components.
 *
 *   node scripts/check-contrast.mjs                 both themes, exit 1 on any failure
 *   node scripts/check-contrast.mjs --quiet         failures and the summary only
 *   node scripts/check-contrast.mjs --md            Markdown tables (both themes side by side)
 *   node scripts/check-contrast.mjs --json          machine-readable result
 *   node scripts/check-contrast.mjs --palette       the resolved colour tokens, both themes
 *   node scripts/check-contrast.mjs --file <path>   check another tokens file (the tests use this)
 *
 * Exit codes: 0 every required pair passes; 1 a required pair fails, the two dark blocks differ,
 * or a theme block is incomplete; 2 the file cannot be read or parsed.
 *
 * The dark theme is written twice in tokens.css (explicit data-theme="dark", and the system
 * preference), because CSS cannot share one block between a selector and a media query. This
 * script fails if the two copies drift apart.
 *
 * WCAG 2.x relative luminance and contrast ratio. Translucent colours are composited over the
 * layers they sit on and rounded to 8 bits, as a browser does. No dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.resolve(here, '../frontend/css/tokens.css');

/* ------------------------------------------------------------------ CLI */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const fileArgIdx = argv.indexOf('--file');
const FILE = fileArgIdx >= 0 ? path.resolve(argv[fileArgIdx + 1] ?? '') : DEFAULT_FILE;
const MODE = flag('--md') ? 'md' : flag('--json') ? 'json' : flag('--palette') ? 'palette' : 'table';
const QUIET = flag('--quiet');
const useColor = process.stdout.isTTY && !process.env.NO_COLOR && MODE === 'table';
const paint = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const red = (s) => paint('31;1', s);
const green = (s) => paint('32', s);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);

/* ---------------------------------------------------------- CSS parsing */

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** Minimal brace-aware CSS parser: returns a tree of { type:'rule', prelude, nodes } and { type:'decl', name, value }. */
function parseBlock(src, start) {
  const nodes = [];
  let buf = '';
  let paren = 0;
  let quote = null;
  const flushDecl = () => {
    const text = buf.trim();
    buf = '';
    if (!text) return;
    const i = text.indexOf(':');
    if (i < 0) return;
    nodes.push({ type: 'decl', name: text.slice(0, i).trim(), value: text.slice(i + 1).trim() });
  };
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      buf += ch;
      if (ch === '\\') buf += src[++i] ?? '';
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    if (paren === 0 && ch === '{') {
      const prelude = buf.trim();
      buf = '';
      const inner = parseBlock(src, i + 1);
      nodes.push({ type: 'rule', prelude, nodes: inner.nodes });
      i = inner.end;
      continue;
    }
    if (paren === 0 && ch === '}') { flushDecl(); return { nodes, end: i }; }
    if (paren === 0 && ch === ';') { flushDecl(); continue; }
    buf += ch;
  }
  flushDecl();
  return { nodes, end: i };
}

const norm = (s) => s.replace(/\s+/g, ' ').replace(/'/g, '"').replace(/\s*([:,()[\]=>])\s*/g, '$1').trim();
const declsOf = (rule) => Object.fromEntries(rule.nodes.filter((n) => n.type === 'decl').map((n) => [n.name, n.value.replace(/\s+/g, ' ')]));

/** Split the token file into the theme blocks the app relies on. */
function readThemes(text) {
  const tree = parseBlock(stripComments(text), 0).nodes;
  const blocks = { light: {}, lightExplicit: {}, darkExplicit: null, darkMedia: null };
  for (const node of tree) {
    if (node.type !== 'rule') continue;
    if (node.prelude.startsWith('@media')) {
      if (/prefers-color-scheme:\s*dark/.test(node.prelude)) {
        for (const inner of node.nodes) {
          if (inner.type === 'rule' && norm(inner.prelude) === norm(':root:not([data-theme="light"])')) {
            blocks.darkMedia = { ...(blocks.darkMedia ?? {}), ...declsOf(inner) };
          }
        }
      }
      continue;
    }
    for (const sel of node.prelude.split(',').map(norm)) {
      if (sel === ':root') Object.assign(blocks.light, declsOf(node));
      else if (sel === norm(':root[data-theme="light"]')) Object.assign(blocks.lightExplicit, declsOf(node));
      else if (sel === norm(':root[data-theme="dark"]')) blocks.darkExplicit = { ...(blocks.darkExplicit ?? {}), ...declsOf(node) };
    }
  }
  return blocks;
}

/* ------------------------------------------------------- var() resolving */

function resolveVars(value, vars, chain = []) {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const at = value.indexOf('var(', i);
    if (at < 0) { out += value.slice(i); break; }
    out += value.slice(i, at);
    let depth = 1;
    let j = at + 4;
    while (j < value.length && depth > 0) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')') depth--;
      j++;
    }
    const inner = value.slice(at + 4, j - 1);
    const comma = inner.indexOf(',');
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    if (chain.includes(name)) throw new Error(`circular var(${name})`);
    if (vars[name] !== undefined) out += resolveVars(vars[name], vars, [...chain, name]);
    else if (fallback !== null) out += resolveVars(fallback, vars, chain);
    else throw new Error(`undefined custom property ${name}`);
    i = j;
  }
  return out.trim();
}

/* ---------------------------------------------------------- colour maths */

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

const NAMED = { transparent: [0, 0, 0, 0], white: [255, 255, 255, 1], black: [0, 0, 0, 1] };

function numberOrPercent(token, scale) {
  const t = token.trim();
  return t.endsWith('%') ? (parseFloat(t) / 100) * scale : parseFloat(t);
}

function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function oklchToRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const [l, m, s] = [l_ ** 3, m_ ** 3, s_ ** 3];
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((v) => clamp(toSrgb(clamp(v, 0, 1)), 0, 1) * 255);
}

/** Parse a CSS colour into { r, g, b, a } (r,g,b 0..255, a 0..1). Throws on anything it cannot read. */
function parseColor(raw) {
  const s = raw.trim().toLowerCase();
  if (NAMED[s]) { const [r, g, b, a] = NAMED[s]; return { r, g, b, a }; }
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) throw new Error(`bad hex colour ${raw}`);
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = s.match(/^(rgba?|hsla?|oklch)\(([^)]*)\)$/);
  if (!m) throw new Error(`cannot read colour "${raw}"`);
  const parts = m[2].split(/[\s,/]+/).filter(Boolean);
  const alpha = parts.length > 3 ? clamp(numberOrPercent(parts[3], 1), 0, 1) : 1;
  if (m[1].startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map((p) => clamp(numberOrPercent(p, 255), 0, 255));
    return { r, g, b, a: alpha };
  }
  if (m[1].startsWith('hsl')) {
    const [r, g, b] = hslToRgb(parseFloat(parts[0]), numberOrPercent(parts[1], 1), numberOrPercent(parts[2], 1));
    return { r, g, b, a: alpha };
  }
  const [r, g, b] = oklchToRgb(numberOrPercent(parts[0], 1), parseFloat(parts[1]), parseFloat(parts[2]));
  return { r, g, b, a: alpha };
}

/** Composite fg over an opaque bg, rounding to 8 bits like the compositor. */
const over = (fg, bg) => ({
  r: Math.round(fg.a * fg.r + (1 - fg.a) * bg.r),
  g: Math.round(fg.a * fg.g + (1 - fg.a) * bg.g),
  b: Math.round(fg.a * fg.b + (1 - fg.a) * bg.b),
  a: 1,
});
const luminance = ({ r, g, b }) => 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hexOf = (c) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const floor2 = (x) => Math.floor(x * 100) / 100; // never round a near miss up to a pass

/* ----------------------------------------------------------- pair table */

const SURFACES = ['bg', 'surface', 'surface-raised', 'sunken', 'code-bg'];
const SOFTS = ['accent-soft', 'gate-soft', 'ok-soft', 'warn-soft', 'danger-soft', 'info-soft'];
const DIFF_BGS = ['diff-add-bg', 'diff-del-bg'];
const STATUS = ['gate', 'ok', 'warn', 'danger', 'info'];
const TEXT_SURFACES = ['bg', 'surface', 'surface-raised', 'sunken'];
const UI_SURFACES = ['bg', 'surface', 'surface-raised'];

/** One pair: fg token, a stack of background layers (bottom first), the minimum, the group. */
const P = (group, fg, bgLayers, min) => ({ group, fg, bg: Array.isArray(bgLayers) ? bgLayers : [bgLayers], min });

const GROUPS = {
  text: { title: 'Text, AA 4.5:1', min: 4.5, note: 'Body and interface text, links, status text, text on filled buttons.' },
  large: { title: 'Large text and disabled controls, 3:1', min: 3, note: 'text-faint only: 18px+ text, disabled controls and decoration. Never body text, never placeholders.' },
  ui: { title: 'UI components and graphics, 3:1', min: 3, note: 'Control borders, status dots and rings, the accent as a fill, and the focus ring against everything it can touch.' },
  info: { title: 'Decorative (not required)', min: 0, note: 'Hairlines carry no information; shown so the low ratio is a decision, not a surprise.' },
};

function buildPairs(has) {
  const pairs = [];
  for (const bg of [...TEXT_SURFACES, 'code-bg', ...SOFTS, ...DIFF_BGS]) pairs.push(P('text', 'text', bg, 4.5));
  for (const bg of [...TEXT_SURFACES, 'code-bg', ...SOFTS, ...DIFF_BGS]) pairs.push(P('text', 'text-soft', bg, 4.5));
  for (const bg of [...TEXT_SURFACES, 'accent-soft']) pairs.push(P('text', 'accent', bg, 4.5));
  for (const s of STATUS) {
    for (const bg of [`${s}-soft`, ...TEXT_SURFACES]) pairs.push(P('text', s, bg, 4.5));
  }
  for (const bg of ['accent', 'accent-hover', 'danger']) pairs.push(P('text', 'on-accent', bg, 4.5));
  pairs.push(P('text', 'diff-add-fg', 'diff-add-bg', 4.5), P('text', 'diff-del-fg', 'diff-del-bg', 4.5));
  if (has('c-hover') && has('c-press')) {
    for (const [base, over_] of [['surface', 'c-hover'], ['surface', 'c-press'], ['bg', 'c-hover'], ['bg', 'c-press'], ['surface-raised', 'c-hover'], ['surface-raised', 'c-press']]) {
      const layers = [base, over_.replace('c-', '')];
      pairs.push(P('text', 'text', layers, 4.5), P('text', 'text-soft', layers, 4.5));
    }
  }
  for (const bg of [...TEXT_SURFACES, 'code-bg']) pairs.push(P('large', 'text-faint', bg, 3));
  for (const bg of [...UI_SURFACES, 'sunken']) pairs.push(P('ui', 'accent', bg, 3));
  for (const bg of UI_SURFACES) pairs.push(P('ui', 'line-strong', bg, 3));
  for (const s of STATUS) for (const bg of ['bg', 'surface']) pairs.push(P('ui', s, bg, 3));
  for (const bg of [...TEXT_SURFACES, 'accent', 'accent-hover', 'accent-soft']) pairs.push(P('ui', 'focus', bg, 3));
  for (const fg of ['diff-add-fg', 'diff-del-fg']) pairs.push(P('ui', fg, 'code-bg', 3));
  for (const bg of UI_SURFACES) pairs.push(P('info', 'line', bg, 0));
  return pairs;
}

const layerLabel = (bg) => (bg.length === 1 ? bg[0] : bg.map((b) => b.replace(/^c-/, '')).join(' + '));
const pairLabel = (p) => `${p.fg} on ${layerLabel(p.bg)}`;

/* ------------------------------------------------------------- the run */

const REQUIRED_COLORS = [
  'c-bg', 'c-surface', 'c-surface-raised', 'c-sunken', 'c-line', 'c-line-strong', 'c-text', 'c-text-soft', 'c-text-faint',
  'c-accent', 'c-accent-hover', 'c-accent-soft', 'c-on-accent', 'c-gate', 'c-gate-soft', 'c-ok', 'c-ok-soft', 'c-warn', 'c-warn-soft',
  'c-danger', 'c-danger-soft', 'c-info', 'c-info-soft', 'c-focus', 'c-scrim', 'c-diff-add-bg', 'c-diff-add-fg', 'c-diff-del-bg',
  'c-diff-del-fg', 'c-code-bg',
];

function fail2(message) {
  console.error(`check-contrast: ${message}`);
  process.exit(2);
}

let text;
try {
  text = fs.readFileSync(FILE, 'utf8');
} catch (e) {
  fail2(`cannot read ${FILE}: ${e.message}`);
}

const blocks = readThemes(text);
const problems = []; // structural problems (exit 1)

if (!blocks.darkExplicit) problems.push('missing :root[data-theme="dark"] block');
if (!blocks.darkMedia) problems.push('missing @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ... } } block');

const lightVars = { ...blocks.light, ...blocks.lightExplicit };
const withLight = (dark) => ({ ...lightVars, ...(dark ?? {}) });
const themes = { light: lightVars, dark: withLight(blocks.darkExplicit) };

// Every colour token must be written in the light block and in BOTH dark blocks, so dark never silently inherits a light value.
for (const [label, block] of [['light (:root)', lightVars], ['dark ([data-theme="dark"])', blocks.darkExplicit], ['dark (prefers-color-scheme)', blocks.darkMedia]]) {
  if (!block) continue;
  const missing = REQUIRED_COLORS.filter((n) => block[`--${n}`] === undefined);
  if (missing.length) problems.push(`${label} block is missing: ${missing.map((n) => `--${n}`).join(', ')}`);
  if (!block['color-scheme']) problems.push(`${label} block has no color-scheme`);
}

// The two dark copies must be identical.
if (blocks.darkExplicit && blocks.darkMedia) {
  const names = new Set([...Object.keys(blocks.darkExplicit), ...Object.keys(blocks.darkMedia)]);
  for (const n of [...names].sort()) {
    if (blocks.darkExplicit[n] !== blocks.darkMedia[n]) {
      problems.push(`dark blocks differ at ${n}: explicit "${blocks.darkExplicit[n] ?? '(absent)'}" vs media "${blocks.darkMedia[n] ?? '(absent)'}"`);
    }
  }
}
if (REQUIRED_COLORS.some((n) => themes.light[`--${n}`] === undefined)) {
  // The pair table cannot be built without the colours; report and stop here.
  if (MODE === 'json') console.log(JSON.stringify({ ok: false, problems }, null, 2));
  else for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(problems.length ? 1 : 2);
}

const resolveColor = (theme, name) => {
  const value = resolveVars(themes[theme][`--${name.startsWith('c-') ? name : 'c-' + name}`] ?? '', themes[theme]);
  return parseColor(value);
};
const has = (name) => themes.light[`--${name}`] !== undefined && themes.dark[`--${name}`] !== undefined;

function evaluate(theme) {
  const rows = [];
  for (const p of buildPairs(has)) {
    let bg = resolveColor(theme, p.bg[0]);
    if (bg.a < 1) bg = over(bg, resolveColor(theme, 'bg')); // a translucent base sits on the page background
    for (const layer of p.bg.slice(1)) bg = over(resolveColor(theme, layer), bg);
    const fgRaw = resolveColor(theme, p.fg);
    const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
    const ratio = contrast(fg, bg);
    rows.push({ group: p.group, label: pairLabel(p), fg: hexOf(fg), bg: hexOf(bg), ratio, min: p.min, pass: ratio >= p.min });
  }
  return rows;
}

let results;
try {
  results = { light: evaluate('light'), dark: evaluate('dark') };
} catch (e) {
  fail2(`cannot resolve a token: ${e.message}`);
}

const failures = [];
for (const [theme, rows] of Object.entries(results)) for (const r of rows) if (!r.pass) failures.push({ theme, ...r });
const ok = failures.length === 0 && problems.length === 0;

/* --------------------------------------------------------------- output */

const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

if (MODE === 'json') {
  console.log(JSON.stringify({ ok, file: FILE, problems, failures, themes: results }, null, 2));
} else if (MODE === 'palette') {
  const names = Object.keys(themes.light).filter((n) => n.startsWith('--c-'));
  console.log(`${pad('token', 22)} ${pad('light', 30)} dark`);
  for (const n of names) console.log(`${pad(n, 22)} ${pad(themes.light[n], 30)} ${themes.dark[n] ?? ''}`);
} else if (MODE === 'md') {
  for (const [key, g] of Object.entries(GROUPS)) {
    console.log(`**${g.title}.** ${g.note}\n`);
    console.log('| Pair | Light | Dark | Needs |');
    console.log('|---|---:|---:|---:|');
    const light = results.light.filter((r) => r.group === key);
    const dark = results.dark.filter((r) => r.group === key);
    light.forEach((l, i) => {
      const d = dark[i];
      const cell = (r) => (r.pass ? floor2(r.ratio).toFixed(2) : `**${floor2(r.ratio).toFixed(2)} FAIL**`);
      console.log(`| ${l.label} | ${cell(l)} | ${cell(d)} | ${g.min ? g.min + ':1' : 'n/a'} |`);
    });
    console.log('');
  }
} else {
  console.log(bold(`Circle Studio contrast check`) + dim(`  ${path.relative(process.cwd(), FILE) || FILE}`));
  for (const [theme, rows] of Object.entries(results)) {
    console.log(`\n${bold(theme.toUpperCase() + ' theme')}`);
    for (const [key, g] of Object.entries(GROUPS)) {
      const list = rows.filter((r) => r.group === key);
      const shown = QUIET ? list.filter((r) => !r.pass) : list;
      console.log(`  ${g.title}` + dim(`  ${g.note}`));
      for (const r of shown) {
        const status = r.min === 0 ? dim('n/a ') : r.pass ? green('pass') : red('FAIL');
        console.log(`    ${pad(r.label, 34)} ${pad(r.fg, 8)} ${pad(r.bg, 8)} ${rpad(floor2(r.ratio).toFixed(2), 6)}  ${status}`);
      }
      if (QUIET && !shown.length) console.log(dim('    all pass'));
    }
  }
  console.log('');
  for (const p of problems) console.log(red(`FAIL  ${p}`));
  const per = results.light.filter((r) => r.min > 0).length;
  if (ok) console.log(green(`OK: ${per} required pairs per theme pass AA in light and dark; the two dark blocks match.`));
  else console.log(red(`FAILED: ${failures.length} pair(s) below the minimum${problems.length ? `, ${problems.length} structural problem(s)` : ''}.`));
}

process.exit(ok ? 0 : 1);
