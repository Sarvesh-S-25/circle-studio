// GitHub through the GitHub CLI (gh): it keeps its own sign-in (in Windows' credential store) and Circle Studio never
// sees a token. Signed in, GitHub requests go through `gh api` (private repositories, and far more requests an hour
// than the anonymous limit); not signed in, they go to GitHub anonymously as before. Only api.github.com is ever asked
// this way, only with GET, and the answer comes back as a normal Response.
import { resolveCli } from './engines/proc.mjs';
import { runCommand } from './run.mjs';

const API = 'https://api.github.com/';
let cache = { at: 0, value: null };

/** { installed, signedIn, account }: from `gh auth status` (its output is never passed on: only the account name). */
export async function ghStatus({ force = false, run, find = resolveCli } = {}) {
  // tests never ask the real gh (they pass `run` to pretend)
  if (!run && process.env.NODE_TEST_CONTEXT) return { installed: false, signedIn: false, account: null };
  const real = !run;
  run ||= runCommand;
  if (real && !force && cache.value && Date.now() - cache.at < 60_000) return cache.value;
  const cli = find('gh');
  let value;
  if (!cli) value = { installed: false, signedIn: false, account: null };
  else {
    const r = await run(cli.bin, [...cli.prefix, 'auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    const account = /account ([A-Za-z0-9-]{1,39})/.exec(text)?.[1] || /as ([A-Za-z0-9-]{1,39})/.exec(text)?.[1] || null;
    value = r.error ? { installed: false, signedIn: false, account: null } : { installed: true, signedIn: r.code === 0, account: r.code === 0 ? account : null };
  }
  if (real) cache = { at: Date.now(), value };
  return value;
}

/** Parse `gh api -i` output: "HTTP/2.0 200 OK", headers, a blank line, the body. */
export function parseGhInclude(text) {
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/.exec(text);
  if (!m) return null;
  const headers = new Headers();
  for (const line of m[2].split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) { try { headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch { /* an odd header */ } } }
  return { status: Number(m[1]), headers, body: m[3] };
}

/**
 * A fetch for the GitHub client: api.github.com GETs go through `gh api` when gh is signed in; everything else (and
 * everything when it is not) goes to `base`. The token stays inside gh.
 */
export function ghAwareFetch(base, { run, find = resolveCli } = {}) {
  return async (url, opts = {}) => {
    const u = String(url);
    if (!u.startsWith(API) || (opts.method && opts.method !== 'GET')) return base(url, opts);
    const st = await ghStatus({ run, find });
    if (!st.signedIn) return base(url, opts);
    const cli = find('gh');
    if (!cli) return base(url, opts);
    const r = await (run || runCommand)(cli.bin, [...cli.prefix, 'api', '-i', '--method', 'GET', u.slice(API.length)], { timeoutMs: 20_000, maxBytes: 16 * 1024 * 1024 });
    const parsed = parseGhInclude(r.stdout || '');
    if (!parsed) return base(url, opts); // gh could not answer: try without it
    return new Response(parsed.status === 204 || parsed.status === 304 ? null : parsed.body, { status: parsed.status, headers: parsed.headers });
  };
}
