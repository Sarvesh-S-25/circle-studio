/**
 * Circle Studio icons.
 *
 * Every glyph is drawn on a 20 x 20 grid, stroke-width 1.5, round caps and joins, currentColor,
 * with a 2 unit margin (the live area is 2..18). A few glyphs carry a filled part (a bead, a
 * pin, a stop square); those parts set fill="currentColor" themselves.
 *
 * The ring family is the identity: `mark` and `spinner` are an open ring with a bead in its gap,
 * `gate` is the ring with the gap empty (a human decision waits here), `gate-done` is the gap
 * filled (the human has been through), `agent` is one bead on a ring, `team` is three, and the
 * three `tier-*` gauges are empty, half and full circles for haiku, sonnet and opus. A project's
 * sigil (sigilSvg) is a closed ring with the bead on it at one of twelve hours, like a dial.
 *
 * Usage:   iconSvg('plus')            20 px icon, decorative (aria-hidden)
 *          iconSvg('warning', 's')    16 px
 *          iconSvg('check', 'm', { title: 'Passed' })   informative: role="img" plus a <title>
 * Sizes are token sizes, never pixels: 's' = --icon-s, 'm' = --icon-m, 'l' = --icon-l. A number is
 * snapped to the nearest token (<= 18 is s, <= 24 is m, larger is l), so no raw size can leak in.
 * The svg carries class "cs-icon cs-icon--{s|m|l}"; base.css sizes it with the token, and the
 * width/height attributes here are only the fallback when that stylesheet has not loaded.
 *
 * Styling hooks (base.css): .cs-mark__bead { fill: var(--c-gate) } paints the brand bead brass;
 * .cs-icon--spinner turns with --dur-spin (still under reduced motion); .cs-sigil__bead { fill: var(--c-accent) }.
 */

export const icons = {
  /* ---- navigation and objects ------------------------------------------------------------ */
  home: `<path d="M3 9.5 10 3.5l7 6"/><path d="M5 8.4V16h3.6v-4.4h2.8V16H15V8.4"/>`,
  library: `<rect x="2.6" y="4" width="3" height="12.5" rx="0.8"/><rect x="7.5" y="4" width="3" height="12.5" rx="0.8"/><rect x="12.4" y="4" width="3" height="12.5" rx="0.8" transform="rotate(12 12.4 16.5)"/>`,
  project: `<path d="M10 2.8 16.5 6.4v7.2L10 17.2 3.5 13.6V6.4L10 2.8Z"/><path d="M3.8 6.6 10 10l6.2-3.4M10 10v7"/>`,
  plan: `<circle cx="4.5" cy="4.5" r="1.6" fill="currentColor" stroke="none"/><circle cx="4.5" cy="10" r="1.6"/><circle cx="4.5" cy="15.5" r="1.6" fill="currentColor" stroke="none"/><path d="M4.5 6.1v2.3M4.5 11.6v2.3M8.5 4.5h9M8.5 10h9M8.5 15.5h5.5"/>`,
  team: `<circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="3.5" r="2" fill="currentColor" stroke="none"/><circle cx="15.63" cy="13.25" r="2" fill="currentColor" stroke="none"/><circle cx="4.37" cy="13.25" r="2" fill="currentColor" stroke="none"/>`,
  skill: `<path d="M11.2 2.5 4.5 10.8h4.6l-.8 6.7 7.2-8.8h-4.7l.4-6.2Z"/>`,
  agent: `<circle cx="10" cy="10" r="6.5"/><circle cx="14.6" cy="5.4" r="2.1" fill="currentColor" stroke="none"/>`,
  health: `<path d="M2.5 10.2h3.6l2-5.7 3.6 11 2.2-5.3h3.6"/>`,
  chat: `<path d="M4.5 4h11A1.5 1.5 0 0 1 17 5.5V12a1.5 1.5 0 0 1-1.5 1.5H11L7.5 16.5v-3h-3A1.5 1.5 0 0 1 3 12V5.5A1.5 1.5 0 0 1 4.5 4Z"/>`,
  advisor: `<path d="M10 2.6a5.2 5.2 0 0 0-3 9.5c.5.45.8 1 .8 1.7v.2h4.4v-.2c0-.7.3-1.25.8-1.7A5.2 5.2 0 0 0 10 2.6Z"/><path d="M8.3 16h3.4M9 17.9h2"/>`,
  settings: `<path d="M3 6h7M14.5 6H17M3 14h2.4M9.6 14H17"/><circle cx="12.25" cy="6" r="2.25"/><circle cx="7.5" cy="14" r="2.25"/>`,
  board: `<rect x="3" y="3.5" width="3.6" height="13" rx="1"/><rect x="8.2" y="3.5" width="3.6" height="8" rx="1"/><rect x="13.4" y="3.5" width="3.6" height="10.5" rx="1"/>`,
  cost: `<ellipse cx="8.5" cy="5.5" rx="5" ry="2.2"/><path d="M3.5 5.5v4c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2v-4M3.5 9.5v4c0 1.2 2.2 2.2 5 2.2 1 0 1.9-.1 2.7-.4"/><circle cx="14.6" cy="13.6" r="3"/><path d="M14.6 12.4v2.4"/>`,
  folder: `<path d="M2.5 5.7A1.7 1.7 0 0 1 4.2 4h3.4l2 2H15.8a1.7 1.7 0 0 1 1.7 1.7v6.6a1.7 1.7 0 0 1-1.7 1.7H4.2a1.7 1.7 0 0 1-1.7-1.7V5.7Z"/>`,
  file: `<path d="M5.5 2.8h5.9l4.1 4.1V16a1.2 1.2 0 0 1-1.2 1.2H5.5A1.2 1.2 0 0 1 4.3 16V4A1.2 1.2 0 0 1 5.5 2.8Z"/><path d="M11.2 2.9v4.2h4.2"/>`,
  git: `<circle cx="5.5" cy="4.5" r="1.8"/><circle cx="5.5" cy="15.5" r="1.8"/><circle cx="14.5" cy="7" r="1.8"/><path d="M5.5 6.3v7.4"/><path d="M14.5 8.8a6.7 6.7 0 0 1-7.2 6.7"/>`,
  /* The GitHub mark: Octicons "mark-github-16" (MIT, see the notice at the end of this file). */
  github: `<path transform="translate(2 2)" fill="currentColor" stroke="none" d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656"/>`,
  shield: `<path d="M10 2.6 16.4 5v5c0 3.9-2.7 6.3-6.4 7.4C6.3 16.3 3.6 13.9 3.6 10V5L10 2.6Z"/>`,
  key: `<circle cx="6.6" cy="13.4" r="3.1"/><path d="m8.9 11.1 7.6-7.6M13.7 6.3l2.3 2.3M11.3 8.7l1.8 1.8"/>`,
  clock: `<circle cx="10" cy="10" r="7.4"/><path d="M10 5.6V10l3 1.9"/>`,
  globe: `<circle cx="10" cy="10" r="7.4"/><path d="M2.6 10h14.8"/><path d="M10 2.6c2 2.1 3 4.6 3 7.4s-1 5.3-3 7.4c-2-2.1-3-4.6-3-7.4s1-5.3 3-7.4Z"/>`,
  terminal: `<rect x="2.5" y="3.5" width="15" height="13" rx="1.7"/><path d="m6 8 2.6 2L6 12M10.6 12.4H14"/>`,
  keyboard: `<rect x="2.5" y="5" width="15" height="10" rx="1.8"/><path d="M5.6 8h.01M8.5 8h.01M11.5 8h.01M14.4 8h.01M5.6 10.7h.01M8.5 10.7h.01M11.5 10.7h.01M14.4 10.7h.01M7 12.9h6"/>`,

  /* ---- the ring family ------------------------------------------------------------------- */
  mark: `<path d="M16.67 7.89A7 7 0 1 1 12.11 3.33"/><circle class="cs-mark__bead" cx="14.95" cy="5.05" r="1.7" fill="currentColor" stroke="none"/>`,
  spinner: `<path d="M16.67 7.89A7 7 0 1 1 12.11 3.33"/><circle cx="14.95" cy="5.05" r="1.7" fill="currentColor" stroke="none"/>`,
  gate: `<path d="M16.67 7.89A7 7 0 1 1 12.11 3.33"/>`,
  'gate-done': `<path d="M16.67 7.89A7 7 0 1 1 12.11 3.33"/><circle cx="14.95" cy="5.05" r="1.7" fill="currentColor" stroke="none"/>`,
  phase: `<path d="M2.5 10h4.3M13.2 10h4.3"/><circle cx="10" cy="10" r="3" fill="currentColor" stroke="none"/>`,
  'tier-haiku': `<circle cx="10" cy="10" r="6"/>`,
  'tier-sonnet': `<circle cx="10" cy="10" r="6"/><path d="M10 4a6 6 0 0 0 0 12Z" fill="currentColor" stroke="none"/>`,
  'tier-opus': `<circle cx="10" cy="10" r="6" fill="currentColor"/>`,

  /* ---- actions --------------------------------------------------------------------------- */
  search: `<circle cx="8.8" cy="8.8" r="5.3"/><path d="m12.8 12.8 4.2 4.2"/>`,
  plus: `<path d="M10 4v12M4 10h12"/>`,
  minus: `<path d="M4.5 10h11"/>`,
  close: `<path d="m5 5 10 10M15 5 5 15"/>`,
  check: `<path d="m4.5 10.5 3.6 3.6 7.4-8"/>`,
  edit: `<path d="M12.6 4.4 15.6 7.4"/><path d="M3.6 16.4l.8-3.6L13.3 3.9a1.5 1.5 0 0 1 2.1 0l.7.7a1.5 1.5 0 0 1 0 2.1L7.2 15.6l-3.6.8Z"/>`,
  trash: `<path d="M4 5.6h12M8 5.6V4.2a.9.9 0 0 1 .9-.9h2.2a.9.9 0 0 1 .9.9v1.4"/><path d="m5.5 5.6.7 9.9a1.5 1.5 0 0 0 1.5 1.4h4.6a1.5 1.5 0 0 0 1.5-1.4l.7-9.9M8.5 9v4.7M11.5 9v4.7"/>`,
  copy: `<rect x="7.2" y="7.2" width="9.3" height="9.3" rx="1.5"/><path d="M13 7.2V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v6.5A1.5 1.5 0 0 0 5 13h2.2"/>`,
  undo: `<path d="M4.5 8.5h7.2a4 4 0 0 1 0 8H8"/><path d="M7.6 5.2 4.3 8.5l3.3 3.3"/>`,
  refresh: `<path d="M3.6 8.87A6.5 6.5 0 0 1 16.11 7.78"/><path d="M16.4 4.3v3.5h-3.5"/><path d="M16.4 11.13A6.5 6.5 0 0 1 3.89 12.22"/><path d="M3.6 15.7v-3.5h3.5"/>`,
  external: `<path d="M8.5 4.5H5.2a1.7 1.7 0 0 0-1.7 1.7v8.6a1.7 1.7 0 0 0 1.7 1.7h8.6a1.7 1.7 0 0 0 1.7-1.7v-3.3"/><path d="M11.5 3.5h5v5M16.5 3.5l-7 7"/>`,
  link: `<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.8.8"/><path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.8-.8"/>`,
  download: `<path d="M10 3v9.5M6.2 8.8l3.8 3.8 3.8-3.8M3.5 14.5v1A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5v-1"/>`,
  upload: `<path d="M10 12.5V3M6.2 6.8 10 3l3.8 3.8M3.5 14.5v1A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5v-1"/>`,
  drag: `<g fill="currentColor" stroke="none"><circle cx="7.5" cy="5" r="1.15"/><circle cx="12.5" cy="5" r="1.15"/><circle cx="7.5" cy="10" r="1.15"/><circle cx="12.5" cy="10" r="1.15"/><circle cx="7.5" cy="15" r="1.15"/><circle cx="12.5" cy="15" r="1.15"/></g>`,
  more: `<g fill="currentColor" stroke="none"><circle cx="4.5" cy="10" r="1.3"/><circle cx="10" cy="10" r="1.3"/><circle cx="15.5" cy="10" r="1.3"/></g>`,
  menu: `<path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13"/>`,
  'chevron-right': `<path d="m7.5 4.5 5.5 5.5-5.5 5.5"/>`,
  'chevron-left': `<path d="m12.5 4.5-5.5 5.5 5.5 5.5"/>`,
  'chevron-down': `<path d="m4.5 7.5 5.5 5.5 5.5-5.5"/>`,
  'chevron-up': `<path d="m4.5 12.5 5.5-5.5 5.5 5.5"/>`,
  'arrow-up': `<path d="M10 16.5V4M5 9l5-5 5 5"/>`,
  'arrow-down': `<path d="M10 3.5V16M5 11l5 5 5-5"/>`,
  pin: `<path d="M6.8 3.2h6.4M8 3.2v4.6l-2.4 3.4h8.8L12 7.8V3.2M10 11.2v5.6"/>`,
  'pin-filled': `<path d="M8 3.2h4v4.6l2.4 3.4H5.6L8 7.8Z" fill="currentColor"/><path d="M6.8 3.2h6.4M10 11.2v5.6"/>`,
  send: `<path d="M17.2 2.8 8.6 11.4"/><path d="M17.2 2.8 12 17.2l-3.4-5.8-5.8-3.4 14.4-5.2Z"/>`,
  stop: `<rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor"/>`,
  play: `<path d="M6.5 4.4v11.2l9-5.6-9-5.6Z"/>`,
  diff: `<rect x="3.5" y="3.5" width="13" height="13" rx="1.6"/><path d="M10 6.4v3.6M8.2 8.2h3.6M8.2 13h3.6"/>`,
  sparkle: `<path d="M10 2.5c.5 3.8 1.7 6.5 7.5 7.5-5.8 1-7 3.7-7.5 7.5-.5-3.8-1.7-6.5-7.5-7.5 5.8-1 7-3.7 7.5-7.5Z"/>`,
  snowflake: `<path d="M10 17.6V2.4M16.58 13.8 3.42 6.2M16.58 6.2 3.42 13.8"/><path d="M8.3 15.6 10 17l1.7-1.4M4.3 11.33l-.36 2.17L6 14.27M6 5.73l-2.06.77.36 2.17M11.7 4.4 10 3 8.3 4.4M15.7 8.67l.36-2.17L14 5.73M14 14.27l2.06-.77-.36-2.17"/>`,
  lock: `<rect x="4.5" y="9" width="11" height="8" rx="1.6"/><path d="M7 9V6.6a3 3 0 0 1 6 0V9M10 12.4V14"/>`,
  unlock: `<rect x="4.5" y="9" width="11" height="8" rx="1.6"/><path d="M7 9V6.6a3 3 0 0 1 5.6-1.5M10 12.4V14"/>`,

  /* ---- status ---------------------------------------------------------------------------- */
  warning: `<path d="M10 3.2 17.6 16.4H2.4L10 3.2Z"/><path d="M10 8.4v3.6M10 14.3h.01"/>`,
  danger: `<path d="M7 2.8h6L17.2 7v6L13 17.2H7L2.8 13V7L7 2.8Z"/><path d="M10 6.6v4.6M10 13.8h.01"/>`,
  info: `<circle cx="10" cy="10" r="7.4"/><path d="M10 9.2v4.6M10 6.3h.01"/>`,
  sun: `<circle cx="10" cy="10" r="3.2"/><path d="M15.6 10h2M13.96 13.96l1.41 1.41M10 15.6v2M6.04 13.96l-1.41 1.41M4.4 10h-2M6.04 6.04 4.63 4.63M10 4.4v-2M13.96 6.04l1.41-1.41"/>`,
  moon: `<path d="M16.4 11.6A6.6 6.6 0 0 1 8.4 3.6a6.6 6.6 0 1 0 8 8Z"/>`,
  contrast: `<circle cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 0 1 0 14Z" fill="currentColor"/>`,
};

export const iconNames = Object.keys(icons);

/* ------------------------------------------------------------------------------------------- */

const FALLBACK_PX = { s: 16, m: 20, l: 32 }; // mirrors --icon-s/-m/-l; CSS overrides these
const SVG_ATTRS = 'viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
const warned = new Set();

function sizeKey(size) {
  if (size === 's' || size === 'm' || size === 'l') return size;
  const n = Number(size);
  if (!Number.isFinite(n)) return 'm';
  return n <= 18 ? 's' : n <= 24 ? 'm' : 'l';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function wrap(body, size, { title, className } = {}) {
  const k = sizeKey(size);
  const px = FALLBACK_PX[k];
  const cls = `cs-icon cs-icon--${k}${className ? ` ${esc(className)}` : ''}`;
  const a11y = title ? `role="img" aria-label="${esc(title)}"` : 'aria-hidden="true" focusable="false"';
  return `<svg class="${cls}" ${SVG_ATTRS} width="${px}" height="${px}" ${a11y}>${title ? `<title>${esc(title)}</title>` : ''}${body}</svg>`;
}

/** An icon as an SVG string. Unknown names render a dashed square (and warn once) rather than nothing. */
export function iconSvg(name, size = 'm', opts = {}) {
  const body = icons[name];
  if (body === undefined) {
    if (!warned.has(name)) {
      warned.add(name);
      if (typeof console !== 'undefined') console.warn(`iconSvg: unknown icon "${name}"`);
    }
    return wrap('<rect x="3.5" y="3.5" width="13" height="13" rx="2" stroke-dasharray="2 2.5"/>', size, { ...opts, className: `cs-icon--missing${opts.className ? ` ${opts.className}` : ''}` });
  }
  const extra = name === 'spinner' ? 'cs-icon--spinner' : '';
  return wrap(body, size, { ...opts, className: [extra, opts.className].filter(Boolean).join(' ') });
}

/* A project sigil: a closed ring with the bead sitting on it at one of twelve hours, like the
   indicator on a dial. The seed (a project id) picks the hour. Every project gets a quiet,
   recognisable shape without colour, letters or stock avatars, and a closed ring can never be
   mistaken for the loader (which is an open ring). Same seed, same sigil. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function sigilSvg(seed, size = 'm', opts = {}) {
  const R = 6.5;
  const hour = fnv1a(String(seed)) % 12;
  const deg = -90 + 30 * hour;
  const n = (v) => Number(v.toFixed(2));
  const bx = n(10 + R * Math.cos((deg * Math.PI) / 180));
  const by = n(10 + R * Math.sin((deg * Math.PI) / 180));
  const body = `<circle cx="10" cy="10" r="${R}"/><circle class="cs-sigil__bead" cx="${bx}" cy="${by}" r="2.1" fill="currentColor" stroke="none"/>`;
  return wrap(body, size, { ...opts, className: `cs-sigil${opts.className ? ` ${opts.className}` : ''}` });
}

/*
 * Notice for the "github" glyph above.
 * Octicons "mark-github-16", https://github.com/primer/octicons, fetched from
 * https://raw.githubusercontent.com/primer/octicons/main/icons/mark-github-16.svg on 2026-09-29.
 *
 * MIT License
 *
 * Copyright (c) 2026 GitHub Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
