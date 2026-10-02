// One window per thing: opening Circle Studio (or the board, or a project's widget) while that window is open brings
// it forward on the page asked for instead of opening a second one. No real window is opened or raised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server.mjs';

const streams = new Set();

/** An open window: its event stream, registered as `key`. Collects the events it gets. */
async function openStream(s, key) {
  const ctl = new AbortController();
  streams.add(ctl);
  const res = await fetch(`${s.base}/api/events?window=${encodeURIComponent(key)}`, { signal: ctl.signal });
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          if (ev && data) events.push({ name: ev[1], data: JSON.parse(data[1]) });
        }
      }
    } catch { /* closed */ }
  })();
  for (let i = 0; i < 50 && !s.app.openWindows().includes(key); i++) await new Promise((r) => setTimeout(r, 20));
  return { events, close: () => ctl.abort() };
}

test('opening again reuses the open window; a window still loading is not started twice', async () => {
  const s = await startServer();
  const opened = [];
  const focused = [];
  let found = true;
  s.app.overrides.openWindow = (url) => { opened.push(url); return true; };
  s.app.overrides.focusWindow = async (mark) => { focused.push(mark); return found; };
  const open = (body) => s.call('POST', '/api/desktop/open', body).then((r) => r.json);
  try {
    // nothing open: one window is opened, and a second click while it loads does not open another
    assert.equal((await open({ kind: 'app' })).shown, 'new');
    assert.equal((await open({ kind: 'app' })).shown, 'starting');
    assert.equal(opened.length, 1);

    // the window is open: it is asked to come forward on the page, and raised by its title mark
    const w = await openStream(s, 'app');
    const r = await open({ kind: 'app', hash: '#/inbox' });
    assert.equal(r.shown, 'existing');
    assert.equal(opened.length, 1, 'no second window');
    for (let i = 0; i < 50 && !w.events.some((e) => e.name === 'show'); i++) await new Promise((res) => setTimeout(res, 20));
    const show = w.events.find((e) => e.name === 'show');
    assert.equal(show.data.hash, '#/inbox');
    assert.match(show.data.mark, /^[\u200b-\u200d]+$/, 'an invisible mark');
    assert.equal(focused.at(-1), show.data.mark, 'the window with that mark is raised');

    // other kinds are separate: the board is not the app
    assert.equal((await open({ kind: 'widget' })).shown, 'new');
    assert.match(opened.at(-1), /\/widget\.html$/);

    // open but not on screen (a background tab): a fresh window after all
    found = false;
    assert.equal((await open({ kind: 'app' })).shown, 'new');
    found = true;

    // closed: forgotten
    w.close();
    for (let i = 0; i < 50 && s.app.openWindows().includes('app'); i++) await new Promise((res) => setTimeout(res, 20));
    assert.ok(!s.app.openWindows().includes('app'));
  } finally {
    for (const c of streams) c.abort();
    await s.close();
  }
});

test('after a restart the launcher waits for open windows to reconnect instead of opening another', async () => {
  const s = await startServer();
  const opened = [];
  s.app.overrides.openWindow = (url) => { opened.push(url); return true; };
  s.app.overrides.focusWindow = async () => true;
  try {
    const asked = s.call('POST', '/api/desktop/open', { kind: 'app', settle: true });
    await new Promise((r) => setTimeout(r, 300));
    const w = await openStream(s, 'app'); // the old window reconnects a moment later
    assert.equal((await asked).json.shown, 'existing');
    assert.equal(opened.length, 0);
    w.close();
    const bad = await openStream(s, 'app; bad');
    assert.ok(!s.app.openWindows().includes('app; bad'), 'a key that is not well formed is not registered');
    bad.close();
  } finally {
    for (const c of streams) c.abort();
    await s.close();
  }
});
