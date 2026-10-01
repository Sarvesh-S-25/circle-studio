// Reads a shell command the way the approval policy needs to: split it into commands (bash, cmd and PowerShell
// share more punctuation than they differ in), find the paths it touches, and name what it would do that must
// never run unasked. Anything this file cannot read is reported as dangerous: the policy is deny-by-default.
import { classifyPath, sensitiveReason, globNamesSecret, isGuardPath, isGitDir } from './policy-paths.mjs';

const MAX_COMMAND = 8000;
const MAX_DEPTH = 4;

/* ---- scanning: text -> commands ------------------------------------------------------------------- */

/** Index of the `)` that closes a group whose `(` came just before `from`, skipping quoted text. -1 when there is none. */
function closeParen(text, from) {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "'") { i = text.indexOf("'", i + 1); if (i < 0) return -1; }
    else if (c === '"') { i = closeDouble(text, i); if (i < 0) return -1; }
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

function closeDouble(text, from) {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/**
 * Split a command into simple commands. Returns { segments, subs, error }.
 * segments: [{ words:[{text}], redirects:[{op,target}], pipedIn }]; subs: text inside `$( )`, backticks and `<( )`.
 * Superset on purpose: a character that is punctuation in one shell and plain in another is treated as punctuation.
 */
export function scanCommand(text) {
  const segments = [];
  const subs = [];
  let words = [];
  let redirects = [];
  let cur = null;
  let pending = null;
  let sepBefore = ';';
  let error = null;
  const fail = (m) => { error ||= m; };
  const word = () => (cur ||= { text: '' });
  const endWord = () => {
    if (!cur) return;
    if (!pending) words.push(cur);
    else if (pending !== '<<<') redirects.push({ op: pending, target: cur });
    pending = null;
    cur = null;
  };
  const endSegment = (sep) => {
    endWord();
    if (pending) fail('a redirection without a target');
    if (words.length || redirects.length) segments.push({ words, redirects, pipedIn: sepBefore === '|' });
    words = [];
    redirects = [];
    sepBefore = sep;
  };
  const sub = (inner) => { subs.push(inner); word().text += '$()'; };

  // A backtick pair is command substitution in bash and an escape in PowerShell: read the inside as a command
  // (the safe reading for both), and leave a $() marker in the word like $( ) does.
  const n = text.length;
  for (let i = 0; i < n && !error; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '\n') endSegment(';');
    else if (c === '\r') continue;
    else if (c === ' ' || c === '\t') endWord();
    else if (c === "'") {
      const j = text.indexOf("'", i + 1);
      if (j < 0) fail('a quote is never closed');
      else { word().text += text.slice(i + 1, j); i = j; }
    } else if (c === '"') {
      i = doubleQuoted(text, i, word(), subs, fail);
    } else if (c === '\\') {
      if (next === '\n') i++;
      else if (next === '\r' && text[i + 2] === '\n') i += 2;
      else if (next === '"' || next === "'") { word().text += next; i++; } else word().text += c;
    } else if (c === '^') {
      if (next === undefined) continue;
      if ('&|;<>()'.includes(next)) continue;
      word().text += next;
      i++;
    } else if (c === '`') {
      const j = text.indexOf('`', i + 1);
      if (j < 0) fail('a backtick is never closed');
      else { sub(text.slice(i + 1, j)); i = j; }
    } else if (c === '$') {
      if (next === '(') {
        const j = closeParen(text, i + 2);
        if (j < 0) fail('a $( ) is never closed');
        else { sub(text.slice(i + 2, j)); i = j; }
      } else if (next === "'" || next === '"') fail('shell escapes it cannot decode ($\'...\')');
      else word().text += c;
    } else if (c === '(') {
      if (!cur && !words.length && !redirects.length) endSegment(';');
      else {
        const j = closeParen(text, i + 1);
        if (j < 0) fail('a ( ) is never closed');
        else { sub(text.slice(i + 1, j)); i = j; }
      }
    } else if (c === ')') endSegment(';');
    else if (c === ';') { if (cur?.text === '\\') cur = null; endSegment(';'); }
    else if (c === '|') {
      if (next === '|') { endSegment('||'); i++; } else endSegment('|');
    } else if (c === '&') {
      if (next === '&') { endSegment('&&'); i++; }
      else if (next === '>') { i++; endWord(); pending = '>'; if (text[i + 1] === '>') i++; }
      else if (!cur && !words.length && !redirects.length) word().text = '&';
      else endSegment('&');
    } else if (c === '<' || c === '>') {
      if (next === '(') {
        const j = closeParen(text, i + 2);
        if (j < 0) fail('a <( ) is never closed');
        else { sub(text.slice(i + 2, j)); i = j; }
        continue;
      }
      if (c === '<' && next === '<' && text[i + 2] !== '<') { fail('a here-document'); continue; }
      if (cur && /^\d+$/.test(cur.text)) cur = null;
      else endWord();
      let end = i;
      let op = c;
      if (c === '>' && next === '>') { end = i + 1; op = '>>'; }
      else if (c === '<' && next === '<') { end = i + 2; op = '<<<'; }
      else if (c === '>' && next === '|') end = i + 1;
      i = end;
      if (text[end + 1] === '&' && /[\d-]/.test(text[end + 2] ?? '')) i = end + 2;
      else pending = op;
    } else word().text += c;
  }
  if (!error) endSegment(';');
  return { segments, subs, error };
}

/** A double-quoted run. Substitutions still run inside it. Returns the index of the closing quote. */
function doubleQuoted(text, start, w, subs, fail) {
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return i;
    if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) { w.text += c === '\\' && text[i + 1] === '"' ? '"' : '\\'; i++; }
    else if (c === '$' && text[i + 1] === '(') {
      const j = closeParen(text, i + 2);
      if (j < 0) { fail('a $( ) is never closed'); return text.length; }
      subs.push(text.slice(i + 2, j));
      w.text += '$()';
      i = j;
    } else if (c === '`') {
      const j = text.indexOf('`', i + 1);
      if (j < 0) { fail('a backtick is never closed'); return text.length; }
      subs.push(text.slice(i + 1, j));
      w.text += '$()';
      i = j;
    } else w.text += c;
  }
  fail('a quote is never closed');
  return text.length;
}

/* ---- rules ------------------------------------------------------------------------------------------ */

const set = (s) => new Set(s.split(/\s+/).filter(Boolean));
const RESERVED = set('if then else elif fi do done while until for in case esac { } ! function');
const WRAPPERS = set('command builtin exec nohup time nice ionice stdbuf env timeout call start xargs busybox');
const PRIVILEGE = set('sudo su doas runas gsudo pkexec');
const AGENT_CLIS = set('claude codex copilot agy gemini antigravity aider opencode');
const NETWORK_TOOLS = set('nc ncat netcat socat telnet scp sftp ftp tftp ssh rsync plink pscp');
const FETCH_TOOLS = set('curl wget iwr irm invoke-webrequest invoke-restmethod');
const DISK_TOOLS = set('format diskpart bcdedit vssadmin fdisk wipefs shred clear-disk format-volume remove-partition initialize-disk wbadmin diskshadow mountvol');
const SYSTEM_TOOLS = set('regedit regini regsvr32 rundll32 mshta wscript cscript msiexec installutil regasm regsvcs odbcconf netsh setx wmic icacls takeown cacls shutdown logoff restart-computer stop-computer set-executionpolicy set-mppreference add-mppreference new-service enable-psremoting register-scheduledtask register-scheduledjob new-scheduledtask new-localuser add-localgroupmember set-netfirewallprofile new-netfirewallrule disable-netfirewallrule tsshutdn wsl');
const REMOVERS = set('rm rmdir del erase rd remove-item ri rimraf unlink');
const DOS_COMMANDS = set('dir del erase rd rmdir copy xcopy robocopy move ren rename type find findstr attrib cmd tasklist taskkill sc schtasks net echo cd chdir pushd start where more sort');
const CD = set('cd chdir pushd set-location sl');
const PRINTERS = set('echo printf write-output write-host write');
const LISTERS = set('ls dir gci get-childitem tree stat where which');
const READERS = set('cat type get-content gc more less head tail grep rg findstr select-string sls ls dir gci get-childitem tree stat file wc echo printf write-output write-host');
const SHELLS = set('sh bash zsh dash ksh fish ash');
const POWERSHELLS = set('powershell pwsh');
const INTERPRETERS = set('sh bash zsh dash ksh fish ash powershell pwsh cmd python python3 py pypy node nodejs bun deno perl ruby php lua');
const INLINE = {
  node: /^-[a-z]*[ep]$|^--(eval|print)$/, nodejs: /^-[a-z]*[ep]$|^--(eval|print)$/, bun: /^-[a-z]*[ep]$|^--(eval|print)$/, deno: /^eval$/,
  python: /^-[A-Za-z]*c$/, python3: /^-[A-Za-z]*c$/, py: /^-[A-Za-z]*c$/, pypy: /^-[A-Za-z]*c$/,
  perl: /^-[A-Za-z]*e$/i, ruby: /^-[A-Za-z]*e$/, lua: /^-e$/, php: /^-r$/,
};
const AWKS = set('awk gawk mawk nawk');
const PS_QUIET = set('-noprofile -nop -nologo -nol -noninteractive -noni -sta -mta -noexit -nonewwindow');
const PS_VALUED = set('-executionpolicy -ep -windowstyle -w -inputformat -outputformat -configurationname -version -psconsolefile');

const nameCandidates = (t) => {
  const ext = (s) => s.replace(/\.(exe|com|cmd|bat|ps1)$/i, '');
  const base = ext(t.split(/[\\/]/).pop().toLowerCase());
  const all = ext(t.replace(/[\\^`]/g, '').toLowerCase());
  return base === all ? [base] : [base, all];
};
const isOneOf = (names, s) => names.some((n) => s.has(n));

/** The command a segment runs, after the words that only wrap it (env, timeout, xargs, ...). */
function commandOf(words) {
  const wrappers = [];
  let fromStdin = false;
  let i = 0;
  for (; i < words.length; i++) {
    const t = words[i].text;
    if (RESERVED.has(t) || t === '&' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue;
    const names = nameCandidates(t);
    const wrapper = names.find((n) => WRAPPERS.has(n));
    if (!wrapper) break;
    wrappers.push(...names);
    if (wrapper === 'xargs') fromStdin = true;
    while (i + 1 < words.length && /^(-|\/[A-Za-z]$|\d+[smhd]?$|""$)/.test(words[i + 1].text)) i++;
  }
  const head = words[i];
  return { head, names: head ? nameCandidates(head.text) : [], args: words.slice(i + 1), wrappers, fromStdin };
}

const flatten = (s) => s.toLowerCase().replace(/["'^`]/g, '').replace(/\\/g, '/').replace(/\s+/g, ' ');

const ENV_SECRET = '[a-z0-9_]*(apikey|api_key|_key|key_|token|secret|passw|credential|_auth|auth_)[a-z0-9_]*';
const FETCH_WORDS = /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer|bitsadmin)\b|downloadstring|downloadfile|net\.webclient|urlopen|urllib|requests\.(get|post)|\bfetch\(/;
const RUN_WORDS = /\b(iex|invoke-expression)\b|\| ?(sh|bash|zsh|dash|ksh|fish|powershell|pwsh|cmd|python[0-9.]*|node|perl|ruby|php)( |$)|\b(sh|bash|zsh|dash) -c\b|(^| )(source|eval) |<\(/;
const PS_ENCODED = /(^| )-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)( |$)/;
const REGISTRY_HIVE = '(hklm|hkcu|hkcr|hku|hkey_[a-z_]+|registry::)';

/** Rules that read the whole command as text, so no trick with quotes, escapes or word boundaries hides them. */
const TEXT_RULES = [
  [(f) => /\b(iex|invoke-expression)\b/.test(f), 'It runs text as code (Invoke-Expression), which the app cannot inspect.'],
  [(f) => /frombase64string|\bbase64 +(-d|--decode)\b/.test(f), 'It decodes hidden code or data.'],
  [(f) => /(powershell|pwsh)/.test(f) && PS_ENCODED.test(f), 'It runs an encoded PowerShell command.'],
  [(f) => /certutil.*-(urlcache|decode|decodehex|verifyctl)/.test(f), 'It uses certutil to download or decode files.'],
  [(f) => /add-type +-(typedefinition|memberdefinition)|-comobject|new-object +-com|\[(system\.)?diagnostics\.process\]/.test(f), 'It compiles or starts code the app cannot inspect.'],
  [(f) => /(^| )reg(\.exe)? +(add|delete|import|load|unload|restore|save|copy|flags)\b/.test(f) || new RegExp(`(set|new|remove|clear|rename|copy|move)-item(property)?.*${REGISTRY_HIVE}|${REGISTRY_HIVE}.*(set|new|remove|clear|rename|copy|move)-item`).test(f), 'It edits the Windows registry.'],
  [(f) => /(^| )cipher +\/w|\bof=(\/dev\/|\/\/\.\/|\/\/\?\/)/.test(f), 'It overwrites a disk.'],
  [(f) => FETCH_WORDS.test(f) && RUN_WORDS.test(f), 'It downloads something and runs it.'],
  [(f) => /disableallhooks|dangerously-(skip|bypass)|bypasspermissions|danger-full-access|--yolo\b|--allow-all(-tools|-paths)?\b|permission-prompt-tool|--permission-mode|approval[-_]?policy|sandbox[-_]mode|apikeyhelper|circle_(data|port|claude_bin|template)/.test(f), 'It would switch off a guard of Circle Studio or of the agent.'],
  [(f) => /npm-loader\.js|@anthropic-ai\/claude|@openai\/codex|@github\/copilot/.test(f), 'It would start another agent, which would skip your approvals.'],
  [(f) => new RegExp(`\\bprintenv\\b|process\\.env\\b|os\\.environ|\\bgetenv\\b|getenvironmentvariable|\\benv\\[|/proc/self/environ|\\$env:${ENV_SECRET}|\\$\\{?${ENV_SECRET}\\}?|%${ENV_SECRET}%`).test(f), 'It reads secrets from the environment.'],
];

/* ---- checks on one path-shaped word -------------------------------------------------------------------- */

const VAR_START = /^(\$|%[^%\s]+%|~)/;
const PATHLIKE = /^[\\/]|^[A-Za-z]:|[\\/]|(^|[\\/])\.\.?([\\/]|$)|^\./;

function pathCandidates(text, dos) {
  if (text === '') return [];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return /^file:\/\//i.test(text) ? [text.replace(/^file:\/\/\/?/i, '')] : [];
  if (text.startsWith('-')) {
    const v = /^-{1,2}[A-Za-z][\w-]*[:=](.+)$/.exec(text) || /^-[A-Za-z](.*[\\/].*)$/.exec(text);
    return v ? pathCandidates(v[1], dos) : [];
  }
  if (/^\/[A-Za-z?]$/.test(text) || (dos && /^\/[A-Za-z?]+(:.*)?$/.test(text))) return [];
  return VAR_START.test(text) || PATHLIKE.test(text) || /^\.[^.]/.test(text) ? [text] : [];
}

function checkWord(text, env, { dos, writer, listing, printing }) {
  const { ctx, state, f } = env;
  const bare = text.replace(/^-{1,2}[A-Za-z][\w-]*[:=]/, '');
  if (!printing) {
    const why = sensitiveReason(bare) || (!listing && globNamesSecret(bare) ? 'a file that may hold secrets' : null);
    if (why) f.danger.push(`It touches ${why}: ${text}.`);
  }
  if (printing) return;
  for (const p of pathCandidates(text, dos)) {
    const c = classifyPath(p, { root: ctx.root, cwd: state.cwd, protect: ctx.protect });
    if (c.device) continue;
    if (c.protectedDir) f.danger.push(`It touches Circle Studio's own data folder: ${p}.`);
    if (c.status !== 'inside') f.outside.push(`It reaches ${c.why}: ${p}.`);
    else if (writer) {
      if (isGuardPath(p)) f.danger.push(`It changes a file that guards the agent (${p}).`);
      else if (isGitDir(p)) f.danger.push(`It changes the git folder (${p}). Git is yours to run.`);
    }
  }
}

/* ---- one command ---------------------------------------------------------------------------------------- */

function isRecursive(t) {
  if (/^\/s$/i.test(t) || /^--recursive$/i.test(t)) return true;
  if (/^-[a-z]*r[a-z]*$/i.test(t)) return true;
  return /^-[a-z]+$/i.test(t) && 'recurse'.startsWith(t.slice(1).toLowerCase());
}

const isFlag = (t, dos) => /^-/.test(t) || (dos && /^\/[A-Za-z?](:.*)?$/.test(t));

function checkRemoval(names, args, cmd, env) {
  const { ctx, state, f } = env;
  const dos = isOneOf(names, DOS_COMMANDS);
  if (!args.some((a) => isRecursive(a.text)) && !isOneOf(names, set('rimraf'))) return;
  const targets = args.filter((a) => !isFlag(a.text, dos));
  if (!targets.length) {
    if (cmd.fromStdin || cmd.pipedIn) f.danger.push('It deletes recursively and the targets come from another command.');
    return;
  }
  for (const t of targets) {
    if (t.text === '{}') { f.danger.push('It deletes recursively and the targets come from another command.'); continue; }
    const c = classifyPath(t.text.replace(/[\\/]*$/, '') || t.text, { root: ctx.root, cwd: state.cwd, protect: ctx.protect });
    const base = t.text.split(/[\\/]/).pop();
    const wide = ['*', '.*', '*.*', '**'].includes(base);
    const parent = wide ? classifyPath(t.text.slice(0, t.text.length - base.length) || '.', { root: ctx.root, cwd: state.cwd, protect: ctx.protect }) : null;
    const isRoot = (x) => x.status === 'inside' && x.real && x.real.toLowerCase() === classifyPath('.', { root: ctx.root, cwd: ctx.root, protect: [] }).real.toLowerCase();
    if (c.status !== 'inside') f.danger.push(`It deletes recursively outside the project or from a place the app cannot resolve: ${t.text}.`);
    else if (isRoot(c) || (parent && isRoot(parent))) f.danger.push(`It deletes the whole project folder: ${t.text}.`);
  }
}

function checkFetch(names, args, f) {
  const lower = args.map((a) => a.text.toLowerCase());
  const isCurl = names.includes('curl');
  const wget = names.includes('wget');
  const psAbbrev = (t, full, min = 2) => /^-[a-z]+$/.test(t) && t.length > min - 1 && full.startsWith(t.slice(1));
  const uploads = args.some((a, i) => {
    const t = a.text;
    if (isCurl && (/^-(d|F|T)/.test(t) || /^--(data|form|upload-file|json|post)/i.test(t))) return true;
    if (isCurl && /^-X$/.test(t) && /^(post|put|patch|delete)$/i.test(args[i + 1]?.text || '')) return true;
    if (wget && /^--(post-data|post-file|body-data|body-file|method)/i.test(t)) return true;
    const l = lower[i];
    if (psAbbrev(l, 'body') || psAbbrev(l, 'infile') || psAbbrev(l, 'form')) return true;
    return psAbbrev(l, 'method') && /^(post|put|patch|delete)$/i.test(args[i + 1]?.text || '');
  });
  if (uploads) f.danger.push('It sends data to the network.');
}

function subcommand(args) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text;
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree') { i++; continue; }
    if (!t.startsWith('-')) return { name: t.toLowerCase(), rest: args.slice(i + 1).map((a) => a.text) };
  }
  return { name: '', rest: [] };
}

function checkGit(args, f) {
  const { name, rest } = subcommand(args);
  if (name === 'push' && rest.some((t) => /^(--force(-with-lease.*)?|--mirror|--delete|-[a-z]*[fd][a-z]*)$/i.test(t) || /^[+:]/.test(t))) f.danger.push('It force-pushes or deletes on a remote (git push).');
}

const CODE_RULES = [
  [/child_process|(^|[^.\w])(execSync|execFileSync|spawnSync)\s*\(|os\.(system|popen)|subprocess|\bpopen\b|(^|[^.\w])(eval|exec|system)\s*\(|new Function|\bFunction\s*\(|Deno\.(run|Command)|Bun\.(spawn|\$)|shell_exec|passthru|proc_open|Kernel\.system|IO\.popen|Open3|__import__|\bimport\s*\(|require\s*\(\s*[^'"\s]|process\.(binding|mainModule)/i, 'The code starts other programs or builds code at run time.'],
  [/require\s*\(\s*['"](node:)?(https?|net|dgram|tls|http2|dns)['"]|from\s+['"](node:)?(https?|net|dgram|tls|http2|dns)['"]|\bfetch\s*\(|XMLHttpRequest|WebSocket|urllib|urlopen|\brequests\.|http\.client|\bhttplib|import\s+socket|\bsocket\.|Net::HTTP|open-uri|curl_init|file_get_contents\s*\(\s*['"]https?/i, 'The code talks to the network.'],
  [/atob\s*\(|b64decode|base64|frombase64|fromCharCode|(\\x[0-9a-f]{2}){2,}/i, 'The code hides what it does with encoding.'],
  [/(^|[^\w])\.env(?!\.(example|sample|template|dist))(\.[\w.-]+)?\b|\.ssh\b|id_(rsa|ed25519|dsa|ecdsa)|\.pem\b|\.pfx\b|\.p12\b|\.npmrc|\.netrc|\.aws\b|\.gnupg|\.git-credentials|credentials\.json/i, 'The code names a file that may hold secrets.'],
];
const DELETE_API = /rmSync|rmdirSync|\brm\s*\(|unlink|rmtree|remove_tree|rimraf|shutil|os\.remove|os\.rmdir|Remove-Item|Deno\.remove|FileUtils\.rm|File\.delete/i;
const ROOTISH = /['"](\.{1,2}|[\\/]|[A-Za-z]:[\\/]?|~[\\/]?|\*)['"]|process\.cwd\(\)|__dirname|os\.getcwd|Path\.cwd|Deno\.cwd|homedir|tmpdir/i;
const OUTSIDE_TEXT = /[A-Za-z]:[\\/]|\\\\|(^|[^.\w])\.\.[\\/]|(^|[^\w])~[\\/]|%[A-Za-z_]+%|\$env:|homedir|userprofile|appdata|expanduser|Path\.home|\/(etc|usr|bin|home|Users|tmp|var|root|opt|mnt|proc|dev|c|d)\b/i;

/** Inline code (`node -e`, `python -c`): opaque, so only rules on its text apply. */
function checkCode(code, f) {
  for (const [re, why] of CODE_RULES) if (re.test(code)) f.danger.push(why);
  if (DELETE_API.test(code) && (ROOTISH.test(code) || OUTSIDE_TEXT.test(code))) f.danger.push('The code deletes files at the project root or outside it.');
  else if (OUTSIDE_TEXT.test(code)) f.outside.push('The code names a path outside the project or in your home folder.');
}

function inlineCode(names, args) {
  const name = names.find((n) => INLINE[n]);
  if (!name) return null;
  const i = args.findIndex((a) => INLINE[name].test(a.text));
  return i < 0 ? null : args.slice(i + 1).map((a) => a.text).join(' ');
}

function shellInner(names, args) {
  if (isOneOf(names, SHELLS)) {
    const i = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a.text));
    return i < 0 ? null : (args[i + 1]?.text ?? '');
  }
  if (names.includes('cmd')) {
    const i = args.findIndex((a) => /^\/[ckr]$/i.test(a.text));
    return i < 0 ? null : args.slice(i + 1).map((a) => a.text).join(' ');
  }
  if (isOneOf(names, POWERSHELLS)) return powershellInner(args);
  return null;
}

function powershellInner(args) {
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text.toLowerCase();
    if (PS_QUIET.has(t)) continue;
    if (PS_VALUED.has(t)) { i++; continue; }
    if (/^-f(i(l(e)?)?)?$/.test(t)) return null;
    if (/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/.test(t) || t === '-commandwithargs' || t === '-cwa') return args.slice(i + 1).map((a) => a.text).join(' ');
    if (t.startsWith('-')) continue;
    rest.push(args[i].text);
  }
  return rest.length ? rest.join(' ') : null;
}

function checkSpecial(names, args, cmd, env) {
  const { f } = env;
  const dosArgs = args.map((a) => a.text.toLowerCase());
  const sub = (dosArgs.find((t) => !t.startsWith('-') && !t.startsWith('/')) || '');
  if (isOneOf(names, PRIVILEGE)) f.danger.push('It asks for administrator rights.');
  if (isOneOf(names, AGENT_CLIS)) f.danger.push('It would start another agent, which would skip your approvals.');
  if (isOneOf(names, NETWORK_TOOLS)) f.danger.push('It moves data over the network with a tool that can send files.');
  if (isOneOf(names, DISK_TOOLS)) f.danger.push('It formats, partitions or wipes a disk or changes boot or backup settings.');
  if (isOneOf(names, SYSTEM_TOOLS)) f.danger.push('It changes Windows itself (system settings, services, permissions, scripts hosts) or shuts the PC down.');
  if (names.includes('reg') && !['query', 'export', ''].includes(sub)) f.danger.push('It edits the Windows registry.');
  if (names.includes('schtasks') && !dosArgs.includes('/query')) f.danger.push('It creates or changes scheduled tasks.');
  if (names.includes('sc') && ['create', 'config', 'delete', 'start', 'stop', 'failure'].includes(sub)) f.danger.push('It changes Windows services.');
  if (isOneOf(names, set('net net1')) && ['user', 'localgroup', 'share', 'use', 'accounts', 'start', 'stop', 'group'].includes(sub)) f.danger.push('It changes accounts, shares or services on this PC.');
  if (names.includes('robocopy') && dosArgs.some((t) => t === '/mir' || t === '/purge')) f.danger.push('It mirrors a folder and deletes what is not in the source.');
  if (names.includes('git')) checkGit(args, f);
  if (isOneOf(names, FETCH_TOOLS)) checkFetch(names, args, f);
  if (isOneOf(names, set('start-process saps start')) && dosArgs.some((t) => /^-verb$/.test(t)) && dosArgs.includes('runas')) f.danger.push('It asks for administrator rights.');
  if (names.includes('set') && !args.length) f.danger.push('It lists every environment variable, which can include secrets.');
  if (names.includes('export') && (!args.length || dosArgs.includes('-p'))) f.danger.push('It lists the environment, which can include secrets.');
  if (isOneOf(names, set('declare typeset')) && dosArgs.some((t) => /^-[a-z]*[xp]/.test(t))) f.danger.push('It lists the environment, which can include secrets.');
  if (isOneOf(names, LISTERS) && dosArgs.some((t) => /^(env|variable):([*\\/]?)$/.test(t))) f.danger.push('It lists every environment variable, which can include secrets.');
  if (isOneOf(names, set('eval source . invoke-command icm start-job'))) f.danger.push('It runs code the app cannot see (eval, source, dot-sourcing).');
  if (isOneOf(names, SHELLS) || isOneOf(names, INTERPRETERS)) {
    if (cmd.pipedIn && !args.some((a) => !a.text.startsWith('-'))) f.danger.push('It runs a program that reads its code from another command.');
  }
  if (names.includes('find')) checkFind(args, cmd, env);
  if (isOneOf(names, AWKS)) {
    const prog = args.find((a) => !a.text.startsWith('-'));
    if (prog && /(^|[^.\w])system\s*\(|\|\s*"|getline\s*<?\s*"?\s*\|/i.test(prog.text)) f.danger.push('The awk program starts other programs.');
  }
  if (isOneOf(names, POWERSHELLS) && dosArgs.some((t) => /^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/.test(t))) f.danger.push('It runs an encoded PowerShell command.');
}

const FIND_FILTERS = /^-(name|iname|path|ipath|regex|iregex|type|mtime|atime|ctime|newer|size|user|empty|maxdepth|mindepth|perm)$/;

function checkFind(args, cmd, env) {
  const { f } = env;
  const texts = args.map((a) => a.text);
  const filtered = texts.some((t) => FIND_FILTERS.test(t));
  if (texts.includes('-delete') && !filtered) f.danger.push('It deletes everything under a folder (find -delete without a filter).');
  if (texts.includes('-delete')) {
    const stop = texts.findIndex((t) => t.startsWith('-') || t === '!' || t === '(');
    for (const t of texts.slice(0, stop < 0 ? texts.length : stop)) {
      if (classifyPath(t, { root: env.ctx.root, cwd: env.state.cwd, protect: env.ctx.protect }).status !== 'inside') f.danger.push(`It deletes files outside the project or from a place the app cannot resolve: ${t}.`);
    }
  }
  const i = texts.findIndex((t) => /^-(exec|execdir|ok|okdir)$/.test(t));
  if (i >= 0) {
    const inner = texts.slice(i + 1);
    const end = inner.findIndex((t) => t === '\\' || t === '+' || t === ';');
    const words = (end < 0 ? inner : inner.slice(0, end)).map((text) => ({ text }));
    const run = commandOf(words);
    if (run.head) segment({ words, redirects: [], pipedIn: true }, env.ctx, env.depth, f, env.state);
  }
}

/** Every word that may name a path: skipped for commands that only print their arguments. */
function checkArgs(names, args, redirects, cmd, env) {
  const dos = isOneOf(names, DOS_COMMANDS);
  const printing = isOneOf(names, PRINTERS);
  const listing = isOneOf(names, LISTERS);
  const writer = !isOneOf(names, READERS);
  for (const a of args) checkWord(a.text, env, { dos, writer, listing, printing });
  for (const r of redirects) checkWord(r.target.text, env, { dos, writer: r.op !== '<', listing: false, printing: false });
}

function changeDirectory(args, env) {
  const { ctx, state, f } = env;
  const target = args.find((a) => !/^(-[A-Za-z]|\/[dD])$/.test(a.text));
  if (!target) { f.outside.push('It changes to your home folder.'); state.cwd = null; return; }
  if (target.text === '-') { state.cwd = null; f.outside.push('It changes to the previous folder, which the app cannot track.'); return; }
  const c = classifyPath(target.text, { root: ctx.root, cwd: state.cwd, protect: ctx.protect });
  if (c.status !== 'inside') f.outside.push(`It changes folder to ${c.why}: ${target.text}.`);
  state.cwd = c.status === 'unknown' ? null : c.abs;
}

function segment(seg, ctx, depth, f, state) {
  const cmd = commandOf(seg.words);
  cmd.pipedIn = seg.pipedIn;
  const env = { ctx, state, f, depth };
  if (!cmd.head) {
    if (cmd.wrappers.includes('env')) f.danger.push('It lists every environment variable, which can include secrets.');
    checkArgs([], [], seg.redirects, cmd, env);
    return;
  }
  const { names, args } = cmd;
  if (/[$%`]/.test(cmd.head.text)) { f.danger.push('The program to run is built from a variable or another command, which the app cannot check.'); return; }
  checkSpecial([...names, ...cmd.wrappers], args, cmd, env);
  if (isOneOf(names, CD)) changeDirectory(args, env);
  if (isOneOf(names, REMOVERS)) checkRemoval(names, args, cmd, env);
  const code = inlineCode(names, args);
  if (code !== null) {
    if (code.includes('$()')) f.danger.push('The code is built from another command, which the app cannot check.');
    checkCode(code, f);
  }
  const inner = shellInner(names, args);
  if (inner !== null) run(inner, ctx, depth + 1, f, state);
  checkArgs(names, args, seg.redirects, cmd, env);
  if (/[\\/]/.test(cmd.head.text) && !/^([A-Za-z]:|[\\/])/.test(cmd.head.text)) checkWord(cmd.head.text, env, { dos: false, writer: false, listing: false, printing: false });
}

function run(command, ctx, depth, f, state) {
  if (depth > MAX_DEPTH) { f.danger.push('The command nests shells too deeply for the app to check.'); return; }
  if (command.length > MAX_COMMAND) { f.danger.push(`The command is longer than ${MAX_COMMAND} characters, too long to check. Put it in a script file.`); return; }
  if (/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(command)) { f.danger.push('The command contains control characters.'); return; }
  const flat = flatten(command);
  for (const [test, why] of TEXT_RULES) if (test(flat)) f.danger.push(why);
  for (const dir of ctx.protect) if (flat.includes(flatten(dir))) f.danger.push("It names Circle Studio's own data folder.");
  const scan = scanCommand(command);
  if (scan.error) { f.danger.push(`The command cannot be checked safely (${scan.error}). Write a script file with the Write tool and run that instead.`); return; }
  for (const seg of scan.segments) segment(seg, ctx, depth, f, state);
  for (const inner of scan.subs) run(inner, ctx, depth + 1, f, { ...state });
}

/**
 * Judge a shell command. ctx: { root, protect: [absolute folders the agent may never touch] }.
 * Returns { danger: [reasons], outside: [reasons] }; a reason is a sentence for the human.
 */
export function analyzeShell(command, ctx) {
  const f = { danger: [], outside: [] };
  run(String(command ?? ''), { root: ctx.root, protect: ctx.protect || [] }, 0, f, { cwd: ctx.root });
  f.danger = [...new Set(f.danger)];
  f.outside = [...new Set(f.outside)];
  return f;
}

/** The words of a command when it is one plain command (no operators, redirections or substitutions), else null. */
export function plainWords(command) {
  const scan = scanCommand(String(command ?? ''));
  if (scan.error || scan.subs.length || scan.segments.length !== 1 || scan.segments[0].redirects.length) return null;
  const words = scan.segments[0].words.map((w) => w.text);
  return words.length && !words.some((w) => /[$%`]/.test(w)) ? words : null;
}

