// The overlay (Ctrl+Alt+C): what it shows (overlay.feed) and the commands typed into it (overlay.command).
// Commands only do what a button elsewhere in Circle Studio does: open a page, answer what waits, send a chat message
// (the agent still asks before every command and edit), stop a run, check a mod. Nothing here writes into a project.
import { badRequest } from './lib/errors.mjs';
import { redact } from './lib/secrets.mjs';
import { computeStats } from './lib/stats.mjs';
import { readPalette } from './lib/palette.mjs';
import { runLabel, limitsView } from './lib/feed.mjs';
import {
  withoutLive,
  parseCommand, chatCommand, findByName, splitAgent, splitNumber, pcStats, waitingPanel, workflowMap, usagePanel, gitPanel, helpLines, projectChoices, OVERLAY_EXTRAS, PAGES,
} from './lib/overlay.mjs';
import { plain } from './lib/chatfeed.mjs';
import { readConversation, listConversations } from './lib/cchistory.mjs';
import { findEditor, openInEditor, workingFile } from './lib/ide.mjs';
import { findWorkWindow, openResumeTerminal } from './lib/terminal.mjs';
import { spawn } from 'node:child_process';
import { cleanEnv } from './lib/run.mjs';
import fs from 'node:fs';
import path from 'node:path';

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// The overlay's chat box: the last messages, whole but plain (no Markdown marks), and what the chat is.
const talkOf = (c) => (c ? {
  title: c.title || null, continueId: c.continueId || null, fresh: Boolean(c.fresh), engine: c.engine || null,
  messages: (c.messages || []).slice(-8).map((m) => { const t = redact(plain(m.md || m.text || '')).trim(); return { who: m.who, mine: Boolean(m.mine), text: t.length > 1200 ? `${t.slice(0, 1200)}…` : t, tools: m.tools || [] }; }),
} : null);
const say = (title, lines = [], tone = 'info') => ({ title, lines: lines.filter((l) => l !== null && l !== undefined && l !== ''), tone });

export function buildOverlayHandlers(app, handlers) {
  const { projects, settings, config } = app;
  // what the overlay sent to a chat, per project, while the answer comes in (and a little after)
  const live = new Map();
  // spending is added up in the background the first time: the overlay never waits for it
  let usage = { at: 0, data: null, busy: false };
  const usageNow = () => {
    if (!usage.busy && Date.now() - usage.at > 5 * 60_000) {
      usage.busy = true;
      Promise.resolve(handlers['usage.providers']({ query: new URLSearchParams({ days: '30' }) }))
        .then((d) => { usage = { at: Date.now(), data: d, busy: false }; })
        .catch(() => { usage = { ...usage, at: Date.now(), busy: false }; });
    }
    return usage.data;
  };

  const listed = () => projects.list().filter((p) => p.exists).map((p) => ({ id: p.id, name: p.name }));
  const current = (id) => { const all = listed(); return id ? all.find((p) => p.id === id) || null : all[0] || null; };
  const nameOf = (id) => { try { return projects.get(id).name; } catch { return id; } };
  const pulse = (id) => { try { return handlers['projects.pulse']({ params: { id } }); } catch { return null; } };
  const agentsOf = (id) => {
    try { return app.workflows.head(projects.get(id)).nodes.filter((n) => n.kind === 'agent').map((n) => ({ id: n.id, title: n.title || n.id, engine: n.engine || 'claude' })); } catch { return []; }
  };
  const pending = () => app.inbox.list({ status: 'pending' }).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const hotkey = () => { try { return fs.readFileSync(path.join(config.dataDir, 'desktop-widgets.hotkey'), 'utf8').trim().slice(0, 40) || null; } catch { return null; } };

  // Start a chat turn and let it run on its own: the overlay reads the answer as it comes, from overlay.feed.
  async function send(project, { nodeId = null, engineId = 'claude', model, reasoning, conversationId, to, message }) {
    await app.sessions.preflight({ projectId: project.id, nodeId, engineId });
    if (conversationId) app.chats.read(app.sessions.chatKey(project.id, nodeId, engineId), conversationId, { limit: 1 });
    const rec = { you: message.slice(0, 2000), to, text: '', error: null, done: false, at: new Date().toISOString(), doneAt: null, nodeId, engine: engineId, conversationId };
    live.set(project.id, rec);
    const ctl = new AbortController();
    app.sessions.runTurn({
      projectId: project.id, nodeId, engineId, model, reasoning, conversationId, message,
      emit: (name, d) => { if (name === 'text') rec.text = (rec.text + (d.delta || '')).slice(-6000); else if (name === 'error') rec.error = String(d.message || 'It stopped.'); },
      signal: ctl.signal,
    }).catch((e) => { rec.error = String(e.message || e); }).finally(() => { rec.done = true; rec.doneAt = new Date().toISOString(); });
    return rec;
  }

  function respondTo(rest, decision) {
    const list = pending();
    if (!list.length) return { say: say('Nothing waits for you.', [], 'ok') };
    const { n, text } = splitNumber(rest);
    const r = list[n - 1];
    if (!r) return { say: say(`There is no number ${n}.`, [`${list.length} wait${list.length === 1 ? 's' : ''}: type waiting to see them.`], 'warn') };
    if (decision === 'answer' || r.kind === 'question') {
      if (r.kind !== 'question') return { say: say(`Number ${n} asks to go ahead, not a question.`, ['Type allow or deny.'], 'warn') };
      if (decision !== 'answer') return { say: say(`Number ${n} is a question.`, ['Type answer, then your answer (an option number works).'], 'warn') };
      const qs = r.questions || [];
      if (qs.length !== 1) return { say: say('This one has several questions.', ['Answer them on the card, or /open inbox.'], 'warn'), open: '#/inbox' };
      const q = qs[0];
      const pick = /^\d{1,2}$/.test(text) ? (q.options || [])[Number(text) - 1]?.label : null;
      const answer = pick || text;
      if (!answer) return { say: say('Say the answer after the word answer.', (q.options || []).map((o, k) => `${k + 1}. ${o.label}`), 'warn') };
      app.sessions.respond(r.id, { decision: 'answer', answers: { [q.question]: answer } });
      return { say: say(`Answered: ${answer}`, [`${nameOf(r.projectId)} · ${r.nodeId || 'the agent'} goes on.`], 'ok') };
    }
    app.sessions.respond(r.id, { decision });
    return { say: say(decision === 'allow' ? 'Allowed.' : 'Refused.', [`${nameOf(r.projectId)} · ${redact(String(r.title || '')).slice(0, 120)}`], decision === 'allow' ? 'ok' : 'warn') };
  }

  // Your conversations in the project folder, newest first: Claude Code's from the terminal or an IDE, and the ones
  // Circle Studio's chat had (they are Claude Code conversations too).
  const conversations = (p) => listConversations(config.claudeHome, projects.get(p.id).path).conversations;
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  // Continue one of them in the main chat: the first message makes a copy, so the original stays as it was.
  async function carryOn(p, c, engine = 'claude') {
    await handlers['projects.chat.link']({ params: { id: p.id }, body: { sessionId: c.id, engine, source: c.source } });
    live.delete(p.id);
  }

  // What you typed, to a chat: the main one (carrying on the conversation it shows, as you see it) or an agent's.
  // Marked as said from the desktop, so its answer comes back as a card there.
  async function sayTo(p, text, nodeId = null, { engine: chosen, model, reasoning, conversationId } = {}) {
    let note = '';
    let engineId = 'claude';
    let to = 'Claude';
    if (nodeId) {
      const agent = agentsOf(p.id).find((a) => a.id === nodeId);
      if (!agent) throw badRequest(`This project's workflow has no agent "${nodeId}".`);
      engineId = chosen || agent.engine; to = agent.title;
      } else {
        chosen ||= app.chats.selected(p.id)?.engine || settings.get().overlayBar?.engine || settings.get().preferredEngine || null;
      const c = await Promise.resolve(handlers['widgets.chat']({ query: new URLSearchParams({ projectId: p.id }) })).catch(() => null);
      if (c?.continueId && (!chosen || chosen === 'claude')) {
        const hit = conversations(p).find((x) => x.id === c.continueId);
        if (hit) { await carryOn(p, hit); note = `It carries on "${hit.title}".`; }
      }
      engineId = note ? 'claude' : chosen || (c?.engine && c.engine !== 'cc' ? c.engine : 'claude');
      to = ENGINE_LABEL[engineId] || engineId;
    }
    // its answer comes back as a card (the card you typed on stays, saying so, until the new one replaces it)
    app.fromDesktop?.add(`${p.id}|${nodeId || ''}`);
    const target = app.chats.selected(p.id, nodeId);
    await send(p, { nodeId, engineId, model: model ?? (target?.engine === engineId ? target.model : undefined), reasoning: reasoning ?? (target?.engine === engineId ? target.reasoning : undefined), conversationId, to, message: text });
    return note;
  }

  /* ---- the terminal a conversation runs in -------------------------------------------------------------------- */
  // A folder named by a terminal's request: it must be a full path to a folder that is there.
  const askedFolder = (f) => {
    if (!path.isAbsolute(f) || f.length > 1000) throw badRequest('folder must be a full path.');
    try { if (!fs.statSync(f).isDirectory()) throw new Error(); } catch { throw badRequest('That folder is not there.'); }
    return path.resolve(f);
  };
  // Its window brought to the front (a terminal titled with the conversation, or the editor open on the folder); when
  // none is open, a new terminal in the folder that carries the newest conversation on. mode: auto, show or new.
  // Only a terminal: an editor's Claude Code panel is not one (the editor stays as it is; "Open in" opens it).
  async function openTerminal(p, mode = 'auto', options = {}) {
    const folder = projects.get(p.id).path;
    const engine = options.engine || settings.get().overlayBar?.engine || settings.get().preferredEngine || 'claude';
    if (!['claude', 'codex', 'gemini', 'copilot'].includes(engine)) throw badRequest('Unknown terminal engine.');
    if (engine !== 'claude' || options.nodeId || options.conversationId) {
      const nodeId = options.nodeId || null;
      const chatKey = app.sessions.chatKey(p.id, nodeId, engine);
      let saved = options.conversationId ? app.chats.read(chatKey, options.conversationId, { limit: 1 }) : app.chats.get(chatKey);
      if (app.sessions.isBusy(p.id, nodeId)) return { opened: false, say: say('This conversation is answering in Circle Studio.', ['Wait for it or stop it before opening a second writer.'], 'warn') };
      const find = app.overrides?.findWindow || (process.env.NODE_TEST_CONTEXT ? async () => ({ found: false }) : findWorkWindow);
      if (mode !== 'new') {
        const window = await find({ folder, engine, titles: [saved.linked?.title], only: 'terminal' });
        if (window.found) return { shown: true, app: window.app, say: say(`Showing ${engine}: ${redact(window.title)}`, [`In ${folder}.`], 'ok') };
        if (mode === 'show') return { shown: false, say: say(`No ${engine} terminal was found for this folder.`, [], 'warn') };
      }
      const resumable = ['codex', 'claude'].includes(engine);
      if (saved.fork) {
        const adapter = app.engines.adapter(engine);
        if (!adapter?.forkHistory) return { opened: false, say: say('This conversation is a copy waiting to be created.', ['Send its first message in Circle before opening it in Terminal. The original has not been changed.'], 'warn') };
        const branch = await adapter.forkHistory({ cwd: folder, id: saved.sessionId });
        saved = await app.chats.providerSession(chatKey, saved.conversationId, branch.id);
      }
      const selected = app.chats.selected(p.id, nodeId);
      const target = selected?.engine === engine ? selected : null;
      const result = openResumeTerminal({ appRoot: config.appRoot, folder, engine, model: options.model ?? target?.model, reasoning: options.reasoning ?? target?.reasoning, sessionId: resumable ? saved.sessionId : null, title: saved.title || saved.linked?.title || '', spawnImpl: app.overrides?.spawnTerminal || (process.env.NODE_TEST_CONTEXT ? () => ({}) : undefined) });
      return { ...result, say: say(result.opened ? `Opened ${engine} in this folder.` : 'Could not open a terminal.', [resumable && saved.sessionId ? 'Continues the selected conversation.' : 'Starts a new terminal conversation.', result.why || ''], result.opened ? 'ok' : 'warn') };
    }
    // the conversation the chat here carries on (its own Claude conversation), else the folder's newest
    const all = conversations(p);
    const ownId = app.chats.get(app.sessions.chatKey(p.id, null, 'claude'))?.sessionId || null;
    const conv = all.find((c) => c.id === ownId) || all[0] || null;
    const title = conv ? redact(String(conv.title || '')).slice(0, 80) : '';
    if (mode !== 'new') {
      // tests never look at (or bring forward) the windows on this PC
      const find = app.overrides?.findWindow || (process.env.NODE_TEST_CONTEXT ? async () => ({ found: false }) : findWorkWindow);
      const w = await find({ folder, titles: [conv?.title], only: 'terminal' });
      if (w.found) {
        const where = w.kind === 'editor' ? 'the editor' : 'the terminal';
        return { shown: true, app: w.app, window: redact(w.title).slice(0, 120), say: say(`Showing ${where}: ${redact(w.title).slice(0, 80)}`, [w.how === 'session' ? `Claude Code is working there, in ${folder}.` : `Its window matches this folder; no Claude Code session was seen running there.`], 'ok') };
      }
      if (mode === 'show') return { shown: false, say: say('No terminal is open on this folder.', ['/terminal new opens one that carries the conversation on.'], 'warn') };
    }
    // two Claudes on one conversation would talk over each other
    if (app.sessions.isBusy(p.id, null)) return { opened: false, say: say('Claude is answering here right now.', ['Wait for it, or /stop, then open the terminal.'], 'warn') };
    const r = openResumeTerminal({ appRoot: config.appRoot, folder, sessionId: conv?.id || null, title, spawnImpl: app.overrides?.spawnTerminal || (process.env.NODE_TEST_CONTEXT ? () => ({}) : undefined) });
    if (!r.opened) return { opened: false, say: say('Open a terminal yourself:', [r.why], 'warn') };
    return { opened: true, resumed: title || null, say: say(conv ? `Opened a terminal with this chat: "${title}".` : 'Opened a terminal with Claude Code in this folder.', [`In ${folder}. The chat here runs inside Circle Studio (no window of its own); the terminal carries the same conversation on.`], 'ok') };
  }

  /* ---- the bar (the overlay's chat box): words go to the chat, / is for commands ------------------------------- */
  const ENGINE_LABEL = { claude: 'Claude', codex: 'Codex', copilot: 'Copilot', gemini: 'Gemini' };
  const usableEngines = () => {
    const known = app.engines?.known?.();
    if (!known) { app.engines?.list?.().catch(() => {}); return ['claude']; } // asked once in the background
    const ids = known.filter((e) => e.usable && e.capabilities?.chat !== false).map((e) => e.id);
    return ids.length ? ids : ['claude'];
  };
  const barChoice = () => { const b = settings.get().overlayBar || {}; const ids = usableEngines(); const preferred = b.engine || settings.get().preferredEngine; return { engine: app.engines.adapter(preferred) ? preferred : ids[0], model: b.model || null, engines: ids }; };
  // what you typed while it answered: sent, in order, as soon as it is done
  const ALIAS = { clear: 'new', reset: 'new', resume: 'chats', cost: 'usage' };

  async function barLine(text, p) {
    const noProject = { say: say('No project yet.', ['Press Folder... to choose one.'], 'warn') };
    let line = text.trim();
    if (line.startsWith('//')) line = line.slice(1); // the word itself, to Claude
    else if (line.startsWith('/')) {
      const [w0, ...rest] = line.slice(1).split(/\s+/);
      const w = (ALIAS[w0.toLowerCase()] || w0).toLowerCase();
      const arg = rest.join(' ').trim();
      if (w === 'engine') {
        const { engine, engines } = barChoice();
        const want = arg === '' || arg === 'next' ? engines[(engines.indexOf(engine) + 1) % engines.length] : arg.toLowerCase();
        if (!engines.includes(want)) return { say: say(`"${arg}" is not ready here.`, [`Ready: ${engines.map((e) => ENGINE_LABEL[e] || e).join(', ')}.`], 'warn') };
          await settings.set({ overlayBar: { ...(settings.get().overlayBar || {}), engine: want, model: null } });
        return { say: say(`Now talking to ${ENGINE_LABEL[want] || want}.`, [], 'ok') };
      }
      if (w === 'model') {
        const engine = barChoice().engine;
        const detected = await app.engines.info(engine);
        const ok = engine === 'claude' ? ['haiku', 'sonnet', 'opus'] : (detected?.modelCatalog || []).map((m) => m.id);
        if (!arg) return { say: say(`Model: ${barChoice().model || 'the default'}`, [`Choose: ${ok.map((m) => `/model ${m}`).join(' · ')}`]) };
        if (!ok.includes(arg.toLowerCase())) return { say: say(`No model "${arg}".`, [`Choose: ${ok.join(', ')}.`], 'warn') };
        await settings.set({ overlayBar: { ...(settings.get().overlayBar || {}), model: arg.toLowerCase() } });
        return { say: say(`Model: ${arg.toLowerCase()}.`, [`The next message uses it (${ENGINE_LABEL[engine] || engine}).`], 'ok') };
      }
      if (w === 'status') {
        if (!p) return noProject;
        const t = app.sessions.turnOf(p.id, null);
        const { engine, model } = barChoice();
        return { say: say(`${p.name}`, [`Folder: ${projects.get(p.id).path}`, `Talking to: ${ENGINE_LABEL[engine] || engine}${model ? ` (${model})` : ''}`, t ? `Answering now${t.tools.length ? `: ${redact(String(t.tools[t.tools.length - 1].summary || ''))}` : ''}` : 'Ready.']) };
      }
      if (w === 'terminal') {
        if (!p) return noProject;
        return openTerminal(p, ['show', 'new'].includes(arg.toLowerCase()) ? arg.toLowerCase() : 'auto');
      }
      if (w === 'help' || w === '?') {
        return { say: say('Type a message to talk. A line starting with / is a command:', [
          '/usage            reported provider quota windows and separate spending totals', '/status           the folder, who answers, what it is doing',
          '/engine codex     talk to another AI tool (or click its name)', '/model            models available for the selected engine',
          '/waiting          what waits for you, numbered', '/allow 1  /deny 1  /answer 1 <answer>',
          '/stop             stop the answer', '/new  /chats  /continue 2   new chat, earlier ones',
          '/project <name>   show another project here', '/open chat        the full Chat in Circle Studio',
          '/terminal         the terminal this chat runs in (or a new one that carries it on)',
          '//word            send a word starting with / to Claude as it is']) };
      }
      const cmd = chatCommand(`/${w}${arg ? ` ${arg}` : ''}`);
      if (cmd && cmd.id !== 'ask') return run(cmd, p);
      if (cmd?.id === 'ask') line = cmd.rest;
      // any other /word is Claude Code's own (a project's commands too): it goes to Claude as typed
    }
    if (!line) return { say: say('Type a message, or / for commands.') };
    if (!p) return noProject;
    if (app.sessions.isBusy(p.id, null)) {
      const choice = barChoice();
      await app.queue.enqueue({ projectId: p.id, nodeId: null, engineId: choice.engine, model: choice.model, message: line.slice(0, 4000) });
      return { say: say('Sends when it finishes.', [line.length > 80 ? `${line.slice(0, 80)}...` : line], 'ok') };
    }
    const note = await sayTo(p, line, null, barChoice());
    return { sent: true, say: note ? say('Sent.', [note], 'ok') : null };
  }

  // The file an agent last worked on in this chat: from Circle Studio's own record of it, else the conversation shown.
  async function fileOf(p, nodeId = null) {
    const lines = [];
    for (const engine of ['claude', 'codex', 'gemini', 'copilot']) {
      for (const m of app.chats.get(app.sessions.chatKey(p.id, nodeId, engine)).messages || []) for (const t of m.tools || []) lines.push({ at: m.at || '', s: t.summary || '' });
    }
    if (!lines.length && !nodeId) {
      const newest = conversations(p)[0];
      const c = newest ? await readConversation(config.claudeHome, projects.get(p.id).path, newest.id, { limit: 40 }).catch(() => null) : null;
      for (const m of c?.messages || []) for (const t of m.tools || []) lines.push({ at: m.at || '', s: t.summary || '' });
    }
    lines.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    return workingFile(projects.get(p.id).path, lines.map((l) => l.s));
  }

  // The chat as a page beside your code (opened with the editor): what is going on now, what waits for you and how to
  // answer it, then the whole conversation with the turn that is running. Written again on every step of a run in
  // that project (a tool, more words, a question, an answer), at most a few times a second. A project has a page once
  // "Open in editor" made it; pages are refreshed when the server starts, so none is left saying "working".
  // In Circle Studio's own data folder, never in the project. Everything on it is masked.
  const pageDir = path.join(config.dataDir, 'chat-view');
  const chatPage = (id) => path.join(pageDir, `${id}.md`);
  const hasPage = (id) => fs.existsSync(chatPage(id));
  const ago = (iso) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`; };
  async function writeChatPage(id) {
    let p; try { p = projects.get(id); } catch { return null; }
    const c = await Promise.resolve(handlers['widgets.chat']({ query: new URLSearchParams({ projectId: id, size: 'l' }) })).catch(() => null);
    const turn = app.sessions.turnOf(id, null);
    const runs = app.sessions.live(id).runs;
    const all = pending();
    const mine = all.map((r, i) => ({ r, n: i + 1 })).filter((x) => x.r.projectId === id);
    const now = new Date().toISOString();
    const L = [`# Chat · ${p.name}`, ''];
    // the one line that says what is going on
    const lastTool = turn?.tools?.length ? turn.tools[turn.tools.length - 1] : null;
    if (mine.length) L.push(`**Waiting for you** (${mine.length}): the agent has stopped until you answer, below.`);
    else if (turn) L.push(`**Working** for ${ago(turn.startedAt)} · ${turn.engine}${turn.model ? ` (${turn.model})` : ''}${lastTool ? ` · ${lastTool.ok === null ? 'now' : 'last'}: ${lastTool.summary}` : ' · thinking'}`);
    else if (runs.length) L.push(`**An agent is working** in this project (below). The main chat is quiet.`);
    else L.push('**Quiet.** Nothing is running in this project.');
    L.push('', `_Updated ${new Date(now).toLocaleTimeString()} by Circle Studio, by itself while things happen. To write: the Chat in Circle Studio, the desktop card or the overlay (Ctrl+Alt+C). Commands there: /waiting, /allow 1, /deny 1, /answer 1 <answer>, /stop, /help._`, '');
    if (mine.length) {
      L.push('## Waiting for you', '');
      for (const { r, n } of mine) {
        L.push(`**${n}. ${r.title}**${r.nodeId ? ` · ${r.nodeId}` : ''}`);
        if (r.detail) L.push('', '```', String(r.detail).slice(0, 1500), '```');
        if (r.kind === 'question') {
          for (const q of r.questions || []) { L.push('', q.question); (q.options || []).forEach((o, k) => L.push(`${k + 1}. ${o.label}`)); }
          L.push('', `Answer: \`/answer ${n} <answer or option number>\``, '');
        } else L.push('', `Answer: \`/allow ${n}\` or \`/deny ${n}\``, '');
      }
    }
    const others = runs.filter((r) => r.nodeId);
    if (others.length) {
      L.push('## Also running in this project', '');
      for (const r of others) L.push(`- ${r.nodeId} · ${r.engine}${r.model ? ` (${r.model})` : ''} · ${r.status === 'waiting' ? 'waiting for you' : 'working'} for ${ago(r.startedAt)}`);
      L.push('');
    }
    // newest first, so the page shows what is happening without scrolling: the turn running now, then each earlier
    // exchange (what you said, then its answer), newest to oldest
    L.push('## Conversation, newest first', '');
    if (c?.title) L.push(`_${c.title}_`, '');
    if (turn) {
      L.push('---', '', `### You · ${clock(turn.startedAt)}`, '', turn.you, '');
      L.push(`### ${turn.engine.replace(/^./, (x) => x.toUpperCase())} · ${mine.length ? 'waiting for you' : 'answering…'}`, '');
      for (const t of turn.tools) L.push(`- ${t.ok === true ? '✓' : t.ok === false ? '✗' : '…'} ${t.summary}`);
      if (turn.tools.length) L.push('');
      L.push(turn.text || '_(no words yet)_', '');
    }
    const exchanges = [];
    for (const m of c?.messages || []) {
      if (m.mine || !exchanges.length) exchanges.push([]);
      exchanges[exchanges.length - 1].push(m);
    }
    for (const ex of exchanges.reverse()) {
      L.push('---', '');
      for (const m of ex) {
        L.push(`### ${m.mine ? 'You' : m.who}${m.at ? ` · ${clock(m.at)}` : ''}`, '');
        if (m.tools?.length) L.push(`_Used ${m.tools.join(', ')}_`, '');
        L.push(m.md || m.text || '', '');
      }
    }
    if (!exchanges.length && !turn) L.push('Nothing said yet.', '');
    const file = chatPage(id);
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(file, redact(L.join('\n')));
    return file;
  }
  // one write at a time per project, the latest state wins; a burst of steps gives one write
  const writing = new Map();
  function refreshPage(id) {
    if (!hasPage(id)) return;
    const w = writing.get(id) || { timer: null };
    writing.set(id, w);
    if (w.timer) return;
    w.timer = setTimeout(() => { w.timer = null; writeChatPage(id).catch(() => {}); }, 300);
  }
  app.sessions.subscribe?.((name, data) => {
    if (['run', 'progress', 'request', 'request-resolved'].includes(name) && data?.projectId) refreshPage(data.projectId);
  });
  // pages left from before a restart: say what is true now
  try { for (const f of fs.readdirSync(pageDir)) if (f.endsWith('.md')) refreshPage(f.slice(0, -3)); } catch { /* none yet */ }

  async function run(cmd, project, selectedEngine = null) {
    const engine = selectedEngine || barChoice().engine;
    const history = async (p) => engine === 'claude' ? conversations(p) : (await handlers['projects.history.list']({ params: { id: p.id }, query: new URLSearchParams({ engine }) })).conversations;
    const p = project;
    const noProject = { say: say('No project yet.', ['Add a folder on Home first: type open home.'], 'warn') };
    switch (cmd.id) {
      case 'empty': return { say: say('Type a command, or help.') };
      case 'help': return { say: say('What you can type', helpLines()) };
      case 'hide': return { hide: true, say: say('See you.') };
      case 'unknown': return { say: say(`"${cmd.rest}" is not a command.`, ['Type help for the list. A sentence goes to the chat.'], 'warn') };
      case 'project': {
        const hit = findByName(listed(), cmd.rest);
        if (!cmd.rest) return { say: say('Your projects', listed().map((x) => `${x.id === p?.id ? '> ' : '  '}${x.name}`)) };
        if (!hit) return { say: say(`No project called "${cmd.rest}".`, listed().map((x) => x.name), 'warn') };
        if (hit.ambiguous) return { say: say(`Which one? "${cmd.rest}" fits several.`, hit.ambiguous.map((x) => x.name), 'warn') };
        return { projectId: hit.id, say: say(`Showing ${hit.name}.`, [], 'ok') };
      }
      case 'open': {
        const [first, ...more] = cmd.rest.split(' ');
        const page = PAGES[(first || 'home').toLowerCase()];
        if (page) {
          let target = p;
          if (more.length) { const hit = findByName(listed(), more.join(' ')); if (hit && !hit.ambiguous) target = hit; }
          if (page.startsWith('project:')) {
            if (!target) return noProject;
            if (first.toLowerCase() === 'chat') return { chatWindow: target.id, hide: true, say: say(`Opening ${target.name}'s chat.`, [], 'ok') };
            return { open: `#/projects/${target.id}/${page.slice(8)}`, hide: true, say: say(`Opening ${target.name}: ${first.toLowerCase()}.`, [], 'ok') };
          }
          return { open: page, hide: true, say: say(`Opening ${first ? first.toLowerCase() : 'Circle Studio'}.`, [], 'ok') };
        }
        const hit = findByName(listed(), cmd.rest);
        if (hit && !hit.ambiguous) return { open: `#/projects/${hit.id}/workflow`, projectId: hit.id, hide: true, say: say(`Opening ${hit.name}.`, [], 'ok') };
        return { say: say(`Nothing to open called "${cmd.rest}".`, [`Pages: ${Object.keys(PAGES).join(', ')}.`, 'Or a project name.'], 'warn') };
      }
      case 'chat': {
        let target = p;
        if (cmd.rest) { const hit = findByName(listed(), cmd.rest); if (hit && !hit.ambiguous) target = hit; else return { say: say(`No project called "${cmd.rest}".`, [], 'warn') }; }
        if (!target) return noProject;
        return { chatWindow: target.id, hide: true, say: say(`Opening ${target.name}'s chat.`, [], 'ok') };
      }
      case 'ask': {
        if (!p) return noProject;
        if (!cmd.rest) return { say: say('Say what to ask after the word ask.', [], 'warn') };
        const note = await sayTo(p, cmd.rest);
        return { say: say(`Sent to ${p.name}'s chat.`, [note, 'The answer appears below. If the agent wants to run or change something, it asks you first.'], 'ok') };
      }
      case 'newchat': {
        if (!p) return noProject;
        if (app.sessions.isBusy(p.id, null)) return { say: say('The chat is answering.', ['Wait for it, or /stop first.'], 'warn') };
        await handlers['projects.chat.reset']({ params: { id: p.id }, query: new URLSearchParams({ engine }) });
        live.delete(p.id);
        return { say: say(`New chat in ${p.name}.`, ['Type a sentence to start it.', 'Earlier ones stay in the folder: type chats to see them, continue 1 to carry one on.'], 'ok') };
      }
      case 'chats': {
        if (!p) return noProject;
        const list = (await history(p)).slice(0, 10);
        if (!list.length) return { say: say(`No conversations in ${p.name} yet.`, ['Type a sentence to start one.']) };
        return { say: say(`Conversations in ${p.name}`, [...list.map((x, i) => `${i + 1}. ${redact(String(x.title || '(untitled)')).slice(0, 70)} · ${when(x.lastAt)}`), 'continue 2 carries that one on · new starts a new chat']) };
      }
      case 'continue': {
        if (!p) return noProject;
        const list = await history(p);
        if (!list.length) return { say: say(`No conversations in ${p.name} yet.`, ['Type a sentence to start one.'], 'warn') };
        let hit = null;
        if (!cmd.rest) hit = list[0];
        else if (/^\d{1,2}$/.test(cmd.rest)) hit = list[Number(cmd.rest) - 1] || null;
        else { const f = findByName(list, cmd.rest, (x) => [x.title]); hit = f && !f.ambiguous ? f : null; if (f?.ambiguous) return { say: say('Which one?', f.ambiguous.slice(0, 6).map((x) => `${list.indexOf(x) + 1}. ${x.title}`), 'warn') }; }
        if (!hit) return { say: say(`No conversation "${cmd.rest}".`, ['Type chats to see them, numbered.'], 'warn') };
        if (app.sessions.isBusy(p.id, null)) return { say: say('The chat is answering.', ['Wait for it, or /stop first.'], 'warn') };
        await carryOn(p, hit, engine);
        return { say: say(`Carrying on "${redact(String(hit.title || '')).slice(0, 80)}".`, [`Last active ${when(hit.lastAt)}. Type a sentence to go on; the original stays as it was.`], 'ok') };
      }
      case 'folder': return { open: '#/open-folder', hide: true, say: say('Choose the folder in Circle Studio.', [], 'ok') };
      case 'run': {
        if (!p) return noProject;
        const agents = agentsOf(p.id);
        if (!agents.length) return { say: say(`${p.name} has no workflow agents yet.`, ['/open workflow draws one; or just write to talk to the main chat.'], 'warn') };
        const { agent, message } = splitAgent(cmd.rest, agents);
        if (!agent) return { say: say('Which agent?', agents.map((a) => `run ${a.title} <message>`), 'warn') };
        if (!message) return { say: say(`What should ${agent.title} do?`, [`run ${agent.title} <message>`], 'warn') };
        await send(p, { nodeId: agent.id, engineId: agent.engine, to: agent.title, message });
        return { say: say(`${agent.title} is on it.`, ['The answer appears below. Commands and edits ask you first.'], 'ok') };
      }
      case 'stop': {
        if (!p) return noProject;
        let nodeId;
        if (cmd.rest) { const { agent } = splitAgent(cmd.rest, agentsOf(p.id)); if (!agent) return { say: say(`No agent called "${cmd.rest}".`, [], 'warn') }; nodeId = agent.id; }
        const runs = app.sessions.live(p.id).runs;
        const stopped = nodeId !== undefined ? app.sessions.stop(p.id, nodeId) : runs.map((r) => app.sessions.stop(p.id, r.nodeId || undefined)).some(Boolean);
        return { say: stopped ? say('Stopped.', [p.name], 'ok') : say('Nothing was running here.', [p.name]) };
      }
      case 'waiting': {
        const w = waitingPanel(pending(), nameOf);
        if (!w.length) return { say: say('Nothing waits for you.', [], 'ok') };
        return { say: say(`${w.length} wait${w.length === 1 ? 's' : ''} for you`, w.flatMap((x) => [`${x.n}. ${x.project} · ${x.who}: ${x.title}`, ...(x.detail ? [`     ${x.detail}`] : []), ...x.options.map((o) => `     ${o}`)]).concat(['allow 1 · deny 1 · answer 1 <answer>']), 'warn') };
      }
      case 'allow': return respondTo(cmd.rest, 'allow');
      case 'deny': return respondTo(cmd.rest, 'deny');
      case 'answer': return respondTo(cmd.rest, 'answer');
      case 'running': {
        const s = computeStats(app);
        if (!s.running.length) return { say: say('Nothing is running.', [], 'ok') };
        return { say: say(`Running now · ${s.running.length}`, s.running.map((r) => `${runLabel(r)}${r.startedAt ? ` · since ${clock(r.startedAt)}` : ''}`)) };
      }
      case 'workflow': {
        if (!p) return noProject;
        const m = workflowMap(pulse(p.id)?.workflow);
        if (!m) return { say: say(`${p.name} has no workflow yet.`, ['/open workflow draws one.']) };
        return { say: say(`${p.name}: ${m.done} of ${m.total} stages done`, [m.now, ...m.stages.map((s) => `${s.n}. ${s.title} · ${s.word}${s.agents.length ? ` · ${s.agents.map((a) => a.title).join(', ')}` : ''}`)]) };
      }
      case 'usage': {
        // your plan's limits first, as Claude Code's /usage shows them, then what was spent
        const lv = limitsView(app.limits?.get(engine) || null);
        const limitLines = lv ? [`${ENGINE_LABEL[engine] || engine} account limits`, ...lv.rows.map((r) => `${r.label}: ${r.value} used${r.resets ? ` · ${r.resets}` : ''}`), ''] : [`${ENGINE_LABEL[engine] || engine} limits unavailable. Refresh the account limits in Widgets.`, ''];
        const u = usagePanel(usageNow());
        if (!u) return { say: say(lv ? `Your plan · ${lv.rows.map((r) => `${r.label.toLowerCase()} ${r.value}`).join(' · ')}` : 'Your use', [...limitLines, 'Adding up spending... ask again in a moment.']) };
        return { say: say(lv ? `Your plan · ${lv.rows.map((r) => `${r.label.toLowerCase()} ${r.value}`).join(' · ')}` : `${u.total} in 30 days · ${u.today} today`, [...limitLines, `Spending: ${u.total} in 30 days · ${u.today} today`, u.note, ...u.rows.map((r) => `${r.label}: ${r.value}`)]) };
      }
      case 'git': {
        if (!p) return noProject;
        const g = gitPanel(pulse(p.id)?.repo);
        return { say: say(g.isRepo ? `${p.name} · ${g.branch}` : p.name, [g.line, g.last ? `Last commit: ${g.last}` : '', 'You do git yourself; this is read only.']) };
      }
      case 'pc': {
        const pc = pcStats();
        return { say: say(`Processor ${pc.cpu ?? '-'}% · memory ${pc.memPct}%`, [`${pc.cpuName} · ${pc.cores} threads`, `${pc.memUsedGb} of ${pc.memTotalGb} GB in use`, `On for ${pc.uptime}`]) };
      }
      case 'mods': {
        const all = (await Promise.resolve(handlers['mods.list']({ query: new URLSearchParams() })).catch(() => ({ mods: [] }))).mods || [];
        const m = /^(check|test|validate)\s+(.+)$/i.exec(cmd.rest);
        if (m) {
          const hit = findByName(all, m[2], (x) => [x.name, x.id]);
          if (!hit) return { say: say(`No mod called "${m[2]}".`, all.map((x) => x.name), 'warn') };
          if (hit.ambiguous) return { say: say('Which one?', hit.ambiguous.map((x) => x.name), 'warn') };
          const r = await handlers['mods.check']({ body: { plugin: hit.id } });
          const lines = [r.validate?.summary || (r.validate?.ok ? 'It loads.' : 'Claude Code refused it.'), ...(r.validate?.problems || []).slice(0, 4).map((x) => `Problem: ${typeof x === 'string' ? x : x.text || JSON.stringify(x)}`)];
          if (r.tests) lines.push(`Tests: ${r.tests.passed ?? '?'} passed, ${r.tests.failed ?? 0} failed`);
          return { say: say(`${hit.name}: ${r.ok ? 'fine' : 'has problems'}`, lines.map((l) => redact(String(l)).slice(0, 200)), r.ok ? 'ok' : 'danger') };
        }
        if (!all.length) return { say: say('No mods yet.', ['/open mods adds a ready-made one.']) };
        return { say: say(`${all.filter((x) => x.group !== 'off').length} on, of ${all.length}`, all.slice(0, 10).map((x) => `${x.group === 'off' ? 'off ' : 'on  '} ${x.name}`).concat(['mod check <name> checks one with Claude Code'])) };
      }
      default: throw badRequest('Unknown command.');
    }
  }

  return {
    'overlay.feed': async ({ query }) => {
      const project = current(query.get('projectId'));
      const pu = project ? pulse(project.id) : null;
      const stats = computeStats(app);
      const rec = project ? live.get(project.id) : null;
      // a finished answer stays two minutes, then the chat panel shows the chat again
      if (rec && rec.done && Date.now() - Date.parse(rec.doneAt) > 120_000) live.delete(project.id);
      let chat = null;
      let chatL = null;
      if (project) {
        chatL = await Promise.resolve(handlers['widgets.chat']({ query: new URLSearchParams({ projectId: project.id, size: 'l' }) })).catch(() => null);
        const c = chatL; // one read of the chat serves both
        chat = { engine: c?.engine || null, messages: (c?.messages || []).slice(-3).map((m) => ({ who: m.who, text: redact(String(m.text || '')).slice(0, 400), mine: Boolean(m.mine) })) };
      }
      const ownLive = live.get(project?.id);
      const r = ownLive?.engine === barChoice().engine ? ownLive : null;
      // widgets added from the Widgets menu, drawn like the desktop tiles for the project shown
      const extra = String(query.get('extra') || '').split(',').filter((k) => OVERLAY_EXTRAS.some((x) => x.kind === k));
      const extras = extra.length ? (await Promise.resolve(handlers['widgets.feed']({ query: new URLSearchParams({ extra: extra.join(','), projectId: project?.id || '', theme: query.get('theme') || 'dark' }) })).catch(() => null))?.tiles || [] : [];
      return {
        at: new Date().toISOString(),
        palette: readPalette(config.appRoot, query.get('theme') === 'light' ? 'light' : 'dark'),
        hotkey: hotkey(),
        project, projects: projectChoices(listed(), stats.running, pending(), project?.id),
        waiting: waitingPanel(pending(), nameOf),
        running: stats.running.map((x) => ({ title: runLabel(x), sub: [x.startedAt ? `since ${clock(x.startedAt)}` : '', x.what ? redact(String(x.what)).slice(0, 80) : ''].filter(Boolean).join(' · ') })),
        workflow: workflowMap(pu?.workflow),
        agents: project ? agentsOf(project.id).map((a) => a.title) : [],
        usage: usagePanel(usageNow()),
        // your plan's 5-hour and weekly limits, as Claude Code's /usage says them (null until Claude has answered once)
        limits: (() => { const lv = limitsView(app.limits?.get(barChoice().engine) || null); return lv ? { ...lv, from: lv.source === 'terminal' ? 'your terminal' : lv.source === 'account' ? 'your account' : 'a chat here', read: clock(lv.at) } : null; })(),
        git: pu ? gitPanel(pu.repo) : null,
        pc: pcStats(),
        chat,
        // the bottom box is the chat: its last messages in plain words, and which editor "Open in" uses
        talk: chat ? withoutLive(talkOf(chatL), r && { ...r, you: redact(plain(r.you || '')).trim() }) : null,
        bar: (() => {
          const { engine, model, engines } = barChoice();
          const t = project ? app.sessions.turnOf(project.id, null) : null;
          let where = null; try { where = project ? projects.get(project.id).path : null; } catch { /* gone */ }
          return { engine, engineLabel: ENGINE_LABEL[engine] || engine, model, engines: engines.length, where, now: t && t.tools.length ? redact(String(t.tools[t.tools.length - 1].summary || '')).slice(0, 120) : null, waiting: t?.waiting?.length || 0, lined: app.queue.list(project?.id).filter((e) => e.status === 'queued').length };
        })(),
        editor: findEditor()?.name || null,
        live: r ? { to: r.to, you: redact(r.you), text: redact(r.text).slice(-1500), error: r.error ? redact(r.error).slice(0, 300) : null, done: r.done } : null,
        notices: (app.notices.list(3).notices || []).map((n) => ({ title: n.title, at: clock(n.at), read: n.read })),
        examples: ['help', 'waiting', 'allow 1', 'ask what changed today?', 'new', 'chats', 'continue 1', 'folder', 'project <name>', 'run <agent> <message>'],
        locked: settings.get().widgetsLocked === true,
        extras, extrasOffered: OVERLAY_EXTRAS,
      };
    },
    // A reply typed on a desktop card (or anywhere outside the app): to the main chat or an agent's.
    'overlay.say': async ({ body }) => {
      if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw badRequest('text is required (at most 4000 characters).');
      const p = current(typeof body?.projectId === 'string' ? body.projectId : null);
      if (!p) throw badRequest('No project yet.');
      const nodeId = typeof body?.nodeId === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(body.nodeId) ? body.nodeId : null;
      if (app.sessions.isBusy(p.id, nodeId)) return { sent: false, say: say('It is still answering.', ['Wait for it, or stop it first.'], 'warn') };
      const note = await sayTo(p, body.text.trim(), nodeId, { engine: body?.engine, model: body?.model, reasoning: body?.reasoning, conversationId: body?.conversationId });
      return { sent: true, projectId: p.id, say: say(`Sent to ${p.name}.`, [note, 'The answer comes back here.'], 'ok') };
    },
    // The answers waiting as desktop cards: what you asked, what came back (plain words, masked), and the file it was on.
    'desktop.replies': async () => {
      const out = [];
      for (const r of app.replies?.list() || []) {
        let p;
        try { p = projects.get(r.projectId); } catch { continue; }
        const key = app.sessions.chatKey(r.projectId, r.nodeId, r.engine || 'claude');
        let msgs = app.chats.get(key).messages || [];
        if (r.conversationId) { try { let offset = 0; msgs = []; do { const page = app.chats.read(key, r.conversationId, { offset, limit: 400 }); msgs.push(...page.messages.filter((m) => !r.runId || m.runId === r.runId)); offset = page.nextOffset; } while (offset != null); } catch { continue; } }
        const answer = [...msgs].reverse().find((m) => m.role === 'assistant' && m.text);
        const asked = [...msgs].reverse().find((m) => m.role === 'user');
        if (!answer) continue;
        const file = await fileOf(p, r.nodeId).catch(() => null);
        const text = redact(plain(answer.text)).trim();
        out.push({
          id: r.id, projectId: p.id, project: p.name, nodeId: r.nodeId, who: r.nodeId ? (agentsOf(p.id).find((a) => a.id === r.nodeId)?.title || r.nodeId) : (r.engine || 'claude').replace(/^./, (c) => c.toUpperCase()),
          asked: asked ? redact(String(asked.text || '')).replace(/\s+/g, ' ').slice(0, 160) : '',
          engine: r.engine, conversationId: r.conversationId, url: r.conversationId ? `#/projects/${p.id}/chat/${r.engine}/${r.conversationId}${r.nodeId ? `/${r.nodeId}` : ''}` : `#/projects/${p.id}/chat`,
          text: text.length > 1500 ? `${text.slice(0, 1500)}…` : text,
          file: file ? path.relative(p.path, file).split(path.sep).join('/') : null,
          at: r.at,
        });
      }
      return { replies: out, editor: findEditor()?.name || null };
    },
    'desktop.replies.dismiss': ({ body }) => ({ dismissed: Boolean(app.replies?.dismiss(String(body?.id || ''))) }),
    // The project's folder in File Explorer (explorer.exe with the folder as its only argument, no shell).
    'desktop.folder': async ({ body }) => {
      const folder = typeof body?.folder === 'string' ? askedFolder(body.folder) : (() => { const p = current(typeof body?.projectId === 'string' ? body.projectId : null); if (!p) throw badRequest('No project yet.'); return projects.get(p.id).path; })();
      if (!process.env.NODE_TEST_CONTEXT && process.platform === 'win32') {
        const child = (app.overrides?.spawnExplorer || spawn)(path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), [folder], { detached: true, stdio: 'ignore', env: cleanEnv() });
        child.on?.('error', () => {}); child.unref?.();
      }
      return { opened: true, folder };
    },
    // The terminal (or editor) window this project's conversation runs in, or a new terminal that carries it on.
    'desktop.terminal': async ({ body }) => {
      // a terminal's request names its folder: only its window is looked for (nothing is opened in a folder you never added)
      if (typeof body?.folder === 'string') {
        const folder = askedFolder(body.folder);
        const find = app.overrides?.findWindow || (process.env.NODE_TEST_CONTEXT ? async () => ({ found: false }) : findWorkWindow);
        const w = await find({ folder, titles: [], only: 'terminal' });
        return { shown: Boolean(w.found), opened: false, app: w.app || null, window: w.found ? redact(w.title).slice(0, 120) : null, resumed: null, say: w.found ? say(`Showing ${w.kind === 'editor' ? 'the editor' : 'the terminal'}: ${redact(w.title).slice(0, 80)}`, [], 'ok') : say('Its terminal could not be found.', [folder], 'warn') };
      }
      const p = current(typeof body?.projectId === 'string' ? body.projectId : null);
      if (!p) throw badRequest('No project yet.');
      const mode = ['auto', 'show', 'new'].includes(body?.mode) ? body.mode : 'auto';
      const r = await openTerminal(p, mode, { engine: body?.engine, model: body?.model, reasoning: body?.reasoning, nodeId: body?.nodeId, conversationId: body?.conversationId });
      return { shown: Boolean(r.shown), opened: Boolean(r.opened), app: r.app || null, window: r.window || null, resumed: r.resumed || null, say: r.say };
    },
    // Open the project in your editor (Antigravity IDE, else VS Code), at the file the agent last worked on.
    'desktop.editor': async ({ body }) => {
      const p = current(typeof body?.projectId === 'string' ? body.projectId : null);
      if (!p) throw badRequest('No project yet.');
      const nodeId = typeof body?.nodeId === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(body.nodeId) ? body.nodeId : null;
      const file = body?.file === false ? null : await fileOf(p, nodeId).catch(() => null);
      // the main chat comes along as a page, kept up to date while this server runs
      const page = nodeId ? null : await writeChatPage(p.id).catch(() => null);
      const r = openInEditor({ folder: projects.get(p.id).path, file, also: page ? [page] : [], spawnImpl: app.overrides?.spawnEditor || (process.env.NODE_TEST_CONTEXT ? () => ({}) : undefined) });
      return { ...r, file: r.file ? path.relative(projects.get(p.id).path, r.file).split(path.sep).join('/') : null };
    },
    'overlay.command': async ({ body }) => {
      if (typeof body?.text !== 'string' || body.text.length > 4000) throw badRequest('text is required (at most 4000 characters).');
      const text = body.text;
      const project = current(typeof body?.projectId === 'string' ? body.projectId : null);
      // the overlay's bar: a message goes to the chat (even one word); / is for commands
      if (body?.from === 'bar') {
        try {
          const out = await barLine(text, project);
          return { command: out.sent ? 'ask' : 'bar', projectId: out.projectId || project?.id || null, open: out.open || null, chatWindow: out.chatWindow || null, hide: out.hide === true, say: out.say || null };
        } catch (e) {
          if (e.status && e.status >= 500) throw e;
          return { command: 'bar', projectId: project?.id || null, open: null, chatWindow: null, hide: false, say: say('That did not work.', [redact(String(e.message || e)).slice(0, 300)], 'danger') };
        }
      }
      // from a chat box: only `/word` commands run here; the rest is the agent's (the chat sends it as it is)
      const fromChat = body?.from === 'chat';
      const cmd = fromChat ? chatCommand(text) : parseCommand(text);
      if (!cmd) return { command: 'none', projectId: project?.id || null };
      if (fromChat && (cmd.id === 'ask' || cmd.id === 'hide')) return { command: cmd.id, projectId: project?.id || null, passthrough: cmd.id === 'ask' ? cmd.rest : null };
      try {
        const selectedEngine = body?.engine;
        if (selectedEngine && !app.engines.adapter(selectedEngine)) throw badRequest('Unknown command engine.');
        const out = await run(cmd, project, selectedEngine);
        // in a chat box a command needs its slash, so the hints say it with one
        if (fromChat && out.say) {
          // only hints: "allow 1", "continue 2", "· new starts", "type open inbox" (never the words of a request)
          const slash = (l) => String(l)
            .replace(/(^|· )(allow|deny|answer|continue) (?=\d|<)/g, '$1/$2 ')
            .replace(/· new starts/g, '· /new starts')
            .replace(/\b([Tt]ype) (help|open|stop|chats|waiting|allow|deny|answer|new|continue|folder|run)\b/g, '$1 /$2')
            .replace(/(Type \/\w+ or) (allow|deny)\b/g, '$1 /$2');
          out.say = { ...out.say, title: out.say.title, lines: (out.say.lines || []).map(slash) };
        }
        return { command: cmd.id, projectId: out.projectId || project?.id || null, open: out.open || null, chatWindow: out.chatWindow || null, hide: out.hide === true, say: out.say };
      } catch (e) {
        if (e.status && e.status >= 500) throw e;
        return { command: cmd.id, projectId: project?.id || null, open: null, chatWindow: null, hide: false, say: say('That did not work.', [redact(String(e.message || e)).slice(0, 300)], 'danger') };
      }
    },
  };
}
