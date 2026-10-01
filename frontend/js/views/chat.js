// Chat with an engine, inside the project folder. Every command and edit the agent wants asks you first (a popup, kept
// in the Inbox). The same component serves the project's chat tab and each graph node's chat.
import { api } from '../api.js';
import { h, icon, fmtBytes } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { confirmDialog, toast } from '../components/overlay.js';
import { engineName, openRequest } from '../components/requests.js';
import { pref, setPref, state } from '../state.js';

const MODELS = { claude: ['haiku', 'sonnet', 'opus'] };

/** A short, honest line about what an engine can do here. */
export function capabilityNote(info) {
  if (!info) return 'This engine is not known.';
  const c = info.capabilities;
  const bits = [];
  if (c.approvals === 'none') bits.push('It cannot ask you first, so it can only answer and read.');
  else bits.push('Every command and edit asks you first.');
  if (c.questions === 'unverified') bits.push('Questions it asks may not reach you yet.');
  if (c.liveVerified === false) bits.push('Not live-tested on this PC.');
  return bits.join(' ');
}

export function mountChat(el, { project, nodeId = null, engine: forcedEngine } = {}) {
  const key = `chat-engine:${project.id}:${nodeId || 'main'}`;
  let engine = forcedEngine || pref(key, '') || 'claude';
  let model = pref(`chat-model:${engine}`, '');
  let abort = null;
  let running = false;
  let alive = true;

  const transcript = h('div', { class: 'cs-chat__log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const input = h('textarea', { class: 'cs-textarea', rows: 3, placeholder: nodeId ? 'Talk to this agent' : 'Ask about this project, or tell it what to do', 'aria-label': 'Your message' });
  const sendBtn = h('button', { class: 'cs-btn cs-btn--primary', type: 'button' }, icon('send', 's'), 'Send');
  const stopBtn = h('button', { class: 'cs-btn', type: 'button', hidden: true }, icon('stop', 's'), 'Stop');
  const notice = h('div', { class: 'cs-stack cs-stack--tight' });
  const waiting = h('div', { class: 'cs-stack cs-stack--tight' });
  const info = h('div', { class: 'cs-banner cs-banner--info' });
  const engineSel = h('select', { class: 'cs-select cs-chat__engine', 'aria-label': 'Engine', onchange: (e) => { engine = e.target.value; setPref(key, engine); model = pref(`chat-model:${engine}`, ''); drawControls(); loadLog(); } });
  const modelSel = h('select', { class: 'cs-select cs-chat__model', 'aria-label': 'Model', onchange: (e) => { model = e.target.value; setPref(`chat-model:${engine}`, model); } });

  const infoFor = (id) => state.engines.find((e) => e.id === id);

  function drawControls() {
    const usable = state.engines.filter((e) => e.usable);
    const off = state.engines.filter((e) => !e.usable);
    if (!usable.some((e) => e.id === engine) && usable.length) { engine = usable[0].id; }
    engineSel.replaceChildren(
      ...usable.map((e) => h('option', { value: e.id, selected: e.id === engine || undefined }, e.label)),
      off.length ? h('optgroup', { label: 'Not available' }, off.map((e) => h('option', { value: e.id, disabled: true }, `${e.label} (${e.installed ? 'not signed in' : 'not installed'})`))) : null);
    engineSel.disabled = Boolean(forcedEngine);
    const list = MODELS[engine] || [];
    modelSel.replaceChildren(h('option', { value: '' }, 'Default model'), ...list.map((m) => h('option', { value: m, selected: model === m || undefined }, m)));
    modelSel.hidden = !list.length;
    const cur = infoFor(engine);
    info.replaceChildren(h('span', { class: 'cs-banner__icon' }, icon('shield', 's')), h('span', {}, `Sent to ${cur ? cur.label : engineName(engine)} through your login. ${capabilityNote(cur)}`));
  }

  function messageEl(m) {
    const who = m.role === 'user' ? 'You' : engineName(m.engine || engine);
    const box = h('article', { class: ['cs-msg', m.role === 'user' ? 'cs-msg--user' : 'cs-msg--claude'], 'aria-label': who }, h('div', { class: 'cs-eyebrow' }, who));
    if (m.role === 'user') { box.append(h('p', { class: 'cs-msg__text' }, m.text)); return box; }
    box.append(h('div', { class: 'cs-msg__tools' }), h('div', { class: 'cs-msg__body' }));
    fill(box, m);
    return box;
  }

  function fill(box, m) {
    box.querySelector('.cs-msg__tools').replaceChildren(...(m.tools || []).map((t) => h('div', { class: 'cs-tool' }, icon(t.ok === false ? 'danger' : t.ok === true ? 'check' : 'spinner', 's'), h('span', { class: 'cs-mono' }, t.summary || t.name))));
    box.querySelector('.cs-msg__body').replaceChildren(m.text ? renderMarkdown(m.text) : (m.error || m.stopped) ? '' : h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Working...'));
    box.querySelector('.cs-msg__foot')?.remove();
    const bits = [];
    if (m.error) bits.push(h('span', { class: 'cs-pill cs-pill--danger' }, icon('danger', 's'), m.error));
    if (m.stopped) bits.push(h('span', { class: 'cs-pill cs-pill--quiet' }, 'Stopped'));
    if (m.models?.length) bits.push(h('span', { class: 'cs-soft cs-small', title: 'The model the engine reports it used' }, `Answered by ${m.models.join(', ')}`));
    if (m.ms != null && m.done !== false) bits.push(h('span', { class: 'cs-soft cs-small' }, `${(m.ms / 1000).toFixed(1)} s`));
    if (m.usage?.contextPct != null) bits.push(h('span', { class: 'cs-soft cs-small' }, `Context ${m.usage.contextPct}%`));
    if (bits.length) box.append(h('div', { class: 'cs-msg__foot cs-row cs-row--wrap' }, ...bits));
  }
  const scroll = () => { transcript.scrollTop = transcript.scrollHeight; };

  function drawWaiting() {
    const mine = state.pending.filter((r) => r.projectId === project.id && (r.nodeId || null) === (nodeId || null));
    waiting.replaceChildren(...mine.map((r) => h('div', { class: 'cs-banner cs-banner--warn', role: 'status' }, h('span', { class: 'cs-banner__icon' }, icon('warning', 's')),
      h('span', { class: 'cs-grow' }, `Waiting for you: ${r.title}`), h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => openRequest(r.id) }, 'Open'))));
  }
  const onRequests = () => drawWaiting();
  window.addEventListener('circle:requests', onRequests);

  /* ---- Claude Code conversations held in the folder (terminal, IDE) ----------------------------------------------- */
  let history = null; // { conversations, agentRuns, folder }
  let viewing = null; // a conversation shown read-only in place of this chat
  const historyBtn = h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', hidden: true, onclick: () => openHistory() }, icon('clock', 's'), 'Earlier conversations');

  async function loadHistory() {
    try { history = await api.history(project.id, nodeId || ''); } catch { history = null; }
    if (!alive) return;
    const n = (history?.conversations.length || 0) + (history?.agentRuns.length || 0);
    historyBtn.hidden = !n;
    historyBtn.replaceChildren(icon('clock', 's'), `Earlier conversations (${n})`);
    const empty = transcript.querySelector('.cs-empty');
    if (empty && n) empty.append(historyList(5));
  }

  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  function historyList(max = Infinity) {
    const runs = (history?.agentRuns || []).slice(0, max);
    const convs = (history?.conversations || []).slice(0, max);
    const row = (title, sub, onclick) => h('li', {}, h('button', { class: 'cs-hist__item', type: 'button', onclick }, h('span', { class: 'cs-hist__title' }, title), h('span', { class: 'cs-soft cs-small' }, sub)));
    return h('div', { class: 'cs-hist' },
      runs.length ? h('div', { class: 'cs-eyebrow' }, 'This agent, run by Claude Code') : null,
      runs.length ? h('ul', { class: 'cs-hist__list' }, runs.map((r) => row(r.description || r.agentType, `${when(r.lastAt)} · in "${r.sessionTitle}"`, () => view({ sessionId: r.sessionId, run: r.run, title: r.description || r.agentType })))) : null,
      convs.length ? h('div', { class: 'cs-eyebrow' }, 'Your Claude Code conversations in this folder') : null,
      convs.length ? h('ul', { class: 'cs-hist__list' }, convs.map((c) => row(c.title, `${when(c.lastAt)} · ${fmtBytes(c.bytes)}`, () => view({ sessionId: c.id, title: c.title })))) : null,
      max < Infinity && (history.conversations.length > max || history.agentRuns.length > max) ? h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: () => openHistory() }, 'Show all') : null);
  }

  function openHistory() {
    viewing = null;
    transcript.replaceChildren(h('div', { class: 'cs-stack' },
      h('div', { class: 'cs-row cs-row--between' }, h('strong', {}, 'Earlier conversations'), h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => loadLog() }, icon('chevron-left', 's'), 'Back to this chat')),
      h('p', { class: 'cs-soft cs-small' }, `Read from ${history?.folder || 'Claude Code'} on this PC. Nothing is changed there.`),
      historyList()));
    transcript.scrollTop = 0;
  }

  async function view({ sessionId, run = '', title }) {
    transcript.replaceChildren(h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Reading the conversation...'));
    let c;
    try { c = await api.historyOne(project.id, sessionId, run); } catch (e) { toast(e.message, { kind: 'danger' }); loadLog(); return; }
    if (!alive) return;
    viewing = { sessionId, run };
    const canContinue = !run;
    transcript.replaceChildren(
      h('div', { class: 'cs-banner cs-banner--info cs-hist__head' }, h('span', { class: 'cs-banner__icon' }, icon('clock', 's')),
        h('span', { class: 'cs-grow' }, h('strong', {}, c.title || title), h('br'), h('span', { class: 'cs-small' }, `From Claude Code, last active ${when(c.lastAt)}. ${run ? 'A run of this agent inside a bigger conversation: read only.' : 'Read only until you continue it here.'}`)),
        canContinue ? h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button', onclick: () => continueHere(sessionId) }, icon('play', 's'), 'Continue it here') : null,
        h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => openHistory() }, 'All conversations')),
      c.earlier ? h('p', { class: 'cs-soft cs-small cs-hist__earlier' }, `${c.earlier} earlier messages are not shown.`) : null,
      ...c.messages.map((m) => (m.role === 'note' ? h('p', { class: 'cs-hist__note cs-soft cs-small' }, m.text) : messageEl(m))));
    scroll();
  }

  async function continueHere(sessionId) {
    const log = await api.chatLog(project.id, nodeId || '', nodeId ? 'claude' : '').catch(() => ({ messages: [] }));
    if (log.messages.length && !(await confirmDialog({ title: 'Continue that conversation here?', message: 'This chat starts again from that conversation. What you said here before is kept in the Inbox and the project, but this transcript is replaced.', confirmLabel: 'Continue it here' }))) return;
    try { await api.linkChat(project.id, nodeId, sessionId); } catch (e) { toast(e.message, { kind: 'danger' }); return; }
    if (engine !== 'claude' && !forcedEngine) { engine = 'claude'; setPref(key, engine); drawControls(); }
    toast('Continuing it here. Your first message makes a copy, so the original in Claude Code stays as it was.');
    viewing = null;
    loadLog();
    input.focus();
  }

  async function loadLog() {
    viewing = null;
    let log;
    try { log = await api.chatLog(project.id, nodeId || '', engine === 'claude' && !nodeId ? '' : engine); } catch { log = { messages: [] }; }
    if (!alive) return;
    transcript.replaceChildren();
    if (log.linked && engine === 'claude') {
      let before = null;
      try { before = await api.historyOne(project.id, log.linked.id); } catch { /* gone from Claude Code's folder */ }
      if (!alive) return;
      transcript.append(h('div', { class: 'cs-hist__divider', role: 'separator' }, `Continued from Claude Code: ${log.linked.title}`));
      if (before) {
        if (before.earlier) transcript.append(h('p', { class: 'cs-soft cs-small cs-hist__earlier' }, `${before.earlier} earlier messages are not shown.`));
        before.messages.forEach((m) => transcript.append(m.role === 'note' ? h('p', { class: 'cs-hist__note cs-soft cs-small' }, m.text) : messageEl(m)));
      } else transcript.append(h('p', { class: 'cs-soft cs-small' }, 'That conversation is no longer in Claude Code\'s folder; Claude still has its context.'));
      if (log.messages.length) transcript.append(h('div', { class: 'cs-hist__divider', role: 'separator' }, 'Here in Circle Studio'));
    } else if (!log.messages.length) {
      const empty = h('div', { class: 'cs-empty' }, icon('chat', 'l'), h('div', { class: 'cs-empty__title' }, nodeId ? 'Talk to this agent' : 'Ask, or tell it what to do'), h('p', {}, 'It works in the project folder. Anything it wants to run or change asks you first.'));
      if (history && (history.conversations.length || history.agentRuns.length)) empty.append(historyList(5));
      transcript.append(empty);
    }
    log.messages.forEach((m) => transcript.append(messageEl(m)));
    scroll();
  }

  async function send() {
    const text = input.value.trim();
    if (!text || running) return;
    if (viewing) await loadLog();
    const cur = infoFor(engine);
    if (!cur?.usable) { toast(`${cur ? cur.label : engineName(engine)} is not available. Check Settings.`, { kind: 'warn' }); return; }
    running = true;
    sendBtn.disabled = true;
    stopBtn.hidden = false;
    notice.replaceChildren();
    transcript.querySelector('.cs-empty')?.remove();
    input.value = '';
    transcript.append(messageEl({ role: 'user', text }));
    const reply = { role: 'assistant', text: '', tools: [], engine };
    const rel = messageEl(reply);
    transcript.append(rel);
    scroll();
    abort = new AbortController();
    let raf = 0;
    const paint = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fill(rel, reply); scroll(); }); };
    try {
      await api.chat({ projectId: project.id, nodeId: nodeId || undefined, engine, model: model || undefined, message: text }, (name, d) => {
        if (name === 'text') reply.text += d.delta;
        else if (name === 'tool') {
          let t = reply.tools.find((x) => x.id === d.id);
          if (!t) { t = { id: d.id, name: d.name, summary: d.name, ok: null }; reply.tools.push(t); }
          if (d.summary) t.summary = d.summary;
          if (d.status === 'end') t.ok = d.ok;
        } else if (name === 'usage') reply.usage = d;
        else if (name === 'notice') notice.append(h('div', { class: 'cs-banner cs-banner--info' }, icon('info', 's'), h('span', {}, d.message)));
        else if (name === 'done') { reply.models = d.models; reply.ms = d.ms; }
        else if (name === 'error') reply.error = d.message;
        else if (name === 'stopped') reply.stopped = true;
        paint();
      }, abort.signal);
    } catch (e) {
      reply.error = e.message;
    } finally {
      running = false;
      abort = null;
      sendBtn.disabled = false;
      stopBtn.hidden = true;
      cancelAnimationFrame(raf);
      fill(rel, reply);
      scroll();
      if (alive) input.focus();
    }
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', async () => { abort?.abort(); try { await api.stopChat(project.id, nodeId || undefined); } catch { /* already gone */ } });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });

  const newBtn = h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: async () => {
    if (running) return;
    if (!(await confirmDialog({ title: 'Start a new conversation?', message: 'The stored transcript is deleted and the agent forgets the earlier context.', confirmLabel: 'Start over', danger: true }))) return;
    await api.resetChat(project.id, nodeId || '', engine === 'claude' && !nodeId ? '' : engine);
    loadLog();
  } }, icon('refresh', 's'), 'New conversation');

  el.append(h('div', { class: 'cs-chat' },
    h('div', { class: 'cs-row cs-row--wrap cs-row--between' }, h('h2', { class: 'cs-h2' }, 'Chat'), h('div', { class: 'cs-row cs-row--wrap' }, historyBtn, engineSel, modelSel, newBtn)),
    info, notice, transcript, waiting,
    h('div', { class: 'cs-card cs-stack cs-stack--tight' }, input,
      h('div', { class: 'cs-row cs-row--wrap' }, h('span', { class: 'cs-grow' }), h('span', { class: 'cs-soft cs-small' }, h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Enter')), stopBtn, sendBtn))));

  drawControls();
  drawWaiting();
  loadLog();
  loadHistory();
  // Leaving the view must not stop the run: a question it asked stays in the Inbox to be answered from there, and
  // aborting the stream here would expire it. The stream is still read in the background; the server saves the reply.
  // Stop is the Stop button; closing the whole app window ends the stream and the server expires what was pending.
  return { destroy() { alive = false; window.removeEventListener('circle:requests', onRequests); } };
}

/** The project's Chat tab. */
export async function mount(el, pctx) {
  if (!state.engines.length) {
    // The first look at the engines on a cold start runs each CLI once (a few seconds): say so instead of a blank page.
    const wait = h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Checking which engines are installed and signed in...');
    el.append(wait);
    try { state.engines = (await api.engines()).engines; } catch { /* the chat says so */ }
    wait.remove();
  }
  return mountChat(el, { project: pctx.project });
}
