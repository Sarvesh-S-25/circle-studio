// Updates for Circle Studio itself (not for projects). A copy cloned with git can update: the check is read only
// (`git ls-remote`, once a day), and the update runs only when the human clicks it: `git pull --ff-only`, and only
// when nothing in the app's folder is changed or committed locally, so it can never merge or overwrite their work.
// A copy downloaded as a ZIP cannot update itself; the check says where to download the new one.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

/** Run git without a shell; never rejects. Async, so a slow network never holds the server up. */
function git(root, args, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout, env: ENV, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
    });
  });
}

/** The version in package.json. */
export function appVersion(appRoot) {
  try { return JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
}

/** What kind of copy this is and where its updates come from. */
export async function localState(appRoot) {
  if (!fs.existsSync(path.join(appRoot, '.git'))) return { mode: 'zip' };
  const head = await git(appRoot, ['rev-parse', 'HEAD']);
  if (!head.ok) return { mode: 'zip' };
  const upstream = await git(appRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const branch = (await git(appRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).out;
  const [remote, ...rest] = upstream.ok ? upstream.out.split('/') : [];
  const url = remote ? (await git(appRoot, ['remote', 'get-url', remote])).out : '';
  const dirty = (await git(appRoot, ['status', '--porcelain', '--untracked-files=no'])).out.split('\n').filter(Boolean);
  const ahead = upstream.ok ? Number((await git(appRoot, ['rev-list', '--count', '@{u}..HEAD'])).out) || 0 : 0;
  return { mode: 'git', head: head.out, branch, remote: remote || null, remoteBranch: rest.join('/') || null, url: url.replace(/\/\/[^/@]+@/, '//'), dirty: dirty.length, ahead };
}

/** Compare with the remote, read only. */
export async function checkUpdate(appRoot) {
  const at = new Date().toISOString();
  const local = await localState(appRoot);
  const version = appVersion(appRoot);
  if (local.mode === 'zip') return { at, version, mode: 'zip', available: null, canUpdate: false, reason: 'This copy was not cloned with git, so it cannot update itself. Download the newest copy and run "Install Circle Studio.cmd" again; your data folder carries over if you copy it across.' };
  if (!local.remote) return { at, version, ...local, available: null, canUpdate: false, reason: `The branch "${local.branch}" does not follow a remote branch, so there is nothing to compare with.` };
  const ls = await git(appRoot, ['ls-remote', local.remote, `refs/heads/${local.remoteBranch}`]);
  if (!ls.ok) return { at, version, ...local, available: null, canUpdate: false, reason: `Could not reach ${local.url || local.remote}: ${ls.err.split('\n')[0] || 'no answer'}.` };
  const remoteHead = ls.out.split(/\s+/)[0] || null;
  const available = Boolean(remoteHead && remoteHead !== local.head);
  const known = available && (await git(appRoot, ['cat-file', '-e', `${remoteHead}^{commit}`])).ok;
  const remoteIsOlder = known && (await git(appRoot, ['merge-base', '--is-ancestor', remoteHead, 'HEAD'])).ok;
  const reason = !available || remoteIsOlder ? null
    : local.dirty ? `${local.dirty} file${local.dirty === 1 ? ' is' : 's are'} changed in the app's folder. Commit or undo them first: the update never overwrites your changes.`
      : local.ahead ? 'This copy has commits that are not on the remote, so it cannot simply move forward. Update it with git yourself.'
        : null;
  return { at, version, ...local, remoteHead, available: available && !remoteIsOlder, canUpdate: available && !remoteIsOlder && !reason, reason };
}

/** Fast-forward to the remote. Returns { ok, from, to, message }. */
export async function applyUpdate(appRoot) {
  const c = await checkUpdate(appRoot);
  if (!c.available) return { ok: false, message: c.reason || 'Already up to date.' };
  if (!c.canUpdate) return { ok: false, message: c.reason };
  const pull = await git(appRoot, ['pull', '--ff-only', '--no-rebase', c.remote, c.remoteBranch], 120_000);
  if (!pull.ok) return { ok: false, message: `git could not move forward: ${(pull.err || pull.out).split('\n').slice(0, 3).join(' ')}` };
  const to = (await git(appRoot, ['rev-parse', 'HEAD'])).out;
  const log = (await git(appRoot, ['log', '--format=%s', `${c.head}..${to}`])).out.split('\n').filter(Boolean).slice(0, 20);
  return { ok: true, from: c.head, to, changes: log, version: appVersion(appRoot) };
}
