import test from 'node:test';
import assert from 'node:assert/strict';
import { codexMcpText } from '../../backend/lib/codex-config.mjs';

test('narrow Codex MCP updates preserve unrelated TOML and only replace owned sections', () => {
  const original = '# My settings\r\nmodel = "my-model"\r\n[profiles.work]\r\napproval_policy = "never"\r\n';
  const added = codexMcpText(original, 'dummy', { command: 'dummy.exe', args: ['one'], env_vars: ['DUMMY_TOKEN'] });
  assert.ok(added.startsWith(original));
  assert.match(added, /\[mcp_servers.dummy\]/);
  assert.ok(added.includes('\r\ncommand = "dummy.exe"\r\n'));
  const updated = codexMcpText(added, 'dummy', { url: 'http://127.0.0.1:9999/mcp' });
  assert.ok(updated.startsWith(original)); assert.ok(!updated.includes('dummy.exe'));
  assert.ok(codexMcpText(updated, 'dummy', null).startsWith(original));
  assert.throws(() => codexMcpText('[mcp_servers.dummy]\ncommand="manual"\n', 'dummy', { command: 'new' }), /unmanaged/);
  assert.throws(() => codexMcpText('notes = """multiline"""', 'dummy', { command: 'new' }), /does not support/);
  assert.throws(() => codexMcpText('', '../escape', { command: 'new' }), /name/);
  assert.throws(() => codexMcpText('', 'dummy', { url: 'https://user:pass@example.com/mcp' }), /credentials/);
  assert.throws(() => codexMcpText('', 'dummy', { command: 'new', env: { TOKEN: 'value' } }), /Supported fields/);
});
