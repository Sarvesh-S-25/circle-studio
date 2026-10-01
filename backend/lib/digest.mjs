// A short, factual map of a project folder for the workflow helper: what is in it, what it is built with, what it
// says about itself, and what the team already has. Read locally, redacted, kept under about 6 000 characters, so the
// helper can design for the real project instead of guessing.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { redact } from './secrets.mjs';
import { parseFrontMatter, fieldString } from './frontmatter.mjs';

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'coverage', 'target', 'bin', 'obj', '.idea', '.vscode', '.turbo', '.cache', 'vendor']);
const LANG = { '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.cs': 'C#', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift', '.c': 'C', '.cpp': 'C++', '.h': 'C/C++', '.css': 'CSS', '.scss': 'CSS', '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte', '.sql': 'SQL', '.sh': 'Shell', '.ps1': 'PowerShell', '.md': 'Markdown' };
const read = (p, n = 200_000) => { try { return fs.readFileSync(p, 'utf8').slice(0, n); } catch { return null; } };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);

function walk(root, limit = 4000) {
  const files = [];
  const top = new Map();
  const stack = [''];
  while (stack.length && files.length < limit) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP.has(e.name) || (e.name.startsWith('.') && !['.claude', '.github', '.gemini', '.agents'].includes(e.name))) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(r);
      else { files.push(r); const t = r.includes('/') ? `${r.split('/')[0]}/` : r; top.set(t, (top.get(t) || 0) + 1); }
    }
  }
  return { files, top };
}

export function projectDigest(root) {
  const { files, top } = walk(root);
  const langs = new Map();
  for (const f of files) { const l = LANG[path.extname(f).toLowerCase()]; if (l && l !== 'Markdown') langs.set(l, (langs.get(l) || 0) + 1); }
  const out = [];
  out.push(`Files: ${files.length}${files.length >= 4000 ? '+' : ''}. Languages: ${[...langs].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([l, n]) => `${l} ${n}`).join(', ') || 'none detected'}.`);
  out.push(`Top level: ${[...top].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([t, n]) => (t.endsWith('/') ? `${t} (${n})` : t)).join(', ')}.`);
  const pkg = (() => { try { return JSON.parse(read(path.join(root, 'package.json')) || 'null'); } catch { return null; } })();
  if (pkg) {
    const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
    out.push(`package.json: ${pkg.name || '(no name)'}; scripts: ${Object.keys(pkg.scripts || {}).slice(0, 12).join(', ') || 'none'}; dependencies (${deps.length}): ${deps.slice(0, 20).join(', ')}.`);
  }
  for (const [file, label] of [['pyproject.toml', 'pyproject.toml'], ['requirements.txt', 'requirements.txt'], ['go.mod', 'go.mod'], ['Cargo.toml', 'Cargo.toml'], ['docker-compose.yml', 'docker-compose'], ['Dockerfile', 'Dockerfile']]) {
    const t = read(path.join(root, file), 1500);
    if (t != null) out.push(`${label}: ${clip(t.replace(/\s+/g, ' '), 300)}`);
  }
  const readme = files.find((f) => /^readme(\.md|\.txt)?$/i.test(f));
  if (readme) out.push(`README (start): ${clip(redact(read(path.join(root, readme), 4000) || '').replace(/\s+/g, ' '), 1200)}`);
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const t = read(path.join(root, f), 60_000);
    if (t) out.push(`${f} sections: ${(t.match(/^#{1,3} .+$/gm) || []).slice(0, 20).map((x) => x.replace(/^#+ /, '')).join(' | ') || clip(t.replace(/\s+/g, ' '), 200)}`);
  }
  const docs = files.filter((f) => /^docs\/.+\.md$/i.test(f)).slice(0, 25);
  if (docs.length) out.push(`docs/: ${docs.map((d) => d.slice(5)).join(', ')}`);
  const tests = files.filter((f) => /(^|\/)(tests?|__tests__|spec)\//i.test(f) || /\.(test|spec)\.[a-z]+$/i.test(f)).length;
  out.push(`Tests: ${tests ? `${tests} test files` : 'none found'}. CI: ${files.some((f) => f.startsWith('.github/workflows/')) ? 'GitHub Actions' : 'none found'}.`);
  const agentDir = path.join(root, '.claude', 'agents');
  let agents = [];
  try { agents = fs.readdirSync(agentDir).filter((f) => f.endsWith('.md')); } catch { /* none */ }
  if (agents.length) {
    out.push(`Claude agents already here: ${agents.slice(0, 20).map((f) => { const fm = parseFrontMatter(read(path.join(agentDir, f), 20_000) || ''); const d = fm.ok ? fieldString(fm, 'description') || '' : ''; const m = fm.ok ? fieldString(fm, 'model') : null; return `${f.slice(0, -3)}${m ? ` (${m})` : ''}: ${clip(d, 90)}`; }).join('; ')}`);
  }
  let skills = [];
  try { skills = fs.readdirSync(path.join(root, '.claude', 'skills')); } catch { /* none */ }
  if (skills.length) out.push(`Skills already here: ${skills.slice(0, 20).join(', ')}.`);
  try { const m = JSON.parse(read(path.join(root, '.mcp.json')) || 'null'); if (m?.mcpServers) out.push(`MCP servers here: ${Object.keys(m.mcpServers).join(', ')}.`); } catch { /* none */ }
  const log = spawnSync('git', ['-C', root, 'log', '-5', '--format=%s'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (log.status === 0 && log.stdout.trim()) out.push(`Recent commits: ${log.stdout.trim().split('\n').map((s) => clip(s, 70)).join(' | ')}`);
  return redact(clip(out.join('\n'), 6000));
}
