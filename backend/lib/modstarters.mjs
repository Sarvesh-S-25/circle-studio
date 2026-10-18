// Ready-made mods Circle Studio ships (backend/seed/mods/<name>), and checking any mod with Claude Code's own tools.
//
// A starter is added to one project as a plugin folder at .claude/skills/<name>/, where Claude Code loads it by itself
// in that project only (as <name>@skills-dir). The write goes through ops.mjs (`mod-add`), so it is a diff you review.
// Checking runs `claude plugin validate <folder>` and, when the mod has *.test.ts files, `claude plugin test <folder>`,
// and says the result in plain words.
import fs from 'node:fs';
import path from 'node:path';
import { inspectPlugin } from './mods.mjs';

export const STARTERS_DIR = path.resolve(import.meta.dirname, '..', 'seed', 'mods');
export const STARTER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FILE = 256 * 1024;

/** Every file of a folder, as posix paths relative to it. Never the types folder Claude Code writes beside a mod. */
function walk(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (r !== '.claude-plugin/types' && e.name !== 'node_modules' && e.name !== '.git') out.push(...walk(root, r)); }
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

/** The starters: name, what it says it does, what it changes, whether it has tests. */
export function listStarters(dir = STARTERS_DIR) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && STARTER_RE.test(e.name)).map((e) => e.name); } catch { return []; }
  return names.map((name) => {
    const root = path.join(dir, name);
    const info = inspectPlugin(root);
    const files = walk(root);
    return { name, description: info.description, version: info.version, categories: info.categories, events: info.events, isMod: info.isMod, files: files.length, tests: files.filter((f) => /\.test\.tsx?$/.test(f)).length };
  });
}

/** The files of one starter, as text, ready to write under .claude/skills/<name>/. */
export function starterFiles(name, dir = STARTERS_DIR) {
  if (!STARTER_RE.test(String(name || ''))) return null;
  const root = path.join(dir, name);
  if (!fs.existsSync(path.join(root, '.claude-plugin', 'plugin.json'))) return null;
  return walk(root).map((rel) => {
    const buf = fs.readFileSync(path.join(root, rel));
    if (buf.length > MAX_FILE) throw new Error(`${rel} is too large for a starter mod.`);
    return { path: rel, text: buf.toString('utf8') };
  });
}

/** Has *.test.ts or *.test.tsx files (then `claude plugin test` has something to run). */
export function hasTests(root) {
  try { return walk(root).some((f) => /\.test\.tsx?$/.test(f)); } catch { return false; }
}

const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');

/**
 * What `claude plugin validate` said, in plain words: passed or not, the problems (lines under "Found N error"),
 * the warnings, and what the mod hooks.
 */
export function readValidate(out, code) {
  const text = strip(out);
  const lines = text.split(/\r?\n/);
  const problems = []; const warnings = []; let hooks = ''; let mode = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (/^✘ Found \d+ error/.test(l)) { mode = 'e'; continue; }
    if (/^⚠ Found \d+ warning/.test(l)) { mode = 'w'; continue; }
    if (/^Validating /.test(l) || /^✔|^✘ Validation/.test(l)) { mode = null; continue; }
    const m = /^❯\s+(.*)$/.exec(l);
    if (!m) continue;
    if (/ hooks: /.test(m[1]) && !hooks) hooks = m[1].replace(/^\S+ hooks: /, '');
    if (mode === 'e') problems.push(m[1]);
    else if (mode === 'w') warnings.push(m[1]);
  }
  const ok = /✔ Validation passed/.test(text) || (code === 0 && !problems.length);
  return { ok, problems: problems.slice(0, 20), warnings: warnings.slice(0, 20), hooks };
}

/** What `claude plugin test` said: how many passed and failed, and the names of the failing ones. */
export function readTests(out, code) {
  const text = strip(out);
  const pass = Number(/(\d+) pass\b/.exec(text)?.[1] || 0);
  const fail = Number(/(\d+) fail\b/.exec(text)?.[1] || 0);
  const failed = [...text.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => m[1]).slice(0, 20);
  return { ok: code === 0 && fail === 0 && pass > 0, pass, fail, failed };
}
