// An isolated, fake-engine demo for browser QA. Never uses the user's provider homes or application data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../backend/config.mjs';
import { createServer } from '../backend/server.mjs';
import { ClaudeService } from '../backend/lib/claude.mjs';
import { createClaudeAdapter } from '../backend/lib/engines/claude.mjs';
import { createCodexAdapter } from '../backend/lib/engines/codex.mjs';
import { blankWorkflow, normalizeWorkflow } from '../backend/lib/workflow.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-demo-'));
const project = path.join(root, 'dummy-project'); fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'README.md'), '# Dummy project\n\nA temporary project for Circle Studio browser testing.\n');
const portAt = process.argv.indexOf('--port');
const config = loadConfig({ CIRCLE_DATA: path.join(root, 'data'), CIRCLE_PORT: portAt >= 0 ? process.argv[portAt + 1] : process.env.CIRCLE_DEMO_PORT || '4396', CIRCLE_USER_HOME: path.join(root, 'home'), CIRCLE_CLAUDE_HOME: path.join(root, 'home', '.claude'), CIRCLE_CODEX_HOME: path.join(root, 'home', '.codex'), CIRCLE_PROJECTS_ROOT: root });
const fakeClaude = path.resolve(import.meta.dirname, '../tests/helpers/fake-claude.mjs');
const fakeEngines = path.resolve(import.meta.dirname, '../tests/helpers/fake-engines.mjs');
const claude = new ClaudeService({ bin: process.execPath, prefixArgs: [fakeClaude] });
const server = createServer(config, { claude, adapters: [createCodexAdapter({ bin: process.execPath, prefixArgs: [fakeEngines, 'codex'] }), createClaudeAdapter({ service: claude, bin: claude.bin, prefixArgs: claude.prefix })], toast: () => false, findWindow: async () => ({ found: false }), spawnTerminal: () => ({}), restart: () => {}, vaultCodec: { protect: (s) => `dummy:${Buffer.from(s).toString('base64')}`, unprotectMany: (ss) => ss.map((s) => Buffer.from(s.slice(6), 'base64').toString()) } });
await server.app.settings.set({ preferredEngine: 'codex', overlayBar: { engine: 'codex' }, desktopAsks: false, desktopWidgets: false, updates: { check: 'off', autoRestart: false } });
const p = await server.app.projects.add(project, { claude: true, run: true, write: true });
const wf = normalizeWorkflow({ ...blankWorkflow('Dummy Codex workflow'), nodes: [{ id: 'you', kind: 'human', title: 'You' }, { id: 'build', kind: 'stage', title: 'Build and check' }, { id: 'builder', kind: 'agent', title: 'Codex builder', parent: 'build', engine: 'codex', model: 'dummy-codex-balanced' }], edges: [{ from: 'you', to: 'build' }] });
server.app.workflows.save(p, { workflow: wf, note: 'Dummy browser fixture' });
await server.app.limits.refresh('codex', server.app.engines.adapter('codex'));
if (process.argv.includes('--fixtures')) {
  fs.mkdirSync(path.join(project, 'docs', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(project, 'docs', 'tasks', 'ALERTS.md'), '# Dummy team questions\n\n## A-001 - Review the dummy choice\n\n- **Status:** open\n- **Question for the human:** Which dummy database should this isolated test use?\n- **Options:** SQLite; Memory\n- **Answer:**\n');
  const key = server.app.sessions.chatKey(p.id, null, 'codex');
  for (let chat = 1; chat <= 3; chat++) {
    await server.app.chats.reset(key);
    await server.app.chats.append(key, Array.from({ length: chat === 1 ? 250 : 4 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `Dummy conversation ${chat}, message ${i + 1}`, engine: 'codex', at: new Date(Date.now() - (300 - i) * 1000).toISOString() })), `dummy-history-${chat}`);
  }
  await server.app.chats.reset(key);
}
await new Promise((resolve) => server.server.listen(config.port, '127.0.0.1', resolve));
console.log(JSON.stringify({ url: `http://127.0.0.1:${config.port}/#/projects/${p.id}/chat`, projectId: p.id, dataDir: config.dataDir, projectFolder: project, dummy: true }));
const stop = async () => { server.app.queue.stop(); await server.app.sessions.stopAll(); server.app.advice.stopAll(); server.app.stopDesktop(); await new Promise((resolve) => server.server.close(resolve)); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
