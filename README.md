# Circle Studio

A local control room for AI agent teams on Windows. You lay out a team as a workflow (stages, agents, checkpoints,
the engine and model each one uses), talk to any agent in its project folder, and answer everything an agent wants to
run, change or ask, from a popup, the Inbox, a desktop notification or a small widget window. It drives
**Claude Code, Codex, Gemini (the `agy` CLI) and GitHub Copilot** through your own terminal sign-ins.

Single user, this PC, `127.0.0.1` only. No account, no telemetry, **no API key**. Node.js built-ins only, no build step.

**1.3.2:** Desktop polling runs asynchronously and keeps the last good tiles through temporary outages. Browser event
connections detect stalled heartbeats after sleep and resync pending approvals. Shortcut launches recover server crashes
with backoff; explicit Stop disables recovery. Codex terminal approval hooks are available in Settings (or
`node scripts/circle.mjs hooks --engine codex --on`). Restart Codex and review/trust the hook through `/hooks` before use.
Circle chats and independent terminal sessions use separate notification paths. Windows notification tests await actual submission. Native Codex approval/answer controls were checked on
Windows with a dummy project. Terminal follows the displayed saved chat and reasoning choice; pending Codex copies
receive their own provider thread, and failed sends retain a draft. A real Codex 0.164.0 CLI round trip passed.
Full evidence and acceptance limits are in [connections.md](connections.md).

## Install

You need **Windows 10 or 11**, **Node.js 24 or newer** ([nodejs.org](https://nodejs.org), the LTS button) and an
account for at least one of the AI tools below. Git is recommended (for project status and updates).

Circle Studio has no AI of its own: it runs the AI tools you already use, with your own sign-in (no API key). The first
time it opens, **Let's begin** asks which you use, shows which are ready, and runs the steps for you if you like:

| Tool | Account | Install | Sign in |
|---|---|---|---|
| Claude Code (Anthropic) | Claude Pro or Max, or an Anthropic Console account | `npm install -g @anthropic-ai/claude-code` | `claude auth login` |
| Codex (OpenAI) | ChatGPT Plus, Pro or Team, or an OpenAI account | `npm install -g @openai/codex` | `codex login` |
| Gemini (Google) | a Google account | Antigravity, from [antigravity.google](https://antigravity.google) | run `agy` once |
| GitHub Copilot | a GitHub account with a Copilot plan | `npm install -g @github/copilot` | `copilot login` |

Codex and Claude support structured advice for the workflow helper, Find skills, Advisor, catalog and connection advice.
Choose a preferred engine in Settings. Circle relays the approval requests an engine raises; Codex's own policies can
allow operations without an approval card. Supported protocol behavior and live verification are separate states.
OpenClaw, Cursor and Aider are not driven by this app.

**GitHub (optional).** Sign in through the GitHub CLI for private repositories, Actions and pull requests, and more
searches when finding skills: `winget install --id GitHub.cli -e --source winget`, then
`gh auth login --hostname github.com --web --git-protocol https` (Let's begin can run both). The CLI keeps the sign-in;
Circle Studio never sees your token.

**With git (recommended: it can then update itself).** In PowerShell or a terminal:

```
cd $HOME\Documents
git clone https://github.com/Sarvesh-S-25/circle-studio.git
cd circle-studio
.\"Install Circle Studio.cmd"
```

**Without git.** Download the ZIP
([github.com/Sarvesh-S-25/circle-studio/archive/refs/heads/main.zip](https://github.com/Sarvesh-S-25/circle-studio/archive/refs/heads/main.zip)),
unpack it somewhere permanent such as `Documents\circle-studio`, and double-click **`Install Circle Studio.cmd`**.

The installer checks Node, lists which engines it found, puts **Circle Studio** on the Desktop and in the Start menu,
asks whether to start at sign-in, and opens the app. No administrator rights, nothing downloaded. Afterwards open it
from the Desktop or Start menu; opening it again while it is open brings the same window forward.

Your data (projects list, templates, chats, Inbox, settings, the key vault) lives in the `data` folder next to the code.
It is never uploaded and never part of git.

For a packaged release, extract the release ZIP and run **Install for this user.cmd**. It verifies the manifest before
staging a version in `%LOCALAPPDATA%\CircleStudio\app-<version>`; data stays in `%LOCALAPPDATA%\CircleStudio\data`.
The Windows runtime package includes a checksum-verified Node binary and its license. Source checkouts keep their
existing data location; `CIRCLE_DATA` overrides either mode. Local artifacts are unsigned until release signing is configured.
Run `powershell -File scripts/install-package.ps1 -Repair` from a verified extracted package to restore damaged installed
files and setup while preserving data. `-ActivateVersion <version>` verifies and activates an older retained version;
keep a backup before using older code with newer data. Packaged copies check stable GitHub Releases and stage checksum-
and manifest-verified downloads; an isolated candidate launch must pass before activation. Current artifacts are unsigned.

This development build adds saved conversation archives, Codex history/model/account-limit discovery, a durable message
queue with explicit restart recovery, Tasks & progress with review evidence and optional local achievements, and
Settings → Storage & diagnostics with backup, isolated restore and previewed generated-file cleanup. See
[connections.md](connections.md) for verified behavior and outstanding acceptance checks. `npm run demo` uses temporary
folders and fake engines; `npm run package` builds a local Windows ZIP. Signing, publication and a clean-account
installation test are separate release gates.

## Commands

```
npm run setup        install: Desktop and Start menu shortcuts, optional start at sign-in
npm run open         open the app (starts the server in the background if needed)
npm run widget -- <project id>   open a project's widget window
npm start            run the server in this console (http://127.0.0.1:4380)
npm run stop         stop the background server
npm run status       is it running?
npm run update       update from the git remote (only when this folder has no changes of yours)
npm run doctor       check Node, the engines, git, shortcuts and updates
npm run uninstall    remove the shortcuts and stop it (your data stays)
npm run mods -- [project]      Claude Code mods and plugins: for every project, only one, or off
npm run chat -- <project> [--engine codex] [--agent <id>] [--model haiku] <message>
                     chat in a project from the terminal (approvals open in Circle Studio)
npm test             unit, contract and integration tests (fake CLIs, temp folders)
```

## Updates

The app checks GitHub once a day (read only). When a newer version is there, the taskbar shows **Update ready** and
Settings, Updates has **Update and restart**: it fast-forwards (never merges, and refuses if you changed files in the
app folder), restarts, and shows **What's new**. The same from a terminal, in the app's folder:

```
npm run update       (or: git pull --ff-only, then open Circle Studio again: it restarts on the new code by itself)
npm run doctor       shows whether an update is waiting
```

Runtime release ZIPs support staged updates with separate data and deferred activation while work is running. Legacy
source ZIPs without a release manifest still need manual replacement with their data preserved. The per-user package
registers repair/uninstall; removal retains data by default and requires a separate choice to remove it.

Chat tiles can pin an exact saved conversation independently. Review handoff prepares an editable summary and a new
draft without starting a model. Tasks retain typed review/test/file evidence; workflow versions can be pinned. Storage
shows retention rules and previews generated-file cleanup; saved chats and pending approvals are excluded.

For Circle-started Codex chats, Settings → Desktop offers completion notifications and a **Test Codex notification
without a model call** button. Short runs notify too. A browser without notification permission permits Windows fallback;
Windows may still suppress visual delivery. Separately running Codex terminals/apps are outside this notification path.

### Publishing a new version (for the maintainer)

People update from the `main` branch. From the app's folder:

```
npm test                       everything passes (3 tests skip when an optional reference folder is missing)
git status                     check that only the files you mean to publish are listed (data/ is never included)
git add -A
git commit -m "What changed, in a few words"
git push origin main
```

Everyone who cloned sees **Update ready** within a day. Change `RELEASE` and `CHANGES` in
`frontend/js/components/whatsnew.js` when there is something new to tell, and the `version` in `package.json`.

## What is in it

| Area | What it does |
|---|---|
| Home | What needs you, what runs, and every project: workflow, git, your last conversation, 30 days of Claude use |
| Mods | Your Claude Code mods (they change Claude Code itself: the chat's look, the prompt and context, how commands are checked) and plugins (skills, agents, commands, tools), sorted into For every project, Only this project and Off, with filters by what they change. Turn one on or off for one project (a reviewed diff of `.claude/settings.json`) or for every project (`claude plugin enable` or `disable --scope user`). Details shows what it brings and its context cost. Also a tab in each project |
| Workflow | A graph: numbered stages on one line, agents on branch lines under their stage, the flow wrapping cleanly into the next row; hover or select a card and what it is linked to lights up; Tidy glides into place; a map in the corner for big teams. Helpers beside agents (a Haiku reader, when the agent decides or automatically above a context limit), and Patterns: ways to shape the team with their trade-offs, which fit your agents, Try on with Undo. The project's graph (the helper reads the folder, your building blocks and indexed pages before it proposes anything): Workflow (edit; drag from a card's dot to link, click a link to remove), Live, Versions. Checkpoints on the arrows. Workflow helper. Click "You" for the main session |
| Chat | A real agent session in the project folder. Circle shows requests raised by the selected engine; approval coverage depends on its policy and version. **Earlier conversations** lists saved Circle chats and supported provider history for reading or continuing. Codex CLI 0.163.0 has scoped live acceptance evidence in `docs/research/codex-2026-10-22.md`. |
| Cost | Claude use for 30 days (by model, day and agent, at API prices), what loads before you type, each agent's model and price, and ways to spend less (apply a cheaper model, or let AI rearrange the workflow), all through a reviewed diff |
| Health | What needs you now, in plain words; details underneath |
| Let's begin | First run (and any time from the AI tools line in the menu): which AI tools you use, which are ready, the install and sign-in steps with a button that runs them |
| Connections (in a project) | The tools (MCP servers) its agents can use: its own, every project's, and what your Claude Code plugins bring. Whether each works and has its key; Key gives it a saved key, Add a tool adds one (warning first when the project already has it), Remove, Test, and Claude's fix when it is broken |
| Widgets | Its own page in the menu. Notifications (what Circle Studio told you, kept and marked read), Running now (what works in every project), and a Chat widget (a project's main chat and its agents' chats; switch between them, see which engine answers, pick it, and reply right in the tile; on the desktop a click opens a small chat window). Every tile comes small, medium or large. Switch any project tile's project from its title; Lock in place keeps tiles where they are. Real widgets on your desktop: rounded tiles for agent rings (working, waiting, done, idle), spending by provider, a workflow, what waits for you. Drag them anywhere, click to open, right-click for options. Choose them on the widget board |
| Chat, like Claude Code | The Chat runs Claude Code as in your terminal (all its tools; every command and change asked first), shows a conversation running in your terminal live, takes messages while it works, and answers `/usage`, `/model`, `/status`, `/clear`, `/resume`. A Limits widget shows your 5-hour and weekly use, from Circle Studio's chats and, if you turn it on, your terminal |
| One question, one card | When an agent asks, one card appears on the desktop (no second notification from the app window). Under Allow: "Allow for this run", "Always allow edits here" or "Always allow reading outside", only where they fit; the "always" ones are shown and turned off in the project's Permissions. Commands are always asked |
| See what goes on | A message sent from anywhere (the app, the overlay, a desktop card) shows in the project's Chat as it happens, with Waiting for you when it needs you. Type Circle Studio's commands in the Chat with a slash: `/waiting`, `/allow 1`, `/deny 1`, `/answer 1 ...`, `/stop`, `/new`, `/chats`, `/continue 2`, `/help`. Open in editor opens the project in Antigravity IDE (or VS Code) at the file the agent worked on, with a page that keeps itself up to date: working or waiting, what waits and the command that answers it, the whole chat. An answer that came while no window was open waits as a card on the desktop, to read and reply |
| On the desktop | When an agent wants to run something or has a question, a card pops up at the bottom right of your screen with Allow and Deny (or the answers to pick): answer it without opening the app (Settings, Desktop, "Ask me on the desktop"). Ctrl+Alt+C anywhere opens the overlay, like the Xbox Game Bar: the screen dims and panels show what waits, what runs, the workflow drawn small, the chat, this PC, spending, git and notifications (drag any panel anywhere; Widgets hides or shows them and adds more, such as Activity rings, Agents or Mods; Reset layout puts them back), a bar at the top switches projects (each says whether it needs you, works or is quiet; type to find one, Ctrl+Tab for the next), and a box takes commands (`help`, `waiting`, `allow 1`, `ask ...`, `new`, `chats`, `continue 2`, `folder`, `run <agent> ...`, `open inbox`, `project <name>`, `pc`...). Esc or the same keys put it back. The Activity tile is a ring per project that turns while it works and pulses while it waits for you; Running now says what runs where and since when, including Claude Code in a terminal |
| Make a mod | Mods, Make your own: add a ready-made mod to a project after reviewing the diff (waiting-game, a tiny game while Claude works; turn-check, a line after each turn on context, time, changed files and whether tests ran), or describe one and Claude builds it in the project's chat. Check loads any mod the way Claude Code will and runs its tests |
| Keys | Paste an API key once (encrypted for your Windows account, never shown again). "Everything on this PC": every connection of every engine, the manager that fixes what is broken, duplicated, stale, already brought by a plugin or keeping a plain-text key (previewed, backed up, undone on failure, tested after), and the security check |
| Inbox | Every approval and question, and team questions from `docs/tasks/ALERTS.md` |
| Ask Circle | Ctrl+J: next steps, built-in help (no AI needed), or ask any engine you are signed in to |
| Library | Skills (how-to cards agents read) for every engine. In the Workflow helper, Find skills searches GitHub for what your agents lack and explains each one; paste a GitHub link to see what is in it. And the Catalog: every building block you have, described in one line, searchable the way the workflow helper searches it; index a link to make its text searchable |
| Advisor | A second opinion on one document (plan, brief, spec): what to keep, what to build, what is wrong; pin items to a stage |
| Settings | Engines, desktop alerts, start at sign-in, the widget board, updates (and "Restart by itself when nothing is running": after an update, Circle Studio restarts into it and open windows reload; or a banner offers Restart now or Later) |

Git is read, never written in your projects: the branch chip shows what is not pushed or pulled, and GitHub Actions and
pull requests appear once you turn GitHub on for a project (the `gh` CLI covers private repositories).

## Privacy and safety

What leaves this PC: what you send in a chat, the Advisor, the workflow helper or Ask Circle (through the engine you
picked, with its own sign-in), GitHub reads you start, a page you choose to index, and a connection test to a remote
MCP server when you press Check. Connector keys stay in the local vault, encrypted for your Windows account. Every write the app makes into a project is shown as a diff
first. Bash is not sandboxed on Windows: the app's policy (`backend/lib/policy.mjs`) refuses dangerous commands and
asks about everything else. Secrets are masked in every screen, log and message.

## Engines, honestly

Verified on this PC: **Claude** (shell with approvals, questions, resume, `tests/live/claude-live.mjs`) and **Copilot**
(approvals). **Codex** is built from its documented protocol and is not live-tested. **Gemini (`agy`)** cannot ask you
from a headless run, so it answers and reads only.

## For developers

`docs/spec.md` is how it is built, `docs/decisions.md` every departure from the plan, `docs/research/` the recorded
facts, `contracts/api.json` the API routes (checked both ways by `tests/contract`). Design values come only from
`frontend/css/tokens.css` (`npm run contrast` checks both themes). Tests never touch a real project, the real `data`
folder, your real `~/.claude`, Desktop or Start menu.
