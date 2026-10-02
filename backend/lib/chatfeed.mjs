// What the Chat widget shows for one project: the main chat (the newest of your Claude Code conversations in the
// folder and Circle Studio's own main chat) and, when there are any, the agents' chats: a workflow agent's chat in
// Circle Studio, or its runs inside your Claude Code conversations, plus other agents those conversations used.
// One thread is shown at a time, its last few messages, clipped. Read only, from this PC.
import { listConversations, readConversation, agentRuns } from './cchistory.mjs';
import { redact } from './secrets.mjs';

const THREAD_RE = /^(main|node:[A-Za-z0-9_-]{1,60}|run:[A-Za-z0-9 _.-]{1,80})$/;
const clip = (t, n) => { const s = redact(String(t || '')).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const newest = (a, b) => (!a ? b : !b ? a : String(b.lastAt || '') > String(a.lastAt || '') ? b : a);

export function createChatFeed({ claudeHome, chats, chatKey, workflowOf }) {
  const cache = new Map(); // conversation file + its time -> messages (so a 15 second refresh does not reread big files)
  async function readCC(root, sessionId, run, lastAt) {
    const k = `${root}|${sessionId}|${run || ''}|${lastAt}`;
    if (cache.has(k)) return cache.get(k);
    const c = await readConversation(claudeHome, root, sessionId, { run, limit: 12 }).catch(() => null);
    const msgs = (c?.messages || []).filter((m) => m.role !== 'note');
    if (cache.size > 60) cache.clear();
    cache.set(k, msgs);
    return msgs;
  }
  const circle = (key) => { const c = chats.get(key); const m = (c.messages || []).filter((x) => x.role === 'user' || x.role === 'assistant'); return m.length ? { messages: m.slice(-12), lastAt: m.at(-1).at || null } : null; };

  /** { threads: [{ id, label, lastAt, source }], selected, messages: [{ who, mine, text, at }], title } */
  async function chatOf(project, { nodeId = 'main', size = 'm' } = {}) {
    const want = THREAD_RE.test(String(nodeId || '')) ? nodeId : 'main';
    if (!project?.exists) return { threads: [], selected: null, messages: [], empty: 'This folder is missing.' };
    const convs = listConversations(claudeHome, project.path, { limit: 4 }).conversations;
    let wf = null;
    try { wf = workflowOf(project); } catch { /* no workflow yet */ }
    const agents = (wf?.nodes || []).filter((n) => n.kind === 'agent');

    // the threads that exist, newest first after "Main chat"
    const threads = [];
    const mainCircle = circle(chatKey(project.id, null, 'claude'));
    const mainCC = convs[0] ? { lastAt: convs[0].lastAt, cc: convs[0] } : null;
    const main = newest(mainCircle && { ...mainCircle, src: 'circle' }, mainCC && { ...mainCC, src: 'cc' });
    if (main) threads.push({ id: 'main', label: 'Main chat', lastAt: main.lastAt, source: main.src === 'cc' ? 'Claude Code' : 'Circle Studio', data: main });
    const usedTypes = new Set();
    for (const n of agents) {
      const own = circle(chatKey(project.id, n.id, n.engine || 'claude'));
      const run = agentRuns(convs, [n.id, n.title])[0];
      if (run) usedTypes.add(run.agentType.toLowerCase());
      const pick = newest(own && { ...own, src: 'circle' }, run && { lastAt: run.lastAt, run, src: 'cc' });
      if (pick) threads.push({ id: `node:${n.id}`, label: n.title || n.id, lastAt: pick.lastAt, source: pick.src === 'cc' ? 'Claude Code' : 'Circle Studio', data: pick });
    }
    // other agents your Claude Code conversations used (for example Explore), once each
    for (const c of convs) {
      for (const a of c.agents || []) {
        const type = a.agentType || 'agent';
        if (usedTypes.has(type.toLowerCase()) || threads.length >= 9) continue;
        usedTypes.add(type.toLowerCase());
        threads.push({ id: `run:${type}`.slice(0, 84), label: type, lastAt: c.lastAt, source: 'Claude Code', data: { run: { ...a, sessionId: c.id }, src: 'cc' } });
      }
    }
    if (!threads.length) return { threads: [], selected: null, messages: [], empty: 'No chats in this project yet.' };

    const sel = threads.find((t) => t.id === want) || threads[0];
    let raw = [];
    const d = sel.data;
    if (d.src === 'circle') raw = d.messages;
    else if (d.cc) raw = await readCC(project.path, d.cc.id, null, d.cc.lastAt);
    else if (d.run) raw = await readCC(project.path, d.run.sessionId, d.run.run, d.lastAt || '');
    const who = sel.id === 'main' ? 'Claude' : sel.label;
    // an agent run inside a Claude Code conversation is asked by the main chat, not by you
    const asker = d.src === 'cc' && d.run ? 'Main chat' : 'You';
    const max = size === 'l' ? 7 : 3;
    const messages = raw.slice(-max).map((m) => {
      const text = m.text ? clip(m.text, size === 'l' ? 260 : 150) : m.tools?.length ? `Used ${[...new Set(m.tools.map((x) => x.name))].slice(0, 4).join(', ')}` : '';
      return { who: m.role === 'user' ? asker : who, mine: m.role === 'user' && asker === 'You', text, at: m.at || null };
    }).filter((m) => m.text);
    return {
      threads: threads.map(({ id, label, lastAt, source }) => ({ id, label: clip(label, 40), lastAt, source })),
      selected: sel.id,
      title: sel.id === 'main' && d.cc ? clip(d.cc.title, 80) : null,
      messages,
      empty: messages.length ? null : 'Nothing said in this chat yet.',
    };
  }
  return { chatOf };
}
