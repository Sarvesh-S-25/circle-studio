// The one exception to "Circle Studio never writes into .claude/hooks/": its own condense hook. Hooks run without
// asking, so the door is as narrow as it can be: two exact paths; the script only byte for byte as shipped with Circle
// Studio (backend/seed/hooks/circle-condense.mjs), the config only agent names and percentages. Nothing an agent or a
// model writes can pass.
import fs from 'node:fs';
import path from 'node:path';
import { forbidden } from './errors.mjs';

export const CONDENSE_SCRIPT = '.claude/hooks/circle-condense.mjs';
export const CONDENSE_CONFIG = '.claude/hooks/circle-condense.json';
const SEED = path.resolve(import.meta.dirname, '..', 'seed', 'hooks', 'circle-condense.mjs');
const AGENT_RE = /^(main|[a-z0-9]+(?:-[a-z0-9]+)*)$/;

export const isCondenseFile = (rel) => rel === CONDENSE_SCRIPT || rel === CONDENSE_CONFIG;

/** Throws forbidden unless `content` is exactly what Circle Studio writes at `rel`. */
export function checkCondenseWrite(rel, content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');
  if (rel === CONDENSE_SCRIPT) {
    if (text !== fs.readFileSync(SEED, 'utf8')) throw forbidden('The condense hook can only be the one that ships with Circle Studio.');
    return;
  }
  if (rel === CONDENSE_CONFIG) {
    let cfg;
    try { cfg = JSON.parse(text); } catch { throw forbidden('The condense settings must be valid JSON.'); }
    const keys = Object.keys(cfg || {});
    const agents = cfg?.agents;
    const ok = keys.every((k) => ['about', 'agents', 'minTokens'].includes(k))
      && (cfg.about === undefined || (typeof cfg.about === 'string' && cfg.about.length <= 300))
      && (cfg.minTokens === undefined || (Number.isInteger(cfg.minTokens) && cfg.minTokens >= 500 && cfg.minTokens <= 100_000))
      && agents && typeof agents === 'object' && !Array.isArray(agents)
      && Object.entries(agents).every(([id, v]) => AGENT_RE.test(id) && v && Object.keys(v).length === 1 && Number.isInteger(v.above) && v.above >= 30 && v.above <= 95);
    if (!ok) throw forbidden('The condense settings may only name agents and their percentages.');
  }
}
