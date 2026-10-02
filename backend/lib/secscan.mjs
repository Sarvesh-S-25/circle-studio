// A local security check of what the engines can reach: connectors (MCP servers), git and GitHub, and the project's
// own agent settings. Nothing leaves this PC; values are never returned. Each finding says what to do.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanSecrets } from './secrets.mjs';

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
const git = (root, args) => { const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 8000, env: GIT_ENV }); return r.status === 0 ? r.stdout : null; };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const TEMPLATE_FILE = /\.(example|sample|template|dist)$/i;
const SENSITIVE_FILE = /(^|\/)(\.env(\..+)?|id_rsa[^/]*|.*\.pem|.*\.key|.*\.p12|.*\.pfx|credentials(\.json)?|\.npmrc|\.pypirc|service-account.*\.json)$/i;

/** Findings about connectors. */
export function scanServers(servers) {
  const out = [];
  for (const s of servers) {
    const where = `${s.name} (${s.engine}, ${s.file})`;
    if (s.anthropicKey) out.push({ id: `anthropic:${s.id}`, severity: 'danger', title: `An Anthropic API key is written in the config of ${s.name}`, detail: `It is in ${s.file}. Revoke it in the Anthropic console and remove it from the file. Claude does not need it here: it runs through your own sign-in, and Circle Studio never stores an Anthropic key.`, where, server: s.id });
    else if (s.plainSecrets.length) out.push({ id: `plain:${s.id}`, severity: 'danger', title: `A key is written in plain text for ${s.name}`, detail: `${s.plainSecrets.join(', ')} in ${s.file}. Anyone or anything that reads that file (a backup, a sync folder, another tool) gets the key. Put it in the Key vault and refer to it as \${NAME} instead.`, where, server: s.id, fix: s.scope === 'project' && s.file === '.mcp.json' ? 'vault' : 'manual' });
    if (s.tokenInUrl) out.push({ id: `urltoken:${s.id}`, severity: 'danger', title: `A credential is inside the URL of ${s.name}`, detail: 'URLs end up in logs and history. Move it to a header that reads from the vault.', where, server: s.id });
    if (s.url && s.url.startsWith('http://') && !/\/\/(localhost|127\.)/.test(s.url)) out.push({ id: `http:${s.id}`, severity: 'warn', title: `${s.name} talks to a remote server without encryption`, detail: `${s.url} is http, not https: what the agent sends and gets back can be read on the way.`, where, server: s.id });
    if (s.transport === 'stdio' && /^(npx|bunx|pnpm dlx)$/i.test(s.command) && !/@\d+\.\d+/.test(s.argsText || '')) out.push({ id: `unpinned:${s.id}`, severity: 'warn', title: `${s.name} downloads the newest package every start`, detail: 'npx without a pinned version runs whatever was published last. Pin it (package@1.2.3) so a bad release cannot reach you silently.', where, server: s.id });
    if (s.transport === 'stdio' && /(^|\s)([A-Za-z]:\\?|~|\/)(\s|$)/.test(s.argsText || '')) out.push({ id: `broad:${s.id}`, severity: 'warn', title: `${s.name} gets a whole drive or home folder`, detail: 'Give a file-system server only the project folder it needs.', where, server: s.id });
    if (s.transport === 'stdio' && /\\(Downloads|Temp|AppData\\Local\\Temp)\\/i.test(s.command || '')) out.push({ id: `tempcmd:${s.id}`, severity: 'warn', title: `${s.name} runs a program from a temporary or downloads folder`, detail: 'Install it somewhere permanent and trusted.', where, server: s.id });
  }
  return out;
}

/** Findings about a project's git remotes, tracked secret files and agent settings. */
export function scanProject(root) {
  const out = [];
  const remotes = git(root, ['remote', '-v']);
  if (remotes != null) {
    for (const line of remotes.split('\n')) {
      const [name, url] = line.split(/\s+/);
      if (url && /^https?:\/\/[^/@\s]+:[^/@\s]+@/.test(url)) { out.push({ id: `remotecred:${name}`, severity: 'danger', title: `The git remote "${name}" has a password or token in its URL`, detail: 'It is stored in .git/config in plain text and shown by git remote -v. Remove it (git remote set-url with a clean URL) and let Git Credential Manager or gh keep the credential.' }); break; }
    }
    // a tracked .env.example holds no values; a tracked .npmrc or .env only matters when it really holds a credential
    const holdsSecret = (f) => {
      if (/\.(pem|key|p12|pfx)$|id_rsa/i.test(f)) return true;
      let text = '';
      try { text = fs.readFileSync(path.join(root, f), 'utf8').slice(0, 200_000); } catch { return false; }
      return scanSecrets(text).length > 0 || /(_authToken|_password|password\s*[=:]\s*\S{6,}|token\s*[=:]\s*\S{12,})/i.test(text);
    };
    const tracked = (git(root, ['ls-files']) || '').split('\n').filter((f) => SENSITIVE_FILE.test(f) && !TEMPLATE_FILE.test(f) && holdsSecret(f));
    if (tracked.length) out.push({ id: 'tracked-secrets', severity: 'danger', title: tracked.length === 1 ? 'A file with a secret in it is in git' : `${tracked.length} files with secrets in them are in git`, detail: `${tracked.slice(0, 5).join(', ')}. Once pushed, a key in git history is public to anyone with the repository. Rotate the key, remove the file from git (git rm --cached) and add it to .gitignore.` });
    const gi = (() => { try { return fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch { return ''; } })();
    if (fs.existsSync(path.join(root, '.env')) && !/^\s*\.env\b/m.test(gi)) out.push({ id: 'env-not-ignored', severity: 'warn', title: '.env is not in .gitignore', detail: 'One git add . and the keys in .env are committed. Add .env to .gitignore.' });
  }
  for (const f of ['.claude/settings.json', '.claude/settings.local.json']) {
    const s = readJson(path.join(root, ...f.split('/')));
    if (!s) continue;
    const allow = s.permissions?.allow || [];
    if (s.permissions?.defaultMode === 'bypassPermissions') out.push({ id: `bypass:${f}`, severity: 'danger', title: `${f} skips every permission question`, detail: 'Claude Code runs commands and edits without asking in this project (outside Circle Studio). Remove defaultMode: bypassPermissions unless the project lives in a throwaway sandbox.' });
    if (allow.some((r) => r === 'Bash' || r === 'Bash(*)' || r === 'Bash(*:*)')) out.push({ id: `allbash:${f}`, severity: 'warn', title: `${f} allows every shell command`, detail: 'Any command runs without asking when Claude Code is used here directly. Allow only the commands the project needs.' });
    const hooks = JSON.stringify(s.hooks || {});
    if (/curl |wget |Invoke-WebRequest|iwr |Invoke-RestMethod|irm /i.test(hooks)) out.push({ id: `nethook:${f}`, severity: 'warn', title: `A hook in ${f} sends or fetches over the network`, detail: 'Hooks run on every matching event without asking. Check that it cannot send your code or prompts anywhere you do not expect. (Circle Studio turns project hooks off for its own runs.)' });
    if (s.env?.ANTHROPIC_BASE_URL || s.apiKeyHelper) out.push({ id: `redirect:${f}`, severity: 'danger', title: `${f} can redirect Claude's sign-in`, detail: 'ANTHROPIC_BASE_URL or apiKeyHelper in a project file can send your credentials to another server. Circle Studio ignores project settings when it sees this, but Claude Code in a terminal does not.' });
  }
  return out;
}

/** What Circle Studio itself does with GitHub, said plainly (shown with the findings). */
export const GITHUB_PRACTICE = [
  'GitHub is only read (GET requests): skill imports and Find skills you start, and Actions and pull requests for a project you turn GitHub on for.',
  'A token is never stored or seen: signed in to GitHub (the gh CLI, in Windows\' credential store), requests go through gh itself; otherwise GITHUB_TOKEN is read from the environment for the length of a request, or GitHub is asked anonymously.',
  'Git is never written in your projects: the app runs only read-only git commands there (status, log, remote, ls-files).',
];
