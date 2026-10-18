// The overlay (Ctrl+Alt+C): what it shows (overlay.feed) and the commands typed into it (overlay.command).
// Commands only do what a button elsewhere in Circle Studio does: open a page, answer what waits, send a chat message
// (the agent still asks before every command and edit), stop a run, check a mod. Nothing here writes into a project.
import { badRequest } from './lib/errors.mjs';
import { redact } from './lib/secrets.mjs';
import { computeStats } from './lib/stats.mjs';
import { readPalette } from './lib/palette.mjs';
import { runLabel } from './lib/feed.mjs';
import {
  parseCommand, findByName, splitAgent, splitNumber, pcStats, waitingPanel, workflowMap, usagePanel, gitPanel, helpLines, PAGES,
} from './lib/overlay.mjs';
import fs from 'node:fs';
import path from 'node:path';

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  const current = (id) => { const all = listed(); return all.find((p) => p.id === id) || all[0] || null; };
  const nameOf = (id) => { try { return projects.get(id).name; } catch { return id; } };
  const pulse = (id) => { try { return handlers['projects.pulse']({ params: { id } }); } catch { return null; } };
  const agentsOf = (id) => {
    try { return app.workflows.head(projects.get(id)).nodes.filter((n) => n.kind === 'agent').map((n) => ({ id: n.id, title: n.title || n.id, engine: n.engine || 'claude' })); } catch { return []; }
  };
  const pending = () => app.inbox.list({ status: 'pending' }).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const hotkey = () => { try { return fs.readFileSync(path.join(config.dataDir, 'desktop-widgets.hotkey'), 'utf8').trim().slice(0, 40) || null; } catch { return null; } };

  // Start a chat turn and let it run on its own: the overlay reads the answer as it comes, from overlay.feed.
  async function send(project, { nodeId = null, engineId = 'claude', to, message }) {
    await app.sessions.preflight({ projectId: project.id, nodeId, engineId });
    const rec = { you: message.slice(0, 2000), to, text: '', error: null, done: false, at: new Date().toISOString(), doneAt: null, nodeId };
    live.set(project.id, rec);
    const ctl = new AbortController();
    app.sessions.runTurn({
      projectId: project.id, nodeId, engineId, message,
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
      if (qs.length !== 1) return { say: say('This one has several questions.', ['Type open inbox to answer them.'], 'warn'), open: '#/inbox' };
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

  async function run(cmd, project) {
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
        const c = await Promise.resolve(handlers['widgets.chat']({ query: new URLSearchParams({ projectId: p.id }) })).catch(() => null);
        const engineId = c?.engine && c.engine !== 'cc' ? c.engine : 'claude';
        await send(p, { engineId, to: 'Main chat', message: cmd.rest });
        return { say: say(`Sent to ${p.name}'s chat.`, ['The answer appears below. If the agent wants to run or change something, it asks you first.'], 'ok') };
      }
      case 'run': {
        if (!p) return noProject;
        const agents = agentsOf(p.id);
        if (!agents.length) return { say: say(`${p.name} has no workflow agents yet.`, ['Type open workflow to draw one, or ask to talk to the main chat.'], 'warn') };
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
        if (!m) return { say: say(`${p.name} has no workflow yet.`, ['Type open workflow to draw one.']) };
        return { say: say(`${p.name}: ${m.done} of ${m.total} stages done`, [m.now, ...m.stages.map((s) => `${s.n}. ${s.title} · ${s.word}${s.agents.length ? ` · ${s.agents.map((a) => a.title).join(', ')}` : ''}`)]) };
      }
      case 'usage': {
        const u = usagePanel(usageNow());
        if (!u) return { say: say('Adding up your use...', ['Ask again in a moment.']) };
        return { say: say(`${u.total} in 30 days · ${u.today} today`, [u.note, ...u.rows.map((r) => `${r.label}: ${r.value}`)]) };
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
        if (!all.length) return { say: say('No mods yet.', ['Type open mods to add a ready-made one.']) };
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
      if (project) {
        const c = await Promise.resolve(handlers['widgets.chat']({ query: new URLSearchParams({ projectId: project.id, size: 'm' }) })).catch(() => null);
        chat = { engine: c?.engine || null, messages: (c?.messages || []).slice(-3).map((m) => ({ who: m.who, text: redact(String(m.text || '')).slice(0, 400), mine: Boolean(m.mine) })) };
      }
      const r = live.get(project?.id);
      return {
        at: new Date().toISOString(),
        palette: readPalette(config.appRoot, query.get('theme') === 'light' ? 'light' : 'dark'),
        hotkey: hotkey(),
        project, projects: listed(),
        waiting: waitingPanel(pending(), nameOf),
        running: stats.running.map((x) => ({ title: runLabel(x), sub: [x.startedAt ? `since ${clock(x.startedAt)}` : '', x.what ? redact(String(x.what)).slice(0, 80) : ''].filter(Boolean).join(' · ') })),
        workflow: workflowMap(pu?.workflow),
        agents: project ? agentsOf(project.id).map((a) => a.title) : [],
        usage: usagePanel(usageNow()),
        git: pu ? gitPanel(pu.repo) : null,
        pc: pcStats(),
        chat,
        live: r ? { to: r.to, you: redact(r.you), text: redact(r.text).slice(-1500), error: r.error ? redact(r.error).slice(0, 300) : null, done: r.done } : null,
        notices: (app.notices.list(3).notices || []).map((n) => ({ title: n.title, at: clock(n.at), read: n.read })),
        examples: ['help', 'waiting', 'allow 1', 'ask what changed today?', 'open inbox', 'project <name>', 'run <agent> <message>', 'pc'],
        locked: settings.get().widgetsLocked === true,
      };
    },
    'overlay.command': async ({ body }) => {
      if (typeof body?.text !== 'string' || body.text.length > 4000) throw badRequest('text is required (at most 4000 characters).');
      const text = body.text;
      const project = current(typeof body?.projectId === 'string' ? body.projectId : null);
      const cmd = parseCommand(text);
      try {
        const out = await run(cmd, project);
        return { command: cmd.id, projectId: out.projectId || project?.id || null, open: out.open || null, chatWindow: out.chatWindow || null, hide: out.hide === true, say: out.say };
      } catch (e) {
        if (e.status && e.status >= 500) throw e;
        return { command: cmd.id, projectId: project?.id || null, open: null, chatWindow: null, hide: false, say: say('That did not work.', [redact(String(e.message || e)).slice(0, 300)], 'danger') };
      }
    },
  };
}
