// "Ask Circle": the app's own guide. Help topics answer "how do I..." with no AI at all (a local search); a question
// can also go to any engine the human has signed in to (Claude, Codex, Gemini or Copilot), run read-only in an empty
// folder of the app's data with the help topics and a short summary of the human's projects as context.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './secrets.mjs';

export const TOPICS = [
  { id: 'start', title: 'Start with a folder', href: '#/', keywords: 'start begin open folder project new add first', text: 'On Home, press "Open a folder" and pick a project folder, or type what you want to make in "What do you want to create today?" to start a new project. Circle Studio asks what it may do there (change files, run commands, send text to an engine) before anything else.' },
  { id: 'workflow', title: 'Build the workflow', href: 'workflow', keywords: 'workflow graph stage agent node link arrow tidy add helper template', text: 'The Workflow tab is a graph: You, stages and agents. Drag from the small dot on a card to another card to link them; click a link to remove it. Click a card to set its engine, model, skills and job. "Workflow helper" proposes a workflow from a description. Save version keeps a numbered version; "Review and write files" shows the diff before writing agent files.' },
  { id: 'checkpoint', title: 'Checkpoints between stages', href: 'workflow', keywords: 'gate checkpoint approve review arrow marker who checks', text: 'The marker on an arrow between two stages is a checkpoint: choose Go on, You decide, An engine checks (for example Codex), or Engine then you.' },
  { id: 'chat', title: 'Talk to the main session or an agent', href: 'chat', keywords: 'chat talk ask agent session claude message continue conversation history earlier terminal', text: 'Chat runs a real agent in the project folder. Everything it wants to run or change asks you first. "Earlier conversations" lists the Claude Code conversations you had in a terminal in this folder: open one to read it, or "Continue it here" (a copy, so the original stays). In the graph, click You for the main session or an agent for its own chat and earlier runs.' },
  { id: 'inbox', title: 'Answer what agents ask', href: '#/inbox', keywords: 'inbox approve deny allow question popup waiting request permission answer alert', text: 'When an agent wants to run a command, edit a file or asks a question, a popup opens and it waits in the Inbox. Team questions from docs/tasks/ALERTS.md are answered there too. With "Ask me on the desktop" on (Settings, Desktop), the same request also pops up as a card at the bottom right of your screen, to Allow, Deny or answer right there. With alerts on, Windows tells you even when the app is in the background or closed.' },
  { id: 'widget', title: 'Widgets on the desktop', href: '#/widgets', keywords: 'widget widgets board tile desktop pin start menu home screen small window shortcut taskbar rings spending', text: 'Widgets (in the menu, below Connections): "Put on desktop" puts real widgets on your desktop (drag them anywhere, right-click for options). The page holds the tiles you choose: rings for every agent (green working, amber waiting for you, blue done, grey idle), spending by provider, a workflow you can switch between projects, what waits for you. Press Edit on the board to add, resize or reorder; each tile can open in its own window. In a project, Widget opens that project\'s widget or adds it to the board.' },
  { id: 'start', title: "Let's begin: set up an AI tool", href: '#/start', keywords: 'start begin first install sign in login setup claude codex gemini copilot openclaw engine missing not installed no claude', text: "Circle Studio has no AI of its own: it runs Claude Code, Codex, Gemini (Antigravity) or GitHub Copilot with your own sign-in. Let's begin (the AI tools line at the bottom of the menu, or Ctrl+K) shows which are ready and the exact install and sign-in commands, with Do it for me to run them in a terminal. No API key is needed. Without Claude Code, the workflow helper and Find skills are off; agents still run on the others." },
  { id: 'patterns', title: 'Helpers, condensing and patterns', href: '#/', keywords: 'pattern patterns helper haiku reader condense condensing context compact smaller cheaper model hook explore try', text: 'In a project, Workflow: an agent\'s Haiku reader shows beside it (dashed). Click it to choose: when it decides, or automatically above a context limit (long command output, pages and searches are then shortened by Haiku, the full output kept in a file; files it reads are never shortened; it works when the team runs in Claude Code). Patterns (next to Workflow helper) lists ways to shape the team with when they pay off and when not, which fit your agents and why, and Try on an agent with Undo. The Cost tab shows what condensing saved.' },
  { id: 'skills-find', title: 'Which skills do my agents need?', href: '#/library', keywords: 'skill skills find github suggest recommend which need import library how-to card', text: 'Skills are how-to cards read when a task needs them. In a project, Workflow, open the Workflow helper and press Find skills: it works out what is missing, searches GitHub and suggests a few, each with what it does and who it is for. Tick and add, or paste a GitHub address to see what is in it.' },
  { id: 'connections', title: 'Tools (MCP), keys and security', href: '#/keys', keywords: 'mcp connector connection server tool plugin key vault api token secret security safe github healthy broken duplicate', text: 'Keys (in the menu): paste an API key once; it stays on this PC, encrypted. In a project, the Connections tab shows the tools its agents can use (its own, every project\'s, and what plugins bring), whether each works and has its key: Key gives it a saved key, Add a tool adds one (and warns when the project already has it, for example from a plugin), Remove takes one away, Test starts it and says how to fix it. Keys, "Everything on this PC" has the manager (Fix it for me, Make it one shared server, Clean them up) and the security check.' },
  { id: 'catalog', title: 'How the helper recommends building blocks', href: '#/library', keywords: 'helper recommend best skill catalog rag index page database describe haiku reader condense', text: 'The workflow helper reads the project folder, the building blocks you already have (the Catalog in the Library, with one-line descriptions Haiku can write) and pages you indexed, and recommends from those. Index a link in the Catalog so the helper can quote it. On an expensive agent that reads a lot, turn on "Haiku reader" so a cheap model reads long files for it.' },
  { id: 'mods', title: 'Mods and plugins: for every project, or one', href: '#/mods', keywords: 'mod mods plugin plugins claude code hook hooks status line pane band colour color context look theme general global project only enable disable turn on off', text: 'Mods change Claude Code itself: how the chat looks (panes, a band above the prompt, the status line, colours), what Claude reads (the prompt and context), and how commands are checked. Plugins add skills, agents, commands and tools. Mods (in the menu) shows them all: For every project, Only some projects, Not on anywhere, with filters by what they change. In a project, the Mods tab turns one on or off for that project only (a diff of .claude/settings.json you review first) or for every project (Circle Studio runs claude plugin enable or disable --scope user). Details shows what it brings and its context cost. Install new ones in Claude Code with /plugin. From a terminal: npm run mods.' },
  { id: 'desktop', title: 'Work from the desktop: cards that ask, Ctrl+Alt+C, the activity ring', href: '#/widgets', keywords: 'desktop notification notify card popup hotkey shortcut front ctrl alt c ring activity running where when home screen', text: 'With "Ask me on the desktop" on (Settings, Desktop; on by default), an agent that wants to run something or asks a question shows a card at the bottom right of your screen, above other windows: press Allow or Deny, or pick an answer, without opening Circle Studio. Put the tiles on your desktop (Widgets, Put on desktop) and press Ctrl+Alt+C anywhere to bring them in front of your windows; press it again to put them back (if another app holds those keys, Ctrl+Alt+W or Win+Alt+C is used: the Widgets page says which). The Activity tile is a ring per project: it turns while the project works, pulses amber while it waits for you and is full blue when just done. Running now says what runs where and since when, including Claude Code in a terminal.' },
  { id: 'mod-make', title: 'Make a mod (a game while Claude works, a context check)', href: '#/mods', keywords: 'make build create mod game mini game waiting context check test tests validate turn-check waiting-game', text: 'Mods, Make your own: "Add to this project" puts a ready-made mod in the project\'s .claude/skills folder after you review the diff (waiting-game: catch the dot while Claude works; turn-check: after each turn, how full the context is, how long it took and whether tests ran after a change). Or describe what you want and press "Ask Claude to build it": the project\'s chat opens with the request written out; every file Claude writes asks you first. Check, on any mod, loads it the way Claude Code will (claude plugin validate) and runs its tests (claude plugin test). Mods run when you use Claude Code in that folder (a terminal or your IDE).' },
  { id: 'cost', title: 'See and cut the cost', href: 'cost', keywords: 'cost price money tokens spend cheaper model haiku sonnet opus budget usage expensive context', text: 'The Cost tab shows what the folder used with Claude Code in the last 30 days (priced at API rates; on a Pro or Max plan you pay the subscription), what loads before you type, the model of each agent, and ways to spend less: apply a cheaper model or let the AI rearrange the workflow. Changes are saved as a new version and reviewed before files are written.' },
  { id: 'health', title: 'Is the project healthy?', href: 'health', keywords: 'health problem blocked freeze adr decision secret key drift warning', text: 'Health lists what needs you now (paused work, decisions waiting, keys written in files) and what is worth a look, in plain words; technical details are under Details. The chips in the project header link there.' },
  { id: 'git', title: 'Git and GitHub', href: 'git', keywords: 'git github branch push pull commit actions ci pull request pr', text: 'The branch chip in a project header shows what is not pushed or pulled and uncommitted files. Open it for GitHub Actions runs and pull requests (turn GitHub on for the project; private repositories need the gh CLI). Circle Studio only reads git: you do git yourself.' },
  { id: 'skills', title: 'Skills', href: '#/library', keywords: 'skill library import github install skills folder', text: 'Library keeps skills for every engine. Import from a GitHub URL, edit, and install into a project (each engine gets its own folder). A project\'s Skills tab shows what it has.' },
  { id: 'engines', title: 'Engines and sign-in', href: '#/settings', keywords: 'engine claude codex gemini copilot login sign in install not available api key', text: 'Circle Studio drives Claude Code, Codex, Gemini (agy) and GitHub Copilot through your own sign-in in a terminal: no API key is used or stored. Settings shows which are installed and signed in, and what each can do here.' },
  { id: 'update', title: 'Install and update', href: '#/settings', keywords: 'update upgrade version install uninstall doctor new release startup login boot', text: 'Settings, Updates checks once a day and updates when you press Update (only moving forward, never over your changes). From a terminal: npm run update, npm run doctor, npm run uninstall. "Install Circle Studio.cmd" installs it for a new user. Settings, Desktop can start it at sign-in.' },
  { id: 'privacy', title: 'What leaves this PC', href: '#/settings', keywords: 'privacy data local send leave secret telemetry offline', text: 'Only what you send in a chat, the Advisor, the helper or this guide (through the engine you picked), and GitHub reads you turn on. No telemetry, no account. Secrets are masked before anything is shown or sent.' },
];

const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];

/** The help topics that best match a question (no AI). */
export function searchHelp(question, limit = 3) {
  const q = words(question).filter((w) => w.length > 2);
  if (!q.length) return [];
  return TOPICS.map((t) => {
    const hay = new Set(words(`${t.title} ${t.keywords}`));
    const body = words(t.text);
    let score = 0;
    for (const w of q) { if (hay.has(w)) score += 3; else if ([...hay].some((h) => h.startsWith(w) || w.startsWith(h))) score += 2; else if (body.includes(w)) score += 1; }
    return { ...t, score };
  }).filter((t) => t.score >= 2).sort((a, b) => b.score - a.score).slice(0, limit);
}

export function guidePrompt({ question, summary }) {
  return [
    'You are "Ask Circle", the guide inside Circle Studio: a local Windows app where one person runs AI agent teams (Claude Code, Codex, Gemini, Copilot) on their own project folders.',
    'Answer the question in plain, friendly words, in at most 8 short sentences or a short list. Say which screen to open and what to press. If the question is about their project itself (code, design, a bug), answer briefly and suggest opening the project\'s Chat for real work in the folder. Do not run tools; you cannot see their files. Never ask for or mention API keys.',
    'How Circle Studio works:',
    ...TOPICS.map((t) => `- ${t.title}: ${t.text}`),
    summary ? `Their situation right now: ${summary}` : '',
    `Question: ${question}`,
  ].filter(Boolean).join('\n');
}

/** A folder in the app's data for the guide's engine runs: empty, so nothing of a project is in reach. */
export function guideFolder(dataDir) {
  const dir = path.join(dataDir, 'guide');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** One read-only answer from an engine adapter: every tool request is refused. */
export async function askEngine(adapter, { prompt, cwd, timeoutMs = 120_000 }) {
  let text = '';
  let error = null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await adapter.runTurn({
      cwd, prompt, model: adapter.id === 'claude' ? 'haiku' : undefined, sessionId: null, signal: ctl.signal, runId: 'guide',
      systemPrompt: 'Answer from what you are told. Do not use tools.',
      emit: (name, data) => { if (name === 'text') text += data.delta || ''; else if (name === 'error') error = data.message; },
      onRequest: async () => ({ decision: 'deny', message: 'The guide answers without tools.' }),
    });
  } finally { clearTimeout(timer); }
  if (!text.trim() && ctl.signal.aborted) error ||= 'The engine took too long to answer.';
  return { reply: redact(text.trim()).slice(0, 6000), error: error ? redact(String(error)).slice(0, 400) : null };
}
