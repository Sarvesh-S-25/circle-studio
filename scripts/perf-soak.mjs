// Six HTTP widget clients against a private fake-engine server. No GUI or real account/project data.
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../tests/helpers/server.mjs';
import { makeMiniProject, rmDir } from '../tests/helpers/project.mjs';
const value = (flag, fallback) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : fallback; };
const minutes = Math.max(0.1, Math.min(60, Number(value('--minutes', '30')) || 30));
const output = path.resolve(value('--output', 'tests/e2e/shots/perf-soak.json'));
const s = await startServer(); const project = makeMiniProject();
const start = Date.now(); const samples = []; let requests = 0;
try {
  const id = (await s.call('POST', '/api/projects', { path: project, permissions: { engine: true } })).json.project.id;
  await s.app.chats.append(id, [{ role: 'user', text: 'Dummy widget fixture', at: new Date().toISOString() }, { role: 'assistant', text: 'No model was called.', at: new Date().toISOString() }]);
  const listeners = s.app.sessions.listeners.size;
  do {
    const before = process.cpuUsage(); const began = performance.now();
    const responses = await Promise.all(Array.from({ length: 6 }, () => s.call('GET', `/api/widgets/chat?projectId=${id}&engine=claude`)));
    requests += responses.length;
    if (responses.some((r) => r.status !== 200)) throw new Error('A dummy widget request failed');
    samples.push({ seconds: Math.round((Date.now() - start) / 1000), memory: process.memoryUsage(), cpu: process.cpuUsage(before), widgetBatchMs: Math.round(performance.now() - began), listeners: s.app.sessions.listeners.size, waiters: s.app.sessions.waiters.size, queues: s.app.store.queues.size, engineChildren: (await s.call('GET', '/api/system/diagnostics')).json.engineChildren.length, caches: s.app.chats.cacheStats() });
    if (s.app.sessions.listeners.size !== listeners || s.app.sessions.waiters.size) throw new Error('Idle listeners or pending request waiters grew');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ status: 'running', minutes, requests, startedAt: new Date(start).toISOString(), samples, note: 'Isolated server with six HTTP widget clients; excludes browser/WPF memory and starts no real model turns.' }, null, 2));
    if (Date.now() - start >= minutes * 60000) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(15000, minutes * 60000 - (Date.now() - start))));
  } while (true);
  const report = JSON.parse(fs.readFileSync(output, 'utf8')); report.status = 'complete'; report.durationSeconds = Math.round((Date.now() - start) / 1000);
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, durationSeconds: report.durationSeconds, requests, samples: samples.length, first: samples[0], last: samples.at(-1), report: output }));
} finally { await s.close(); rmDir(project); }
