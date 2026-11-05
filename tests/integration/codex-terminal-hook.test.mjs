import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startServer } from '../helpers/server.mjs';
import { makeMiniProject, rmDir } from '../helpers/project.mjs';

test('Codex terminal hook preserves other hooks, backs up settings, and delivers exact allow/deny decisions', async () => {
  const toasts = [];
  const s = await startServer({ toast: (n) => { toasts.push(n); return true; } });
  const folder = makeMiniProject();
  const file = path.join(s.app.config.codexHome, 'hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const other = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } };
  fs.writeFileSync(file, JSON.stringify(other));
  try {
    const installed = await s.call('POST', '/api/permhook', { on: true, engine: 'codex' });
    assert.equal(installed.json.on, true);
    assert.equal(installed.json.trustRequired, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).hooks.Stop, other.hooks.Stop);
    assert.ok(fs.readdirSync(path.join(s.app.config.dataDir, 'backups')).some((f) => f.startsWith('codex-settings-')));
    for (const decision of ['deny', 'allow', 'terminal']) {
      const child = spawn(process.execPath, [path.resolve('scripts/permission-hook.mjs'), '--port', String(s.port), '--engine', 'codex'], { windowsHide: true, env: { ...process.env, CIRCLE_PORT: String(s.port) }, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = ''; let errors = '';
      child.stdout.on('data', (b) => { output += b; });
      child.stderr.on('data', (b) => { errors += b; });
      const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'echo isolated-hook-fixture' }, cwd: folder, session_id: '12345678-1234-1234-1234-123456789abc' }));
      try {
        let request;
        for (let n = 0; n < 100 && !request; n++) { request = s.app.inbox.list({ status: 'pending' })[0]; if (!request) await new Promise((r) => setTimeout(r, 20)); }
        assert.ok(request, errors);
        assert.equal(request.engine, 'codex');
        assert.equal(request.source, 'terminal');
        assert.match(request.detail, /echo isolated-hook-fixture/);
        assert.ok(toasts.some((n) => /Codex asks/.test(n.title)));
        if (decision === 'terminal') await s.call('POST', `/api/hooks/permission/${request.id}/release`, {});
        else await s.call('POST', `/api/requests/${request.id}/respond`, { decision });
        assert.equal(await closed, 0, errors);
        if (decision === 'terminal') assert.equal(output, '');
        else assert.equal(JSON.parse(output).hookSpecificOutput.decision.behavior, decision);
      } finally { child.kill(); }
    }
    await s.call('POST', '/api/permhook', { on: false, engine: 'codex' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), other);
    assert.equal((await s.call('POST', '/api/permhook', { on: true, engine: 'invalid' })).status, 400);
  } finally { await s.close(); rmDir(folder); }
});
