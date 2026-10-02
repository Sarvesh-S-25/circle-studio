// Widgets: the tiles you keep on your desktop (agents, spending, a workflow, what waits for you). Choose and arrange
// them here, and put them on the desktop or take them off. The same board also opens in its own small window.
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { toast } from '../components/overlay.js';
import { mountBoard } from '../components/board.js';

export async function mount(el) {
  const desk = h('div', { class: 'cs-card cs-row cs-row--wrap' }, h('span', { class: 'cs-soft cs-small' }, 'Checking the desktop...'));
  const boardEl = h('div', {});
  el.append(h('div', { class: 'cs-stack cs-stack--loose' },
    h('header', {}, h('h1', { class: 'cs-h1', id: 'main-title' }, 'Widgets'),
      h('p', { class: 'cs-soft' }, 'Tiles for your desktop, like phone widgets: agents, spending, a workflow, what waits for you.')),
    desk, boardEl));

  async function drawDesk() {
    let st;
    try { st = await api.desktopWidgets('status'); } catch {
      desk.replaceChildren(h('span', { class: 'cs-soft cs-small' }, 'Desktop widgets work on Windows only. You can still use the board below.'));
      return;
    }
    const toggle = async (on) => {
      try {
        await api.desktopWidgets(on ? 'start' : 'stop');
        // the start-at-sign-in shortcut brings them back too
        const sc = (await api.desktopStatus().catch(() => null))?.shortcuts;
        if (sc?.startup) await api.shortcut({ where: 'startup' });
        toast(on ? 'On your desktop now. Drag a tile to move it; right-click for options.' : 'The widgets are off the desktop.', { kind: 'ok' });
      } catch (e) { toast(e.message, { kind: 'danger' }); }
      drawDesk();
    };
    desk.replaceChildren(
      h('div', { class: 'cs-grow cs-stack cs-stack--tight' },
        h('strong', {}, st.running ? 'On your desktop' : 'Not on your desktop'),
        h('span', { class: 'cs-soft cs-small' }, st.running ? 'Drag a tile to move it. Click it to open Circle Studio there. Right-click for options.' : 'Put the tiles below on your desktop. They come back whenever Circle Studio runs.')),
      h('button', { class: `cs-btn ${st.running ? '' : 'cs-btn--primary'}`, type: 'button', onclick: () => toggle(!st.running) }, icon(st.running ? 'close' : 'pin', 's'), st.running ? 'Take them off' : 'Put on desktop'),
      h('button', { class: 'cs-btn cs-btn--quiet', type: 'button', title: 'The same tiles in a small window of their own', onclick: () => api.openWindow('widget').catch((e) => toast(e.message, { kind: 'danger' })) }, icon('external', 's'), 'Own window'));
  }

  drawDesk();
  const board = mountBoard(boardEl, { openApp: (hash) => { location.hash = hash; }, embedded: true });
  return { destroy: () => { board.then((b) => b?.destroy()).catch(() => {}); } };
}
