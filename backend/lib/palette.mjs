// The colours of frontend/css/tokens.css for things that are not a web page (the native desktop widgets), so they keep
// the one source of design values. Light = the :root block, dark = the :root[data-theme="dark"] block.
import fs from 'node:fs';
import path from 'node:path';

function block(css, selector) {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return '';
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(at, i);
  }
  return '';
}

/** { bg, surface, raised, sunken, line, lineStrong, text, soft, accent, onAccent, gate, ok, warn, info, danger } as #rrggbb. */
export function readPalette(appRoot, theme = 'dark') {
  const css = fs.readFileSync(path.join(appRoot, 'frontend', 'css', 'tokens.css'), 'utf8');
  const light = block(css, ':root');
  const chosen = theme === 'dark' ? block(css, ':root[data-theme="dark"]') : light;
  const get = (name) => (new RegExp(`--c-${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(chosen) || new RegExp(`--c-${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(light))?.[1] || null;
  return {
    bg: get('bg'), surface: get('surface'), raised: get('surface-raised'), sunken: get('sunken'), line: get('line'), lineStrong: get('line-strong'),
    text: get('text'), soft: get('text-soft'), accent: get('accent'), onAccent: get('on-accent'), gate: get('gate'),
    ok: get('ok'), warn: get('warn'), info: get('info'), danger: get('danger'),
  };
}
