// Claude Code's PermissionRequest hook: when Claude Code in a terminal or an editor wants to run a command, change a
// file or ask a question, the request goes to Circle Studio, which shows it as a card on the desktop; your answer there
// comes back here and Claude Code goes on. Set up (and removed) from Circle Studio, Settings.
// When Circle Studio is not running, or you press "In the terminal" on the card, this prints nothing and Claude Code asks
// in the terminal as usual. Only 127.0.0.1 is ever contacted.
import http from 'node:http';

const port = Number(process.env.CIRCLE_PORT) || Number(process.argv[process.argv.indexOf('--port') + 1]) || 4380;
const LIMIT_MS = 9 * 60 * 1000; // under the hook's own timeout (10 minutes), so Claude Code never has to cut it off

function call(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false, timeout: 35_000, headers: { 'X-Circle': '1', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(data || undefined);
  });
}

// nothing printed: Claude Code shows its own question in the terminal
const stepAside = () => process.exit(0);
const say = (decision) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }), () => process.exit(0));

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return stepAside(); }
  if (input?.hook_event_name && input.hook_event_name !== 'PermissionRequest') return stepAside();
  const sent = await call('POST', '/api/hooks/permission', { tool_name: input.tool_name, tool_input: input.tool_input, cwd: input.cwd, session_id: input.session_id });
  if (!sent?.id) return stepAside(); // Circle Studio is not running (or refused it): the terminal asks
  const until = Date.now() + LIMIT_MS;
  while (Date.now() < until) {
    const r = await call('GET', `/api/hooks/permission/${encodeURIComponent(sent.id)}?wait=25`);
    if (!r) return stepAside();
    if (r.status === 'pending') continue;
    if (r.status !== 'done' || r.decision === 'terminal') return stepAside();
    // a question's answers go back inside the tool's input, as Claude Code expects them
    if (r.decision === 'allow' || r.decision === 'answer') return say(r.answers ? { behavior: 'allow', updatedInput: { ...(input.tool_input || {}), answers: r.answers } } : { behavior: 'allow' });
    return say({ behavior: 'deny', message: r.message && r.message !== 'The human said no.' ? `Refused on the Circle Studio card: ${r.message}` : 'Refused on the Circle Studio card.' });
  }
  // nobody answered in time: hand it back to the terminal
  await call('POST', `/api/hooks/permission/${encodeURIComponent(sent.id)}/release`);
  return stepAside();
});
