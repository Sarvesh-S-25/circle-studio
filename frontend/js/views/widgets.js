// Widgets: the tiles you keep on your desktop (agents, spending, a workflow, what waits for you). Choose and arrange
// them here, and put them on the desktop or take them off. The same board also opens in its own small window.
import { api } from '../api.js';
import { h, icon } from '../dom.js';
import { toast, openModal } from '../components/overlay.js';
import { mountBoard } from '../components/board.js';

// The overlay's chat bar, here too: a message goes to the project's chat (every word); a line starting with / is a
// command (/usage, /status, /allow 1, /help).
function commands() {
  let projectId = null;
  const reply = h('div', { class: 'cs-stack cs-stack--tight', 'aria-live': 'polite' });
  const input = h('input', { class: 'cs-input cs-mono', type: 'text', 'aria-label': 'Command', placeholder: 'Message Claude in your project, or / for commands (/help lists them)', autocomplete: 'off' });
  const run = async (text) => {
    if (!text.trim()) return;
    reply.replaceChildren(h('span', { class: 'cs-soft cs-small' }, 'Working...'));
    try {
      const r = await api.overlayCommand(text, projectId, 'bar');
      projectId = r.projectId || projectId;
      const tone = { ok: 'cs-st--done', warn: 'cs-st--waiting', danger: 'cs-st--danger' }[r.say.tone] || '';
      if (!r.say) { reply.replaceChildren(h('span', { class: 'cs-small cs-st--done' }, 'Sent. The answer shows in the project\'s Chat, and as a notification when it is done.')); return; }
      reply.replaceChildren(h('strong', { class: tone }, r.say.title), ...r.say.lines.map((l) => h('span', { class: `cs-small cs-soft ${/^\/(help|\?)/.test(text.trim()) ? 'cs-mono cs-cmdhelp' : ''}` }, l)));
      if (r.open) location.hash = r.open;
      else if (r.chatWindow) location.hash = `#/projects/${encodeURIComponent(r.chatWindow)}/chat`;
    } catch (e) { reply.replaceChildren(h('strong', { class: 'cs-st--danger' }, e.message)); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const t = input.value; input.value = ''; run(t); } });
  api.overlay().then((f) => { projectId = f.project?.id || null; }).catch(() => {});
  return h('section', { class: 'cs-card cs-stack', 'aria-labelledby': 'cmd-title' },
    h('div', {}, h('strong', { id: 'cmd-title' }, 'Quick chat'),
      h('p', { class: 'cs-soft cs-small' }, 'The same bar as Ctrl+Alt+C on your desktop: what you type goes to your project\'s chat. Start with / for a command, like /usage.')),
    input, reply);
}

// Limits from your terminal too: Claude Code gives your status line the plan's use; a small tap keeps it for the
// Limits tile and then runs your own status line unchanged. Shown before it is changed, backed up, off in one click.
function limitsCard() {
  const card = h('section', { class: 'cs-card cs-row cs-row--wrap', 'aria-labelledby': 'lim-title' }, h('span', { class: 'cs-soft cs-small' }, 'Checking your limits...'));
  const draw = async () => {
    let r;
    try { r = await api.limits(); } catch (e) { card.replaceChildren(h('span', { class: 'cs-soft cs-small' }, e.message)); return; }
    const t = r.tap;
    if (r.engine !== 'claude') {
      card.replaceChildren(h('div', { class: 'cs-grow cs-stack cs-stack--tight' }, h('strong', { id: 'lim-title' }, `${r.engine} account limits`), h('p', { class: 'cs-soft cs-small' }, r.limits?.error || 'Account windows are shown in the Limits tile. Context capacity and account quotas are separate.')), h('button', { class: 'cs-btn', onclick: async () => { try { await api.limits(r.engine, true); await draw(); } catch (error) { toast(error.message, { kind: 'danger' }); } } }, 'Refresh account limits'));
      return;
    }
    const set = async (on) => {
      if (on) {
        const ok = await new Promise((resolve) => openModal({
          title: 'Read your limits from your terminal too?',
          body: h('div', { class: 'cs-stack' },
            h('p', {}, 'Claude Code tells its status line how much of your 5-hour window and week is used. Circle Studio puts a small step in front of your status line that keeps that number, then runs your own status line exactly as before.'),
            h('p', { class: 'cs-soft cs-small' }, 'In your Claude Code settings (~/.claude/settings.json), the status line changes from:'),
            h('pre', { class: 'cs-cmd' }, t.before || '(none)'),
            h('p', { class: 'cs-soft cs-small' }, 'to:'),
            h('pre', { class: 'cs-cmd' }, t.after || ''),
            h('p', { class: 'cs-soft cs-small' }, 'A copy of the file is kept first. Turn it off here any time: your own status line goes back.')),
          actions: [{ label: 'Cancel', kind: 'quiet', onClick: (c) => c.close(false) }, { label: 'Turn on', kind: 'primary', onClick: (c) => c.close(true) }],
          onClose: (v) => resolve(v === true),
        }));
        if (!ok) return;
      }
      try { await api.setLimitsTap(on); toast(on ? 'On. Your limits update with each Claude Code answer in your terminal.' : 'Off. Your own status line is back.', { kind: 'ok' }); } catch (e) { toast(e.message, { kind: 'danger' }); }
      draw();
    };
    card.replaceChildren(
      h('div', { class: 'cs-grow cs-stack cs-stack--tight' },
        h('strong', { id: 'lim-title' }, t.on ? 'Limits: from your terminal too' : 'Limits'),
        h('span', { class: 'cs-soft cs-small' }, t.on
          ? 'Your 5-hour and weekly use update with every Claude answer, here and in your terminal. Add the Limits tile below to see them.'
          : 'Your 5-hour and weekly use update when Claude answers in Circle Studio. Turn this on to update them from your terminal too.'),
        !t.on && !t.canTap && t.why ? h('span', { class: 'cs-small cs-st--waiting' }, t.why) : null),
      t.on || t.canTap ? h('button', { class: `cs-btn ${t.on ? '' : 'cs-btn--primary'}`, type: 'button', onclick: () => set(!t.on) }, icon(t.on ? 'close' : 'clock', 's'), t.on ? 'Turn off' : 'From your terminal too') : null);
  };
  draw();
  return card;
}

export async function mount(el) {
  const desk = h('div', { class: 'cs-card cs-row cs-row--wrap' }, h('span', { class: 'cs-soft cs-small' }, 'Checking the desktop...'));
  const boardEl = h('div', {});
  el.append(h('div', { class: 'cs-stack cs-stack--loose' },
    h('header', {}, h('h1', { class: 'cs-h1', id: 'main-title' }, 'Widgets'),
      h('p', { class: 'cs-soft' }, 'Tiles for your desktop, like phone widgets: agents, spending, a workflow, what waits for you.')),
    desk, limitsCard(), commands(), boardEl));

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
        st.running && st.hotkey && st.hotkey !== 'no hotkey' ? h('span', { class: 'cs-small' }, 'Press ', h('kbd', { class: 'cs-kbd' }, st.hotkey), ' anywhere to open the overlay: panels you can drag, a project switcher and a box to type commands (try help). Esc closes it.') : null,
        st.asking ? h('span', { class: 'cs-soft cs-small' }, 'When an agent asks something, a card pops up at the bottom right of your screen to answer there.') : null),
      st.running ? h('button', { class: 'cs-btn', type: 'button', 'aria-pressed': String(locked), title: locked ? 'Let tiles be dragged again' : 'Keep every tile where it is', onclick: lock }, icon(locked ? 'lock' : 'pin', 's'), locked ? 'Unlock' : 'Lock in place') : null,
      h('button', { class: `cs-btn ${st.running ? '' : 'cs-btn--primary'}`, type: 'button', onclick: () => toggle(!st.running) }, icon(st.running ? 'close' : 'pin', 's'), st.running ? 'Take them off' : 'Put on desktop'),
      h('button', { class: 'cs-btn cs-btn--quiet', type: 'button', title: 'The same tiles in a small window of their own', onclick: () => api.openWindow('widget').catch((e) => toast(e.message, { kind: 'danger' })) }, icon('external', 's'), 'Own window'));
  }

  drawDesk();
  const board = mountBoard(boardEl, { openApp: (hash) => { location.hash = hash; }, embedded: true });
  return { destroy: () => { board.then((b) => b?.destroy()).catch(() => {}); } };
}
