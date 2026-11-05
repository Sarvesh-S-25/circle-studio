// Inspect only the isolated browser's dummy-backup download. No real user browser or external account access.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const endpoint = new URL(process.argv[2]);
if (endpoint.hostname !== '127.0.0.1' || !endpoint.pathname.startsWith('/devtools/browser/')) throw new Error('Use an isolated local browser endpoint.');
const socket = new WebSocket(endpoint);
await new Promise((resolve, reject) => { const timeout = setTimeout(() => { socket.close(); reject(new Error('The isolated browser endpoint did not connect.')); }, 10000); socket.onopen = () => { clearTimeout(timeout); resolve(); }; socket.onerror = () => { clearTimeout(timeout); reject(new Error('The isolated browser endpoint is unavailable.')); }; });
let id = 0; const pending = new Map(); const events = [];
socket.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) { const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }
  else if (/download|loadingFailed/i.test(m.method || '')) events.push({ method: m.method, params: m.params });
};
const rpc = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const request = ++id; const timeout = setTimeout(() => { pending.delete(request); reject(new Error(`Browser command timed out: ${method}`)); }, 15000); pending.set(request, { resolve: (result) => { clearTimeout(timeout); resolve(result); }, reject: (error) => { clearTimeout(timeout); reject(error); } }); socket.send(JSON.stringify({ id: request, method, params, ...(sessionId ? { sessionId } : {}) })); });
const output = path.resolve('tests/e2e/shots');
try {
  await rpc('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: output, eventsEnabled: true });
  const { targetInfos } = await rpc('Target.getTargets');
  const page = targetInfos.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:4397/'));
  if (!page) throw new Error('No isolated dummy page is open.');
  const { sessionId } = await rpc('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  await rpc('Network.enable', {}, sessionId);
  const result = await rpc('Runtime.evaluate', { expression: "(async () => { const r=await fetch('/api/storage/backup',{method:'POST',headers:{'X-Circle':'1','Content-Type':'application/json'},body:JSON.stringify({download:true})}); const b=await r.json(); const a=document.createElement('a'); a.href='/api/storage/download/'+b.token; a.download='dummy-browser-backup.json'; document.body.append(a); a.click(); a.remove(); return {token:b.token,files:b.files}; })()", awaitPromise: true, returnByValue: true }, sessionId);
  const start = Date.now();
  while (Date.now() - start < 15000 && !events.some((e) => e.method === 'Browser.downloadProgress' && ['completed', 'canceled'].includes(e.params.state))) await new Promise((resolve) => setTimeout(resolve, 100));
  const completed = events.find((e) => e.method === 'Browser.downloadProgress' && e.params.state === 'completed');
  if (!completed) throw new Error('The browser did not complete the dummy backup download.');
  const file = path.join(output, completed.params.guid);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (backup.schema !== 'circle-backup/1' || backup.entries.length !== result.result?.value?.files) throw new Error('Downloaded backup metadata does not match.');
  for (const entry of backup.entries) if (createHash('sha256').update(Buffer.from(entry.data, 'base64')).digest('hex') !== entry.sha256) throw new Error('Downloaded backup entry checksum mismatch.');
  const report = { prepared: result.result?.value, integrityVerified: true, events };
  fs.writeFileSync(path.join(output, 'browser-download-events.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { socket.close(); }
