// Your Claude plan's limits: how much of the 5-hour window and of the week is used, and when each resets. Claude Code
// says it itself, with no key: in the stream of every run (`rate_limit_event`) and to your status line (`rate_limits`).
// The newest reading is kept in limits.json in Circle Studio's data folder; nothing is asked of Anthropic for it.
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'limits.json';
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
// resetsAt comes in seconds (stream) or as a date (status line)
const when = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
};

/** A `rate_limit_event`'s rate_limit_info -> { fiveHour, week } (percent used, reset time), or null. */
export function fromStream(info) {
  const w = info?.unifiedWindows;
  if (!w || typeof w !== 'object') return null;
  const one = (x) => (x && typeof x.utilization === 'number' ? { pct: pct(x.utilization * 100), resetsAt: when(x.resetsAt) } : null);
  const out = { fiveHour: one(w.five_hour), week: one(w.seven_day) };
  return out.fiveHour || out.week ? out : null;
}

/** A status line's `rate_limits` -> the same shape, or null. */
export function fromStatusLine(rl) {
  if (!rl || typeof rl !== 'object') return null;
  const one = (x) => (x && x.used_percentage != null ? { pct: pct(Number(x.used_percentage)), resetsAt: when(x.resets_at ?? x.resetsAt) } : null);
  const out = { fiveHour: one(rl.five_hour), week: one(rl.seven_day) };
  return out.fiveHour || out.week ? out : null;
}

export class Limits {
  constructor(store) { this.store = store; this.refreshing = new Map(); }

  /** The newest reading, or null when Claude Code has not said yet. */
  get(provider = 'claude') { return this.store.readJson(provider === 'claude' ? FILE : `limits-${/^(codex|gemini|copilot)$/.test(provider) ? provider : 'unknown'}.json`, null); }

  record(reading, source) {
    if (!reading) return;
    if (reading.provider && reading.provider !== 'claude') {
      if (reading.provider !== 'codex') return;
      const buckets = reading.rateLimitsByLimitId || (reading.rateLimits ? { codex: reading.rateLimits } : {});
      const windows = Object.entries(buckets).flatMap(([id, bucket]) => ['primary', 'secondary'].flatMap((kind) => {
        const w = bucket?.[kind];
        if (!w || pct(w.usedPercent) == null) return [];
        const mins = w.windowDurationMins;
        const label = mins === 10080 ? 'Week' : mins === 300 ? '5 hours' : mins >= 60 && mins % 60 === 0 ? `${mins / 60} hours` : mins > 0 ? `${mins} minutes` : kind === 'primary' ? 'Current window' : 'Longer window';
        return [{ id: `${id}:${kind}`, label: Object.keys(buckets).length > 1 ? `${bucket.limitName || id} · ${label}` : label, durationMins: mins ?? null, pct: pct(w.usedPercent), resetsAt: when(w.resetsAt) }];
      }));
      this.store.writeJson('limits-codex.json', { provider: 'codex', profileId: reading.profileId || null, at: new Date().toISOString(), source, windows, available: windows.length > 0 });
      return;
    }
    const prev = this.get();
    this.store.writeJson(FILE, { at: new Date().toISOString(), source, fiveHour: reading.fiveHour || prev?.fiveHour || null, week: reading.week || prev?.week || null });
  }

  async refresh(provider, adapter) {
    if (!adapter?.readLimits) return this.get(provider);
    if (this.refreshing.has(provider)) return this.refreshing.get(provider);
    const pending = (async () => {
      try { this.record(await adapter.readLimits(), 'account'); return this.get(provider); }
      catch {
        const state = { provider, at: new Date().toISOString(), source: 'account', available: false, windows: [], error: 'Could not refresh account limits. Check sign-in and try again.' };
        this.store.writeJson(`limits-${provider}.json`, state);
        return state;
      } finally { this.refreshing.delete(provider); }
    })();
    this.refreshing.set(provider, pending);
    return pending;
  }
}

/** For the status line tap (a separate small process): write the reading straight into the data folder. */
export function writeReading(dataDir, reading, source) {
  if (!reading) return;
  const file = path.join(dataDir, FILE);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first one */ }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ at: new Date().toISOString(), source, fiveHour: reading.fiveHour || prev?.fiveHour || null, week: reading.week || prev?.week || null }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/* ---- the status line tap: set up and removed in one click, your own command kept ----------------------------- */

const TAP_FILE = 'statusline-tap.json';
const tapMark = 'statusline-tap.mjs';

/** A command line as program and arguments, or null when it needs a shell (pipes, &&, redirects, variables...). */
export function splitCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim() || /[|&;<>`]|\$[({A-Za-z]|%[A-Za-z_]+%/.test(cmd)) return null;
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out.length ? out : null;
}

const quote = (s) => `"${s}"`;

/** Where things stand: { on, own (your command, shown), canTap, why, before, after } for the preview. */
export function tapState({ claudeHome, dataDir, appRoot, nodePath = process.execPath }) {
  const file = path.join(claudeHome, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return { on: false, canTap: false, why: 'Your Claude Code settings file could not be read.' }; }
  const line = settings.statusLine || null;
  const on = typeof line?.command === 'string' && line.command.includes(tapMark);
  let kept = null;
  try { kept = JSON.parse(fs.readFileSync(path.join(dataDir, TAP_FILE), 'utf8')); } catch { /* none */ }
  if (on) return { on: true, canTap: true, own: kept?.statusLine?.command || null, before: line, after: kept?.statusLine || null };
  const argv = line ? splitCommand(line.command) : [];
  if (line && line.type !== 'command') return { on: false, canTap: false, why: 'Your status line is not a command.' };
  if (line && !argv) return { on: false, canTap: false, why: 'Your status line command uses shell features (pipes, &&, variables), so Circle Studio cannot run it without a shell.' };
  const after = { ...(line || {}), type: 'command', command: `${quote(nodePath)} ${quote(path.join(appRoot, 'scripts', tapMark))}` };
  return { on: false, canTap: true, own: line?.command || null, argv, before: line, after };
}

/** Turn the tap on or off. Your settings file is copied to the backups first; off puts your own line back. */
export function setTap(on, { claudeHome, dataDir, appRoot, nodePath = process.execPath }) {
  const st = tapState({ claudeHome, dataDir, appRoot, nodePath });
  if (st.on === on) return st;
  if (on && !st.canTap) throw Object.assign(new Error(st.why), { status: 400 });
  const file = path.join(claudeHome, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* a new file */ }
  const backups = path.join(dataDir, 'backups');
  fs.mkdirSync(backups, { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backups, `claude-settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  if (on) {
    fs.writeFileSync(path.join(dataDir, TAP_FILE), `${JSON.stringify({ statusLine: st.before, argv: st.argv }, null, 2)}\n`);
    settings.statusLine = st.after;
  } else {
    if (st.after) settings.statusLine = st.after; else delete settings.statusLine;
    try { fs.unlinkSync(path.join(dataDir, TAP_FILE)); } catch { /* gone */ }
  }
  const tmp = `${file}.circle.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return tapState({ claudeHome, dataDir, appRoot, nodePath });
}
