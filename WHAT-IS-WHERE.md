# Circle Studio: what is built, and where it is

A map of everything in this folder, written 2026-10-04, kept up to 2026-10-19 (version 17.14). For *how* it is built and what is fixed, see
`docs/spec.md`; for why things changed from the original request, `docs/decisions.md`; for install and commands,
`README.md`.

**In one line:** a local Windows control room for AI agent teams. Node 24 built-ins only, plain JavaScript, no build
step, served on `http://127.0.0.1:4380`. It runs Claude Code, Codex, Gemini (`agy`) and GitHub Copilot through your own
sign-ins, never an API key.

About 29,000 lines across `backend/`, `frontend/`, `scripts/` and `tests/`. 300 tests: 297 pass, 3 skip (they need an
optional reference folder).

---

## 1. The folder at a glance

| Folder / file | What it is |
|---|---|
| `backend/` | The server: routes, services, and `lib/` with all the logic |
| `backend/lib/engines/` | One adapter per AI tool (Claude, Codex, Gemini, Copilot) |
| `backend/seed/` | Things copied out once: the starter template, the pattern store, the condense hook |
| `frontend/` | The web app: `index.html` (main app), `widget.html` (widget windows), `js/`, `css/` |
| `scripts/` | Launcher, installer CLI, desktop widgets (PowerShell), contrast check |
| `contracts/api.json` | Every API route (id, method, path). Tests check backend and frontend both match it |
| `tests/` | Unit, contract, integration and one live test, plus fake CLIs |
| `docs/` | Spec, decisions, design rules, the original request, research notes |
| `data/` | **Your** runtime data (projects list, chats, vault...). Never in git |
| `Install Circle Studio.cmd` | Double-click installer for new users |
| `package.json` | `npm` commands (setup, open, start, stop, update, doctor, test...) |
| `README.md` | Install, commands, updates, publishing, feature table |
| `CLAUDE.md` | The rules for whoever (human or AI) works on the code |
| `trail.md` | An old test log from an earlier team; safe to delete (`git rm trail.md`) |
| `.playwright-mcp/` | Leftover browser-check logs from building; ignored by git, safe to delete |
| `Desktopcircle-studio-site` (a separate folder, not in this repository) | The public website for Vercel, with the Download button. Static HTML, uses a copy of `tokens.css`. Its own `README.md` says how to deploy |

---

## 2. Every feature, and where it lives

Each row: what you see, the screen file, the backend files, and the tests that cover it.

### Home, projects, permissions

| Feature | Screen (frontend) | Logic (backend) | Tests |
|---|---|---|---|
| Home: what needs you, what runs, every project | `js/views/home.js` | `lib/stats.mjs`, `lib/agentstate.mjs`, `lib/projects.mjs` | `integration/api.test.mjs` |
| Open a folder (Windows folder dialog) | `js/components/openfolder.js` | `lib/pickfolder.mjs` | `integration/api.test.mjs` |
| What the app may do in a folder | `js/components/permissions.js` | `lib/projects.mjs` | `integration/api.test.mjs` |
| New project from "What do you want to create today?" | `js/components/newproject.js` | `routes.workflow.mjs`, `lib/render.mjs`, `lib/templates.mjs` | `integration/workflow.test.mjs` |
| Project page (header, tabs) | `js/views/project.js` | `routes.mjs` | |
| Left taskbar (create box, recent, navigation) | `js/components/rail.js` | `lib/stats.mjs` | |
| Ctrl+K palette and shortcut sheet | `js/components/palette.js` | | |

### Workflow (the graph)

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| The graph: You, numbered stages, agents on branch lines, links; hover lights what a card is linked to; Tidy glides; a map in the corner; Edit / Live / Versions | `js/components/graph/index.js` (`nodeEl`, `highlight`, `drawMap`, `tidyAll`, `placeAll`), `graph/layout.js` (`tidy`, `branchPaths`, wrap routing in `edgeGeometry`), `graph/svg.js`, `js/views/workflow.js`, `css/graph.css` | `lib/workflow.mjs` (the `circle-workflow/1` format) | `unit/workflow.test.mjs`, `unit/graph-layout.test.mjs` |
| Agent and stage settings panel | `graph/nodepanel.js`, `components/panelsize.js` | `lib/workflow.mjs` | |
| Checkpoints on arrows (Go on / You / An engine / Engine then you) | `graph/nodepanel.js` | `lib/workflow.mjs`, `lib/render.mjs` | `unit/gates.test.mjs` |
| Versions (semantic, one per save, restore) | `graph/versions.js` | `lib/semver.mjs`, `lib/templates.mjs` | `unit/semver.test.mjs` |
| "Review and write files" (agents, AGENTS.md, CLAUDE.md...) | `components/diffreview.js` | `lib/render.mjs`, `lib/ops.mjs`, `lib/changes.mjs` | `unit/render.test.mjs`, `integration/ops.test.mjs` |
| What a folder already has (no fake workflow) | `js/views/workflow.js` | `lib/discover.mjs`, `lib/team.mjs` | `integration/workflow.test.mjs` |
| Templates (yours, in `data/templates`) | `components/newproject.js` | `lib/templates.mjs`, `seed/staged-build-team.json` | `unit/templates.test.mjs` |
| **Workflow helper** (proposes a workflow) | `graph/helper.js` | `lib/helper.mjs`, `lib/digest.mjs`, `lib/catalog.mjs` | `unit/helper.test.mjs` |
| Find skills on GitHub (you approve) | `graph/helper.js` | `lib/skillfind.mjs`, `lib/github.mjs`, `lib/ghcli.mjs` | `integration/tools.test.mjs` |
| **Helpers beside agents** (dashed node: Haiku reader, "when it decides" or "auto above N%") | `graph/index.js` (`helperEl`), `graph/layout.js` (`helperBox`), `graph/nodepanel.js` (`helperSection`) | `lib/workflow.mjs` (`reader`, `condense`), `lib/render.mjs` | `integration/helpers.test.mjs` |
| **Write only the helper files** (no agent file rewritten) | `graph/nodepanel.js` (Helper section), `views/workflow.js` (`writeHelpers`) | `lib/ops.mjs` (`helpers-write`) | `integration/helpers.test.mjs` |
| **Automatic condensing** (hook) | same as above | `seed/hooks/circle-condense.mjs`, `lib/render.mjs` (`condenseHookEntry`), `lib/ops.mjs` (`syncCondenseHook`), `lib/condenseguard.mjs` | `integration/helpers.test.mjs`, `helpers/fake-haiku.mjs` |
| **Patterns panel** (what fits your agents, Try on, Undo) | `graph/patterns.js` | `lib/patterns.mjs`, `seed/patterns.json` | `integration/helpers.test.mjs` |

### Mods (Claude Code mods and plugins)

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| Mods page (menu) and Mods tab (project): For every project / Only this project (or some projects) / Off, filters by what each changes | `js/views/mods.js`, `css/views.css` (`.cs-mods__*`) | `lib/mods.mjs`, `routes.mods.mjs` (`mods.list`) | `integration/mods.test.mjs` |
| On or off in one project (diff of `.claude/settings.json`) | `js/views/mods.js` (`setHere`) | `lib/ops.mjs` (`mod-set`) | `integration/mods.test.mjs` |
| On or off for every project; Details | `js/views/mods.js` (`general`, `details`) | `routes.mods.mjs` (`mods.general`, `mods.details`: runs `claude plugin enable/disable --scope user`, `claude plugin details`) | `integration/mods.test.mjs` |
| From a terminal | | `scripts/circle.mjs` (`mods`) | |
| **Make your own**: ready-made mods added to a project (diff first), or "Ask Claude to build it" (the project's chat opens with the request written out) | `js/views/mods.js` (`drawMake`, `modPrompt`), `js/views/chat.js` (prefill), `css/views.css` (`.cs-mods__starter`) | `lib/modstarters.mjs`, `seed/mods/waiting-game`, `seed/mods/turn-check`, `lib/ops.mjs` (`mod-add`), `routes.mods.mjs` (`mods.starters`) | `integration/desktop-helper.test.mjs` |
| **Check** a mod (`claude plugin validate`, then `claude plugin test` when it has tests), said in plain words | `js/views/mods.js` (`check`) | `routes.mods.mjs` (`mods.check`), `lib/modstarters.mjs` (`readValidate`, `readTests`), `lib/mods.mjs` (`findPluginRoot`) | `integration/desktop-helper.test.mjs` |

### Chat, Inbox, approvals

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| Chat: a real agent session in the folder. **Plain Claude Code** since v17.9: all of its tools (no `--tools` list), subagents in the foreground, no Circle Studio persona (one line about approvals); the folder and version shown at the top; a run goes on when the window closes or reloads (only Stop or `/stop` ends it) | `js/views/chat.js`, `js/markdown.js` | `routes.engines.mjs` (`chat.send` without the window's signal), `lib/sessions.mjs` (`systemPrompt`), `lib/engines/claude.mjs` (`SETTINGS`, `FOREGROUND`), `lib/policy.mjs` (PowerShell), `lib/records.mjs` | `integration/chat.test.mjs`, `integration/engines.test.mjs` |
| **Live from your terminal**: when Claude Code is working on the folder in a terminal or editor (its conversation file written in the last 2 minutes, not this chat's own), the Chat shows it live, refreshed every 3 s; writing carries it on here (a fork); Back to this chat | `views/chat.js` (`watchTerminal`, `view({ live })`, `carried`, `dismissed`) | `projects.history.list/get` | checked in a browser (section 13) |
| **Type while it works**: a message sent while Claude answers waits in line ("Sends when Claude finishes") and goes the moment it is done; Send stays usable during a run | `views/chat.js` (`queue`, `sendQueued`), `css/views.css` (`.cs-msg--queued`) | | checked in a browser |
| **Claude Code's commands in the Chat**: `/usage` (plan limits, then spending), `/model <name>`, `/status`, `/clear` (= `/new`), `/resume` (= `/chats`), `/cost` (= `/usage`), plus every Circle Studio command | `views/chat.js` (`ALIAS`, `localCommand`) | `routes.overlay.mjs` (`usage` with `limitsView`) | `integration/limits.test.mjs` |
| Earlier Claude Code conversations (read, continue) | `js/views/chat.js` | `lib/cchistory.mjs` | `integration/history.test.mjs` |
| **New chat and earlier chats without a terminal**: the chat window's main chat shows the newest conversation in the folder (terminal, IDE or here) and a reply carries it on; New chat (a new page, `startedAt`); Earlier chats lists the folder's conversations to take one up; the same in the overlay (`new`, `chats`, `continue [n or words]`, `folder` opens the folder dialog and lands in its chat) | `components/tiles.js` (`chatBar`, `earlierList`, `composer`), `css/tiles.css` (`.cs-tile__chatbar`, `.cs-tile__earlier`), `views/home.js` and `app.js` (`#/open-folder`), `components/openfolder.js` (`tab`) | `lib/chatfeed.mjs` (`continueId`, `fresh`, a continued chat's earlier part), `lib/records.mjs` (`Chats.reset` keeps `startedAt`), `routes.overlay.mjs` (`newchat`, `chats`, `continue`, `folder`, `ask` carries on), `lib/overlay.mjs` (`COMMANDS`, `PAGES.folder`) | `integration/chatcontinue.test.mjs` |
| **Live everywhere**: a turn started anywhere (the overlay, a desktop card, another window) shows in the Chat as it happens: what you said, each tool, the answer, and "Waiting for you" while it waits; it finishes in place | `views/chat.js` (`followLive`, `circle:progress`), `components/requests.js` (relays `progress`) | `lib/sessions.mjs` (`turnOf`, the `progress` event: at most twice a second for words, at once for tools), `routes.mjs` (`projects.chat.live`, masked) | `integration/chatlive.test.mjs` |
| **Commands in the Chat**: `/waiting`, `/allow 1`, `/deny 1`, `/answer 1 ...`, `/stop`, `/new`, `/chats`, `/continue 2`, `/help`... answered in the chat, even while the agent answers; `//word` and slash words that are not ours (`/compact`) go to the agent; hints carry the slash | `views/chat.js` (`command`, `commandEl`), `css/views.css` (`.cs-msg--circle`) | `lib/overlay.mjs` (`chatCommand`), `routes.overlay.mjs` (`overlay.command` with `from: 'chat'`) | `integration/chatlive.test.mjs` |
| **Open in editor** (Antigravity IDE, else VS Code) at the file the agent last worked on, with a **live chat page** beside it (`data/chat-view/<project>.md`: working / waiting / quiet, what waits with the command that answers it, other runs, the whole chat with tools; rewritten on every step, refreshed when the server starts) | `views/chat.js` (Open in editor), `components/tiles.js`, `overlay.ps1` (`Open-Editor`), `desktop-widgets.ps1` (reply card) | `lib/ide.mjs` (`findEditor`, `workingFile`, `openInEditor`), `routes.overlay.mjs` (`desktop.editor`, `writeChatPage`, `refreshPage`) | `integration/desktopreply.test.mjs`, `integration/chatlive.test.mjs` |
| **Answers as desktop notifications** (v17.9: no reply box): who answered, the first lines, Open chat; closes by itself after 30 s unless the mouse is on it (kept in Notifications) | `desktop-widgets.ps1` (`New-ReplyCard`) | `lib/replies.mjs`, `services.desktop.mjs` (`replies`, `fromDesktop`), `routes.overlay.mjs` (`desktop.replies`, `desktop.replies.dismiss`, `overlay.say`) | `integration/desktopreply.test.mjs` |
| Approval and question popups | `js/components/requests.js`, `css/requests.css` | `lib/sessions.mjs` | `integration/engines.test.mjs` |
| **A question in the chat, in words**: while it waits "Asked you: ..."; answered "<question> You answered: <answer>" with a tick; skipped "You did not answer." | `views/chat.js` (tool lines) | `lib/claude.mjs` (`summarize` AskUserQuestion), `lib/sessions.mjs` (`respond`: the tool line, `status: 'end'`) | `integration/questions.test.mjs` |
| **Allow from now on**: on the popup ("When you allow it") and the desktop card (small buttons under Allow), only the choices that fit: this kind of step for the rest of this run; always allow edits in this project; always allow reading files outside it. One answer also lets the same kind waiting beside it go ahead. The two "always" switches live in the project's Permissions (off by default, turned off there); what they let through is kept in the Inbox with the reason. Commands, edits outside the folder and secrets are never allowed for good | `components/requests.js` (`rememberChoice`, `REMEMBER`), `components/permissions.js` (two rows), `views/project.js` and `views/home.js` (read the permissions fresh before the dialog), `desktop-widgets.ps1` (`New-AskCard`) | `lib/sessions.mjs` (`rememberOptions`, `alwaysAllows`, `respond` with `remember`, `permsNow`), `lib/projects.mjs` (`autoEdits`, `autoReadsOutside`) | `integration/alwaysallow.test.mjs` |
| **One notification, not two**: a request a desktop card shows is marked `carded` on the window's event stream, so the open window shows no Windows notification of its own (it was the second one, "via Microsoft Edge", and a click on it opened the app) | `components/requests.js` | `routes.engines.mjs` (`events.stream`), `services.desktop.mjs` (`carded`) | `integration/alwaysallow.test.mjs` |
| The approval policy (refuse / ask / outside the project) | | `lib/policy.mjs`, `lib/policy-shell.mjs`, `lib/policy-paths.mjs` | `unit/policy.test.mjs` |
| Inbox (every approval and question, kept) | `js/views/inbox.js` | `lib/inbox.mjs` | `unit/inbox.test.mjs` |
| **Asking on the desktop**: each pending approval or question as a card at the bottom right of the screen with Allow / Deny or the answers; no Windows toast as well. **Questions (v17.10): every kind on the card**: up to 4 questions, pick one (one question: a click sends it) or pick several (ticks), option descriptions shown, your own answer typed (Enter or Send), Send answers (refuses to send with a question left out), Skip; titled "Claude asks" | `js/views/settings.js` ("Ask me on the desktop") | `scripts/widgets/desktop-widgets.ps1` (`New-AskCard`, `Refresh-Asks`), `services.desktop.mjs` (`carded`), `routes.desktop.mjs` (`desktop.widgets` action `asks`, `widgets.feed?asks=1`) | `integration/desktop-helper.test.mjs` |
| Team questions from `docs/tasks/ALERTS.md` | `js/components/alerts.js` | `lib/alerts.mjs` | `unit/alerts.test.mjs`, `integration/alerts.test.mjs` |
| Windows notifications | `js/components/notify.js` | `services.desktop.mjs` | `integration/desktop.test.mjs` |
| Live: what each agent is doing | `graph/index.js` (Live mode) | `lib/agentstate.mjs`, `events.stream` route | |

### Engines and first run

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| Claude Code adapter (stream-json) | | `lib/engines/claude.mjs`, `lib/claude.mjs` | `integration/chat.test.mjs`, `live/claude-live.mjs` |
| Codex adapter (app-server JSON-RPC) | | `lib/engines/codex.mjs`, `lib/engines/rpc.mjs` | `integration/engines.test.mjs` |
| Copilot adapter (ACP) | | `lib/engines/copilot.mjs`, `lib/engines/rpc.mjs` | `integration/engines.test.mjs` |
| Gemini / Antigravity adapter (`agy`, read-only) | | `lib/engines/agy.mjs` | `integration/engines.test.mjs` |
| Engine registry, what each can do | `js/views/settings.js` | `lib/engines/index.mjs` | |
| Starting CLIs safely (no shell, clean env, npm `.cmd` shims found) | | `lib/engines/proc.mjs`, `lib/run.mjs` | `integration/security.test.mjs` |
| **Let's begin** (which tools you use, install and sign-in steps, "Do it for me") | `js/views/start.js` | `lib/engines/setup.mjs`, `scripts/open-terminal.vbs` | `integration/security.test.mjs` |
| GitHub sign-in through `gh` (token never seen), and Sign out of GitHub as a button | `js/views/start.js` | `lib/ghcli.mjs` (`ghSignOut`), `routes.engines.mjs` (`github.signout`) | `integration/security.test.mjs` |

### Cost, health, git

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| Cost tab: 30 days of Claude use, per model, day, agent; cheaper options; what condensing saved | `js/views/cost.js`, `components/charts.js` | `lib/cost.mjs`, `lib/pricing.mjs` | `unit/cost.test.mjs` |
| Spending by provider (all folders) | widget tiles | `lib/usage.mjs` | |
| Health (what needs you, in plain words) | `js/views/health.js` | `lib/health.mjs` | `unit/health.test.mjs` |
| Git chip and panel, GitHub Actions and PRs (read only) | `components/gitpanel.js` | `lib/gitstatus.mjs`, `lib/ghcli.mjs` | `integration/desktop.test.mjs` |
| Project rules (lanes, local only, you do git: one closed line, toggle buttons and checkboxes inside) | `js/views/workflow.js` (`drawOptions`), `css/components.css` (`.cs-chipbtn`, `.cs-rules`) | `lib/workflow.mjs` | |
| Plan, brief, pinned advisor items | `js/views/project.js` | `lib/plan.mjs`, `lib/records.mjs` | `unit/plan.test.mjs` |
| Team matrix (tiers, engine chain, drift) | `js/views/team.js`, `components/inspector.js`, `js/chain.js` | `lib/team.mjs` | `unit/chain.test.mjs` |

### Skills, Library, Catalog, Advisor, Ask Circle

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| Library of skills (import from GitHub, edit, install) | `js/views/library.js`, `js/views/skilleditor.js`, `js/views/pskills.js` | `lib/skills.mjs`, `lib/github.mjs`, `lib/frontmatter.mjs` | `unit/skills-github.test.mjs`, `unit/skills-partition.test.mjs`, `unit/frontmatter.test.mjs` |
| Drag and drop (skills, agents, files) | `components/dnd.js` | `import.files` route | |
| Catalog (every building block, searchable, index a link) | `components/catalog.js` | `lib/catalog.mjs`, `routes.catalog.mjs` | `unit/v6.test.mjs` |
| Advisor (second opinion on one document) | `js/views/advisor.js` | `lib/claude.mjs` | |
| Ask Circle (Ctrl+J: help with no AI, or ask an engine) | `components/guide.js` | `lib/guide.mjs` | `integration/guide.test.mjs` |
| What's new (after an update) | `components/whatsnew.js` | | |

### Keys and connections (MCP)

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| Keys page (paste once, encrypted with Windows DPAPI) | `js/views/keys.js` | `lib/vault.mjs`, `lib/secrets.mjs` | `unit/v6.test.mjs`, `integration/v6.test.mjs` |
| Connections tab in a project (tools its agents can use, plugins, duplicates warned) | `js/views/connections.js` | `lib/connections.mjs`, `lib/mcpmanage.mjs` | `integration/tools.test.mjs` |
| Test a connection for real, plain-words fix | `js/views/connections.js` | `lib/mcpprobe.mjs` | `integration/v7.test.mjs`, `helpers/fake-mcp.mjs` |
| The manager ("Fix it for me", "one shared server", clean up; backed up, undone on failure) | `components/cxmanager.js` | `lib/mcpmanage.mjs`, `lib/jsonpatch.mjs` | `integration/v8.test.mjs` |
| Security check (what engines can reach) | `js/views/keys.js` | `lib/secscan.mjs` | `integration/v6.test.mjs` |

### Widgets and windows

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| Widgets page (choose and arrange tiles) | `js/views/widgets.js`, `components/board.js`, `components/tiles.js`, `css/tiles.css` | `lib/feed.mjs` | `integration/v7.test.mjs` |
| **Limits** tile (5-hour and weekly use of your Claude plan, reset times; a window that reset shows "new"; green, amber from 70%, red from 90%) and **From your terminal too** (Widgets page: a status line tap, previewed, backed up, off in one click) | `components/tiles.js` (`limitsTile`), `views/widgets.js` (`limitsCard`), `css/tiles.css` (`.cs-lim--*`) | `lib/limits.mjs` (`fromStream`, `fromStatusLine`, `tapState`, `setTap`, `splitCommand`), `lib/claude.mjs` (`rate_limit_event`), `lib/feed.mjs` (`limitsView`, `limitsTile`), `routes.desktop.mjs` (`limits.get`, `limits.tap`), `scripts/statusline-tap.mjs`, `app.mjs` | `integration/limits.test.mjs` |
| A project's widget window | `frontend/widget.html`, `js/widget.js`, `css/widget.css` | `projects.pulse` route | `integration/desktop.test.mjs` |
| Chat widget (main chat and agents' chats; which engine answers, pick it, reply in the tile, answer streams in) | `components/tiles.js` (`composer`, `sendChat`), `components/board.js` (no redraw while typing), `css/tiles.css` | `lib/chatfeed.mjs` (`engine`, `canReply`, main chat of any engine) | `integration/chatwidget.test.mjs` |
| Chat from a terminal | | `scripts/circle.mjs` (`chat`, through `/api/chat`) | checked live with Haiku |
| Notifications (kept, live, marked read) and Running now tiles; every tile small, medium or large | `components/tiles.js`, `components/board.js`, `components/requests.js` (`notice` event), `css/tiles.css`, `icons.js` (`bell`) | `lib/notices.mjs`, `services.desktop.mjs` (records each event), `lib/feed.mjs` (`noticesTile`, `runningTile`, small variants), `notices.list/read` | `integration/notices.test.mjs` |
| Real desktop widgets (the same card as the overlay's panels: heading with a grip, or a lock when locked; draggable, lock in place; a project tile's title is a chip with the project's state that opens a **project picker** card, each project with what it is doing; a click on Chat opens that project's chat window) | | `desktop-widgets.ps1` (`Tile-Head`, `Show-ProjectPicker`), `routes.desktop.mjs` (`widgets.feed`: `projects` with state), `scripts/widgets/desktop-widgets.ps1` (`Open-App` `chat:<id>`), `lib/feed.mjs` (`chatWindow`, `engine`),, `scripts/widgets/start-widgets.vbs`, `lib/deskhost.mjs`, `lib/palette.mjs` | `integration/chatwidget.test.mjs` |
| **Activity ring** tile (a ring per project: turns while working, pulses while it waits, full when just done) and **Mods** tile | `components/tiles.js` (`pulseTile`, `liveRing`, `modsTile`), `css/tiles.css` (`.cs-live`) | `lib/feed.mjs` (`pulseTile`, `modsTile`), `scripts/widgets/desktop-widgets.ps1` (`Live-Ring`) | `integration/notices.test.mjs` |
| Workflow tile: stages done as a count, the stage now and who works, what is next | `components/tiles.js` (`workflowTile`, `stageBar`) | `lib/feed.mjs` (`workflowTile`), `routes.desktop.mjs` (`pulseOf`: each stage's people), `desktop-widgets.ps1` (`Stage-Bar`) | `integration/notices.test.mjs`, `integration/v7.test.mjs` |
| Running now: where and since when, including Claude Code in a terminal; earlier today (large) | `components/tiles.js` (`runningTile`) | `lib/feed.mjs` (`runningTile`), `lib/stats.mjs` (`TERMINAL_LIVE_MS`) | `integration/notices.test.mjs` |
| Chat window: whole messages with formatting, speaker once per run, tools used, scrolls | `components/tiles.js` (`chatTile`, `ctx.solo`), `css/tiles.css` | `lib/chatfeed.mjs` (`plain`, `md`, `tools`) | `integration/desktop-helper.test.mjs` |
| **Hotkey**: Ctrl+Alt+C (else Ctrl+Alt+W, Win+Alt+C) opens the overlay; the right-click menu keeps "Bring to front" (tiles only) | `js/views/widgets.js` (shows it) | `desktop-widgets.ps1` (`CsHotKey`, `Toggle-Overlay`, `Toggle-Front`), `routes.desktop.mjs` (`hotkey` in the status) | checked by hand (section 13) |
| **The overlay** (like the Xbox Game Bar): the screen dims (`--c-scrim`; the desktop tiles stay under it), panels show what waits (Allow / Deny / answer buttons), what runs, the workflow drawn small, the chat with the answer streaming in, this PC (time, processor, memory), spending, git, notifications; every panel drags on its own (the tile lock does not apply; places kept), Widgets hides or shows panels and **adds more widgets** (Activity rings, Agents, Project at a glance, All projects, Mods: drawn like the desktop tiles for the project shown, in a middle row, draggable, kept), Reset layout; a top bar with the **project switcher** (state dot and words per project, how many others need you, search, Enter, Ctrl+P, Ctrl+Tab / Ctrl+Shift+Tab); Esc, the keys again or a click on the dim closes it | | `scripts/widgets/overlay.ps1` (`Show-Overlay`, `Paint-*`, `New-TopBar`, `Paint-Chip`, `New-Switcher`, `New-WidgetsMenu`, `Lay-Out`, `Begin-Drag`), `lib/overlay.mjs` (`projectChoices`, `OVERLAY_EXTRAS`), `widgets.feed?extra=` (the added widgets), `routes.overlay.mjs` (`overlay.feed`), `lib/overlay.mjs` (`waitingPanel`, `workflowMap`, `usagePanel`, `gitPanel`, `pcStats`), `lib/palette.mjs` (`scrim`) | `integration/overlay.test.mjs` |
| **Terminal** (v17.12; since v17.14 only a real terminal, never an editor's Claude Code panel, and the new one carries this chat's own conversation on): brings forward the terminal or editor window where Claude Code works on the folder (each `claude.exe`'s working folder is read from the process; Windows Terminal through the console window's owner, an editor's terminal by walking up to the editor and its window titled with the folder); when none, a new terminal in the folder runs `claude --resume <newest conversation>` (never while Circle Studio answers in it). In the Chat tab (button, "Show that terminal" on the live banner, `/terminal`), the bar (button, `/terminal`, `/terminal show`, `/terminal new`), and the desktop cards; the cards also have **Folder** (File Explorer) | `views/chat.js` (`terminal`), `overlay.ps1`, `desktop-widgets.ps1` (`Where-Btn`) | `lib/terminal.mjs` (`findWorkWindow`, `resumeScript`, `openResumeTerminal`), `routes.overlay.mjs` (`openTerminal`, `desktop.terminal`, `desktop.folder`) | `integration/terminal.test.mjs` |
| **Plan limits** panel in the overlay (v17.14): the 5 hours and the week, how much is used (coloured bar) and when each starts again; the bar's line says them too ("5 hours 46%, week 58% used") | | `overlay.ps1` (`Paint-Limits`, `PANELS.limits`), `routes.overlay.mjs` (feed `limits`, from `limitsView`) | `integration/limits.test.mjs` |
| **The bar** (v17.11, the overlay's chat box and the Widgets page's Quick chat; v17.14: a message being answered shows once, `withoutLive`): what you type goes to the project's chat, even one word; `/` starts a command answered under the box (`/usage`, `/status`, `/engine`, `/model`, `/help`, every command below with a slash); `//word` sends the word; a message sent while it answers waits its turn; the engine button switches who answers; a line says the folder and what it does now; Send button; no list of command words; question and approval cards show on top of the bar | `scripts/widgets/overlay.ps1` (`New-CommandBar`, `Paint-Talk`, `Send-Command` with `from: 'bar'`), `views/widgets.js` (`commands`) | `routes.overlay.mjs` (`barLine`, `barChoice`, `waitingLine`, feed `bar`), `scripts/widgets/desktop-widgets.ps1` (cards over the overlay) | `integration/bar.test.mjs` |
| **Commands** typed in the overlay (and in the Commands box on the Widgets page): help, project, open, chat, ask (a sentence goes to the chat too), run <agent>, stop, waiting, allow / deny / answer <n>, running, workflow, usage, git, pc, mods, mod check, hide; Up and Down recall earlier ones | `js/views/widgets.js` (`commands`), `css/views.css` (`.cs-cmdhelp`) | `lib/overlay.mjs` (`parseCommand`, `findByName`, `splitAgent`, `COMMANDS`), `routes.overlay.mjs` (`overlay.command`; a chat turn runs on its own and is read back from the feed) | `integration/overlay.test.mjs` |
| **Answer Claude Code in your terminal from the desktop** (v17.13): Claude Code running in a terminal or an editor asks on the same desktop cards (heading "<folder> · your terminal"): Allow, Deny, the answers to its questions; **In the terminal** hands it back; Folder and Terminal show where. A switch in Settings, Desktop adds a PermissionRequest hook to `~/.claude/settings.json` (preview of the change first, a copy kept, your own hooks kept; off removes it); **Try it** sends a harmless sample. With Circle Studio stopped the hook steps aside and Claude Code asks in the terminal as before. Steps Circle Studio would refuse in its own chat are marked "Careful" but stay yours to answer | `views/settings.js` (`termAsksRow`), `components/requests.js` (terminal line, In the terminal), `desktop-widgets.ps1` (`New-AskCard`, `Where-Btn` with a folder) | `scripts/permission-hook.mjs`, `lib/permhook.mjs`, `lib/sessions.mjs` (`externalRequest`, `releaseExternal`), `routes.engines.mjs` (`hooks.permission`, `.wait`, `.release`), `routes.desktop.mjs` (`permhook.get/set`), `routes.overlay.mjs` (`desktop.folder` / `desktop.terminal` with `folder`), `lib/overlay.mjs` (`waitingPanel`) | `integration/termasks.test.mjs` |
| Home: "Keep Circle Studio on your desktop", offered once | `js/views/home.js` (`offerDesktop`) | `desktop.widgets` | |
| One window per thing (reopening brings it forward) | | `services.desktop.mjs`, `lib/desktop.mjs`, `scripts/launch.mjs` | `integration/windows.test.mjs` |

### Install, update, settings

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| Installer, shortcuts, start at sign-in | | `Install Circle Studio.cmd`, `scripts/circle.mjs`, `lib/desktop.mjs`, `lib/icon.mjs` | `integration/installer.test.mjs` |
| Launcher (no console window); a start that fails says so in a message box instead of nothing | | `scripts/launch.vbs`, `scripts/launch.mjs` (`fail`), `scripts/message.vbs` | `integration/launcher.test.mjs` |
| Self-update (fast-forward only) | `components/updates.js` | `lib/updater.mjs`, `lib/codeversion.mjs` | `integration/updater.test.mjs` |
| Newer code on this PC: banner (Restart now / Reload / Later until the window is opened again), restarts by itself when nothing runs or waits (Settings, Updates switch), windows reload by themselves | `components/freshness.js` (app and widget windows), `components/updates.js` (switch), `css/components.css` (`.cs-fresh`) | `services.desktop.mjs` (`autoRestart`, `restartIntoNewCode`), `routes.desktop.mjs` (`app.code`, `app.restart`), `lib/codeversion.mjs` (`uiFingerprint`), `lib/desktop.mjs` (`updates.autoRestart`) | `integration/freshness.test.mjs` |
| Settings | `js/views/settings.js` | `routes.desktop.mjs`, `services.desktop.mjs` | `integration/desktop.test.mjs` |
| Theme (light/dark, no flash) | `js/theme-init.js`, `js/state.js` | | `unit/design.test.mjs` |

---

## 3. Backend, file by file

### Entry and wiring (`backend/`)

| File | What it does |
|---|---|
| `server.mjs` | Starts the HTTP server on 127.0.0.1 |
| `app.mjs` | Wires the services together (tests build it with a temp data folder) |
| `config.mjs` | Settings from environment variables, local defaults |
| `routes.mjs` | One handler per route id in `contracts/api.json` |
| `routes.workflow.mjs` | Templates, workflows, versions, the helper, patterns, new projects |
| `routes.engines.mjs` | Engines, chat, approvals and questions, live runs, the advisor |
| `routes.connections.mjs` | Connections, the vault, the security check |
| `routes.catalog.mjs` | The catalog and link indexing |
| `routes.mods.mjs` | Mods and plugins: the list, on/off for every project through the claude CLI, Details |
| `routes.overlay.mjs` | The overlay: what it shows (`overlay.feed`) and the commands typed into it (`overlay.command`), run through the other handlers |
| `routes.desktop.mjs` | Settings, shortcuts, windows, git and GitHub state |
| `services.workflow.mjs` | Templates and each project's workflow |
| `services.engines.mjs` | Engine registry, Inbox, session broker |
| `services.desktop.mjs` | Settings, the window registry, Windows notifications |

### `backend/lib/`: grouped

**Safety (writes, paths, secrets, approvals)**

| File | What it does |
|---|---|
| `paths.mjs` | Every outside path goes through here; what is readable and writable |
| `workspace.mjs` | A virtual copy of the files an edit touches; nothing hits disk until applied |
| `changes.mjs` | Diff first: `preview` builds a change set, `apply` writes it (with backups) |
| `ops.mjs` | The change operations (workflow write, skills, settings merges) |
| `diff.mjs` | The line diff shown in reviews |
| `textfile.mjs` | Reads/writes keeping line endings and BOM; atomic writes |
| `jsonpatch.mjs` | Edits one value in a JSON text and leaves every other byte alone |
| `condenseguard.mjs` | The one allowed door into `.claude/hooks/`: only the condense script (byte-identical) and its config (names and percentages only) |
| `policy.mjs`, `policy-shell.mjs`, `policy-paths.mjs` | What an agent may do, what asks, what is refused |
| `secrets.mjs` | Finds secrets and redacts them everywhere |
| `vault.mjs` | Encrypted key store (Windows DPAPI) |
| `secscan.mjs` | The security check |
| `errors.mjs` | One error type; the code decides the HTTP status |
| `run.mjs` | Runs programs with no shell, clean environment, killable as a tree |

**Projects and workflows**

| File | What it does |
|---|---|
| `projects.mjs` | Registry of your projects |
| `workflow.mjs` | The graph format and its normalising |
| `semver.mjs` | Workflow versions |
| `templates.mjs` | Your templates under `data/templates` |
| `render.mjs` | Workflow to files (agents, AGENTS.md, CLAUDE.md, the condense hook and settings) |
| `discover.mjs` | What a folder already says about its workflow |
| `team.mjs` | Reads a project's team files tolerantly |
| `digest.mjs` | A short map of a folder for the helper |
| `helper.mjs` | The workflow helper's prompt and answer schema |
| `patterns.mjs` | Pattern store and `relate()` (which pattern fits which agent, using measured context) |
| `catalog.mjs` | The local database of building blocks |
| `plan.mjs`, `records.mjs` | Plan, brief, chat transcripts |
| `health.mjs` | Health checks in plain words |
| `alerts.mjs` | `docs/tasks/ALERTS.md` questions |
| `notices.mjs` | Notifications kept for the tiles: the newest 60, redacted, in `data/notices.json` |
| `frontmatter.mjs` | YAML front matter of agents and skills |
| `gitblock.mjs` | The managed block in a project's `.gitignore` |
| `mods.mjs` | Claude Code mods and plugins: what is installed, what each changes (read from its module), where it is on (user, project, local settings), `findPluginRoot` |
| `modstarters.mjs` | The ready-made mods in `seed/mods` (list, files), and reading what `claude plugin validate` and `claude plugin test` said |

**Engines and sessions**

| File | What it does |
|---|---|
| `engines/index.mjs` | Registry and what each engine can do now |
| `engines/claude.mjs` | Claude Code adapter |
| `engines/codex.mjs` | Codex adapter |
| `engines/copilot.mjs` | Copilot adapter |
| `engines/agy.mjs` | Gemini (Antigravity) adapter, read only |
| `engines/rpc.mjs` | JSON-RPC over stdio (Codex, Copilot) |
| `engines/proc.mjs` | Finding and starting CLIs (`resolveCli` for npm shims) |
| `engines/setup.mjs` | Install and sign-in steps per engine (Let's begin) |
| `claude.mjs` | Claude login state, the advisor, stream parser |
| `sessions.mjs` | The broker: every run, every request to you; `turnOf` (the turn running in a chat now) and the `progress` event; the "allow from now on" choices (`rememberOptions`) and a project's "always" switches |
| `inbox.mjs` | Approvals and questions, kept |
| `agentstate.mjs` | Working / waiting / done / idle per agent |
| `cchistory.mjs` | Your Claude Code conversations from the terminal (each file's summary kept until the file changes) |
| `guide.mjs` | Ask Circle |

**Cost and usage**

| File | What it does |
|---|---|
| `cost.mjs` | Project cost from transcripts, per agent, cheaper options, condensing savings |
| `pricing.mjs` | Claude API list prices |
| `usage.mjs` | Spending per provider across the PC |
| `stats.mjs` | Dashboard numbers |

**Skills, GitHub, connections**

| File | What it does |
|---|---|
| `skills.mjs` | The local skills library |
| `skillfind.mjs` | Finding skills on GitHub for a workflow |
| `github.mjs` | Importing from public GitHub (only GitHub hosts allowed) |
| `ghcli.mjs` | GitHub through `gh` (private repos, Actions, PRs; token stays in `gh`) |
| `gitstatus.mjs` | Branch, sync, uncommitted files (read only) |
| `connections.mjs` | Every MCP server of every engine, plugins included |
| `mcpmanage.mjs` | The manager: duplicates, broken, stale, plain-text keys; fixes with backups |
| `mcpprobe.mjs` | Tests one MCP server for real |

**Desktop and the app itself**

| File | What it does |
|---|---|
| `desktop.mjs` | Shortcuts, start at sign-in, app and widget windows, focusing an open window |
| `deskhost.mjs` | Runs the PowerShell desktop widgets, restarts them after updates |
| `feed.mjs` | What each desktop tile draws |
| `chatfeed.mjs` | What the Chat widget shows |
| `palette.mjs` | Token colours for the native widgets (and `scrim` as #aarrggbb for the overlay) |
| `overlay.mjs` | The overlay's commands (read a typed line, find a project or agent by name) and its panels (what waits, numbered; the workflow small; spending; git; this PC; the projects for the switcher with their state) |
| `limits.mjs` | Your plan's limits (from Claude's stream and the status line), kept in `data/limits.json`; the status line tap's setup |
| `permhook.mjs` | The switch for answering Claude Code in your terminal: adds or removes the PermissionRequest hook in `~/.claude/settings.json` (backup first, only our entry touched) |
| `terminal.mjs` | The terminal a conversation runs in: found through the Claude Code processes' working folders and brought forward, or a new one that resumes the conversation |
| `ide.mjs` | Your editor: finds Antigravity IDE (else VS Code), the file an agent last worked on (inside the folder only), opens both through the editor's own `cli.js` (no shell) |
| `replies.mjs` | Answers waiting as desktop cards (the newest per chat, four at most, in memory) |
| `icon.mjs` | The app icon, drawn in code |
| `pickfolder.mjs` | Windows folder dialog |
| `updater.mjs`, `codeversion.mjs` | Self-update, "is the server running old code" and "are the screens on disk newer" |
| `store.mjs` | The `data/` folder: atomic JSON writes |
| `route-helpers.mjs` | Shared route helpers |

### `backend/seed/`

| File | What it does |
|---|---|
| `staged-build-team.json` | The starter template, copied once into `data/templates` |
| `patterns.json` | The 7 patterns: Haiku reader, automatic condensing, second opinion, engine checks a stage, cheapest model, skills, optional agents. Each with use when, avoid when, costs, how to set it |
| `mods/waiting-game/`, `mods/turn-check/` | Ready-made Claude Code mods (each with a test), added to a project's `.claude/skills/` by `mod-add`. Validated and tested with Claude Code 2.1.301 |
| `hooks/circle-condense.mjs` | The condense hook copied into a project when you turn it on. Runs inside Claude Code (PostToolUse), calls Haiku, keeps the full output in a file |

---

## 4. Frontend, file by file (`frontend/`)

| File | What it does |
|---|---|
| `index.html` | The main app page |
| `widget.html` | Widget windows (the board, or one project's widget) |
| `js/app.js` | Boot, shell, hash router |
| `js/api.js` | The only file that calls `fetch`; every path matches `contracts/api.json` |
| `js/state.js` | Shared state and theme |
| `js/dom.js` | DOM helpers (text only, never `innerHTML`) |
| `js/markdown.js` | Safe Markdown renderer |
| `js/icons.js` | The icon set |
| `js/chain.js` | Main + backup engine chain |
| `js/theme-init.js` | Theme before first paint |
| `js/widget.js` | A project's widget window |
| `js/views/*.js` | One per screen: home, project, workflow, chat, cost, health, team, inbox, library, skilleditor, pskills, keys, connections, mods (page and project tab), widgets, advisor, settings, start |
| `js/components/graph/*.js` | The graph: `index` (canvas), `layout` (geometry), `nodepanel`, `helper` (workflow helper), `patterns` (Patterns panel), `versions`, `svg` |
| `js/components/*.js` | Shared pieces: overlay (modals, toasts), freshness (the newer-version banner), diffreview, requests (popups), rail, palette, guide, whatsnew, updates, catalog, cxmanager, gitpanel, board, tiles, charts, dnd, inspector, newproject, openfolder, permissions, notify, alerts, panelsize |
| `css/tokens.css` | **Every** design value (colours, spacing, type), light and dark |
| `css/base.css`, `components.css`, `views.css`, `graph.css`, `requests.css`, `tiles.css`, `widget.css` | Styles, tokens only |
| `logo.svg`, `favicon.svg` | The ring logo |

---

## 5. Scripts (`scripts/`)

| File | What it does |
|---|---|
| `circle.mjs` | The `npm run setup / open / stop / status / update / doctor / uninstall / mods / chat` commands |
| `launch.mjs`, `launch.vbs` | Start the app with no console window; bring an open window forward |
| `statusline-tap.mjs` | Claude Code's status line, tapped: keeps `rate_limits` in `data/limits.json`, then runs your own status line (program and arguments, no shell) with the same input |
| `permission-hook.mjs` | The hook Claude Code runs when it needs permission: sends the request to Circle Studio, waits for your answer on the card (up to 9 minutes), prints Claude Code's decision; prints nothing (Claude Code asks in the terminal) when Circle Studio is not running or you chose In the terminal |
| `message.vbs` | A message box: how the launcher says Circle Studio could not start (it has no window of its own) |
| `open-terminal.vbs` | Opens a visible PowerShell for one sign-in command (Let's begin) |
| `widgets/desktop-widgets.ps1` | The real desktop widgets (tiles in the overlay's card style, drag, right-click, lock, the project picker card), the cards that ask (Allow / Deny, answers), the hotkey, the turning activity ring |
| `widgets/overlay.ps1` | The overlay the hotkey opens (dot-sourced by the host): dimmed screen, the top bar (project switcher, Widgets menu, Reset layout, Close), panels each dragged on its own, the widgets added from the Widgets menu, the command box |
| `widgets/start-widgets.vbs` | Starts them with no console window |
| `check-contrast.mjs` | `npm run contrast`: checks text contrast in both themes |

---

## 6. Tests (`tests/`)

| Folder | What is there |
|---|---|
| `unit/` | Pure logic: policy, workflow, layout, render, cost, health, helper, semver, templates, frontmatter, design rules, and `frontend-syntax.test.mjs` (parses every browser module) |
| `contract/routes.test.mjs` | Every route in `contracts/api.json` has a handler and every frontend call matches |
| `integration/` | The real server on a private port with temp data: api, workflow, ops, chat, engines, history, guide, alerts, desktop, windows, installer, launcher, updater, security, tools, chatwidget, helpers, notices, mods, freshness, desktop-helper, overlay, chatcontinue, terminalfree, desktopreply, chatlive, alwaysallow, limits, questions, bar, terminal, v6 / v7 / v8 |
| `helpers/` | Fake CLIs (`fake-claude`, with a `tools` scenario that asks for several tools at once, `question` with any questions from `FAKE_CLAUDE_QUESTIONS`, `say` (`FAKE_CLAUDE_SAY`, streamed), and `FAKE_CLAUDE_LIMITS`; `fake-engines`, `fake-haiku`, `fake-mcp`), fake transcripts (`fake-history`), server and project helpers |
| `fixtures/` | Recorded real Claude output and an old plan |
| `live/claude-live.mjs` | Real Claude, three Haiku turns. Not part of `npm test` |

Run: `npm test` (all of it), `npm run contrast`.

---

## 7. Docs (`docs/`)

| File | What it is |
|---|---|
| `original-prompt.md` | Your original request, word for word (highest authority) |
| `spec.md` | How it is built and what is fixed |
| `decisions.md` | Every departure from the request, and a log per version (v1 to v13) |
| `design.md`, `design-rules.md` | The look ("Open Ring") and the checked rules |
| `research/` | Facts measured by running things: Claude CLI, engines, GitHub skills, team internals |

---

## 8. Your data (`data/`, never in git, never uploaded)

| Path | What it holds |
|---|---|
| `registry.json` | Your projects list |
| `settings.json` | App settings |
| `vault.json` | Your keys, encrypted for your Windows account |
| `catalog.json` | The building-block catalog |
| `templates/` | Your workflow templates |
| `workflows/` | Each project's workflow and its versions |
| `chats/`, `plans/` | Chat transcripts, plans and briefs |
| `library/` | Your skills library |
| `backups/` | Backups taken before every write (safe to clear) |
| `desktop-widgets.*` | Desktop widget layout, process id, version, the hotkey in use (`desktop-widgets.hotkey`) |
| `notices.json` | Your notifications (the newest 60; what the Notifications tile shows) |
| `server.log` | Server log (secrets masked) |

---

## 9. What the app writes into a project (always after you review the diff)

| File in the project | When |
|---|---|
| `workflow.json` | "Review and write files" |
| `AGENTS.md`, `CLAUDE.md`, `.claude/agents/*.md` (and each engine's own agent folder) | Same |
| Skills folders per engine | Installing a skill |
| `.claude/skills/<mod>/` | Adding a ready-made mod (Mods, Make your own) |
| `.mcp.json` and engine configs | Connections: Add / Remove / Key / Fix (backed up, undone on failure) |
| `.claude/hooks/circle-condense.mjs`, `.claude/hooks/circle-condense.json` | Only when an agent's helper is "Automatically" |
| `.claude/settings.json` | Only Circle Studio's one hook entry is merged in or removed, and `enabledPlugins.<mod>` (Mods tab); everything else stays |
| `.gitignore` | A marked local-only block |

Git is never written: you commit and push yourself.

---

## 10. Where each safety rule is enforced

| Rule | Where |
|---|---|
| Local only (127.0.0.1) | `backend/server.mjs`, `backend/config.mjs` |
| No API key ever; clean environment for every child | `lib/run.mjs`, `lib/engines/proc.mjs` |
| Diff first | `lib/changes.mjs`, `lib/workspace.mjs`, `components/diffreview.js` |
| Writable paths only | `lib/paths.mjs` (`.claude/hooks/` blocked except the condense door in `lib/condenseguard.mjs`) |
| Agents ask first | `lib/policy*.mjs`, `lib/sessions.mjs` |
| Secrets never shown | `lib/secrets.mjs` (`redact`) |
| Circle Studio's own Chat and Advisor run with project hooks off | `lib/engines/claude.mjs`, `lib/claude.mjs` (`disableAllHooks`) |
| Tokens only, no inline script or style | `frontend/css/tokens.css`, `tests/unit/design.test.mjs` |

---

## 11. API routes (`contracts/api.json`, 111 routes)

| Group | Routes |
|---|---|
| App | `app.health`, `app.code`, `app.restart`, `app.state`, `stats.get`, `app.update.get/apply`, `system.pickFolder`, `events.stream` |
| Projects | `projects.list/add/create/get/remove/health/plan.get/plan.save/permissions/file/git/git.github/pulse/cost/live` |
| Chat and history | `projects.chat.get/live/reset/link`, `projects.history.list/get`, `chat.send/stop`, `advisor.run`, `guide.ask` |
| Engines and requests | `engines.list/check/terminal`, `github.signout`, `requests.list/respond`, `alerts.list`, `hooks.permission` (+ `.wait`, `.release`: the terminal's hook), `permhook.get/set` |
| Changes | `changes.preview`, `changes.apply` |
| Workflow and templates | `workflow.get/save/restore/suggest/patterns`, `templates.list/create/import/get/save/remove`, `skills.discover` |
| Skills | `skills.list/get/save/remove/use/scan/fetch`, `import.files` |
| Catalog | `catalog.get/rebuild/describe/index` |
| Mods | `mods.list/general/details/starters/check` |
| Connections and keys | `connections.list/check/test/fix/manage/plan/apply`, `security.scan`, `vault.list/set/remove/import`, `usage.providers` |
| Desktop and widgets | `settings.get/save`, `desktop.shortcut/status/open/widgets`, `widgets.feed/chat/pick`, `notices.list/read`, `overlay.feed/command/say`, `desktop.replies`, `desktop.replies.dismiss`, `desktop.editor`, `desktop.terminal`, `desktop.folder`, `limits.get`, `limits.tap` |

---

## 12. What was built when

| Version | Date | What came in |
|---|---|---|
| v1 | 2026-09-30 | First build: Home dashboard, folder permissions, skills library, plan, health, team matrix, diff-first writes, chat, advisor |
| v2 | 2026-09-30 | Engines (Codex, Copilot, Gemini), templates, the workflow graph |
| v3 | 2026-09-30 | Team questions in the Inbox, the launcher |
| v4 | 2026-09-30 | Checkpoints, engine access, workflow helper, plain Health, no silent templates |
| v5 | 2026-10-01 | Your Claude Code history, widgets, alerts, git, Cost, Ask Circle, installer and updater |
| v6 | 2026-10-01 | Widget board, connections and the key vault, the helper reads the project, Haiku reader |
| v7 | 2026-10-02 | Real desktop widgets, connection repair |
| v8 | 2026-10-02 | Connection manager: one-click fixes, keys in the environment, upkeep |
| v9 | 2026-10-02 | One window per thing, a Widgets page in the menu |
| v10 | 2026-10-02 | Keys page, tools per project, skills found on GitHub, Let's begin |
| v11 | 2026-10-02 | GitHub sign-in through `gh`, npm installs found, OpenClaw checked (cannot ask first, so not supported), security pass |
| v12 | 2026-10-02 | Chat widget, switching and locking tiles, widgets that restart after updates |
| v13 | 2026-10-04 | Helpers on the graph, automatic condensing, the pattern store and Patterns panel |
| v14 | 2026-10-05 | Install check from GitHub, Codex matched to its real protocol, "Write only the helper files", Notifications and Running now tiles, small tiles |
| v16 | 2026-10-16 | The desktop as the place to work: agents ask on the desktop (cards with Allow / Deny), the Ctrl+Alt+C hotkey, the Activity ring and Mods tiles, Running now with times and terminal sessions, a new Workflow tile, a neater chat window; ready-made mods, Make a mod with Claude, Check; project rules behind one line; Home offers the desktop |
| v17 | 2026-10-18 | The overlay, like the Xbox Game Bar: Ctrl+Alt+C dims the screen, brings every tile forward with panels (waiting, running, workflow small, chat, this PC, spending, git, notifications) and a command box; the same commands on the Widgets page |
| v17.5 | 2026-10-18 | Lighter: conversation files summarised once until they change, git state reused for 10 s, the desktop widgets give unused memory back each minute, hidden windows stop polling; the Chat tab offers "Carry on" the newest conversation |
| v17.4 | 2026-10-18 | Fewer terminal steps: Sign out of GitHub is a button, old backups that held keys go by themselves, the Mods error and the to-do list no longer send you to a terminal; ideas for later (voice) noted |
| v17.3 | 2026-10-18 | New chat and earlier chats without a terminal: in the chat window (New chat, Earlier chats, a reply carries on what is shown) and the overlay (`new`, `chats`, `continue`, `folder`) |
| v17.2 | 2026-10-18 | Desktop tiles in the overlay's look (grip or lock in the heading) with a project picker card; more widgets can be added to the overlay from its Widgets menu |
| v17.1 | 2026-10-18 | The overlay rebuilt after trying it: the desktop tiles no longer jump in front of it, every panel drags on its own (even with tiles locked), a project switcher bar (state per project, search, Ctrl+Tab), Widgets menu and Reset layout |
| v17.6 | 2026-10-18 | Answers as desktop cards with a reply box; Open in editor (Antigravity IDE, else VS Code) at the agent's file with the chat as a page beside it. Left unfinished with one broken line (see v17.7) |
| v17.7 | 2026-10-19 | Fixed: Circle Studio would not start at all (that broken line); a failed start now shows a message. The chat page in the editor made complete and live; a turn started anywhere shows live in the Chat; Circle Studio's commands typed with a slash in the Chat; tools named in every answer; the project header no longer overlaps at narrow widths |
| v17.8 | 2026-10-19 | One notification per request (the desktop card; no second one from the open window); "allow from now on" on the popup and the card (this run, always edits here, always reading outside), kept in Permissions; the chat page in the editor newest first; the chosen option in a list is now visible; the Permissions dialog no longer shows (and saves back) an old copy |
| v17.9 | 2026-10-19 | The Chat is plain Claude Code (all its tools, subagents in the foreground, no persona), follows a terminal conversation live, takes messages while it works, `/usage` `/model` `/status` `/clear` `/resume`; a run survives the window; Open chat opens the real Chat; answer cards are short notifications; the Limits widget and the status line tap |
| v17.10 | 2026-10-19 | Every kind of question answered on the desktop card (several questions, pick several, your own words, Skip), said in words in the chat; a terminal session in Working now and Running now opens the Chat (it opened Health / Workflow); command answers stay in the live view; the medium Chat tile shows messages again; "Claude" named where it said "the agent". Two videos of it working, in your Videos folder |
| v17.11 | 2026-10-19 | The bar (Ctrl+Alt+C) is a plain chat with the folder: every word goes to Claude ("hi" was refused as "not a command"), `/` for commands with the answer under the box, an engine button, the folder and what it does now, Send and Stop buttons, no command chips; cards show over it; a message typed while it answers waits its turn; the Widgets page box is the same. One video of the bar, the question cards and the chat |
| v17.12 | 2026-10-19 | Terminal: the window where Claude works on the folder brought forward (or a new terminal that carries the conversation on), from the Chat, the bar and the notification cards; Folder on the cards |
| v17.14 | 2026-10-19 | Terminal opens a real terminal (it brought forward the Antigravity window, open on Circle Studio's chat page); the bar no longer shows your message twice while Claude answers; a Plan limits panel (5 hours, week) in the overlay and in the bar's line |
| v17.13 | 2026-10-19 | Claude Code in a terminal or editor asks on the desktop cards (a PermissionRequest hook, switched on in Settings with a preview); In the terminal hands a request back; tested with a real terminal session and a video |
| v15 | 2026-10-09 | Mods (page and project tab), the workflow graph redrawn (branch lines, focus, glide, map), reply and engine in the Chat widget, desktop chat window, `npm run mods` and `npm run chat`; Circle Studio restarts into newer code by itself (or Restart now / Later) and windows reload |

The full reasoning for each is in `docs/decisions.md`.

---

## 13. Where things stand right now (2026-10-19)

**v17.14 (2026-10-19).** You pressed Terminal in the bar for draw-text and got Circle Studio: its Claude Code runs in
Antigravity's Claude Code panel, so the finder brought that Antigravity window forward, and it was showing
`draw_text.md` (Circle Studio's chat page). The bar's own chat has no window at all: Circle Studio runs it. Now
Terminal only ever brings forward a real terminal (Windows Terminal, PowerShell...), and when there is none it opens a
new terminal carrying this chat's own conversation on (not the folder's newest, which may be the editor's). Checked on
this PC: the finder now finds no terminal for draw-text and circle-studio-app (both only in Antigravity), so Terminal
will open one. Your message showed twice in the bar while Claude answered: real Claude Code writes the turn into the
conversation the list is read from, and the bar added it again as the live answer (the stand-in Claude writes no such
file, so tests missed it); now that copy is left out until the answer is done. The overlay has a Plan limits panel
(right column, top) and the bar's line ends with "5 hours 46%, week 58% used". `npm test`: 303 tests, 300 pass, 0
fail, 3 skipped. The panel was drawn off-screen with the overlay's own code and looked at (dark); the full overlay was
not opened on your screen. Not seen by me: the twice-shown message on your real screen before and after (fixed from
the code and the feed), and a Terminal press opening a new terminal for draw-text (it would have started Claude there).

**v17.13 (2026-10-19).** `npm test`: 302 tests, 299 pass, 0 fail, 3 skipped (new: `integration/termasks`: allow,
deny, a question's answers, In the terminal, a folder that is not a project, a refused-kind step marked, the hook with
Circle Studio stopped, the settings switch on a temp Claude folder). **Real run on this PC:** a test copy of the host
and server (port 4399), a new empty `Desktop\claude-test`, a visible Windows Terminal running real Claude Code (Haiku)
with the hook passed by `--settings` (your `~/.claude/settings.json` was not changed): it asked to write hello.txt,
the card showed the file and its text, Allow on the card, the file was written; it asked to run `node -p 2+2`, Allow,
it printed 4 and finished. Video: `Videos\Circle Studio - answer your terminal from the desktop.webm`. The test
folder and its two test conversations were deleted after. Found while testing: a question's answers were dropped by
the hook (the app says "allow" with answers, not "answer"), fixed; the long poll left a 25 s timer behind, fixed.
Not tried for real: Deny and In the terminal in a live terminal (tested against the server only), a question
(AskUserQuestion) through the hook in a live terminal, an editor's Claude Code (Antigravity). **The switch is off**
on your PC until you turn it on.

**v17.12 (2026-10-19).** `npm test`: 300 tests, 297 pass, 0 fail, 3 skipped (new: `integration/terminal`). Checked on
this PC: the finder found the window for each of your three running Claude Code sessions (circle-studio-app, Desktop
Improver, draw-text, each in its own Antigravity IDE window) and nothing for a folder without one; through your
running Circle Studio, Terminal (show) for Desktop Improver brought that Antigravity window forward; a new terminal on a
temp folder opened Windows Terminal running `claude` there (closed after). Learned: Claude Code titles its window just
"claude", so the window is found through the process, not its title. Not tried: a new terminal resuming a real
conversation (it would have carried on this one), and editors other than Antigravity IDE.


**v17.11 (2026-10-19).** You typed "hi" in the overlay and got "not a command": one word was treated as a typo. Now
everything typed goes to the chat and `/` is for commands. `npm test`: 298 tests, 295 pass, 0 fail, 3 skipped (new:
`integration/bar`). Driven for real on this screen: a test copy of the host (lock `...QTEST`, hotkey
Ctrl+Alt+Shift+F11) against a private server on **port 4399** (port 4397 is used by `installer.test`, which stopped my
earlier test servers), two folders, the stand-in Claude: the hotkey opened the bar; `/project my-app`, "hi" answered,
`/usage` (5 hours 38%, week 61%), `/status`, `/project test`; a question card over the bar answered with one click; an
approval card, Allow (the bar said "Waiting for you"); a summary then `/hide`, and the "Claude answered" notification
came. Found and fixed while recording: cards were held back while the bar was open; the bar's status line did not
redraw (waiting, what it does now); "Main chat" / "the agent" where it is Claude; old "Type: open workflow" hints.
Video: `Videos\Circle Studio - the bar, questions and chat.webm` (the bar, then the question cards, then the chat in
the app). Not tried: the bar with Codex or Copilot answering (only Claude is ready here; the engine button cycles the
ready ones).


**v17.10 (2026-10-19).** `npm test`: 297 tests, 294 pass, 0 fail, 3 skipped (new: `integration/questions`). One full
run had two failures (`v8` EPERM on a temp folder, `windows`), both passing alone and in the next full run. The
question card was driven for real on this screen: a renamed copy of the desktop host (lock `...QTEST`, hotkey
Ctrl+Alt+Shift+F11) against a private server (port 4397, temp data, the fake Claude asking), clicked and filled through
UI Automation (no key presses): one click (Vitest), two questions with Home + About ticked, Send answers refused with
the second open, Dark, Send; your own words then Send; Skip. Each answer reached Claude exactly and the chat said it.
Videos (made from the card's own drawings and app screenshots, since Defender blocks screen capture by script):
`Videos\Circle Studio - answering Claude's questions.webm` (49 s) and `Videos\Circle Studio - finding and using a
chat.webm` (Home, live terminal view, `/status`, carrying on, approval, a queued message, `/waiting`, `/allow 1`,
`/usage`, adding the Limits widget, the terminal tap preview, Running now to the Chat). Bugs found while recording and
fixed: a terminal session linked to Health (Home) and Workflow (Running now); command answers wiped by the live view
every 3 s; the medium Chat tile had no room for messages and showed a lone "W"; `/waiting` and the card said "the
agent" for Claude; the question line kept spinning after it was answered. **Not seen with the real Claude:** a real
AskUserQuestion (only the stand-in; the request shape is the one the CLI sends).


**v17.9 (2026-10-19).** `npm test`: 296 tests, 293 pass, 0 fail, 3 skipped (new: `integration/limits`); `npm run
contrast` passes. Real Claude (Haiku, temp folder, about 3 short turns; your 5-hour window was at 98% earlier in the day,
15% by then): the stream carries `rate_limit_event` with `unifiedWindows.five_hour` / `seven_day` (`utilization`,
`resetsAt` in seconds); with every tool on, a subagent ran **in the background** and its Bash and PowerShell
permission requests failed after the turn ended ("Stream closed", nothing ran); with
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` its Bash came to the app for approval (now always set). One more turn was
wasted: Git Bash turned `/usage` into a path (Opus answered it). Checked in a browser on a private server (port 4396,
temp data and Claude folder, fake Claude): a growing "terminal" conversation shown live and carried on; Send usable
while it works, a second message queued and sent after Allow; `/usage`, `/model sonnet`, `/status`; the Limits tiles
(64% / 38%) and the From your terminal too preview, turned on against the temp Claude folder; dark 1280 and light
700. Your real `~/.claude/settings.json` was checked unchanged. Found and fixed on the way: Send was disabled during a
run; reloading the window stopped the run. **Not seen:** the new notification card and the Limits tile drawn natively
on the desktop (the script parses; the tile uses the generic rows the desktop already draws); `/compact` and other
Claude Code built-ins sent through the Chat (they go to Claude as text; whether the headless CLI runs them was not
checked).


**v17.8 (2026-10-19, after your screenshots).** Built after you said go ahead; your Circle Studio chat in Desktop
Improver had finished (only your terminal Claude Code was working, which a Circle Studio restart does not touch). The
two notifications: the desktop card is one; the other ("127.0.0.1 ... via Microsoft Edge") came from the open app window
itself, which the earlier "no double toast" rule did not cover; a click on it brought the app forward. `npm test`: 292
tests, 289 pass, 0 fail, 3 skipped (new: `integration/alwaysallow`); `npm run contrast` passes. Checked on a private
server (port 4396, temp data, the fake Claude asking for an edit) in a browser, 1280 px dark and light: the popup's
"When you allow it" choices, "Always allow edits in this project" then Allow, the answer finishing in the Chat, and the
project's Permissions showing the switch on. Found there and fixed: the chosen option was not visibly marked, and the
Permissions dialog showed the page's old copy (Save would have turned the new switch off again). **Not seen:** the new
buttons on the native desktop card (the script parses; the card was not drawn here), and the chat page with a real
long conversation.


**v17.7 (2026-10-19).** Why Circle Studio did not open after a shutdown or on a click: the unfinished v17.6 work had left
a line break inside a string in `backend/routes.overlay.mjs` (line 150), so the server crashed on start every time; the
launcher logged "did not start within 10 seconds" in `data/server.log` and showed nothing. Fixed, then started with the
desktop shortcut's own script (`wscript scripts/launch.vbs`): the server answered on 4380 and the desktop widgets host
came up. `npm test`: 289 tests, 286 pass, 0 fail, 3 skipped (new: `integration/chatlive`); `npm run contrast` passes.
One run had a test fail on a temp folder Windows had not let go of (`v7`, EPERM on delete); it passed alone twice and
in the next three full runs. Checked on a private server (port 4396, temp data, temp project, the fake Claude that asks
before a command): a message sent through `overlay.say` showed in the Chat tab as it happened with "Waiting for you"
(1280 dark, 700 light); `/waiting` and `/allow 1` typed in the Chat answered it and the answer finished in place; the
live page in `chat-view` said Waiting for you with `/allow 1`, then Quiet with the whole chat. Open in editor opened
Antigravity IDE for real on a temp project with the chat page (that test window may still be open; close it). Not
checked with the real Claude this time.


**Code.** v17.5 (2026-10-18): `npm test` gives 285 tests, 282 pass, 0 fail, 3 skipped (new: `unit/caching`). Measured
on this PC against your running copy (same tiles, nothing else changed): the widgets' refresh went from 120-180 ms to
50-100 ms, stats from 119 to 52-69 ms, the overlay from 373 to about 100 ms; the server's private memory from swinging
88-175 MB to a steady 70-77 MB; the widgets host's memory in use (working set) from 240 MB to 18-43 MB between refreshes
(its committed memory stays about 202 MB, paged out; a bare PowerShell with one WPF window is 147 MB). The Chat tab's
"Carry on" button was looked at in a browser (1280 px dark, 700 px light) and continued the conversation.

v17.4: 283 tests, 280 pass, 3 skipped (new: `terminalfree`). The
Library and Keys pages were looked at in a browser (1280 px, dark): nothing broken; small ideas went to section 14.

v17.3: 281 tests, 278 pass, 3 skipped (new: `chatcontinue`). The chat
window was checked in a browser on a private server (port 4397, temp data, a temp project with two terminal
conversations, the fake Claude), dark and light at its own size (420 px): it showed the newest terminal conversation with
"Writing here carries it on"; a reply carried it on (its four earlier messages, then the new turn); Earlier chats listed
both and took up the older one; New chat gave an empty page. The app's Chat tab "New conversation" dialog was looked at
(1280 px, light). Not checked by hand: `folder` from the overlay (it opens the Windows folder dialog), and with the real
Claude (the fake writes no conversation file, so the fallback that shows a continued chat's earlier part was what showed).

v17.2: `npm test` gave 280 tests, 277 pass, 3 skipped (the overlay test now also covers
the added widgets and the projects' state in the tiles' feed). Checked for real with the renamed host copy and the private
server: the test tiles in the new card (grip; a lock after `widgetsLocked`), the project chip opening the picker card
(the shown project ticked, each with its state), a pick saved through `widgets.pick` and the picker closed; in the
overlay, Widgets, Add more added Activity rings and Agents (drawn for the project shown, kept in `overlay.extra`), Agents
dragged and kept, Activity removed. To see the tiles the desktop was shown with Win+D for a moment, then given back.

v17.1: `npm test` gave 280 tests, 277 pass, 3 skipped. The rebuilt overlay was checked
for real with a renamed copy of the host (mutex `...TEST`, hotkey Ctrl+Alt+W) against a private server (port 4396, temp
data, three temp projects, the fake Claude), on this screen, in dark and light (the copy's theme forced): it opened with
the copy's tiles left under the dim; three panels (one from each column and the command box) dragged by mouse with
the tiles locked, kept in `overlay.places` and back where they were after Esc and the keys again; the switcher showed
each project's state (one "1 thing waits for you" with an amber count, the shown one ticked), typing `ruo` and Enter
switched the chip, chat, git and workflow; Ctrl+Tab went to the next project; Widgets hid Git (kept after reopening);
Reset layout restacked everything; Allow on the Waiting panel still let the agent go on. Not checked: a screen narrower
than 1320 px (the columns then start below the bar), a second monitor.

v17: 278 tests, 275 pass, 3 skipped. The overlay was checked for real
with a renamed copy of the desktop host against a private server (temp data, a temp mini project, the fake Claude), on this
screen (3000x1876 at 225%, a work area of 1333x834 in Windows' units): it opened over the dimmed screen with the tiles in front, in dark and light; a sentence sent
to the chat made the agent ask to run `echo circle-live`, Allow on the Waiting panel let it go on and the answer showed
in the Chat panel; the test hotkey (Ctrl+Alt+W, since your host holds Ctrl+Alt+C) closed and opened it and gave the
command box the keyboard; `workflow` typed with keys answered; Esc closed it. A first look found panels for empty lists
never drawn; fixed. The Widgets page Commands box was checked in a browser (light 1280 px, dark 700 px).

v16: `npm test` gave 274 tests, 271 pass, 0 fail, 3 skipped (they need an optional
`Desktop\circle-studio` reference folder that is not on this PC). `npm run contrast` passes in both themes.
`package.json` says version `1.2.0`. v16 was checked on a private server (port 4396, temp data, a temp "demo app" project):
the Widgets page, the chat window, Home, the Mods tab and the project rules in a browser (light and dark, 1280 and 700 px);
the native tiles and the ask card drawn by a renamed copy of the desktop host off-screen to PNG (never on your desktop);
a real Haiku run's Bash approval shown as a desktop card and answered by pressing its Allow (status `allowed`, the card
closed); Ctrl+Alt+C pressed twice by a script (tiles to the front, then back, in the host's log); a ready-made mod added
through the diff and checked with the real `claude plugin validate` and `claude plugin test` (it loads, 3 of 3 pass). A design pass the same day (every new tile in every size and state, light and dark, 1280 and 700 px; native tiles and both card kinds; the Mods page, Settings, the chat window) found and fixed clipped text, a stray dot on an empty ring, oversized rings and a stretched picker.
 v15 was checked in a browser on a private server (port 4396, temp data): the
graph in light and dark at 1280 and 700 px, the Mods page and tab, and the chat window, where a real Haiku reply was
sent and streamed in; `npm run chat` got a real Haiku answer from the terminal.

**Git and GitHub (read 2026-10-18 with `git status`, `git log` and `git branch -vv`, no fetch):**

| What | State |
|---|---|
| Repository | `https://github.com/Sarvesh-S-25/circle-studio.git` (remote `origin`) |
| Your local branch | `master` at `5ee363c Continued desktop hub` (v15 to v17, committed by you), level with `origin/master` as last fetched |
| GitHub's default branch | (read 2026-10-09, not re-checked) **`main`, at `88b4086`** (v12: no `patterns.mjs`, 241 tests). A stranger who clones, or uses the ZIP or the website's Download button, gets v12, not v13 |
| `main` and `master` have split | `main` has 2 commits `master` lacks (the GitHub merge commits of pull requests #1 and #2, no file changes of their own); `master` has 4 that `main` lacks. So `git push origin master:main` alone is **refused** (not a fast-forward). Merging `origin/main` into `master` first is clean and changes no files (checked with `git merge-tree`). See the to-do list |
| Not committed yet | v17.1 to v17.7 (2026-10-18 and 19; v17.6 and v17.7 add `backend/lib/ide.mjs`, `lib/replies.mjs`, `scripts/message.vbs`, tests `chatlive`, `desktopreply`), also `lib/cchistory.mjs`, `lib/gitstatus.mjs`, `components/alerts.js`, `components/board.js`, `tests/unit/caching.test.mjs`, `server.mjs`, `lib/ghcli.mjs`, `routes.engines.mjs`, `views/start.js`, `views/mods.js`, `tests/integration/terminalfree.test.mjs`, `routes.desktop.mjs`, `lib/chatfeed.mjs`, `lib/records.mjs`, `components/tiles.js`, `css/tiles.css`, `components/openfolder.js`, `app.js`, `views/chat.js`, `tests/integration/chatcontinue.test.mjs`: `scripts/widgets/overlay.ps1`, `desktop-widgets.ps1`, `backend/lib/overlay.mjs`, `routes.overlay.mjs`, `lib/deskhost.mjs`, tests `overlay` and `chatwidget`, `whatsnew.js`, `views/widgets.js`, `views/settings.js`, `views/home.js`, `README.md`, `docs/decisions.md`, this file |
| `trail.md` | Still in git; an old test log from an earlier team, not part of the app |

**Stranger install check (2026-10-05).** Fresh clones of both branches were made in a temp folder whose path has a
space, then deleted. Both pass `npm test` (`master`: 255 tests, 252 pass, 3 skip; `main`: 241, 238 pass, 3 skip).
`Install Circle Studio.cmd`, both double-click style and the README's PowerShell line, with `CIRCLE_SHORTCUT_DIR`
and a private port, made the Desktop and Start-menu shortcuts (pointing to `launch.vbs` in the clone, with the icon
in its `data`) and started the server. The updater, on a copy moved back one commit, said **Update ready**, and on
`master` **Update and restart** fast-forwarded it and restarted. Nothing in the app needed fixing. The only problem a
newcomer hits is that `main` is behind.

**On this PC:**

- v17.2: your Circle Studio restarted into it by itself; your widgets host was restarted at 20:39 through the app's own `desktop.widgets` start (as the Settings button does), since it had started before the last script change. It holds Ctrl+Alt+C.
- v17.1: your running Circle Studio restarted into it by itself (the overlay feed carries each project's state), and your desktop widgets host restarted on its own at 20:24 with the new scripts and holds Ctrl+Alt+C. Your tiles are set to Lock in place (`widgetsLocked`).
- Your running Circle Studio (port 4380) **restarted into v17 by itself** (checked 2026-10-18: `app.code` says not stale, the overlay route answers). Your desktop widgets host restarted on its own at 13:44 with the new scripts and holds Ctrl+Alt+C, so the overlay is ready to try.
- On this PC **Ctrl+Alt+Space is held by another app**, so the hotkey is Ctrl+Alt+C (free when checked 2026-10-16).
- **sample-test has automatic condensing on for `qa` (above 60%)**, written 2026-10-05 after you approved the diff: `.claude/settings.json` (+12 lines, one PostToolUse entry), `.claude/hooks/circle-condense.mjs` and `.json`. Backup and Undo: `data\backups\sample_test\2026-10-05T16-59-38-938Z`. Its workflow is now v1.0.3 in Circle Studio.
- Your desktop widgets restart on their own after updates.
- `data\backups` holds 4 old copies of `~/.claude.json` from 2026-10-02. They contain **the plain-text keys** that the
  connection fixes later moved out. They are in the app's own data folder (never in git), but they are worth deleting.
- In the `uml-analyzer` project, a hand-made copy of the `stitch` connection duplicates one a plugin already brings. The
  manager (Keys, Everything on this PC) offers to remove it; it was left for your click.

## 14. Your to-do list

000000000. **Try v17.14** in the bar (Ctrl+Alt+C): Terminal now opens a real terminal with that chat; your message
   shows once while Claude answers; Plan limits is in the right column (Widgets menu hides or shows it).
00000000. **Answer your terminal from the desktop**: Settings, Desktop, turn on "Answer Claude Code in my terminal
   from the desktop" (it shows the change first), press Try it, then start a new `claude` in a terminal: its
   permission questions come to the card. Watch `Videos\Circle Studio - answer your terminal from the desktop.webm`.
0000000. **Terminal**: in a project's Chat, the bar (Ctrl+Alt+C) or a notification card, press Terminal: the window
   where Claude works on that folder comes forward; if none is open, a new terminal carries the conversation on.
   Folder on the cards opens the folder in File Explorer.
000000. **Try the bar**: Ctrl+Alt+C, type anything (it goes to Claude in the project shown), `/usage`, `/help`. Watch
   `Videos\Circle Studio - the bar, questions and chat.webm`.
00000. **Watch the two videos** in your Videos folder (`Circle Studio - answering Claude's questions.webm`, `Circle
   Studio - finding and using a chat.webm`; they open in Edge or the Films app).
0000. **Try v17.9**: open a project's Chat while Claude works in your terminal on it: it shows live. Type `/usage`. On
   the Widgets page, press **From your terminal too** (it shows the change to your status line first; your own status
   line keeps working) and add the **Limits** tile (Edit tiles, Add).
000. **Try v17.8**: when an agent asks, you get only the desktop card. Under Allow it now offers "Allow for this run",
   "Always allow edits here" or "Always allow reading outside" (only the ones that fit). The "always" ones show up and
   are turned off in that project's Permissions (the lock button). The chat page in Antigravity now starts with the
   newest exchange.
00. **Try v17.7** (Circle Studio restarts into it by itself once nothing runs): in a project's Chat type `/help`,
   `/waiting`, `/allow 1`; press **Open in editor** and keep the chat page open beside your code in Antigravity; send
   something from the overlay (Ctrl+Alt+C) and watch it appear in the Chat. Close the Antigravity window on a
   `circle-mini-...` temp folder if it is still open (a test window from this check).

0. **Try the rebuilt overlay**: press Ctrl+Alt+C anywhere; drag a panel by its heading; click the project at the top
   (or Ctrl+P) to switch, Ctrl+Tab for the next; Widgets hides panels; Reset layout puts them back; Esc closes it. Your
   desktop tiles are set to **Lock in place** (that is why they would not move; it no longer stops the overlay):
   right-click a tile and untick it to move them (a locked tile now shows a lock in its heading). In the overlay,
   Widgets, Add more puts Activity rings, Agents and others in it. Chats without a terminal: click a desktop Chat tile
   (its window has New chat and Earlier chats), or in the overlay type `chats`, `continue 1`, `new`, `folder`. (Circle Studio and the widgets host restart into the new code by
   themselves.) Also from v16: in Widgets, Edit tiles, Add,
   try Activity ring and Mods (your board keeps its old tiles); in a project, Mods, Make your own, add waiting-game and
   run `claude` in that folder to play it while Claude works.
1. ~~Delete the old backups~~ **Done for you (v17.4):** the old copies of `~/.claude.json` in `data\backups` (they held
   plain-text keys) are now removed when Circle Studio starts, once a day old. The `sample_test` folder there (the Undo of
   a change) stays.
2. **Put your latest version (v15, once committed) on `main`** (this is what strangers get; today they get v12). From the app folder:
   ```
   npm test
   git rm trail.md
   git add -A
   git status                       (check: no data/ files, only what you mean to publish)
   git commit -m "Notes, remove old test log"
   git fetch origin
   git merge origin/main            (takes in GitHub's two pull-request merges; no files change)
   git push origin master
   git push origin master:main      (now a fast-forward: main moves to your work, nothing lost)
   ```
   Without the `git merge origin/main` line, the last push is refused, because `main` has those two merge commits.
   Merging (not force-pushing) also matters for people who already cloned `main`: their copy can still fast-forward,
   so their **Update ready** keeps working.
   Then choose one name and stick to it. To keep `main` (what the README and the ZIP link use):
   ```
   git branch -m master main
   git branch -u origin/main
   git push origin --delete master  (optional: removes the old branch on GitHub)
   ```
   From then on, `git push origin main` publishes. The app's own updater follows whatever branch your copy tracks, so
   people who clone `main` get **Update ready** when `main` moves.
3. **Put the website online** (`Desktopcircle-studio-site`): make it its own GitHub repository, then in Vercel Add New,
   Project, preset **Other**, no build command. Do step 2 first, so the Download button gives the latest version. Details in that
   folder's `README.md`.
4. Optional, to finish the Codex test: in Let's begin, Codex, press Sign in (it opens the sign-in for you), then ask for "test Codex for real" again (a few
   short turns in a temp folder, one that runs a command so the popup is tried).
5. Optional: in the `uml-analyzer` project, remove the duplicate `stitch` through the manager.
6. Optional: see condensing work in sample-test. In Circle Studio, sample-test, Chat (no terminal needed), ask for
   something that makes the qa agent read a lot, for example *"Use the qa subagent to review every test and script in
   this folder and run the checks it finds."* It condenses only once qa's own context is 60% full, so a short task
   shows nothing; to see it sooner, set the limit to 30% (Workflow, qa, Helper) and use "Write only the helper files".
   Then Circle Studio, sample-test, Cost: "condensed" shows how many outputs and how many tokens were kept out, per
   agent. Never use "Review and write files" on sample-test unless you want its 19 agent files rewritten.

### Ideas for later (not built; noted so they are not lost)

- **Voice (talk to the agents, hear the answers).** Checked 2026-10-18: none of the engine CLIs here (Claude Code,
  Codex, Gemini, Copilot) has a voice option in `--help`; ChatGPT's voice lives in the ChatGPT app, and OpenAI's speech
  API needs an API key, which Circle Studio never uses. What needs no key: Windows' own voices (Microsoft David and Zira
  are installed) to read answers aloud, and Windows voice typing (Win+H) or its speech recognizer to dictate into the
  chat window and the overlay. A microphone button and a "read it aloud" switch could use those, all local.
- Library, when empty: a "Find skills for a project" button there (today it points to the Workflow helper).
- A lighter desktop host: the tiles run in PowerShell with WPF, whose floor is about 147 MB committed (paged out
  between refreshes since v17.5). A small compiled program (C#, with the compiler that ships in Windows) could hold the
  same tiles in a fraction of that, but it is a rewrite of `desktop-widgets.ps1` and `overlay.ps1`.
- Engine sign-in still opens a terminal window (one click; the CLI's own sign-in needs it). Running it inside the app
  would need a terminal emulator in the page.

## 15. Limits and what has not been verified

| Area | The honest state |
|---|---|
| Automatic condensing | Works only when the team runs in Claude Code (terminal or IDE). Circle Studio's own Chat runs with project hooks off on purpose. Verified with real Haiku in a temp folder. Written into sample-test (qa, 60%) on 2026-10-05; the hook passed a dry run there. **Not yet seen condensing in a real team run** |
| "Review and write files" | Rewrites every agent file from the workflow: hand-written instructions in them are replaced (in sample-test, 19 files would lose 40 to 165 lines each). The diff shows it and a warning counts them. For helpers, use "Write only the helper files" |
| Notifications | Only from now on (nothing before 2026-10-05 was kept). A run counts when it took 20 s or more, or failed. Team runs in Claude Code are not notified when they finish (only their questions in `ALERTS.md`) |
| Codex | Installed here (codex-cli 0.154.0) but **not signed in**, so no real answer has run. Checked 2026-10-05 against the schema the real binary writes (`codex app-server generate-json-schema`), and the real app-server ran through the adapter signed out: start, thread and turn are accepted, and the missing sign-in now ends the turn in about 5 s with "Run `codex login`". Command approvals, file-change approvals and questions are tested only against the fake (now in the real shapes). To finish: `codex login`, then a few short turns in a temp folder |
| Terminal asks on the cards | Real terminal tested with Allow only (two steps). Deny, In the terminal and questions are tested against the server, not in a live terminal. Claude Code sessions started before the switch keep asking in the terminal. If a card is not answered in 9 minutes, the terminal asks. The request runs with Claude Code's own rules, not Circle Studio's policy: the card warns, it does not refuse |
| Gemini (`agy`) | Cannot ask you before acting in headless mode, so it answers and reads only |
| Copilot | Approvals verified for real |
| Claude Code | Verified for real (shell with approvals, questions, resume) |
| OpenClaw, Cursor, Aider | Not supported: they cannot ask you before running a command or changing a file |
| Adding or removing tools | Claude Code only. Codex, Gemini and Copilot configs are listed and tested, not changed |
| "Do it for me" (Let's begin) | Checked with a harmless command, not by really installing or signing in an engine |
| Condensing savings | Mostly context quality, not money: Claude Code already offloads huge outputs, and cache reads cost about a tenth |
| A ZIP download | Cannot update itself; only a git clone can |
| The live chat page and Open in editor | Checked with the fake Claude and the Antigravity IDE on this PC. The page is a Markdown file that the editor reloads when it changes; whether Antigravity refreshes an open page without a click was not watched. Only the main chat gets a page; an agent's runs show under "Also running". The page is rewritten at most about three times a second |
| The Chat as plain Claude Code | MCP servers are still not loaded (`--strict-mcp-config`: each answer is a new process, and starting every server per answer is slow) and hooks stay off; everything else is Claude Code's own. Claude Code's built-in slash commands other than the ones the Chat answers itself go to Claude as text; not checked which the headless CLI runs. PowerShell commands are always asked and never remembered; the policy refuses ones naming a secret file. Following a terminal conversation reads its file every 3 s while the Chat is open and visible |
| Limits | Updated only when Claude answers in Circle Studio, or (with the tap) when your terminal's status line refreshes. A window whose reset time passed shows "new" until the next reading |
| Allow from now on | "Always" is per project and kept until you turn it off in Permissions. "For this run" ends with the answer (a new message is a new run). Checked with the fake Claude; the desktop card's new buttons were not drawn on screen in this session. Codex and Copilot requests use the same broker, so the same choices apply, not tried |
| Commands in the Chat | A project's own slash command with the same name as one of ours (a `/run` or `/stop` in `.claude/commands`) is taken by Circle Studio; `//run` sends it to the agent. Command results live only in the open page (not saved with the chat) |
| New chat and earlier chats | Checked in a browser with the fake Claude (section 13). With the real Claude, that the forked conversation's file holds the whole earlier conversation was not checked here; if it does not, the window still shows the earlier part from the original. Circle Studio's main chat is per engine: a reply that carries on a terminal conversation is always Claude's |
| A stranger's install | Verified 2026-10-05 from fresh GitHub clones (tests, installer with shortcuts redirected, updater sees and applies an update). Not tried on a PC without Node, or as a different Windows user. The installer opening the window was skipped (`CIRCLE_NO_OPEN`) |
| Mods | No real mod (a plugin with a hooks module) is installed on this PC, so the "Chat look / Prompt and context / Tool checks" tags were checked only on fake mods in tests; the four real plugins here (skills, tools, commands, scripts) sort and tag correctly. What a mod changes is read from its source text (which `on(...)` events and `$.ui`, `$.command`, `$.tool` calls it names), not by running it. "On for every project" was checked against the real CLI only as a no-op ("already enabled" counts as done); no real plugin was switched. Installing mods stays in Claude Code (`/plugin`). Codex, Gemini and Copilot have no mods |
| Chat widget reply | Checked live with Claude (Haiku) in the chat window. Not tried with Codex, Gemini or Copilot from the tile (the same `/api/chat` as the Chat tab). The native desktop tile only opens the chat window: typing happens in that window, not in the PowerShell tile |
| Restarting into newer code | Checked for real on a private copy started through the launcher: Restart now (server back on new code in a few seconds, window reloaded, banner gone) and the automatic restart (about 100 s after the change, with nothing running; the open window reloaded by itself at its next check). A window where you are typing or a dialog is open asks before reloading. Desktop widget tiles restart through `lib/deskhost.mjs` as before. A copy downloaded as a ZIP also restarts into code you change by hand, but cannot fetch updates |
| The new graph | Checked in a browser with the 19-agent starter template. A graph you arranged by hand keeps its saved positions, which were made for the old, larger cards, so it may look spread out until you press Tidy |
| Asking on the desktop | Checked for real with a Claude (Haiku) Bash approval: card shown, Allow pressed, run went on. A question card (answer buttons, the "something else" line) was not seen with a real question: Haiku asked none; it is drawn from the same request shape the popup uses. Codex and Copilot requests use the same route, not tried. Cards poll every 3 seconds, so one can show up to 3 seconds late. Team questions from `ALERTS.md` get no card (they are answered by editing the file, through the Inbox) |
| The overlay | Checked on one screen at 225% scaling (1333x834 units: the middle row of added widgets is one wide there and scrolls) with a renamed copy of the host (section 13). Not tried on a second monitor (it covers every screen and puts its panels on the main one), over a full-screen game (a topmost window sits under exclusive full-screen), or with a real question (its answer buttons are drawn from the same shape the tests use). It takes the keyboard only when opened by the hotkey: Windows refuses focus to a window opened any other way, so the right-click "Open the overlay" item may leave the box without the caret until you click it. A sentence typed there costs a real chat turn; one unknown word is treated as a typo, not sent. The panels refresh every 1.5 s while it is open; the tiles stay on their 15 s cycle. Not checked on a screen narrower than 1320 px (the columns then start below the top bar); a panel kept from a bigger screen is pulled back inside |
| The hotkey | Checked with keys sent by a script to a renamed copy of the host: front, then back. Not tried with a person's real key press on a second monitor or a full-screen app (a Topmost window still sits under a full-screen game) |
| The activity ring | Turning and pulsing are WPF and CSS animations; a snapshot shows one frame, so the motion itself was seen only in the code path, not watched by eye in this session. Off when Windows "Show animations" is off or the browser asks for reduced motion |
| Ready-made mods | Both pass `claude plugin validate` and `claude plugin test` with Claude Code 2.1.301. The game and the turn line were not seen inside a real interactive Claude Code session (headless runs cannot show panes). The mod API is early access and may change between Claude Code releases |
| Make a mod with Claude | The request opens in the chat, written out; a full run where Claude builds a mod from it was not done (it is a long agent run with many approvals). Circle Studio's own Chat runs with `disableAllHooks`; whether that also keeps a project's mods out of that Chat was not checked |
| Terminal sessions in Running now | A Claude Code conversation file written to in the last 2 minutes counts as running; one waiting quietly for your typing for longer drops off, and an idle file touched by something else would show for 2 minutes |
| The website | Checked locally in a browser (light and dark, 1280, 700 and 375 px, theme button, 404 page). Not yet deployed to Vercel, so `vercel.json` (redirects, headers) is untested there |

## 16. Facts learned by running things (keep these; they cost time to find)

**Claude Code hooks (checked against Claude Code 2.1.287 on this PC):**
- Claude Code's **PermissionRequest hook** (checked with real Claude Code 2026-10-19): stdin has `tool_name`, `tool_input`, `cwd`,
  `session_id`, `permission_suggestions`; print `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
  (or `"deny"` with a `message` Claude reads); print nothing and Claude Code asks as usual. It fires only for steps
  that need permission (`echo` is auto-allowed, `mkdir` asks); a hook can set its own `timeout` (600 s here). Passing a
  settings file with `--settings` tests it without touching `~/.claude/settings.json`. In `-p` mode with no
  `--permission-mode` the session ran without asking; start a test with `--permission-mode default`.
- No hook fires on context size. A hook cannot change when Claude Code compacts, or which model compacts.
- A `PostToolUse` hook can replace a tool's output with `hookSpecificOutput.updatedToolOutput`, but **only in the
  tool's own shape** (Bash: `{stdout, stderr, interrupted, isImage, noOutputExpected}`). Otherwise Claude Code silently
  keeps the original ("does not match ... output shape; using original output"). See `reshape()` in
  `backend/seed/hooks/circle-condense.mjs`.
- Hook input has `transcript_path`, `agent_type`, `agent_id`, `scratchpad_dir`, `tool_name`, `tool_input`,
  `tool_response`. A subagent's own transcript is
  `<folder of transcript_path>/<session>/subagents/agent-<agent_id>.jsonl`.
- Useful environment variables: `CLAUDE_CODE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`.
- `claude --allowedTools` takes several values and swallows a prompt placed after it: send the prompt on stdin.

**Windows:**
- A process writing to a pipe just before `process.exit` can be cut off: exit in the `write` callback.
- PowerShell 5.1 `Set-Content -Encoding utf8` adds a BOM, which breaks `JSON.parse`. Write JSON without a BOM.
- A PowerShell started detached from Node closes at once: `scripts/open-terminal.vbs` starts it instead.
- `npm install -g` leaves `.cmd` launchers Node cannot start without a shell: `resolveCli` in
  `lib/engines/proc.mjs` finds the real target.
- Edge `--app` never reuses a window: the server keeps a window registry and focuses the open window by a mark in
  its title (`services.desktop.mjs`, `lib/desktop.mjs`).
- Screen capture and clicks need `SetProcessDPIAware` (and `PrintWindow`) under display scaling.
- Desktop widgets started from older code must be restarted: `lib/deskhost.mjs` compares a fingerprint (of `desktop-widgets.ps1`, `overlay.ps1` and `start-widgets.vbs`; before 2026-10-18 a change to `overlay.ps1` alone did not count). It is compared only when the server starts (or Desktop widgets is started): a change to the scripts alone, after the server's last restart, waits for the next one.
- To run the installer from a script, call the file itself (`& "...\Install Circle Studio.cmd"`). `cmd /c` with the
  quoted name can be split at the space and run `install.cmd` from `PATH` instead (nvm-windows ships one).

**Codex app-server (codex-cli 0.154.0):**
- `codex app-server generate-json-schema --out <folder>` writes the whole protocol; check field names there, not in docs.
- A file-change approval (`item/fileChange/requestApproval`) names **no file**: the paths and diff are in that item's
  earlier `item/started` (`changes[].path`, `.diff`, `.kind.move_path`). `codex.mjs` keeps them by item id.
- Question answers go back as `{ answers: { <question id>: { answers: [text] } } }`. Questions may be `isSecret`.
- Signed out, a turn does not fail: it sends `error` notifications with `codexErrorInfo.*.httpStatusCode: 401` and
  `willRetry: true`, 5 tries over WebSocket then 5 over HTTPS (over a minute). Treat the first 401 as signed out.
- A `CODEX_HOME` under `%TEMP%` works but warns that it will not create its helper programs there.

**Circle Studio itself:**
- `workflow-write` regenerates every agent file from the workflow (the body becomes the role text plus stage and
  helper lines). Found by previewing condensing in sample-test before writing. `helpers-write` exists for that.
- Headless Edge takes page screenshots when the Playwright browser is busy: `msedge --headless=new
  --user-data-dir=<temp> --blink-settings=preferredColorScheme=0` (dark; 1 light) `--window-size=1280,1100
  --virtual-time-budget=8000 --screenshot=<file> <url>`.

**Restarting into newer code:**
- The server runs `scripts/launch.vbs --background` (wscript, detached) to restart itself: the launcher sees the
  running server is older than the code on disk, stops it and starts the new one. The child inherits the server's
  environment, so a private copy (`CIRCLE_PORT`, `CIRCLE_DATA`) restarts as itself. Measured: back in a few seconds.

**Claude Code mods and plugins (checked against Claude Code 2.1.29x on this PC, 2026-10-09):**
- A mod is a plugin whose `hooks/hooks.json` is `{ "modules": ["./register.tsx"] }`; classic hooks use `{ "hooks": {...} }`.
  Installed plugins are listed in `~/.claude/plugins/installed_plugins.json` (`scope` user / project / local, and
  `projectPath` for the last two); a plugin folder in `~/.claude/skills/<name>` (or a project's `.claude/skills`) loads
  by itself as `<name>@skills-dir`.
- On or off lives in `enabledPlugins` of `~/.claude/settings.json`, the project's `.claude/settings.json` and
  `.claude/settings.local.json`; the later one wins.
- `claude plugin list --json`, `claude plugin details <id>` (components and context cost) and
  `claude plugin enable|disable <id> --scope user|project|local` exist. Enabling one that is already on exits 1 with
  "is already enabled at user scope".

**Claude Code mods (2.1.301, 2026-10-16):**
- `claude plugin validate <folder>` refuses a module that passes [the middle of this note was lost when this file got duplicated on 2026-10-16; re-check by running `claude plugin validate` on a mod] must be top-level functions.
- `claude plugin test <folder>` runs `*.test.ts` files that import `test`, `expect` from `claude-code/testing`, and can import the module's own exports (`./register.tsx`).
- `$.session.usage()` gives `context.percent` (the status line's used percentage); `Text color` takes theme keys such as `'warning'`.
- A plugin folder under a project's `.claude/skills/<name>/` loads by itself in that project as `<name>@skills-dir`, so adding a mod there needs no install step.

**Windows desktop:**
- A window opened by a timer cannot take the keyboard (`SetForegroundWindow` is refused, the app in front keeps it); the same call from the `WM_HOTKEY` handler works, because the key press gives the host the right. Checked with `GetForegroundWindow` on 2026-10-18.
- In PowerShell 5.1, `@() | ConvertTo-Json` gives nothing (not `[]`), so a change check built that way treats an empty list as "already drawn". Use `ConvertTo-Json -InputObject @{ v = ... }`.
- Claude Code runs Circle Studio's chat in the project folder, so those conversations are files in `~/.claude/projects/<folder>` too: Earlier chats lists them with the terminal's. A continued conversation forks on its first message (the original stays); the chat window shows the fork's file when it is there, else the conversation it came from followed by what was said here.
- Where the RAM goes (2026-10-18): the desktop widgets host (PowerShell + WPF) is the largest; PowerShell with one empty WPF window already commits 147 MB. `SetProcessWorkingSetSize(-1, -1)` once a minute, after a GC, brings its working set from 240 MB to about 20-40 MB; the pages come back as needed. Edge windows open with `--app` in your normal Edge profile, so they share your Edge's processes.
- The server's memory swings came from reading up to 512 KB of every conversation file on every refresh (titles are in the head and the tail): `listConversations` now keeps each file's summary until its size or time changes.
- This PC's screen is 3000x1876 at **225%**: WPF's `WorkArea` is 1333x834. Earlier notes said 150%; the overlay's panels were measured at 2.25 pixels per unit (2026-10-18).
- A screen capture from a PowerShell that is not DPI aware gets only the top-left part of a scaled screen (here 1333x834 of 3000x1876): call `SetProcessDPIAware` first.
- `RegisterHotKey` fails when another app holds the combination; on this PC Ctrl+Alt+Space is taken. Try it, then fall back.
- Tiles owned by Progman (`CsDesk::OnDesktop`) do not pull the desktop (Progman) in front when they are raised, freed and given back: checked with `EnumWindows` z-order on 2026-10-18 (Progman stayed last). What "came in front" with the overlay was the tiles themselves, over the panels.
- To drive a test copy of the host: `keybd_event` for its hotkey, `SetCursorPos` plus `mouse_event` in small steps for drags (WPF needs the moves), `SendKeys.SendWait` for typing; all after `SetProcessDPIAware`, in screen pixels.
- A WPF window can be drawn to PNG off-screen (`RenderTargetBitmap` of its content, window placed at -5000) to check the native tiles without touching the screen.

- When the server never comes up, read the end of `data/server.log`: the launcher writes there, and so does the server's own crash. A syntax error in any backend module stops the whole server (2026-10-19). After any hand or scripted edit, run `node --check` on every changed file.
- In this Claude Code Bash tool on Windows, a quoted heredoc fed to `python -` still lost one level of backslashes: a newline escape meant for JavaScript came out as a real line break, and an escaped quote as a bare quote (2026-10-19). Use the Edit tool, or a script file, for anything with backslashes, then `node --check`.
- Claude Code's stream sends `rate_limit_event` (`rate_limit_info.unifiedWindows.five_hour|seven_day.utilization` 0..1, `resetsAt` in seconds) every turn; the status line gets `rate_limits.five_hour|seven_day.used_percentage` (2026-10-19, Claude Code 2.1.303). Conversation files do not keep them.
- With all tools on, Claude may start a subagent in the background; in a per-turn `-p` process its permission requests then fail after the result ("Tool permission request failed: AbortError: Stream closed"). `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` keeps subagents in the turn, and their Bash asks through the stdio permission tool (2026-10-19).
- From Git Bash, an argument starting with `/` (such as `/usage`) is rewritten to a Windows path (MSYS path conversion) before a program sees it.
- Windows Defender blocks a PowerShell script that grabs the screen in a loop (`CopyFromScreen`): "This script contains malicious content and has been blocked by your antivirus software" (2026-10-19). Do not work around it; to record the desktop cards, the host draws its own windows (`RenderTargetBitmap`), and app screens come from the browser.
- `SendKeys` types into whatever window has the keyboard, including the human's: in a test it mixed with their typing ("cWhkatever is. alrpeady"). Fill boxes with UI Automation's `ValuePattern.SetValue` and press buttons with `InvokePattern`, never key presses.
- A UI Automation element of a window that has closed keeps answering `.Current.Name` from its cache: check that the window is gone by searching the windows again.
- Claude Code names its terminal window just "claude" (not the conversation). A `claude.exe`'s working folder can be read from the process itself (PEB, process parameters, `CurrentDirectory`); in Windows Terminal, `AttachConsole(pid)` + `GetConsoleWindow()` + `GetWindow(GW_OWNER)` gives the terminal's window; in Antigravity IDE the console window has no owner, and the parents lead to the IDE process, one process with a window per folder (2026-10-19).
- `tests/integration/installer.test.mjs` starts and stops a Circle Studio on port 4397: a manual test copy must use another port (4399) or a test run stops it (2026-10-19).
- In PowerShell, `@(@('a', 1, 2))` is flattened to one list of three: a one-item list of lists needs `@(,@('a', 1, 2))`. And variables ignore case: `$W` and `$w` are the same variable.
- A video can be made without a recorder: draw the frames on a canvas and record it with the browser's `MediaRecorder` (WebM; it plays, but does not seek well).
- A page keeps the project it loaded: a dialog that saves the whole permissions object must read them fresh first, or it undoes a change made elsewhere (a card's "always") since the page loaded (2026-10-19).
- `.cs-radio` marked its checked state only through a `data-checked` attribute that some forms never set; `:has(input:checked)` now marks it too (2026-10-19).
- Claude's stream does not always send a tool in pieces: a whole `assistant` message with `tool_use` (no stream events) left the tool unnamed in the chat; `lib/claude.mjs` now names it from the whole message too (`toolsSeen`).

**GitHub:**
- Merging a pull request on GitHub adds a merge commit to `main` that the local branch does not have, so later
  `git push origin master:main` is refused. Merge `origin/main` locally first. Do not force-push: clones of `main` would
  then fail to fast-forward.

## 17. Working on it again (for a new chat)

Claude Code loads `CLAUDE.md` by itself in this folder, and `CLAUDE.md` says to read this file first and to keep it
true: every change to features, files, limits, facts or state updates the matching section here before the final
report. So a new chat needs nothing extra. If in doubt, say: *"Read `CLAUDE.md` and `WHAT-IS-WHERE.md` first."*

- **The rules** are in `CLAUDE.md`: local only, no API key ever, you do git yourself, diff first for every write into a
  project, agents ask first, secrets never shown, design values only from `tokens.css`, Node built-ins only, no shell.
- **Testing:** never touch real projects or the running app's `data/`. Tests use temp folders, a private port and
  the fake CLIs in `tests/helpers/`. For a manual look, start a private server on another port (4396 was used) with
  a temp data folder and `CIRCLE_SHORTCUT_DIR` pointing to a temp folder, and check in a browser in light and dark,
  about 1280 and 700 px wide. Real Claude only with Haiku and a few short prompts.
- **After a change:** `npm test`, `npm run contrast`; for something new to tell users, change `RELEASE` and `CHANGES`
  in `frontend/js/components/whatsnew.js` (keep the newest 7), add a topic in `backend/lib/guide.mjs` if it needs
  help text, add a section to `docs/decisions.md`, a row in `README.md`, and update this file.
- **Preferences:**
  - Plain, short words in the interface, with jargon behind Details.
  - Never show a template or a guess as a project's real state.
  - Fixes run in one click (previewed, reversible, verified), not handed over as commands.
  - Every feature also works for someone without your setup (no Claude, other tools, nothing signed in).

### Your requests, and where each went

| You asked | Built in |
|---|---|
| Only one Circle Studio window should open | v9 |
| Widgets as a menu item below Connections | v9 |
| GitHub publishing, README, update commands | README (Install, Commands, Updates, Publishing) |
| Inbox and Library looked off to the right | v10 (centred column) |
| The agent finds skills on GitHub, you approve; paste a link | v10 (Find skills) |
| Connections as "keys only", tools managed per project, no duplicate plugins or MCP servers | v10 (Keys page, Connections tab) |
| People without Claude: a Let's begin with commands | v10 |
| GitHub sign-in inside the app; check OpenClaw; sign-in in a terminal; a security pass | v11 |
| A Chat widget; one window on tap; switch the project in widgets | v12 |
| Freeze widgets in place | v12 (Lock in place) |
| A cheaper model shrinking context, through hooks above a limit | v13 (automatic condensing) |
| The smaller agent as part of the workflow | v13 (helper nodes) |
| A store of patterns that relates them to your team, open to explore | v13 (patterns and the Patterns panel) |
| A website for Vercel in the app's style, with a download | `Desktopcircle-studio-site` (2026-10-05) |
| Test Codex for real | 2026-10-05: not signed in, so checked against its own schema and run signed out; three fixes (file approvals, answers, sign-in error). Live turns still to do (section 15) |
| Try automatic condensing in a real project | 2026-10-05: sample-test, qa above 60%; found and fixed the rewrite of every agent file (`helpers-write`) |
| Notifications in the same design, small tiles, other useful widgets | v14: Notifications, Running now, small sizes for every tile |
| Check that a stranger can really install it from GitHub | Checked 2026-10-05: works; `main` is behind (section 13, to-do 2) |
| Mods: help check and change them, sorted into general (every project) and separate (one project) | v15: Mods page and project tab (`lib/mods.mjs`, `views/mods.js`), `npm run mods` |
| The workflow "just circles", not nice: make it graph based, dynamic, fresh and neat | v15: the graph redrawn (branch lines, numbered stages, focus on hover, glide, map) |
| A chat widget to chat and see the engine on the desktop | v15: reply box and engine in the Chat tile; the desktop Chat tile opens a chat window |
| Everything works in the CLI | v15: `npm run mods`, `npm run chat` (checked live with Haiku) |
| The chat feels messy; widgets built better and neatly | v16: whole, formatted messages in the chat window, speaker once, plain words in tiles |
| The workflow widget still not good enough | v16: stages done as a count, the stage now with its people, what is next |
| A circle widget with animations when a project is working | v16: the Activity ring tile (desktop and app) |
| Any query should come through my desktop or a notification, not the Inbox | v16: cards on the desktop with Allow / Deny or the answers; no double toast |
| What is running where and at what time, simpler | v16: Running now with clock times, including Claude Code in a terminal |
| Too many toggle buttons (Lanes, Local only, Human does git) | v16: one "Project rules" line, toggle buttons and checkboxes inside |
| People find it hard; put it on their desktop | v16: Home offers the desktop once; new installs get a useful starter board |
| Mods for end-to-end testing and context checking; a mods widget; Claude builds a mod like a mini game | v16: turn-check and waiting-game ready-made, Make a mod with Claude, Check, the Mods tile |
| Use the apple-design skill for design ideas | v16: widget, notification, motion, progress and toggle guidance applied (`docs/decisions.md`, v16) |
| A hotkey that brings everything to the front | v16: Ctrl+Alt+C (fallbacks Ctrl+Alt+W, Win+Alt+C) |
| Xbox Game Bar style: all my widgets plus other info come up with a hotkey, and commands I type, fully working, also in Circle Studio | v17: the overlay (Ctrl+Alt+C) with panels and a command box; the same commands on the Widgets page |
| The game bar is buggy: things cannot be moved, what is on my desktop comes in front too, and the project change is plain; make it a nice switcher | v17.1: tiles stay under the dim, every panel drags (lock no longer blocks it), project switcher bar, Widgets menu, Reset layout |
| Build what you think is best, neat and functional, with the least RAM and overhead | v17.5: the server and the widgets made lighter (measured, section 13), hidden windows stop polling, Carry on in the Chat tab |
| Voice (Claude's or ChatGPT's text to speech) if it comes with them, else a future idea; refine everything for ease of use: terminals, skills, keys | v17.4: no engine CLI has voice (noted under Ideas for later, with a keyless Windows route); GitHub sign-out button, old key backups removed by themselves, terminal steps taken out of the Mods error and the to-do list; Library and Keys checked |
| Create a new chat or continue the previous one in the folder I want, with no IDE or terminal: everything in the app or on the desktop | v17.3: chat window New chat / Earlier chats / a reply carries on the newest conversation; overlay `new`, `chats`, `continue`, `folder` |
| Refine the desktop widgets to look like the overlay, and let other widgets be added to the bar when needed | v17.2: tiles in the panels' card with grip or lock and a project picker card; Widgets, Add more in the overlay (Activity rings, Agents, Project at a glance, All projects, Mods) |
| Antigravity connect: open the project and the file being worked on in Antigravity, with the chat there | v17.6 (Open in editor, chat page) and v17.7 (the page live and complete) |
| It does not open after shutting down or on a click; debug everything | v17.7: the crash on start fixed (one broken line), a failed start now shows a message; the project header fixed at narrow widths; tools named in every answer |
| The chat I type shown there with everything; airtight; know what is going on at any time; commands in the normal chat | v17.7: live turns in the Chat from anywhere, the live editor page (status, what waits and how to answer, the whole chat), `/commands` in the Chat |
| Two notifications for one request (keep only the desktop card); the notifications open the app; I cannot view the chat; allow modifications always, with options; wait until my chat is done | v17.8: the window's own notification dropped when a card shows it; "allow from now on" choices (run, always edits here, always reading outside) on the popup and card, kept in Permissions; the editor page newest first; built only after asking, once the Circle Studio chat had finished |
| Open chat does not show where the chat runs in the terminal; the chat is not like normal Claude; a notification after an answer, not a prompt; weekly and 5-hour limits in a widget; the chat is the main thing: /usage, everything I get there, the location, send immediately | v17.9: the real Chat opens, follows a terminal conversation live, plain Claude Code (all tools), messages queue while it works, `/usage` `/model` `/status` `/clear` `/resume`, the folder at the top, runs survive the window; answer cards are notifications; the Limits widget with the terminal tap |
| When Claude asks to choose options: a notification where I can choose; all kinds tested, understandable, not broken; record a video. Then: record opening a chat, finding where it runs, the terminal with the chat, widgets and commands; fix bugs | v17.10: the question card handles every kind and the chat says the answer in words; two videos in Videos; five bugs found while recording, fixed (section 13) |
| I type hi, no response; no command nonsense; Ctrl+Alt+C should be a chat with that folder's Claude, the one I choose, in a small bar, seeing where it works; /usage shown below; answer on notifications; record it with the previous ones | v17.11: the bar (every word to Claude, `/` commands under the box, engine button, where and now, Send/Stop, cards over it); one video of all three |
| How do I open the terminal where the chat is running? Give an option; the folder too, in the notification next to Open chat | v17.12: Terminal (Chat, bar, cards) and Folder (cards) |
| I clicked Terminal and it opened in Circle Studio; the message I type in the bar shows twice (I work in the bar, not the app); a widget with the 5-hour and weekly usage there too | v17.14: Terminal is a real terminal; the bar shows it once; Plan limits panel and the bar's line |
| Try the terminal, that's the main part: any permission I can approve instead of opening the terminal; make a video; properly and clean | v17.13: the PermissionRequest hook and the Settings switch; tested with real Claude Code in a terminal; video |
| The older running version should pick up an update by itself, or give me an option (close until I reopen) | v15: restarts by itself when nothing runs; banner with Restart now / Reload / Later (`components/freshness.js`) |
