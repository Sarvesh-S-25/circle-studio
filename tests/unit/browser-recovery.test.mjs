import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('browser events: stalled streams recover after sleep and all watchers stop on close', async () => {
  const timers = new Map(); const intervals = new Map(); let nextId = 0;
  let now = 0; let fetches = 0; let aborted = 0;
  const window = new EventTarget(); const document = new EventTarget(); document.visibilityState = 'visible';
  const context = vm.createContext({
    window, document, AbortController, TextDecoder, Date: { now: () => now },
    setInterval: (fn) => { const id = ++nextId; intervals.set(id, fn); return id; }, clearInterval: (id) => intervals.delete(id),
    setTimeout: (fn) => { const id = ++nextId; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id),
    fetch: async (url, { signal }) => {
      fetches++;
      return { headers: { get: () => 'text/event-stream' }, body: { getReader: () => ({ read: () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true });
      }) }) } };
    },
  });
  vm.runInContext(fs.readFileSync('frontend/js/api.js', 'utf8').replaceAll('export ', '') + '\nglobalThis.testApi = api;', context);
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const stream = context.testApi.events(() => {}, 'app');
  await settle(); assert.equal(fetches, 1);
  now = 3600_000;
  for (const tick of intervals.values()) tick();
  await settle(); assert.equal(aborted, 1, 'missing heartbeat after a simulated hour of sleep aborts the stale reader');
  window.dispatchEvent(new Event('online'));
  await settle(); assert.equal(fetches, 2, 'network recovery wakes the pending reconnect');
  stream.close();
  await settle();
  assert.equal(intervals.size, 0); assert.equal(timers.size, 0);
  window.dispatchEvent(new Event('online'));
  assert.equal(fetches, 2, 'closed windows never reconnect');
});
