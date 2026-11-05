// Chat with an engine, inside the project folder. Every command and edit the agent wants asks you first (a popup, kept
// in the Inbox). The same component serves the project's chat tab and each graph node's chat.
import { api } from '../api.js';
import { h, icon, fmtBytes } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { confirmDialog, toast } from '../components/overlay.js';
import { engineName, openRequest } from '../components/requests.js';
import { pref, setPref, state } from '../state.js';
import { reviewHandoff } from '../components/handoff.js';

const MODELS = { claude: ['haiku', 'sonnet', 'opus'] };

/** A short, honest line about what an engine can do here. */
export function capabilityNote(info) {
  if (!info) return 'This engine is not known.';
  const c = info.capabilities;
  const bits = [];
  if (c.approvals === 'none') bits.push('It cannot ask you first, so it can only answer and read.');
  else if (c.approvalCoverage === 'engine') bits.push('Circle relays the requests this engine raises; its own policies can allow operations without a card.');
  else bits.push('Every command and edit asks you first.');
  if (c.questions === 'unverified') bits.push('Questions it asks may not reach you yet.');
  if (c.liveVerified === false) bits.push('Not live-tested on this PC.');
  else if (c.liveEvidence) bits.push(`Temporary-folder checks recorded for ${c.liveEvidence.version}; unlisted scenarios remain unverified.`);
  return bits.join(' ');
}

export function mountChat(el, { project, nodeId = null, engine: forcedEngine, model: initialModel, reasoning: initialReasoning, conversationId: requestedConversation } = {}) {
  const key = `chat-engine:${project.id}:${nodeId || 'main'}`;
  let engine = forcedEngine || pref(key, '') || state.preferredEngine || state.engines.find((e) => e.usable)?.id || 'claude';
  let model = initialModel !== undefined ? initialModel || '' : pref(`chat-model:${engine}`, '');
  if (initialReasoning !== undefined) setPref(`chat-reasoning:${engine}:${model || 'default'}`, initialReasoning || '');
  let reasoning = '';
  let abort = null;
  let running = false;
  let alive = true;
  let conversationId = 'active';
  let logGeneration = 0;

  const transcript = h('div', { class: 'cs-chat__log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const input = h('textarea', { class: 'cs-textarea', rows: 3, placeholder: `${nodeId ? 'Talk to this agent' : 'Ask about this project, or tell it what to do'}. Type /help for Circle Studio's commands`, 'aria-label': 'Your message' });
  const draftKey = () => `draft:${project.id}:${nodeId || 'main'}:${engine}:${conversationId}`;
  function saveDraft() { setPref(draftKey(), input.value); }
  function restoreDraft() { input.value = pref(draftKey(), ''); }
  input.addEventListener('input', saveDraft);
  restoreDraft();
  // a message another screen prepared (Mods: "Make a mod with Claude"): put in the box for you to read and send
  if (!nodeId) {
    let ready = null;
    try { ready = sessionStorage.getItem(`circle:prefill:${project.id}`); sessionStorage.removeItem(`circle:prefill:${project.id}`); } catch { /* storage off */ }
    if (ready) { input.value = ready; input.rows = 8; requestAnimationFrame(() => input.focus()); }
  }
  const sendBtn = h('button', { class: 'cs-btn cs-btn--primary', type: 'button' }, icon('send', 's'), 'Send');
  const stopBtn = h('button', { class: 'cs-btn', type: 'button', hidden: true }, icon('stop', 's'), 'Stop');
  const notice = h('div', { class: 'cs-stack cs-stack--tight' });
  const queueBox = h('div', { class: 'cs-stack cs-stack--tight', 'aria-live': 'polite' });
  async function loadQueue() {
    if (!alive || document.hidden) return;
    try {
      const { entries } = await api.chatQueue(project.id, nodeId || '');
      if (!alive) return;
      queueBox.replaceChildren(...entries.filter((e) => ['queued', 'paused', 'interrupted', 'error'].includes(e.status)).map((entry) => {
        const editable = ['queued', 'paused'].includes(entry.status);
        const text = h('input', { class: 'cs-input', value: entry.message, 'aria-label': `Queued message to ${engineName(entry.engineId)}`, readonly: !editable });
        const change = async (action) => { try { await api.queueChat({ id: entry.id, action, message: text.value }); await loadQueue(); } catch (error) { toast(error.message, { kind: 'danger' }); } };
        return h('div', { class: 'cs-card cs-stack cs-stack--tight' }, h('p', { class: 'cs-soft cs-small' }, `${entry.status} · ${engineName(entry.engineId)}${entry.model ? ` · ${entry.model}` : ''}${entry.error ? ` · ${entry.error}` : ''}`), text, h('div', { class: 'cs-row' }, editable ? h('button', { class: 'cs-btn cs-btn--small', onclick: () => change('edit') }, 'Save edit') : null, editable ? h('button', { class: 'cs-btn cs-btn--small', onclick: () => change('cancel') }, 'Remove') : null, editable ? h('button', { class: 'cs-btn cs-btn--small', onclick: () => change('up') }, 'Move up') : null, editable ? h('button', { class: 'cs-btn cs-btn--small', onclick: () => change('down') }, 'Move down') : null, entry.status === 'paused' ? h('button', { class: 'cs-btn cs-btn--small', onclick: () => change('resume') }, 'Resume queue') : null, !editable ? h('button', { class: 'cs-btn cs-btn--small', onclick: () => { input.value = entry.message; saveDraft(); input.focus(); } }, 'Copy to draft') : null));
      }));
    } catch { /* keep the last queue visible while temporarily disconnected */ }
  }
  const waiting = h('div', { class: 'cs-stack cs-stack--tight' });
  const info = h('div', { class: 'cs-banner cs-banner--info' });
  const persistSelection = () => api.selectChat(project.id, engine, nodeId || null, model || null, reasoning || null).catch((error) => toast(error.message, { kind: 'danger' }));
  const engineSel = h('select', { class: 'cs-select cs-chat__engine', 'aria-label': 'Engine', onchange: (e) => { saveDraft(); engine = e.target.value; conversationId = 'active'; setPref(key, engine); model = pref(`chat-model:${engine}`, ''); restoreDraft(); drawControls(); void persistSelection(); loadLog(); loadHistory(); } });
  const modelSel = h('select', { class: 'cs-select cs-chat__model', 'aria-label': 'Model', onchange: (e) => { model = e.target.value; setPref(`chat-model:${engine}`, model); drawControls(); void persistSelection(); } });
  const reasoningSel = h('select', { class: 'cs-select', 'aria-label': 'Reasoning effort', onchange: (e) => { reasoning = e.target.value; setPref(`chat-reasoning:${engine}:${model || 'default'}`, reasoning); void persistSelection(); } });

  const infoFor = (id) => state.engines.find((e) => e.id === id);

  function drawControls() {
    const usable = state.engines.filter((e) => e.usable);
    const off = state.engines.filter((e) => !e.usable);
    engineSel.replaceChildren(
      ...usable.map((e) => h('option', { value: e.id, selected: e.id === engine || undefined }, e.label)),
      off.length ? h('optgroup', { label: 'Not available' }, off.map((e) => h('option', { value: e.id, disabled: true, selected: e.id === engine || undefined }, `${e.label} (${e.installed ? 'not signed in' : 'not installed'})`))) : null);
    engineSel.disabled = Boolean(forcedEngine) || running || Boolean(elsewhere);
    modelSel.disabled = running || Boolean(elsewhere);
    const list = infoFor(engine)?.models || MODELS[engine] || [];
    const shownModels = model && !list.includes(model) ? [...list, model] : list;
    modelSel.replaceChildren(h('option', { value: '' }, 'Default model'), ...shownModels.map((m) => h('option', { value: m, selected: model === m || undefined }, list.includes(m) ? m : `${m} (not advertised)`)));
    modelSel.hidden = !shownModels.length;
    const cur = infoFor(engine);
    const catalogModel = cur?.modelCatalog?.find((m) => model ? m.id === model : m.isDefault);
    const efforts = catalogModel?.reasoning || [];
    reasoning = pref(`chat-reasoning:${engine}:${model || 'default'}`, '');
    if (!efforts.includes(reasoning)) reasoning = '';
    reasoningSel.hidden = !efforts.length; reasoningSel.disabled = running || Boolean(elsewhere);
    reasoningSel.replaceChildren(h('option', { value: '' }, 'Default reasoning'), ...efforts.map((e) => h('option', { value: e, selected: e === reasoning || undefined }, e)));
    info.replaceChildren(h('span', { class: 'cs-banner__icon' }, icon('shield', 's')), h('span', { class: 'cs-grow' },
      `${cur ? cur.label : engineName(engine)}${cur?.version ? ` ${cur.version}` : ''} working in `, h('span', { class: 'cs-mono', title: project.path || '' }, project.path || project.name), `, through your login. ${capabilityNote(cur)}`));
  }

  function messageEl(m) {
    const who = m.role === 'user' ? 'You' : engineName(m.engine || engine);
    const box = h('article', { class: ['cs-msg', m.role === 'user' ? 'cs-msg--user' : 'cs-msg--claude'], 'aria-label': who }, h('div', { class: 'cs-eyebrow' }, who));
    if (m.role === 'user') { box.append(h('p', { class: 'cs-msg__text' }, m.text)); return box; }
    box.append(h('div', { class: 'cs-msg__tools' }), h('div', { class: 'cs-msg__body' }));
    fill(box, m);
    return box;
  }

  const renderStates = new WeakMap();
  function fill(box, m) {
    const previous = renderStates.get(box);
    const toolState = (m.tools || []).map((t) => ({ ...t }));
    const sameTools = previous?.tools.length === toolState.length && toolState.every((t, i) => ['id', 'name', 'summary', 'ok', 'output'].every((k) => previous.tools[i][k] === t[k]));
    if (!sameTools) box.querySelector('.cs-msg__tools').replaceChildren(...toolState.map((t) => h('div', { class: 'cs-tool' }, icon(t.ok === false ? 'danger' : t.ok === true ? 'check' : 'spinner', 's'), h('span', { class: 'cs-mono' }, t.summary || t.name), t.output ? h('details', {}, h('summary', {}, 'Command output'), h('pre', {}, t.output)) : null)));
    if (!previous || previous.text !== m.text || previous.error !== m.error || previous.stopped !== m.stopped || previous.waiting !== m.waiting) box.querySelector('.cs-msg__body').replaceChildren(m.text ? renderMarkdown(m.text) : (m.error || m.stopped) ? '' : h('div', { class: 'cs-loading' }, icon(m.waiting ? 'warning' : 'spinner', 'm'), m.waiting ? 'Waiting for you: see below' : 'Working...'));
    renderStates.set(box, { tools: toolState, text: m.text, error: m.error, stopped: m.stopped, waiting: m.waiting });
    box.querySelector('.cs-msg__foot')?.remove();
    const bits = [];
    if (m.error) bits.push(h('span', { class: 'cs-pill cs-pill--danger' }, icon('danger', 's'), m.error));
    if (m.stopped) bits.push(h('span', { class: 'cs-pill cs-pill--quiet' }, 'Stopped'));
    if (m.models?.length) bits.push(h('span', { class: 'cs-soft cs-small', title: 'The model the engine reports it used' }, `Answered by ${m.models.join(', ')}`));
    if (m.ms != null && m.done !== false) bits.push(h('span', { class: 'cs-soft cs-small' }, `${(m.ms / 1000).toFixed(1)} s`));
    if (m.usage?.contextPct != null) bits.push(h('span', { class: 'cs-soft cs-small' }, `Context ${m.usage.contextPct}%`));
    if (bits.length) box.append(h('div', { class: 'cs-msg__foot cs-row cs-row--wrap' }, ...bits));
  }
  let following = true;
  const jump = h('button', { class: 'cs-btn cs-btn--small', hidden: true, onclick: () => { following = true; transcript.scrollTop = transcript.scrollHeight; jump.hidden = true; } }, 'Jump to latest');
  transcript.addEventListener('scroll', () => { following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 60; if (following) jump.hidden = true; });
  const scroll = (force = false) => { if (following || force) transcript.scrollTop = transcript.scrollHeight; else jump.hidden = false; };

  function drawWaiting() {
    const mine = state.pending.filter((r) => r.projectId === project.id && (r.nodeId || null) === (nodeId || null));
    waiting.replaceChildren(...mine.map((r) => h('div', { class: 'cs-banner cs-banner--warn', role: 'status' }, h('span', { class: 'cs-banner__icon' }, icon('warning', 's')),
      h('span', { class: 'cs-grow' }, `Waiting for you: ${r.title}`), h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => openRequest(r.id) }, 'Open'))));
  }
  const onRequests = () => drawWaiting();
  window.addEventListener('circle:requests', onRequests);

  /* ---- a turn in this chat started somewhere else (the overlay, a desktop card, another window): shown live ---- */
  let elsewhere = null; // { user, box, reply }
  let liveBusy = false;
  const mineEv = (d) => d && d.projectId === project.id && (d.nodeId || null) === (nodeId || null);
  async function followLive() {
    if (running || viewing || liveBusy || !alive) return;
    liveBusy = true;
    let t = null;
    try { t = (await api.chatLive(project.id, nodeId || '')).turn; } catch { /* the next event tries again */ }
    liveBusy = false;
    if (!alive || running || viewing) return;
    if (t && (t.engine !== engine || (t.conversationId && conversationId !== 'active' && t.conversationId !== conversationId))) return;
    if (!t) {
      // it ended: finish its answer in place from the saved chat (what you typed here stays on the page)
      if (!elsewhere) return;
      const done = elsewhere;
      elsewhere = null;
      const log = await api.chatLog(project.id, nodeId || '', done.reply.engine === 'claude' && !nodeId ? '' : done.reply.engine).catch(() => null);
      const last = [...(log?.messages || [])].reverse().find((m) => m.role === 'assistant');
      Object.assign(done.reply, last || {}, { waiting: false });
      ourSession = log?.sessionId || ourSession;
      lastOwnAt = last?.at || lastOwnAt;
      if (!last && !done.reply.text) done.reply.stopped = true;
      fill(done.box, done.reply);
      scroll();
      setTimeout(sendQueued, 0);
      return;
    }
    if (!elsewhere || elsewhere.runId !== t.runId) {
      transcript.querySelector('.cs-empty')?.remove();
      const reply = { role: 'assistant', text: '', tools: [], engine: t.engine };
      const note = h('p', { class: 'cs-soft cs-small cs-chat__elsewhere' }, 'Sent from outside this window (the overlay, a desktop card or another window). It shows here as it happens.');
      const user = messageEl({ role: 'user', text: t.you });
      const box = messageEl(reply);
      transcript.append(note, user, box);
      elsewhere = { runId: t.runId, reply, box };
    }
    Object.assign(elsewhere.reply, { text: t.text, tools: t.tools, waiting: t.waiting.length > 0 });
    fill(elsewhere.box, elsewhere.reply);
    scroll();
  }
  const onLive = (e) => { if (mineEv(e.detail)) followLive(); };
  window.addEventListener('circle:progress', onLive);
  window.addEventListener('circle:run', onLive);

  /* ---- Claude Code conversations held in the folder (terminal, IDE) ----------------------------------------------- */
  let history = null; // { conversations, agentRuns, folder }
  let historySource = '';
  let historyArchived = false;
  let historyGeneration = 0;
  let viewing = null; // a conversation shown read-only in place of this chat
  const historyBtn = h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', hidden: true, onclick: () => openHistory() }, icon('clock', 's'), 'Earlier conversations');

  async function loadHistory() {
    const generation = ++historyGeneration;
    let result;
    try { result = await api.history(project.id, nodeId || '', engine, { source: historySource, archived: historyArchived }); } catch { result = null; }
    if (generation !== historyGeneration) return;
    history = result;
    if (!alive) return;
    const n = (history?.conversations.length || 0) + (history?.agentRuns.length || 0);
    historyBtn.hidden = false;
    historyBtn.replaceChildren(icon('clock', 's'), `Earlier conversations (${n})`);
    const empty = transcript.querySelector('.cs-empty');
    if (empty && n) { empty.querySelector('.cs-chat__suggestions')?.remove(); empty.append(h('div', { class: 'cs-chat__suggestions' }, ...carryOnLatest(), historyList(5))); }
  }

  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  function historyList(max = Infinity) {
    const runs = (history?.agentRuns || []).slice(0, max);
    const convs = (history?.conversations || []).slice(0, max);
    const row = (title, sub, onclick) => h('li', {}, h('button', { class: 'cs-hist__item', type: 'button', onclick }, h('span', { class: 'cs-hist__title' }, title), h('span', { class: 'cs-soft cs-small' }, sub)));
    return h('div', { class: 'cs-hist' },
      runs.length ? h('div', { class: 'cs-eyebrow' }, 'This agent, run by Claude Code') : null,
      runs.length ? h('ul', { class: 'cs-hist__list' }, runs.map((r) => row(r.description || r.agentType, `${when(r.lastAt)} · in "${r.sessionTitle}"`, () => view({ sessionId: r.sessionId, run: r.run, title: r.description || r.agentType })))) : null,
      convs.length ? h('div', { class: 'cs-eyebrow' }, `${engineName(engine)} conversations in this folder`) : null,
      convs.length ? h('ul', { class: 'cs-hist__list' }, convs.map((c) => row(c.title, `${when(c.lastAt)} · ${c.source === 'circle' ? 'Saved in Circle' : engineName(engine)}${c.bytes ? ` · ${fmtBytes(c.bytes)}` : ''}`, () => view({ sessionId: c.id, title: c.title, source: c.source || '' })))) : null,
      max < Infinity && (history.conversations.length > max || history.agentRuns.length > max) ? h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: () => openHistory() }, 'Show all') : null);
  }

  // the newest conversation in this folder, one click to carry on (the main chat only; an agent's chat starts fresh)
  function carryOnLatest() {
    const c = !nodeId && history?.conversations[0];
    return c ? [h('button', { class: 'cs-btn cs-btn--primary', type: 'button', onclick: () => continueHere(c.id, c.source || '') }, icon('play', 's'), `Carry on "${c.title}"`)] : [];
  }

  function openHistory() {
    viewing = null;
    transcript.replaceChildren(h('div', { class: 'cs-stack' },
      h('div', { class: 'cs-row cs-row--between' }, h('strong', {}, 'Earlier conversations'), h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => loadLog() }, icon('chevron-left', 's'), 'Back to this chat')),
      h('div', { class: 'cs-row cs-row--wrap' }, h('button', { class: 'cs-btn cs-btn--small', onclick: async () => { historySource = ''; historyArchived = false; await loadHistory(); openHistory(); } }, 'Provider history'), h('button', { class: 'cs-btn cs-btn--small', onclick: async () => { historySource = 'circle'; historyArchived = false; await loadHistory(); openHistory(); } }, 'Saved in Circle'), h('button', { class: 'cs-btn cs-btn--small', onclick: async () => { historySource = 'circle'; historyArchived = true; await loadHistory(); openHistory(); } }, 'Archived in Circle')),
      h('input', { class: 'cs-input', type: 'search', 'aria-label': 'Search loaded conversations', placeholder: 'Search loaded conversations', oninput: (e) => { for (const li of transcript.querySelectorAll('.cs-hist__list li')) li.hidden = !li.textContent.toLowerCase().includes(e.target.value.toLowerCase()); } }),
      h('p', { class: 'cs-soft cs-small' }, history?.historyError || `Read from ${history?.folder || engineName(engine)} on this PC.`),
      historyList(),
      history?.nextOffset != null || history?.nextCursor ? h('button', { class: 'cs-btn', onclick: async () => { const more = await api.history(project.id, nodeId || '', engine, { source: historySource, archived: historyArchived, offset: history.nextOffset ?? history.total ?? 0, cursor: history.nextCursor }); const ids = new Set(history.conversations.map((c) => `${c.source}:${c.id}`)); history = { ...more, conversations: [...history.conversations, ...more.conversations.filter((c) => !ids.has(`${c.source}:${c.id}`))] }; openHistory(); } }, 'Load more conversations') : null));
    transcript.scrollTop = 0;
  }

  // live: a conversation Claude Code is working on in your terminal or IDE right now, shown as it goes
  async function view({ sessionId, run = '', title, live = false, source = '' }) {
    const quiet = live && viewing?.live && viewing.sessionId === sessionId; // a refresh: no "Reading..." flash
    const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    if (!quiet) transcript.replaceChildren(h('div', { class: 'cs-loading' }, icon('spinner', 'm'), 'Reading the conversation...'));
    let c;
    try { c = await api.historyOne(project.id, sessionId, run, { engine, source, nodeId: nodeId || '' }); } catch (e) { if (!quiet) { toast(e.message, { kind: 'danger' }); loadLog(); } return; }
    if (!alive) return;
    viewing = { sessionId, run, live, source, title: c.title || title };
    const canContinue = !run;
    const note = live
      ? 'Claude is working on this in your terminal or editor. It shows here as it goes. Write below to carry it on here (the original stays as it was).'
      : `From ${source === 'circle' ? 'Circle Studio' : engineName(engine)}, last active ${when(c.lastAt)}. ${run ? 'A run of this agent inside a bigger conversation: read only.' : 'Read only until you continue it here.'}`;
    transcript.replaceChildren(
      h('div', { class: `cs-banner ${live ? 'cs-banner--ok' : 'cs-banner--info'} cs-hist__head` }, h('span', { class: 'cs-banner__icon' }, icon(live ? 'play' : 'clock', 's')),
        h('span', { class: 'cs-grow' }, h('strong', {}, live ? `Live: ${c.title || title}` : c.title || title), h('br'), h('span', { class: 'cs-small' }, note)),
        canContinue && !live ? h('button', { class: 'cs-btn cs-btn--primary cs-btn--small', type: 'button', onclick: () => continueHere(sessionId, source) }, icon('play', 's'), 'Continue it here') : null,
        canContinue && !live && ['claude', 'codex'].includes(engine) && (source !== 'circle' || c.sessionId) ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => continueHere(sessionId, source, true) }, 'Continue as a copy') : null,
        source === 'circle' && !historyArchived ? h('button', { class: 'cs-btn cs-btn--small', onclick: async () => { try { await api.archiveChat(project.id, sessionId, engine, nodeId || ''); await loadHistory(); openHistory(); } catch (error) { toast(error.message, { kind: 'danger' }); } } }, 'Archive') : null,
        source === 'circle' ? h('button', { class: 'cs-btn cs-btn--small', onclick: async () => {
          try {
            const messages = []; let offset = 0;
            do { const page = await api.historyOne(project.id, sessionId, '', { engine, source, nodeId: nodeId || '', offset }); messages.push(...page.messages); offset = page.nextOffset; if (messages.length > 100000) throw new Error('This conversation is too large for browser export. Use the data-folder backup.'); } while (offset != null);
            const url = URL.createObjectURL(new Blob([JSON.stringify({ schema: 'circle-conversation/1', engine, title: c.title, messages }, null, 2)], { type: 'application/json' }));
            const a = h('a', { href: url, download: `circle-conversation-${sessionId}.json` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (error) { toast(error.message, { kind: 'danger' }); }
        } }, 'Export conversation') : null,
        live ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', title: 'Bring the terminal or editor it runs in to the front', onclick: () => terminal('show') }, icon('terminal', 's'), 'Show that terminal') : null,
        live ? h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => { dismissed = sessionId; loadLog(); } }, 'Back to this chat') : h('button', { class: 'cs-btn cs-btn--small', type: 'button', onclick: () => openHistory() }, 'All conversations')),
      c.earlier ? h('p', { class: 'cs-soft cs-small cs-hist__earlier' }, `${c.earlier} earlier messages are not shown.`) : null,
      ...c.messages.map((m) => (m.role === 'note' ? h('p', { class: 'cs-hist__note cs-soft cs-small' }, m.text) : messageEl(m))),
      c.nextOffset != null || c.nextCursor ? h('button', { class: 'cs-btn', onclick: async (event) => {
        const button = event.currentTarget; button.disabled = true;
        try {
          const page = await api.historyOne(project.id, sessionId, run, { engine, source, nodeId: nodeId || '', offset: c.nextOffset || 0, cursor: c.nextCursor });
          if (!alive || viewing?.sessionId !== sessionId) return;
          for (const m of page.messages) button.before(messageEl(m));
          c = { ...c, nextOffset: page.nextOffset, nextCursor: page.nextCursor };
          if (c.nextOffset == null && !c.nextCursor) button.remove();
        } catch (error) { toast(error.message, { kind: 'danger' }); } finally { button.disabled = false; }
      } }, 'Load more messages') : null,
      ...said);
    if (!quiet || atBottom) scroll();
  }

  /* ---- Claude Code working in your terminal or IDE on this folder: shown here, live --------------------------- */
  let ourSession = null; // this chat's own conversation (its file is in the folder too)
  let lastOwnAt = null;
  let dismissed = null; // "Back to this chat" on that one: not shown again by itself
  let carried = null; // the terminal conversation this chat carries on: it is this chat now, never "live elsewhere"
  const LIVE_MS = 2 * 60 * 1000;
  async function watchTerminal() {
    if (!alive || nodeId || engine !== 'claude' || running || elsewhere || document.hidden) return;
    if (viewing && !viewing.live) return; // reading something on purpose
    let hist;
    try { hist = await api.history(project.id, ''); } catch { return; }
    const c = hist.conversations[0];
    const active = c && Date.now() - Date.parse(c.lastAt) < LIVE_MS;
    const foreign = c && c.id !== ourSession && c.id !== dismissed && c.id !== carried && (!lastOwnAt || Date.parse(c.lastAt) > Date.parse(lastOwnAt));
    if (active && foreign) await view({ sessionId: c.id, title: c.title, live: true });
    else if (viewing?.live) {
      // it stopped (two minutes quiet): show it once more as finished, then leave it as an ordinary view
      await view({ sessionId: viewing.sessionId, title: viewing.title });
    }
  }
  const terminalTimer = nodeId ? null : setInterval(watchTerminal, 3000);

  async function continueHere(sessionId, source = '', fork = false) {
    const log = await api.chatLog(project.id, nodeId || '', engine).catch(() => ({ messages: [] }));
    if (log.messages.length && !(await confirmDialog({ title: 'Continue that conversation here?', message: 'Your current conversation remains in saved history. This selects the conversation you chose.', confirmLabel: 'Continue it here' }))) return;
    try { await api.linkChat(project.id, nodeId, sessionId, { engine, source, fork }); } catch (e) { toast(e.message, { kind: 'danger' }); return; }
    toast(fork ? 'The next message starts a provider copy. The original stays in history.' : source === 'circle' ? 'Opened your saved conversation.' : 'Continuing the selected conversation.');
    viewing = null;
    loadLog();
    input.focus();
  }

  async function loadLog() {
    const generation = ++logGeneration;
    viewing = null;
    elsewhere = null;
    let log;
    try { log = await api.chatLog(project.id, nodeId || '', engine === 'claude' && !nodeId ? '' : engine); } catch { log = { messages: [] }; }
    if (!alive || generation !== logGeneration) return;
    const initialDraft = conversationId === 'active' ? input.value : '';
    saveDraft();
    conversationId = log.conversationId || 'active';
    restoreDraft();
    if (!input.value && initialDraft) input.value = initialDraft;
    ourSession = log.sessionId || null;
    carried = log.linked?.id || carried;
    lastOwnAt = log.messages.length ? log.messages[log.messages.length - 1].at || null : null;
    transcript.replaceChildren();
    if (log.linked) {
      let before = null;
      try { before = await api.historyOne(project.id, log.linked.id, '', { engine }); } catch { /* provider history unavailable */ }
      if (!alive) return;
      transcript.append(h('div', { class: 'cs-hist__divider', role: 'separator' }, `Continued from ${engineName(engine)}: ${log.linked.title}`));
      if (before) {
        if (before.earlier) transcript.append(h('p', { class: 'cs-soft cs-small cs-hist__earlier' }, `${before.earlier} earlier messages are not shown.`));
        before.messages.forEach((m) => transcript.append(m.role === 'note' ? h('p', { class: 'cs-hist__note cs-soft cs-small' }, m.text) : messageEl(m)));
      } else transcript.append(h('p', { class: 'cs-soft cs-small' }, 'That conversation is no longer in Claude Code\'s folder; Claude still has its context.'));
      if (log.messages.length) transcript.append(h('div', { class: 'cs-hist__divider', role: 'separator' }, 'Here in Circle Studio'));
    } else if (!log.messages.length) {
      const empty = h('div', { class: 'cs-empty' }, icon('chat', 'l'), h('div', { class: 'cs-empty__title' }, nodeId ? 'Talk to this agent' : 'Ask, or tell it what to do'), h('p', {}, 'It works in the project folder using the selected engine and its permissions.'));
      if (history && (history.conversations.length || history.agentRuns.length)) empty.append(h('div', { class: 'cs-chat__suggestions' }, ...carryOnLatest(), historyList(5)));
      transcript.append(empty);
    }
    log.messages.forEach((m) => transcript.append(messageEl(m)));
    transcript.append(...said);
    scroll();
  }

  /* ---- Circle Studio's commands typed here (/waiting, /allow 1, /stop...): answered in place, never sent ---- */
  // the answers stay on the page (the newest six), also while a live view redraws itself every few seconds
  const said = [];
  function showSaid(el) {
    said.push(el);
    if (said.length > 6) said.shift().remove();
    transcript.querySelector('.cs-empty')?.remove();
    transcript.append(el);
    scroll();
  }
  function commandEl(typed, out) {
    const s = out.say || { title: 'Done.', lines: [], tone: 'info' };
    return h('article', { class: ['cs-msg', 'cs-msg--circle'], 'aria-label': 'Circle Studio' },
      h('div', { class: 'cs-eyebrow' }, `Circle Studio · ${typed}`),
      h('div', { class: ['cs-banner', `cs-banner--${['ok', 'warn', 'danger'].includes(s.tone) ? s.tone : 'info'}`] }, h('strong', {}, s.title)),
      s.lines?.length ? h('pre', { class: 'cs-msg__lines' }, s.lines.join('\n')) : null);
  }

  // Claude Code's words for the same things: /clear is a new chat, /resume lists the earlier ones, /cost is /usage
  const ALIAS = { clear: 'new', reset: 'new', resume: 'chats', cost: 'usage' };
  // answered right here, from what this window knows
  function localCommand(text) {
    const [word, ...rest] = text.slice(1).trim().split(/\s+/);
    const w = (word || '').toLowerCase();
    if (w === 'model') {
      const list = infoFor(engine)?.models || MODELS[engine] || [];
      const want = (rest[0] || '').toLowerCase();
      if (want && list.includes(want)) { model = want; setPref(`chat-model:${engine}`, model); drawControls(); return { say: { title: `Model: ${want}`, lines: ['The next message uses it.'], tone: 'ok' } }; }
      return { say: { title: `Model: ${model || 'default'}`, lines: [list.length ? `Choose: ${list.map((m) => `/model ${m}`).join(' · ')}` : 'This engine picks its own model.'], tone: want ? 'warn' : 'info' } };
    }
    if (w === 'status') {
      const cur = infoFor(engine);
      return { say: { title: `${cur ? cur.label : engineName(engine)}${cur?.version ? ` ${cur.version}` : ''}`, lines: [`Folder: ${project.path || project.name}`, `Model: ${model || 'default'}`, viewing?.live ? `Showing: "${viewing.title}", live from your terminal or editor (write to carry it on here)` : `Conversation: ${ourSession || 'new'}`, running || elsewhere ? 'Answering now.' : 'Ready.', cur ? capabilityNote(cur) : ''].filter(Boolean), tone: 'info' } };
    }
    return null;
  }

  // true when it was one of ours (shown here); false when the words go to the agent (`text` may change: /ask, //)
  async function command(text) {
    const word = (/^\/(\S+)/.exec(text)?.[1] || '').toLowerCase();
    if (ALIAS[word]) text = `/${ALIAS[word]}${text.slice(word.length + 1)}`;
    if (word === 'terminal') {
      input.value = '';
      const arg = text.slice(word.length + 1).trim().toLowerCase();
      const r = await terminal(['show', 'new'].includes(arg) ? arg : 'auto');
      if (r?.say) showSaid(commandEl(text, r));
      return true;
    }
    const here = localCommand(text);
    if (here) { input.value = ''; if (viewing && !viewing.live) await loadLog(); showSaid(commandEl(text, here)); return true; }
    let out;
    try { out = await api.overlayCommand(text, project.id, 'chat', engine); } catch (e) { toast(e.message, { kind: 'danger' }); return true; }
    if (out.command === 'none' || out.command === 'ask' || out.command === 'hide') return false;
    input.value = '';
    if (viewing && !viewing.live) await loadLog();
    showSaid(commandEl(text, out));
    const goTo = out.chatWindow || (out.projectId && out.projectId !== project.id ? out.projectId : null);
    if (out.open) location.hash = out.open;
    else if (goTo) location.hash = `#/projects/${goTo}/chat`;
    else if (['newchat', 'continue'].includes(out.command)) { await loadLog(); loadHistory(); }
    return true;
  }

  async function send() {
    let text = input.value.trim();
    if (!text) return;
    // commands work even while the agent answers (/allow 1, /stop); a sentence waits for the answer to finish
    if (text.startsWith('//')) text = text.slice(1);
    else if (text.startsWith('/')) {
      if (await command(text)) return;
      const c = /^\/(ask|say|tell)\s+(.+)$/is.exec(text);
      if (c) text = c[2].trim();
    }
    if (running || elsewhere) {
      // like Claude Code: type while it works; it goes the moment the answer is done (Stop or /stop to cut it short)
      try {
        await api.queueChat({ projectId: project.id, nodeId, engine, model: model || undefined, reasoning: reasoning || undefined, conversationId: conversationId !== 'active' ? conversationId : undefined, message: text, clientId: crypto.randomUUID() });
        input.value = ''; saveDraft(); await loadQueue();
      } catch (error) { toast(error.message, { kind: 'danger' }); }
      return;
    }
    if (viewing?.live && !nodeId) {
      // what you see is what you carry on: the conversation from your terminal (a copy; the original stays)
      try { await api.linkChat(project.id, null, viewing.sessionId); } catch (e) { toast(e.message, { kind: 'danger' }); return; }
      if (engine !== 'claude' && !forcedEngine) { engine = 'claude'; setPref(key, engine); drawControls(); }
      toast('Carrying on the conversation from your terminal here. The original stays as it was.');
    }
    if (viewing && !viewing.live) { toast('Choose Continue it here before replying to this saved conversation.'); return; }
    if (viewing) await loadLog();
    const cur = infoFor(engine);
    if (!cur?.usable) { toast(`${cur ? cur.label : engineName(engine)} is not available. Check Settings.`, { kind: 'warn' }); return; }
    running = true;
    engineSel.disabled = true;
    modelSel.disabled = true;
    stopBtn.hidden = false;
    notice.replaceChildren();
    transcript.querySelector('.cs-empty')?.remove();
    input.value = '';
    saveDraft();
    transcript.append(messageEl({ role: 'user', text }));
    const reply = { role: 'assistant', text: '', tools: [], engine };
    const rel = messageEl(reply);
    transcript.append(rel);
    scroll();
    abort = new AbortController();
    let raf = 0;
    const paint = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fill(rel, reply); scroll(); }); };
    try {
      await api.chat({ projectId: project.id, nodeId: nodeId || undefined, engine, model: model || undefined, reasoning: reasoning || undefined, conversationId: conversationId !== 'active' ? conversationId : undefined, message: text }, (name, d) => {
        if (name === 'text') reply.text += d.delta;
        else if (name === 'tool') {
          let t = reply.tools.find((x) => x.id === d.id);
          if (!t) { t = { id: d.id, name: d.name, summary: d.name, ok: null }; reply.tools.push(t); }
          if (d.summary) t.summary = d.summary;
          if (d.status === 'end') t.ok = d.ok;
        } else if (name === 'output') { const tool = reply.tools.find((t) => t.id === d.id); if (tool) tool.output = ((tool.output || '') + (d.delta || '')).slice(-16000); }
        else if (name === 'usage') reply.usage = d;
        else if (name === 'notice') notice.append(h('div', { class: 'cs-banner cs-banner--info' }, icon('info', 's'), h('span', {}, d.message)));
        else if (name === 'done') { reply.models = d.models; reply.ms = d.ms; }
        else if (name === 'error') reply.error = d.message;
        else if (name === 'stopped') reply.stopped = true;
        else if (name === 'request') reply.waiting = true;
        else if (name === 'request-resolved') reply.waiting = false;
        paint();
      }, abort.signal);
    } catch (e) {
      reply.error = e.message;
    } finally {
      running = false;
      drawControls();
      abort = null;
      stopBtn.hidden = true;
      cancelAnimationFrame(raf);
      fill(rel, reply);
      scroll();
      const saved = await api.chatLog(project.id, nodeId || '', engine).catch(() => null);
      if (saved && alive) { const draft = input.value; saveDraft(); conversationId = saved.conversationId || conversationId; ourSession = saved.sessionId || ourSession; restoreDraft(); if (draft) { input.value = draft; saveDraft(); } loadHistory(); }
      if (reply.error && alive && !input.value.trim()) { input.value = text; saveDraft(); }
      if (alive) input.focus();
      setTimeout(sendQueued, 0);
    }
  }

  // what you typed while Claude was answering: sent in order, one after the other
  function sendQueued() {
    if (alive) loadQueue();
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', async () => { abort?.abort(); try { await api.stopChat(project.id, nodeId || undefined); } catch { /* already gone */ } });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });

  const newBtn = h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: async () => {
    if (running) return;
    if (!(await confirmDialog({ title: 'Start a new conversation?', message: 'The agent starts without the earlier context. This conversation stays in the folder: Earlier conversations takes it up again.', confirmLabel: 'New conversation' }))) return;
    await api.resetChat(project.id, nodeId || '', engine === 'claude' && !nodeId ? '' : engine);
    loadHistory();
    loadLog();
  } }, icon('refresh', 's'), 'New conversation');

  const editorBtn = h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', title: 'Open this project in Antigravity IDE (or VS Code), at the file the agent last worked on', onclick: async () => {
    try { const r = await api.openEditor(project.id, nodeId); toast(r.opened ? `Opened in ${r.editor}${r.file ? `: ${r.file}` : ''}.` : r.why, { kind: r.opened ? 'ok' : 'warn' }); } catch (e) { toast(e.message, { kind: 'danger' }); }
  } }, icon('external', 's'), 'Open in editor');

  // the terminal this conversation runs in, brought to the front; or a new one that carries it on
  async function terminal(mode = 'auto') {
    try {
      if (viewing && !viewing.live && viewing.source !== 'circle') { toast('Choose Continue it here before opening this provider history in Terminal.'); return null; }
      const targetId = viewing?.source === 'circle' ? viewing.sessionId : conversationId;
      const r = await api.openTerminal(project.id, mode, { engine, model: model || undefined, reasoning: reasoning || undefined, nodeId, conversationId: targetId !== 'active' ? targetId : undefined });
      toast(r.say ? [r.say.title, ...(r.say.lines || [])].join(' ') : 'Done.', { kind: r.shown || r.opened ? 'ok' : 'warn' });
      return r;
    } catch (e) { toast(e.message, { kind: 'danger' }); return null; }
  }
  const terminalBtn = h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', title: 'Show the terminal (or editor) this conversation runs in. If none is open, a new terminal carries it on.', onclick: () => terminal() }, icon('terminal', 's'), 'Terminal');

  const handoffBtn = h('button', { class: 'cs-btn cs-btn--quiet cs-btn--small', type: 'button', onclick: () => {
    if (running) { toast('Finish or stop this turn before preparing a handoff.'); return; }
    reviewHandoff({ projectId: project.id, nodeId, engine, conversationId, onPrepared: async (target, summary) => {
      await api.resetChat(project.id, nodeId || '', target);
      saveDraft(); engine = target; model = ''; reasoning = ''; conversationId = 'active'; setPref(key, engine);
      await persistSelection(); drawControls(); await loadLog(); await loadHistory();
      input.value = summary; saveDraft(); input.focus();
    } });
  } }, 'Review handoff');
  el.append(h('div', { class: 'cs-chat' },
    h('div', { class: 'cs-row cs-row--wrap cs-row--between' }, h('h2', { class: 'cs-h2' }, 'Chat'), h('div', { class: 'cs-row cs-row--wrap' }, historyBtn, terminalBtn, editorBtn, handoffBtn, engineSel, modelSel, reasoningSel, newBtn)),
    info, notice, transcript, jump, waiting, queueBox,
    h('div', { class: 'cs-card cs-stack cs-stack--tight' }, input,
      h('div', { class: 'cs-row cs-row--wrap' }, h('span', { class: 'cs-grow' }), h('span', { class: 'cs-soft cs-small' }, h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Enter')), stopBtn, sendBtn))));

  drawControls();
  drawWaiting();
  if (requestedConversation) void view({ sessionId: requestedConversation, source: 'circle' }); else loadLog();
  loadHistory();
  loadQueue();
  const queueTimer = setInterval(loadQueue, 5000);
  // Leaving the view must not stop the run: a question it asked stays in the Inbox to be answered from there. The run
  // goes on even when the window closes or reloads (the server keeps it); only Stop or /stop ends it.
  followLive();
  watchTerminal();
  return { destroy() { saveDraft(); alive = false; clearInterval(queueTimer); if (terminalTimer) clearInterval(terminalTimer); window.removeEventListener('circle:requests', onRequests); window.removeEventListener('circle:progress', onLive); window.removeEventListener('circle:run', onLive); } };
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
  return mountChat(el, { project: pctx.project, engine: pctx.chatEngine || pctx.selectedChat?.engine, model: pctx.chatEngine ? undefined : pctx.selectedChat?.model, reasoning: pctx.chatEngine ? undefined : pctx.selectedChat?.reasoning, nodeId: pctx.chatNode, conversationId: pctx.conversationId });
}
