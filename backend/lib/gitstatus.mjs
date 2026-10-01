// A project's git state (read only: branch, sync with its upstream, uncommitted files, last commit) and, when the
// human turns it on for that project, its GitHub Actions runs and open pull requests. GitHub is read through the `gh`
// CLI when it is installed (its own sign-in, the app never sees a token), else the public REST API (GITHUB_TOKEN when
// set, for private repositories). Never runs a git command that writes.
import { spawnSync } from 'node:child_process';
import { redact } from './secrets.mjs';

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 8000, env: GIT_ENV });
  return r.status === 0 ? r.stdout : null;
}

/** owner/repo of a GitHub remote URL, or null. */
export function parseGithubUrl(url) {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Branch, upstream, ahead/behind and changed files from `git status --porcelain=v1 -b`. */
export function parseStatus(text) {
  const lines = String(text || '').split('\n').filter(Boolean);
  const head = lines[0]?.startsWith('## ') ? lines.shift().slice(3) : '';
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, changed: lines.length, untracked: lines.filter((l) => l.startsWith('??')).length, detached: false };
  if (/^No commits yet on /.test(head)) { out.branch = head.replace(/^No commits yet on /, ''); return out; }
  if (/^HEAD \(no branch\)/.test(head)) { out.detached = true; return out; }
  const m = /^([^.\s]+(?:\.[^.\s]+)*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
  if (m) {
    out.branch = m[1];
    out.upstream = m[2] || null;
    for (const part of (m[3] || '').split(',').map((s) => s.trim())) {
      const a = /^ahead (\d+)$/.exec(part); if (a) out.ahead = Number(a[1]);
      const b = /^behind (\d+)$/.exec(part); if (b) out.behind = Number(b[1]);
    }
  }
  return out;
}

export function repoState(root) {
  if (git(root, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return { isRepo: false };
  const st = parseStatus(git(root, ['status', '--porcelain=v1', '-b', '--untracked-files=normal']));
  const last = git(root, ['log', '-1', '--format=%h%x09%cI%x09%s']);
  const [hash, at, ...subject] = (last || '').trim().split('\t');
  const remotes = (git(root, ['remote', '-v']) || '').split('\n').map((l) => l.split(/\s+/)).filter((p) => p[0] && p[1]);
  const upstreamRemote = st.upstream?.split('/')[0];
  const pick = remotes.find((r) => r[0] === upstreamRemote && parseGithubUrl(r[1])) || remotes.find((r) => parseGithubUrl(r[1])) || remotes[0];
  const gh = pick ? parseGithubUrl(pick[1]) : null;
  return {
    isRepo: true,
    ...st,
    lastCommit: hash ? { hash, at, subject: redact(subject.join('\t')).slice(0, 200) } : null,
    remote: pick ? { name: pick[0], github: gh, url: gh ? `https://github.com/${gh.owner}/${gh.repo}` : null } : null,
  };
}

let ghChecked = null;
function ghInstalled() {
  if (ghChecked === null) ghChecked = spawnSync('gh', ['--version'], { windowsHide: true, timeout: 5000 }).status === 0;
  return ghChecked;
}

const RUN_FIELDS = (r) => ({
  name: redact(String(r.name || r.workflowName || '')).slice(0, 80),
  title: redact(String(r.display_title || r.displayTitle || '')).slice(0, 140),
  branch: r.head_branch || r.headBranch || null,
  status: r.status || null, // queued, in_progress, completed
  conclusion: r.conclusion || null, // success, failure, cancelled, skipped...
  event: r.event || null,
  at: r.created_at || r.createdAt || null,
  url: r.html_url || r.url || null,
});

/** GitHub Actions runs and open pull requests for owner/repo. */
export async function githubState({ owner, repo }, { fetchImpl = globalThis.fetch, token = '', useGh = true } = {}) {
  if (useGh && ghInstalled()) {
    const ghJson = (args) => {
      const r = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      if (r.status !== 0) throw new Error((r.stderr || 'gh failed').trim().split('\n')[0].slice(0, 200));
      return JSON.parse(r.stdout || '[]');
    };
    try {
      const runs = ghJson(['run', 'list', '--repo', `${owner}/${repo}`, '--limit', '6', '--json', 'name,displayTitle,headBranch,status,conclusion,event,createdAt,url,workflowName']);
      const prs = ghJson(['pr', 'list', '--repo', `${owner}/${repo}`, '--limit', '6', '--json', 'number,title,url,isDraft,author']);
      return { source: 'gh', runs: runs.map(RUN_FIELDS), prs: prs.map((p) => ({ number: p.number, title: redact(p.title).slice(0, 140), url: p.url, draft: p.isDraft })) };
    } catch (e) { return { source: 'gh', error: redact(e.message) }; }
  }
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'circle-studio', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const get = async (p) => {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}${p}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) throw Object.assign(new Error(token ? 'GitHub does not show this repository to your token.' : 'Not visible without signing in: a private repository needs the gh CLI (gh auth login) or GITHUB_TOKEN.'), { code: 'private' });
    if (res.status === 403 || res.status === 429) throw Object.assign(new Error('GitHub rate limit reached for now. Try again in a while, or install the gh CLI.'), { code: 'rate' });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    return res.json();
  };
  try {
    const [runs, prs] = await Promise.all([get('/actions/runs?per_page=6'), get('/pulls?state=open&per_page=6')]);
    return { source: 'api', runs: (runs.workflow_runs || []).map(RUN_FIELDS), prs: (prs || []).map((p) => ({ number: p.number, title: redact(p.title).slice(0, 140), url: p.html_url, draft: p.draft })) };
  } catch (e) { return { source: 'api', error: e.message, code: e.code || null }; }
}
