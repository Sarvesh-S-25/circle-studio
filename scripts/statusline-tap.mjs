// Claude Code's status line, tapped: Claude Code gives its status line the plan's 5-hour and weekly use
// (`rate_limits`); this keeps that reading for Circle Studio's Limits widget, then runs your own status line command
// with the same input and prints what it prints, so your status line looks exactly as before.
// Set up and removed from Circle Studio (the Limits widget), which keeps your command in
// data/statusline-tap.json. Your command is started without a shell (program and arguments only).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fromStatusLine, writeReading } from '../backend/lib/limits.mjs';

const dataDir = process.env.CIRCLE_DATA || path.join(import.meta.dirname, '..', 'data');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  let data = null;
  try { data = JSON.parse(input.toString('utf8')); } catch { /* not JSON: nothing to keep */ }
  try { writeReading(dataDir, fromStatusLine(data?.rate_limits), 'terminal'); } catch { /* never break the status line */ }
  let own = null;
  try { own = JSON.parse(fs.readFileSync(path.join(dataDir, 'statusline-tap.json'), 'utf8')).argv; } catch { /* none */ }
  if (!Array.isArray(own) || !own.length) {
    // no status line of your own: a short one
    const rl = fromStatusLine(data?.rate_limits);
    const bits = [rl?.fiveHour && `5h ${rl.fiveHour.pct}%`, rl?.week && `week ${rl.week.pct}%`].filter(Boolean);
    process.stdout.write(bits.join('  ·  '), () => process.exit(0));
    return;
  }
  const child = spawn(own[0], own.slice(1), { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  child.on('error', () => process.exit(0));
  child.on('exit', (code) => process.exit(code ?? 0));
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});
