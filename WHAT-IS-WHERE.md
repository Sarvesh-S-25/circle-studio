# Circle Studio: what is built, and where it is

A map of everything in this folder, written 2026-10-04, kept up to 2026-10-05 (version 14). For *how* it is built and what is fixed, see
`docs/spec.md`; for why things changed from the original request, `docs/decisions.md`; for install and commands,
`README.md`.

**In one line:** a local Windows control room for AI agent teams. Node 24 built-ins only, plain JavaScript, no build
step, served on `http://127.0.0.1:4380`. It runs Claude Code, Codex, Gemini (`agy`) and GitHub Copilot through your own
sign-ins, never an API key.

About 25,000 lines across `backend/`, `frontend/`, `scripts/` and `tests/`. 263 tests: 260 pass, 3 skip (they need an
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
| The graph: You, stages, agents, links; Edit / Live / Versions | `js/components/graph/index.js`, `graph/layout.js`, `graph/svg.js`, `js/views/workflow.js` | `lib/workflow.mjs` (the `circle-workflow/1` format) | `unit/workflow.test.mjs`, `unit/graph-layout.test.mjs` |
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

### Chat, Inbox, approvals

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| Chat: a real agent session in the folder | `js/views/chat.js`, `js/markdown.js` | `routes.engines.mjs`, `lib/sessions.mjs`, `lib/engines/*`, `lib/records.mjs` | `integration/chat.test.mjs`, `integration/engines.test.mjs` |
| Earlier Claude Code conversations (read, continue) | `js/views/chat.js` | `lib/cchistory.mjs` | `integration/history.test.mjs` |
| Approval and question popups | `js/components/requests.js`, `css/requests.css` | `lib/sessions.mjs` | `integration/engines.test.mjs` |
| The approval policy (refuse / ask / outside the project) | | `lib/policy.mjs`, `lib/policy-shell.mjs`, `lib/policy-paths.mjs` | `unit/policy.test.mjs` |
| Inbox (every approval and question, kept) | `js/views/inbox.js` | `lib/inbox.mjs` | `unit/inbox.test.mjs` |
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
| GitHub sign-in through `gh` (token never seen) | `js/views/start.js` | `lib/ghcli.mjs` | `integration/security.test.mjs` |

### Cost, health, git

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| Cost tab: 30 days of Claude use, per model, day, agent; cheaper options; what condensing saved | `js/views/cost.js`, `components/charts.js` | `lib/cost.mjs`, `lib/pricing.mjs` | `unit/cost.test.mjs` |
| Spending by provider (all folders) | widget tiles | `lib/usage.mjs` | |
| Health (what needs you, in plain words) | `js/views/health.js` | `lib/health.mjs` | `unit/health.test.mjs` |
| Git chip and panel, GitHub Actions and PRs (read only) | `components/gitpanel.js` | `lib/gitstatus.mjs`, `lib/ghcli.mjs` | `integration/desktop.test.mjs` |
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
| A project's widget window | `frontend/widget.html`, `js/widget.js`, `css/widget.css` | `projects.pulse` route | `integration/desktop.test.mjs` |
| Chat widget (main chat and agents' chats) | `components/tiles.js` | `lib/chatfeed.mjs` | `integration/chatwidget.test.mjs` |
| Notifications (kept, live, marked read) and Running now tiles; every tile small, medium or large | `components/tiles.js`, `components/board.js`, `components/requests.js` (`notice` event), `css/tiles.css`, `icons.js` (`bell`) | `lib/notices.mjs`, `services.desktop.mjs` (records each event), `lib/feed.mjs` (`noticesTile`, `runningTile`, small variants), `notices.list/read` | `integration/notices.test.mjs` |
| Real desktop widgets (rounded, draggable, lock in place, switch project) | | `scripts/widgets/desktop-widgets.ps1`, `scripts/widgets/start-widgets.vbs`, `lib/deskhost.mjs`, `lib/palette.mjs` | `integration/chatwidget.test.mjs` |
| One window per thing (reopening brings it forward) | | `services.desktop.mjs`, `lib/desktop.mjs`, `scripts/launch.mjs` | `integration/windows.test.mjs` |

### Install, update, settings

| Feature | Screen | Logic | Tests |
|---|---|---|---|
| Installer, shortcuts, start at sign-in | | `Install Circle Studio.cmd`, `scripts/circle.mjs`, `lib/desktop.mjs`, `lib/icon.mjs` | `integration/installer.test.mjs` |
| Launcher (no console window) | | `scripts/launch.vbs`, `scripts/launch.mjs` | `integration/launcher.test.mjs` |
| Self-update (fast-forward only) | `components/updates.js` | `lib/updater.mjs`, `lib/codeversion.mjs` | `integration/updater.test.mjs` |
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
| `sessions.mjs` | The broker: every run, every request to you |
| `inbox.mjs` | Approvals and questions, kept |
| `agentstate.mjs` | Working / waiting / done / idle per agent |
| `cchistory.mjs` | Your Claude Code conversations from the terminal |
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
| `palette.mjs` | Token colours for the native widgets |
| `icon.mjs` | The app icon, drawn in code |
| `pickfolder.mjs` | Windows folder dialog |
| `updater.mjs`, `codeversion.mjs` | Self-update and "is the server running old code" |
| `store.mjs` | The `data/` folder: atomic JSON writes |
| `route-helpers.mjs` | Shared route helpers |

### `backend/seed/`

| File | What it does |
|---|---|
| `staged-build-team.json` | The starter template, copied once into `data/templates` |
| `patterns.json` | The 7 patterns: Haiku reader, automatic condensing, second opinion, engine checks a stage, cheapest model, skills, optional agents. Each with use when, avoid when, costs, how to set it |
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
| `js/views/*.js` | One per screen: home, project, workflow, chat, cost, health, team, inbox, library, skilleditor, pskills, keys, connections, widgets, advisor, settings, start |
| `js/components/graph/*.js` | The graph: `index` (canvas), `layout` (geometry), `nodepanel`, `helper` (workflow helper), `patterns` (Patterns panel), `versions`, `svg` |
| `js/components/*.js` | Shared pieces: overlay (modals, toasts), diffreview, requests (popups), rail, palette, guide, whatsnew, updates, catalog, cxmanager, gitpanel, board, tiles, charts, dnd, inspector, newproject, openfolder, permissions, notify, alerts, panelsize |
| `css/tokens.css` | **Every** design value (colours, spacing, type), light and dark |
| `css/base.css`, `components.css`, `views.css`, `graph.css`, `requests.css`, `tiles.css`, `widget.css` | Styles, tokens only |
| `logo.svg`, `favicon.svg` | The ring logo |

---

## 5. Scripts (`scripts/`)

| File | What it does |
|---|---|
| `circle.mjs` | The `npm run setup / open / stop / status / update / doctor / uninstall` commands |
| `launch.mjs`, `launch.vbs` | Start the app with no console window; bring an open window forward |
| `open-terminal.vbs` | Opens a visible PowerShell for one sign-in command (Let's begin) |
| `widgets/desktop-widgets.ps1` | The real desktop widgets (rounded tiles, drag, right-click, lock, switch project) |
| `widgets/start-widgets.vbs` | Starts them with no console window |
| `check-contrast.mjs` | `npm run contrast`: checks text contrast in both themes |

---

## 6. Tests (`tests/`)

| Folder | What is there |
|---|---|
| `unit/` | Pure logic: policy, workflow, layout, render, cost, health, helper, semver, templates, frontmatter, design rules, and `frontend-syntax.test.mjs` (parses every browser module) |
| `contract/routes.test.mjs` | Every route in `contracts/api.json` has a handler and every frontend call matches |
| `integration/` | The real server on a private port with temp data: api, workflow, ops, chat, engines, history, guide, alerts, desktop, windows, installer, launcher, updater, security, tools, chatwidget, helpers, notices, v6 / v7 / v8 |
| `helpers/` | Fake CLIs (`fake-claude`, `fake-engines`, `fake-haiku`, `fake-mcp`), fake transcripts (`fake-history`), server and project helpers |
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
| `desktop-widgets.*` | Desktop widget layout, process id, version |
| `notices.json` | Your notifications (the newest 60; what the Notifications tile shows) |
| `server.log` | Server log (secrets masked) |

---

## 9. What the app writes into a project (always after you review the diff)

| File in the project | When |
|---|---|
| `workflow.json` | "Review and write files" |
| `AGENTS.md`, `CLAUDE.md`, `.claude/agents/*.md` (and each engine's own agent folder) | Same |
| Skills folders per engine | Installing a skill |
| `.mcp.json` and engine configs | Connections: Add / Remove / Key / Fix (backed up, undone on failure) |
| `.claude/hooks/circle-condense.mjs`, `.claude/hooks/circle-condense.json` | Only when an agent's helper is "Automatically" |
| `.claude/settings.json` | Only Circle Studio's one hook entry is merged in or removed; everything else stays |
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

## 11. API routes (`contracts/api.json`, 87 routes)

| Group | Routes |
|---|---|
| App | `app.health`, `app.state`, `stats.get`, `app.update.get/apply`, `system.pickFolder`, `events.stream` |
| Projects | `projects.list/add/create/get/remove/health/plan.get/plan.save/permissions/file/git/git.github/pulse/cost/live` |
| Chat and history | `projects.chat.get/reset/link`, `projects.history.list/get`, `chat.send/stop`, `advisor.run`, `guide.ask` |
| Engines and requests | `engines.list/check/terminal`, `requests.list/respond`, `alerts.list` |
| Changes | `changes.preview`, `changes.apply` |
| Workflow and templates | `workflow.get/save/restore/suggest/patterns`, `templates.list/create/import/get/save/remove`, `skills.discover` |
| Skills | `skills.list/get/save/remove/use/scan/fetch`, `import.files` |
| Catalog | `catalog.get/rebuild/describe/index` |
| Connections and keys | `connections.list/check/test/fix/manage/plan/apply`, `security.scan`, `vault.list/set/remove/import`, `usage.providers` |
| Desktop and widgets | `settings.get/save`, `desktop.shortcut/status/open/widgets`, `widgets.feed/chat/pick`, `notices.list/read` |

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

The full reasoning for each is in `docs/decisions.md`.

---

## 13. Where things stand right now (2026-10-05)

**Code.** v14: `npm test` gives 263 tests, 260 pass, 0 fail, 3 skipped (they need an optional
`Desktop\circle-studio` reference folder that is not on this PC). `npm run contrast` passes in both themes. A secret
scan of the files to push found nothing real (4 known false positives, nothing over 2 MB). `package.json` says
version `1.1.0`.

**Git and GitHub (read 2026-10-05 with `git fetch` and `git ls-remote`):**

| What | State |
|---|---|
| Repository | `https://github.com/Sarvesh-S-25/circle-studio.git` (remote `origin`) |
| Your local branch | `master`, the same as `origin/master`: `88bfe64 New features for smaller agents` (v13 is pushed to `master`) |
| GitHub's default branch | **`main`, still at `88b4086`** (v12: no `patterns.mjs`, 241 tests). A stranger who clones, or uses the ZIP or the website's Download button, gets v12, not v13 |
| `main` and `master` have split | `main` has 2 commits `master` lacks (the GitHub merge commits of pull requests #1 and #2, no file changes of their own); `master` has 4 that `main` lacks. So `git push origin master:main` alone is **refused** (not a fast-forward). Merging `origin/main` into `master` first is clean and changes no files (checked with `git merge-tree`). See the to-do list |
| Not committed yet | All of v14 (2026-10-05): the Codex fixes (`engines/codex.mjs`, `policy.mjs`), `helpers-write` (`ops.mjs`, `nodepanel.js`, `workflow.js`), notifications and the new tiles (`notices.mjs` new, `services.desktop.mjs`, `routes.desktop.mjs`, `routes.engines.mjs`, `feed.mjs`, `tiles.js`, `board.js`, `requests.js`, `api.js`, `icons.js`, `tiles.css`, `contracts/api.json`), tests (`notices.test.mjs` new, `engines`, `helpers`, `chatwidget`, `policy`, `fake-engines`), `whatsnew.js`, `README.md`, `docs/decisions.md`, this file |
| `trail.md` | Still in git; an old test log from an earlier team, not part of the app |

**Stranger install check (2026-10-05).** Fresh clones of both branches were made in a temp folder whose path has a
space, then deleted. Both pass `npm test` (`master`: 255 tests, 252 pass, 3 skip; `main`: 241, 238 pass, 3 skip).
`Install Circle Studio.cmd`, both double-click style and the README's PowerShell line, with `CIRCLE_SHORTCUT_DIR`
and a private port, made the Desktop and Start-menu shortcuts (pointing to `launch.vbs` in the clone, with the icon
in its `data`) and started the server. The updater, on a copy moved back one commit, said **Update ready**, and on
`master` **Update and restart** fast-forwarded it and restarted. Nothing in the app needed fixing. The only problem a
newcomer hits is that `main` is behind.

**On this PC:**

- Your running Circle Studio (port 4380) runs v14 (restarted in the background 2026-10-05; health says not stale). Your desktop widgets restart on their own; add Notifications or Running now on the Widgets page.
- **sample-test has automatic condensing on for `qa` (above 60%)**, written 2026-10-05 after you approved the diff: `.claude/settings.json` (+12 lines, one PostToolUse entry), `.claude/hooks/circle-condense.mjs` and `.json`. Backup and Undo: `data\backups\sample_test\2026-10-05T16-59-38-938Z`. Its workflow is now v1.0.3 in Circle Studio.
- Your desktop widgets restart on their own after updates.
- `data\backups` holds 4 old copies of `~/.claude.json` from 2026-10-02. They contain **the plain-text keys** that the
  connection fixes later moved out. They are in the app's own data folder (never in git), but they are worth deleting.
- In the `uml-analyzer` project, a hand-made copy of the `stitch` connection duplicates one a plugin already brings. The
  manager (Keys, Everything on this PC) offers to remove it; it was left for your click.

## 14. Your to-do list

1. **Delete the old backups** (they hold plain-text keys): in PowerShell, from the app folder:
   `Remove-Item -Recurse -Force data\backups`
2. **Put v13 on `main`** (this is what strangers get; today they get v12). From the app folder:
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
   Project, preset **Other**, no build command. Do step 2 first, so the Download button gives v13. Details in that
   folder's `README.md`.
4. Optional, to finish the Codex test: run `codex login` in a terminal, then ask for "test Codex for real" again (a few
   short turns in a temp folder, one that runs a command so the popup is tried).
5. Optional: in the `uml-analyzer` project, remove the duplicate `stitch` through the manager.
6. Optional: see condensing work in sample-test. In a terminal: `cd $HOME\Desktop\sample-test`, `claude`, then ask for
   something that makes the qa agent read a lot, for example *"Use the qa subagent to review every test and script in
   this folder and run the checks it finds."* It condenses only once qa's own context is 60% full, so a short task
   shows nothing; to see it sooner, set the limit to 30% (Workflow, qa, Helper) and use "Write only the helper files".
   Then Circle Studio, sample-test, Cost: "condensed" shows how many outputs and how many tokens were kept out, per
   agent. Never use "Review and write files" on sample-test unless you want its 19 agent files rewritten.

## 15. Limits and what has not been verified

| Area | The honest state |
|---|---|
| Automatic condensing | Works only when the team runs in Claude Code (terminal or IDE). Circle Studio's own Chat runs with project hooks off on purpose. Verified with real Haiku in a temp folder. Written into sample-test (qa, 60%) on 2026-10-05; the hook passed a dry run there. **Not yet seen condensing in a real team run** |
| "Review and write files" | Rewrites every agent file from the workflow: hand-written instructions in them are replaced (in sample-test, 19 files would lose 40 to 165 lines each). The diff shows it and a warning counts them. For helpers, use "Write only the helper files" |
| Notifications | Only from now on (nothing before 2026-10-05 was kept). A run counts when it took 20 s or more, or failed. Team runs in Claude Code are not notified when they finish (only their questions in `ALERTS.md`) |
| Codex | Installed here (codex-cli 0.154.0) but **not signed in**, so no real answer has run. Checked 2026-10-05 against the schema the real binary writes (`codex app-server generate-json-schema`), and the real app-server ran through the adapter signed out: start, thread and turn are accepted, and the missing sign-in now ends the turn in about 5 s with "Run `codex login`". Command approvals, file-change approvals and questions are tested only against the fake (now in the real shapes). To finish: `codex login`, then a few short turns in a temp folder |
| Gemini (`agy`) | Cannot ask you before acting in headless mode, so it answers and reads only |
| Copilot | Approvals verified for real |
| Claude Code | Verified for real (shell with approvals, questions, resume) |
| OpenClaw, Cursor, Aider | Not supported: they cannot ask you before running a command or changing a file |
| Adding or removing tools | Claude Code only. Codex, Gemini and Copilot configs are listed and tested, not changed |
| "Do it for me" (Let's begin) | Checked with a harmless command, not by really installing or signing in an engine |
| Condensing savings | Mostly context quality, not money: Claude Code already offloads huge outputs, and cache reads cost about a tenth |
| A ZIP download | Cannot update itself; only a git clone can |
| A stranger's install | Verified 2026-10-05 from fresh GitHub clones (tests, installer with shortcuts redirected, updater sees and applies an update). Not tried on a PC without Node, or as a different Windows user. The installer opening the window was skipped (`CIRCLE_NO_OPEN`) |
| The website | Checked locally in a browser (light and dark, 1280, 700 and 375 px, theme button, 404 page). Not yet deployed to Vercel, so `vercel.json` (redirects, headers) is untested there |

## 16. Facts learned by running things (keep these; they cost time to find)

**Claude Code hooks (checked against Claude Code 2.1.287 on this PC):**
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
- Desktop widgets started from older code must be restarted: `lib/deskhost.mjs` compares a fingerprint.
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
