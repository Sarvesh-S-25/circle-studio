# Circle Studio

A local control room for AI agent teams on Windows. You lay out a team as a workflow (stages, agents, checkpoints,
the engine and model each one uses), talk to any agent in its project folder, and answer everything an agent wants to
run, change or ask, from a popup, the Inbox, a desktop notification or a small widget window. It drives
**Claude Code, Codex, Gemini (the `agy` CLI) and GitHub Copilot** through your own terminal sign-ins.

Single user, this PC, `127.0.0.1` only. No account, no telemetry, **no API key**. Node.js built-ins only, no build step.

## Install

You need **Windows 10 or 11**, **Node.js 24 or newer** ([nodejs.org](https://nodejs.org), the LTS button) and at least
one engine signed in from a terminal, for example Claude Code: `npm install -g @anthropic-ai/claude-code`, then
`claude auth login`. Git is recommended (for project status and updates).

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

A ZIP copy cannot update itself: download the new ZIP, unpack it over a new folder, copy your old `data` folder into
it, and run the installer again.

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
| Workflow | The project's graph (the helper reads the folder, your building blocks and indexed pages before it proposes anything): Workflow (edit; drag from a card's dot to link, click a link to remove), Live, Versions. Checkpoints on the arrows. Workflow helper. Click "You" for the main session |
| Chat | A real agent session in the project folder. Every command, edit and question asks you first. **Earlier conversations** lists your Claude Code conversations from the terminal in that folder: read them or continue them here |
| Cost | Claude use for 30 days (by model, day and agent, at API prices), what loads before you type, each agent's model and price, and ways to spend less (apply a cheaper model, or let AI rearrange the workflow), all through a reviewed diff |
| Health | What needs you now, in plain words; details underneath |
| Widgets | Its own page in the menu, below Connections. Real widgets on your desktop: rounded tiles for agent rings (working, waiting, done, idle), spending by provider, a workflow, what waits for you. Drag them anywhere, click to open, right-click for options. Choose them on the widget board |
| Connections | Every MCP server each engine uses. The Manager groups them across projects and fixes what is broken, duplicated, stale or keeping a plain-text key in one click (previewed, backed up, undone on failure, tested after). Paste a key and it is saved in your Windows environment; Test explains any failure; Claude can propose a config fix and advice for the code. A security check and an encrypted key vault |
| Inbox | Every approval and question, and team questions from `docs/tasks/ALERTS.md` |
| Ask Circle | Ctrl+J: next steps, built-in help (no AI needed), or ask any engine you are signed in to |
| Library | Skills for every engine, and the Catalog: every building block you have, described in one line, searchable the way the workflow helper searches it; index a link to make its text searchable |
| Advisor | A second opinion on one document (plan, brief, spec): what to keep, what to build, what is wrong; pin items to a stage |
| Settings | Engines, desktop alerts, start at sign-in, the widget board, updates |

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
