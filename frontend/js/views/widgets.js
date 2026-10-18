// Widgets: the tiles you keep on your desktop (agents, spending, a workflow, what waits for you). Choose and arrange
// them here, and put them on the desktop or take them off. The same board also opens in its own small window.
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { toast } from '../components/overlay.js';
import { mountBoard } from '../components/board.js';

// The overlay's command box, here too: the same commands as Ctrl+Alt+C on the desktop, for this window.
function commands() {
  let projectId = null;
  const reply = h('div', { class: 'cs-stack cs-stack--tight', 'aria-live': 'polite' });
  const input = h('input', { class: 'cs-input cs-mono', type: 'text', 'aria-label': 'Command', placeholder: 'Type a command or a message. help shows them all.', autocomplete: 'off' });
  const examples = h('div', { class: 'cs-row cs-row--wrap' });
  const run = async (text) => {
    if (!text.trim()) return;
    reply.replaceChildren(h('span', { class: 'cs-soft cs-small' }, 'Working...'));
    try {
      const r = await api.overlayCommand(text, projectId);
      projectId = r.projectId || projectId;
      const tone = { ok: 'cs-st--done', warn: 'cs-st--waiting', danger: 'cs-st--danger' }[r.say.tone] || '';
      reply.replaceChildren(h('strong', { class: tone }, r.say.title), ...r.say.lines.map((l) => h('span', { class: `cs-small cs-soft ${r.command === 'help' ? 'cs-mono cs-cmdhelp' : ''}` }, l)));
      if (r.open) location.hash = r.open;
      else if (r.chatWindow) location.hash = `#/projects/${encodeURIComponent(r.chatWindow)}/chat`;
    } catch (e) { reply.replaceChildren(h('strong', { class: 'cs-st--danger' }, e.message)); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const t = input.value; input.value = ''; run(t); } });
  api.overlay().then((f) => {
    projectId = f.project?.id || null;
    examples.replaceChildren(...f.examples.map((x) => h('button', { class: 'cs-chipbtn cs-mono', type: 'button', title: 'Put it in the box', onclick: () => { input.value = x.includes('<') ? x.slice(0, x.indexOf('<')) : x; input.focus(); } }, x)));
  }).catch(() => {});
  return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cmd-title' },
    h('div', {}, h('strong', { id: 'cmd-title' }, 'Commands'),
      h('p', { class: 'cs-soft cs-small' }, 'The same box as the overlay on your desktop. A sentence goes to the project’s chat; allow 1 answers what waits.')),
    input, examples, reply);
}

export async function mount(el) {
  const desk = h('div', { class: 'cs-card cs-row cs-row--wrap' }, h('span', { class: 'cs-soft cs-small' }, 'Checking the desktop...'));
  const boardEl = h('div', {});
  el.append(h('div', { class: 'cs-stack cs-stack--loose' },
    h('header', {}, h('h1', { class: 'cs-h1', id: 'main-title' }, 'Widgets'),
      h('p', { class: 'cs-soft' }, 'Tiles for your desktop, like phone widgets: agents, spending, a workflow, what waits for you.')),
    desk, commands(), boardEl));

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
    const locked = (await api.settings().catch(() => null))?.settings?.widgetsLocked === true;
    const lock = async () => {
      try { await api.saveSettings({ widgetsLocked: !locked }); toast(locked ? 'Unlocked: drag a tile to move it.' : 'Locked in place: tiles stay put; a click still opens Circle Studio.', { kind: 'ok' }); } catch (e) { toast(e.message, { kind: 'danger' }); }
      drawDesk();
    };
    desk.replaceChildren(
      h('div', { class: 'cs-grow cs-stack cs-stack--tight' },
        h('strong', {}, st.running ? `On your desktop${locked ? ', locked in place' : ''}` : 'Not on your desktop'),
        h('span', { class: 'cs-soft cs-small' }, st.running ? (locked ? 'Tiles stay where they are. Click one to open Circle Studio there; right-click for options, or switch a tile\'s project from its title.' : 'Drag a tile to move it. Click it to open Circle Studio there. Click a tile\'s title to show another project; right-click for options.') : 'Put the tiles below on your desktop. They come back whenever Circle Studio runs.'),
        st.running && st.hotkey && st.hotkey !== 'no hotkey' ? h('span', { class: 'cs-small' }, 'Press ', h('kbd', { class: 'cs-kbd' }, st.hotkey), ' anywhere to open the overlay: every tile in front, with a box to type commands (try help). Esc closes it.') : null,
        st.asking ? h('span', { class: 'cs-soft cs-small' }, 'When an agent asks something, a card pops up at the bottom right of your screen to answer there.') : null),
      st.running ? h('button', { class: 'cs-btn', type: 'button', 'aria-pressed': String(locked), title: locked ? 'Let tiles be dragged again' : 'Keep every tile where it is', onclick: lock }, icon(locked ? 'lock' : 'pin', 's'), locked ? 'Unlock' : 'Lock in place') : null,
      h('button', { class: `cs-btn ${st.running ? '' : 'cs-btn--primary'}`, type: 'button', onclick: () => toggle(!st.running) }, icon(st.running ? 'close' : 'pin', 's'), st.running ? 'Take them off' : 'Put on desktop'),
      h('button', { class: 'cs-btn cs-btn--quiet', type: 'button', title: 'The same tiles in a small window of their own', onclick: () => api.openWindow('widget').catch((e) => toast(e.message, { kind: 'danger' })) }, icon('external', 's'), 'Own window'));
  }

  drawDesk();
  const board = mountBoard(boardEl, { openApp: (hash) => { location.hash = hash; }, embedded: true });
  return { destroy: () => { board.then((b) => b?.destroy()).catch(() => {}); } };
}
