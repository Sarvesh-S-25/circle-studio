# Circle Studio v2: the build spec

Source of truth for this iteration (decided by the human on 2026-09-30). Engine facts with evidence are in
`docs/research/engines.md`. The routes are in `contracts/api.json` (46: add a route only with a decisions.md line; report a
missing route instead). The frontend client is `frontend/js/api.js` (already written for every route).

## What changed and why

The human found the first build too tied to one folder and one engine. Decisions:

1. **Engine-neutral.** Claude, Codex, Gemini (the `agy` CLI) and Copilot are engines. Claude is fully wired;
   the others are wired as far as `docs/research/engines.md` proves and are labelled honestly when not live-tested.
2. **No `claude-teams` anywhere.** No default template folder, no reserved `template` project id, no call to a
   `new-project.mjs`. New projects come from **templates the human owns** (`data/templates`). One template is seeded
   once from `backend/seed/staged-build-team.json`; after that nothing reads any outside folder.
3. **Graph, not list.** A project's plan is a graph of nodes and edges (`circle-workflow/1`). Three modes on one
   canvas: **Workflow** (edit), **Live** (who is running, tokens, context, pending approvals), **Versions**
   (semantic-version history of the workflow: compare, restore). Click a node: inspector (settings) and a chat with
   that node. Buttons like the human's reference screenshots: **Tidy** (auto layout) and **Legend**.
4. **Chat is a real agent session in the project folder, with a shell.** Every shell command, every edit and every
   question the agent raises **asks the human first** as a popup, and is saved in the **Inbox** (find, verify,
   remember). Limited to that project's folder.
5. **Skills are partitioned per engine** (`shared`, `claude`, `copilot`, `gemini`) and installed into each engine's
   own folder.
6. **The human does git.** The app never runs git. No API key is ever read, stored or passed.

Hard rules from the old build that stay: single user, Windows, binds `127.0.0.1`, no sign-in, no telemetry; diff
first for every write the **app** makes into a project (`changes.preview` then `changes.apply`, or the new-project
preview); secrets never appear in any response, log, diff or popup (`secrets.redact`); design values only from
`frontend/css/tokens.css`; light and dark; keyboard reachable; no inline script or style (CSP); Node 24 built-ins
only; never spawn through a shell; `cleanEnv()` for every child. Rule 5 of the old build ("chat never gets Bash") is
**replaced** by decision 4.

## Data shapes

### Workflow (`circle-workflow/1`), stored inside a template or a project
```
{ schema:'circle-workflow/1', name, description, version:'1.0.0',
  lanes:{frontend,backend,contract,migrations:bool}, flags:{localOnly,humanDoesGit:bool}, links:[https url],
  nodes:[{ id, kind:'human'|'stage'|'agent', title, parent?:stageId (agents), engine?:'claude'|'codex'|'gemini'|'copilot',
           model?:string, consult?:[engine], gate?:{on:bool, by:'you'|'engine'|'both', engine?, label}, needs?:[nodeId], optional?:bool, defaultOn?:bool,
           skills:[libraryName], links:[https url], notes, does?, prompt?, skipWhen?, position?:{x,y} }],
  edges:[{ id?, from, to, label? }] }
```
Limits: at most 80 nodes and 200 edges; node ids match `NAME_RE`; unknown fields dropped; every string capped;
links must be `https://`. `edges` between stages are the flow; `human`->stage starts it; an edge between agents is a
delegation. Agents sit under their `parent` stage; layout puts a stage's agents in its column. `position` is
optional (Tidy computes it). The seed is `backend/seed/staged-build-team.json`.

### Template and history (also used per project in `data/workflows/<projectId>.json`)
```
{ id, name, description, createdAt, updatedAt, builtin:bool, templateId?:string (projects), head:'1.2.0',
  versions:[{ version, at, note, parent:null|version, restoredFrom?:version, summary:{added,removed,changed}, workflow }] }
```
Semantic version on every save: **patch** = only property edits (engine, model, skills, links, notes, gate label,
positions); **minor** = nodes or edges added; **major** = nodes or edges removed, `needs` changed, or stage order
changed. The request may force `bump`. First version `1.0.0`. Restore appends a new version (`restoredFrom` set).
Identical content is not saved again (returns the head unchanged). Keep at most 200 versions.

### Engine (GET /api/engines)
`{ engines:[{ id, label, binary, installed, version, loggedIn:true|false|null, loginHint, usable,
  capabilities:{ chat, shell:'approvals'|'none', approvals:'relay'|'none'|'unverified', questions:'relay'|'none'|'unverified',
  resume, skillsDirs:[..], instructionsFile, liveVerified }, models:[..], notes:[..] }] }`. `gemini` means the `agy`
CLI. Detection makes no model call and is cached 30 s (`engines.check` bypasses the cache). Never return an e-mail,
organisation or token.

### Request (Inbox record) and events
`{ id (matches ID_RE, e.g. r_ab12cd34), projectId, nodeId|null, runId, engine, kind:'approval'|'question', risk:'normal'|'outside-project'|'dangerous',
  tool, title, detail (redacted: the exact command, the file path, a diff preview), input (redacted), questions?:[{question,header,options:[{label,description}],multiSelect}],
  status:'pending'|'allowed'|'denied'|'answered'|'expired'|'auto-denied', answer?, note?, at, resolvedAt|null }`.
Persisted (`data/inbox/<projectId>.json`, newest first, capped at 1000). On startup every `pending` becomes `expired`.
`POST /api/requests/:id/respond` body `{ decision:'allow'|'deny'|'answer', answers?:{[questionText]:label|[labels]|text}, note?, remember?:'run' }`.
`remember:'run'` allows the same tool and command prefix for the rest of that run, never for `dangerous`.

`chat.send` SSE events: `session {sessionId, model, engine}`, `text {delta}`, `tool {id,name,summary,status,ok}`,
`request {..record..}`, `request-resolved {..record..}`, `usage {inputTokens,outputTokens,contextTokens,contextWindow,costUsd}`,
`notice {message}`, `done {..}`, `error {code,message}`, `stopped {}`.
`events.stream` (global SSE): `request`, `request-resolved`, `run {projectId,nodeId,runId,engine,model,status:'active'|'waiting'|'idle'|'done'|'error'}`, `usage {projectId,nodeId,runId,...}`.
`projects.live` -> `{ runs:[{runId,nodeId,engine,model,status,startedAt,tokens:{input,output},contextPct,costUsd,lastEventAt}], pending:n, lastHandoff:null|{from,to,at,ms} }`.

`chat.send` body: `{ projectId, nodeId?, engine?, model?, message, newSession? }`. Session and transcript key = project +
node + engine; a node chat's system prompt is that node's role (`does`/`prompt`) plus the project brief; the project
chat is the explainer. `run` permission is required for shell, `write` for edits, `claude` (shown as "send text to an
engine") for any chat; a missing permission answers 403 with `detail.permission` as today.

## Engine adapters (`backend/lib/engines/`)

One adapter per engine, same shape: `detect()` and `runTurn({ cwd, prompt, model, systemPrompt, sessionId, signal, emit, onRequest })`
where `onRequest(req)` returns a promise of the human's decision (the broker turns it into an Inbox record and a
popup). A turn is one process; resume uses the engine's own session id.

* **claude** (verified live): `claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --permission-mode manual --permission-prompt-tool stdio --tools Read,Grep,Glob,Edit,Write,Bash,AskUserQuestion
  --disallowedTools <NO_SECRET_READS> --settings {"disableAllHooks":true} --strict-mcp-config [--resume id] [--model m]`,
  cwd = project folder. One user JSON line on stdin; answer every `control_request` (`can_use_tool`) with a
  `control_response` carrying the same `request_id`; `AskUserQuestion` is answered with
  `updatedInput:{questions, answers:{[question]:label}}`. Never `--permission-prompts none` in this mode. Keep the
  credential guard (`--setting-sources user` when the project could redirect credentials).
* **copilot**: ACP over stdio (`node .../@github/copilot/npm-loader.js --acp`), JSON-RPC 2.0 lines:
  `initialize`, `session/new {cwd}`, `session/prompt`, permission via `session/request_permission` (options
  `allow_once`/`reject_once`). Approvals proven live; questions unknown; label `questions:'unverified'`.
* **codex**: `codex app-server` over stdio (`initialize`, `thread/start`, `turn/start`; server requests
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/tool/requestUserInput`).
  Schema-verified offline; **not logged in on this PC, so not live-tested**: build it against a fake app-server and
  say so in `capabilities.liveVerified:false`. Sandbox `workspace-write`; never `danger-full-access`.
* **gemini (agy)**: `agy -p ... --output-format stream-json`; headless auto-denies commands and cannot relay
  approvals: chat only (`shell:'none'`, `approvals:'none'`). Read `result.denied_actions` and tell the human plainly.

Windows: never a shell; `killTree` on stop; strip API-key variables (`cleanEnv`).

## Approval policy (`backend/lib/policy.mjs`, security critical)

Bash is **not sandboxed** on Windows, so the host is the only guard. Every request gets a `risk`:
* **auto-allow (no popup):** Read/Grep/Glob inside the project folder on a non-sensitive path.
* **ask (popup):** every Bash command, every Edit/Write (show the path and a diff or content preview), every question,
  anything else. The popup shows the exact command.
* **outside-project (popup with a strong warning):** any path resolving outside the project folder (absolute, `..`,
  `~`, env vars like `%USERPROFILE%`), `cd` out, or a Claude `blocked_path`.
* **dangerous (auto-denied, recorded as `auto-denied`, no popup):** recursive delete of a drive/home/project root,
  `format`, `diskpart`, registry edits, `curl|iex`-style download-and-run, `powershell -enc`, `git push --force`,
  reading or writing sensitive files (`.env*`, keys, `.ssh`, credentials), network exfiltration of a file, disabling
  the app's own guards. Also anything that touches the app's own `data/` folder.
The policy is deny-by-default for anything it cannot parse. It is unit-tested with a table of allowed, ask and denied
cases including evasion attempts (quoting, `^` escapes, `node -e`, `python -c`, chained `&&`, encoded commands).

## Skills partitions

Library skills get `partition:'shared'|'claude'|'copilot'|'gemini'` (default `shared`) and `engines:[..]` (default all).
Install folders: claude `.claude/skills/<name>/`, codex and copilot `.agents/skills/<name>/` (shared; Copilot also reads
`.github/skills` and `.claude/skills`), gemini `.gemini/skills/<name>/` (**unverified**, show that). The `skill-install`
change op takes `engines:[..]` (default `['claude']` to keep today's behaviour), dedupes folders, and goes through the diff review.

## New project (no outside folder)

`projects.create` `{ name, idea?, templateId, workflow?, folder?, permissions?, confirm }`. `confirm:false` returns the
file list with previews and writes nothing; `confirm:true` writes (target must not exist or be empty) then registers
the project. Rendered files: `workflow.json`, `docs/brief.md`, `AGENTS.md` (engine-neutral: the stages, gates, agents,
which engine each uses, how to read `workflow.json`), `CLAUDE.md` (one line importing `AGENTS.md`, only if any node uses
claude), `.claude/agents/<id>.md` for claude agent nodes (name, description, model, the role text), and the skills the
nodes list, installed per partition. No git, no scripts copied. The project's workflow starts as the template's head.

A project added without a template never gets one it did not choose (`lib/discover.mjs`): its workflow is the folder's
own `workflow.json`, else one stage holding the agents in `.claude/agents` (real models), else blank (only you). A record an
older build filled with an automatic template copy says so (`autoTemplate` in `workflow.get`) and offers the folder's version.

## Graph interface (`frontend/js/components/graph/`)

* Canvas in SVG plus positioned HTML cards, no library. Pan (drag empty space), zoom (wheel, buttons, Fit), **Tidy**
  (layered auto layout: longest-path layers left to right, stage agents stacked in the stage's column, order by
  barycenter), **Legend**. Pure layout code lives in `layout.js` (no DOM) so `tests/unit` can import it.
* Node card: kind icon, title, engine chip and model chip, status dot and word (**Active** working now, **Ready/Idle**,
  **Waiting** needs your approval, **Off** no session or engine unusable), an `asks codex` chip for engine access, skills chips, and in Live
  mode tokens (`6.8M tok`) and a context bar (`Context 91%`). Edges are curved lines with arrowheads, dashed for
  delegation, an optional label pill; in Live mode a `seen Nx` count.
* Workflow mode edits: add/remove/duplicate node, connect (drag from a handle, or keyboard: select node, `C`, pick
  target), move, reorder stages, set engine/model/skills/gate/links/notes in the inspector. Keyboard: Tab to nodes,
  arrows move focus to neighbours, Enter opens, Delete removes, Alt+arrows nudge, `T` tidy. Every action reachable
  without a mouse.
* Live mode: subscribes to the app event stream; a node with a pending request pulses and opens its popup on click.
  A footer line shows the last hand-off.
* Versions mode: a chain of version nodes (`1.0.0` -> `1.1.0`), branches when a restore happened, each with note, date
  and `+added -removed ~changed`; click one to compare with the head (a readable list of what differs) and **Restore**.
  Saving asks for an optional note and shows the suggested bump.
* Inspector (side panel): Settings tab and Chat tab (a node chat using the shell lane's chat component). Reduced
  motion respected; all colours from tokens.

## Ownership (each file has exactly one lane; api.js and contracts/api.json are frozen)

* **Engine lane:** `backend/lib/engines/**`, `sessions.mjs`, `inbox.mjs`, `policy.mjs`, `claude.mjs`, `routes.engines.mjs`,
  `services.engines.mjs`, the shutdown lines of `server.mjs`, `tests/helpers/fake-*.mjs`, `tests/fixtures/engines/**`,
  tests for all of these.
* **Workflow lane:** `backend/lib/workflow.mjs`, `semver.mjs`, `templates.mjs`, `render.mjs`, `plan.mjs`, `scaffold.mjs`
  (delete), `config.mjs`, `projects.mjs`, `ops.mjs`, `skills.mjs`, `health.mjs`, `team.mjs`, `routes.workflow.mjs`,
  `services.workflow.mjs`, `routes.mjs`, `backend/seed/**`, the `template` exception in `server.mjs` `validateParams`,
  tests for all of these.
* **Graph lane:** `frontend/js/components/graph/**`, `frontend/js/views/workflow.js`, `views/plan.js` (delete at the end,
  after moving the brief form into `workflow.js`), `frontend/css/graph.css`, a marked block in `tokens.css`, tests.
* **Shell lane:** the rest of `frontend/js` (requests popup, Inbox, chat, node-chat component, settings with engine cards,
  new-project flow with template chooser and graph step, rail badge, library partitions, home, palette, state, dnd),
  `frontend/css/requests.css`, `components.css`, `views.css`, `frontend/index.html`, tests.
* The graph and shell lanes meet at `mountGraph(el, opts)` (see the stub in `components/graph/index.js`) and at
  `mountChat(el, { project, nodeId, engine? })` exported from `frontend/js/views/chat.js`.

## Acceptance (every lane)

`npm test` green; new tests for new code; no dead code or stale docs left behind; no file outside this folder written
(temp dirs excepted); start a private server for checks with `CIRCLE_PORT=43xx CIRCLE_DATA=<temp dir>` and never touch
the running instance on 4380 or the real `data/`; never touch `claude-teams`, `circle-studio`, `A2G`, `sample-test`.
Report what was verified by running it and what was not.

## Checkpoints, engine access, the workflow helper, Health

* **Checkpoint** (a stage's `gate`): what happens when the stage is done. `on:false` go on; `by:'you'` the human
  approves; `by:'engine'` another engine reviews in a read-only session, then the work goes on; `by:'both'` an engine
  reviews, then the human approves. Drawn as a marker on the arrow that leaves the stage (brass = you, dashed petrol =
  an engine). AGENTS.md and each agent file get one plain instruction per stage (`render.checkpointText`). An old gate
  `{on,label}` reads as `by:'you'`. The app does not enforce a checkpoint; the team is told to follow it.
* **Engine access** (`consult`): per agent, on/off per engine, for a second opinion only; rendered as "May ask Codex for
  a second opinion (read-only)". Empty means the agent works on its own.
* **Workflow helper** (`workflow.suggest`, `lib/helper.mjs`): Circle Studio's own agent in the graph's side panel. One
  Claude call with no tools and a JSON schema; it sees the graph as it is on screen (without positions, notes, prompts),
  the brief, the usable engines and the library's skill names. A proposal is merged (unseen fields kept, unknown skills
  dropped, agents left without a stage parked in "Not placed yet") and shown as a change list; **Apply** puts it on the
  graph unsaved. Needs the "send text to an engine" permission. Nothing is written.
* **Health** groups every check as `now` (work stopped or a decision waits), `look` (worth fixing, suggestions) or
  `fine`, with a one-line `summary`; titles and details are plain words and the jargon moves to `tech` (Details).

## Desktop, history, cost, guide, installer (v5)

* **Claude Code history** (`lib/cchistory.mjs`; `projects.history.list`, `projects.history.get` at `/history/:sid`,
  `projects.chat.link`): conversations are `~/.claude/projects/<root with every non-alphanumeric as "-">/<uuid>.jsonl`;
  a conversation's `cwd` must match the project (the key can collide). Listing reads the first and last 256 KB of each
  file; reading streams it, keeps typed user text (slash commands as `/name args`), merges one answer's lines, sums tools
  into one-line summaries, skips sidechains, synthetic replies and tool results, and marks compactions. Agent runs come
  from `<uuid>/subagents/agent-*.jsonl` + `.meta.json`. A linked chat (`{sessionId, fork:true, linked}`) resumes with
  `--fork-session` once; the record's `fork` clears when the CLI returns a new id.
* **Desktop** (`lib/desktop.mjs`, `services.desktop.mjs`, `routes.desktop.mjs`): `settings.json` in data
  (`desktopAlerts`, `github` per project, `updates`); shortcuts through PowerShell `WScript.Shell` (data in env vars);
  Edge `--app` windows; toasts with PowerShell's app id. `app.viewers.count` = open `/api/events` streams; server toasts
  only at 0. `projects.pulse` serves the widget in one call.
* **Git** (`lib/gitstatus.mjs`, `projects.git`, `projects.git.github`): `status --porcelain=v1 -b`, `log -1`, `remote -v`
  (the upstream's remote first, else any GitHub remote); GitHub via `gh run/pr list --json` or REST, cached one minute.
* **Updater** (`lib/updater.mjs`, `app.update.get`, `app.update.apply`): async git (`execFile`), `ls-remote` to check,
  `merge-base --is-ancestor` to ignore an older remote, `pull --ff-only` only when clean and not ahead.
* **Cost** (`lib/pricing.mjs`, `lib/cost.mjs`, `projects.cost`): always-loaded context = CLAUDE.md (+ CLAUDE.local.md,
  .claude/CLAUDE.md, @imports to depth 4), `~/.claude/CLAUDE.md`, agent and skill descriptions (project and user);
  on-use = agent and skill bodies; tokens ~ chars/4. Usage = transcripts modified in the window, each `message.id` once,
  1-hour cache writes from `cache_creation.ephemeral_1h_input_tokens`. Issues carry `fix: {agent, model}` when a model
  change would help.
* **Guide** (`lib/guide.mjs`, `guide.ask`): 13 help topics with keyword search; `askEngine` runs any adapter's
  `runTurn` in `data/guide`, denying every request, with a 2-minute limit.
* **Installer** (`scripts/circle.mjs`, `Install Circle Studio.cmd`): `CIRCLE_SHORTCUT_DIR` and `CIRCLE_SKIP_CHECKS` are
  for tests only. `launch.vbs` passes its arguments to `launch.mjs` (`--widget <id>`, `--background`, `--stop`).

## Status (what was checked by running it)

* **Claude:** live, real CLI, haiku: approved and denied commands, a question, a refused `.env` read, resume
  (`node tests/live/claude-live.mjs`); and through the real UI in a browser (popup, Inbox, Live status, versions).
* **Copilot:** approvals over ACP against the real CLI (probe) and against a fake in `tests/integration/engines.test.mjs`;
  questions unproven.
* **Codex:** against a fake app-server only. **agy:** real one-word turn (probe) and a fake. Neither is proven through the UI.
* **Graph:** edit, Tidy, Legend, node inspector with chat, Live, Versions, light and dark, narrow window, keyboard
  navigation code paths: looked at in a browser; the layout maths is unit-tested. Not exercised by an automated browser
  test.
* Edge labels show the workflow's own labels; hand-off counts ("seen 3x") are not tracked.
* **Checkpoints, engine access, helper, Health (v4):** unit and integration tests; the helper once live with haiku on a
  19-agent copy (106 s, a 4-stage proposal); looked at in a browser, light and dark, 1280 and 700 px. Whether a team
  actually honours an engine checkpoint is not verified: that depends on the agents following AGENTS.md.
* **v5:** history, desktop routes, alerts rule, installer (redirected shortcut folder), updater (throwaway repos), cost
  and guide have unit and integration tests. Live: the history reader and cost on the human's real folders, read only
  (spark2, clydee: 0.1 to 0.9 s); a real Windows toast; shortcuts written to a temp path and read back; GitHub's public
  API for spark2; Ask Circle with real Claude (haiku, 11 s). Looked at in a browser: chat history, "You" main session,
  widget, git panel, Settings, Cost, Ask Circle, Home, dark at 1280-1333 and light at 700. Not run: the update click
  on a real clone (only on temp repos), a real start-at-login reboot, Ask Circle through Codex, Copilot or Gemini.

## Widget board, connections, vault, catalog, Haiku reader (v6)

* **Widgets** (`frontend/js/components/tiles.js`, `board.js`, `css/tiles.css`): `widget.html` = the board, `?p=<id>` =
  a project widget, `?w=<kind>&size=s|m|l[&p=]` = one tile. Tiles read `/stats`, `/pulse` (now with `agents[]` and a
  `state` per stage), `/usage` and the request stream. `settings.widgets` = `[{kind, size, projectId}]`, at most 16.
* **Agent state** (`lib/agentstate.mjs`): waiting (a pending request or a Circle run waiting) > working (a Circle run,
  or a transcript or activity entry in the last 3 minutes) > done (in the last day) > idle.
* **Usage** (`lib/usage.mjs`, `usage.providers`): Claude per answer from every transcript folder, priced; Codex the last
  `token_count` total of each session file in the window; Gemini and Copilot the assistant turns in Circle's chats.
* **Connections** (`lib/connections.mjs`, `connections.list`, `connections.check`, `security.scan`): server ids are
  `<engine>:<scope>:<name>`; `listServers` returns names, transport, command or URL host, env and header names, the names
  holding a literal secret, and whether an Anthropic key is present. `config.userHome` / `CIRCLE_USER_HOME` and
  `config.codexHome` / `CIRCLE_CODEX_HOME` point elsewhere in tests.
* **Vault** (`lib/vault.mjs`, `vault.*`, `/api/vault/:key`): `data/vault.json` holds DPAPI blobs; `envFor(projectId)`
  decrypts the allowed keys in one PowerShell call per engine run. Tests use `FAKE_CODEC`.
* **Catalog** (`lib/catalog.mjs`, `routes.catalog.mjs`): entries `{id, type, name, where, model, url, summary, tags,
  summaryBy: file|haiku, indexed}`, rebuilt from sources when older than ten minutes (Haiku summaries survive while the
  source text is unchanged); `search` = BM25 with duplicates merged; `passages` = BM25 over indexed chunks.
* **Helper input**: graph, brief, `projectDigest(root)`, 12 catalog hits for message + brief + digest, 3 passages from
  the indexed links of this workflow (else any). The answer carries `read: {digest, blocks, passages}`.
* **Reader**: agent `reader: true`; `renderProject` adds `.claude/agents/reader.md` and `readerText` to the agent.
* **Status (v6):** unit and integration tests for all of the above (fake homes, fake DPAPI codec, fetch stub). Live,
  read-only on the human's files: connections (found plain-text keys in `~/.claude.json`), the security check,
  provider usage (Claude across every folder, Codex tokens), agent states (this build session showed as working), the
  digest; real DPAPI round trip; a real Haiku catalog description (22 items, $0.03). Looked at in a browser: the board
  light and dark, gallery, a single tile, Connections with "Move to the vault" up to the redacted diff on a temp
  project, the resized helper panel, the catalog search. Not run: the helper with real Claude after this change, a
  remote connector Check, the vault key used by a real MCP server.

## Native desktop widgets and connection repair (v7)

* **Host**: `scripts/widgets/desktop-widgets.ps1 -Port -DataDir` (STA, WPF), started by `lib/deskhost.mjs` through
  `start-widgets.vbs`; `desktop.widgets` {action: start|stop|status}; `settings.desktopWidgets` makes it come back with
  the server. Each tile: a 168 px cell grid (small 1x1, medium 2x1, large 2x2), packed from the top right when it has no
  saved place; owner = Progman (`SetWindowLongPtr(GWL_HWNDPARENT)`), `WS_EX_TOOLWINDOW`; "Keep on top" clears the owner.
* **Feed** (`widgets.feed`, `lib/feed.mjs`): `{palette, tiles: [{key, kind, size, title, empty?, rings?, big?, bigState?,
  rows?, bars?, steps?, stats?, lines?, items?, sub?, note?, url}]}`; `key` = kind:size:project:n for saved places.
* **Probe** (`lib/mcpprobe.mjs`): `expand` (${VAR}, ${VAR:-default}), `resolveLaunch`, `probeStdio` (45 s), `probeHttp`
  (15 s), `diagnose`, `workingTwins`, `recreateCommands`. `connections.test` keeps the last result per server for
  `connections.fix` (Claude, Sonnet by default, `FIX_SCHEMA`).
* **Status (v7)**: tests with a fake MCP server (crash, missing key, fixed config, key from the vault reaching it), the
  feed, the twin commands and the host command. Live: the host drew six tiles on this desktop from the test server
  (captured; owned by the desktop, tool windows); Settings started and stopped it; the real broken `stitch` entry
  (command `\`) was diagnosed with the spark2 setup as its twin; one real Haiku fix call ($0.03). Not checked: Win+D
  with the widgets (it would minimise the human's windows), a drag (positions are saved on mouse up), a real MCP
  server's start (the human's servers were not started).
* **Manager (v8)**: `connections.manage` (`analyze`), `connections.plan` ({action: repair|share|remove|secure|key}) and
  `connections.apply` (`runPlan`: backup, `claude mcp` via `app.claude.bin`, user env via PowerShell
  `SetEnvironmentVariable(.., 'User')` with the value in an environment variable, vault; restore on failure; then
  `testServer` on what changed). Plans live ten minutes and run once; their key values never leave the server.
  Tested with a simulated `claude mcp` on a fake home (repair, a failed step restored, a pasted key) and live as a preview
  on the human's real config (nothing applied).

## One window per thing, and the Widgets page (v9)

* **Window keys**: every window opens `/api/events?window=<key>`: `app`, `board`, `widget:<project>`,
  `tile:<kind>:<size>[:<project>]`. `app.showWindow(key, url, {size, hash, settle})` (services.desktop) sends the newest
  window of that key a `show` event `{hash, mark}`; the window navigates, adds `mark` (13 zero-width characters) to its
  title for 8 s, and `focusWindowMarked` (lib/desktop.mjs, PowerShell + user32: EnumWindows, restore if minimised,
  AttachThreadInput, SetForegroundWindow) raises exactly that window. Not found within 5 s (a background tab): a new
  window. No window: one is opened, and another request within 15 s answers `starting` instead of opening a second.
* **Everything opens through `desktop.open`**: the launcher (`--overview`, `--widget`, plain), the desktop widgets
  (asynchronous WebClient POST, opening Edge directly only when the server does not answer) and the in-app buttons.
  After the launcher restarts an older server, it passes `settle`: the server waits up to 6 s from its start for the open
  windows to reconnect before deciding a new one is needed.
* **Widgets page** `#/widgets` (menu, below Connections): on/off for the desktop, "Own window", and the board embedded
  (`mountBoard(.., {embedded: true})`, which returns `destroy()`). Project tiles with no project at all say so instead
  of "Loading...".
* **Status (v9) (see v10 below for the menu: Connections became Keys)**: `tests/integration/windows.test.mjs`; live on a private port: launched twice (the minimised window
  came back to the front, no second window), the board twice (one window), a forced restart (the open window was
  reused); the page looked at in light and dark at 1280 and 700 px.

## Keys, per-project tools, Find skills, Let's begin (v10)

* **Routes**: `#/keys` (menu; `#/connections` opens it with "Everything on this PC" open), `#/projects/<id>/connections`
  (tab; `#/connections/<id>` lands there), `#/start` (Let's begin; shown on first run when there is no project).
* **Connections** (`lib/connections.mjs`): `claudePlugins(home)` reads enabled plugins (installPath must be under
  `~/.claude/plugins`; `.mcp.json` flat or `mcpServers`, else `plugin.json` mcpServers; `skills/*/SKILL.md`); scope
  `plugin: <name>`; Gemini extensions as `extension: <name>`. `isBundled(s)` servers are never changed.
* **Manager** (`lib/mcpmanage.mjs`): findings `covered` and `redundant` (both remove the extra copies); action `add`
  `{name, setup:{command,args}|{url}, scope: local|project, key?:{name, value?, slot, field}, force?}`; refused with
  `detail.duplicates` when `alreadyAvailable` finds the same name or command; `key` accepts `fromVault`. Step kind
  `env-from-vault` (vault value to the Windows user environment). Ops `mcp-server-add`, `mcp-server-remove`.
* **Find skills**: `POST /api/projects/:id/skills/discover {workflow?, message?, links?}` (`lib/skillfind.mjs`):
  `{needs, suggestions:[{id,key,dir,ref,repo:{url,fullName,stars,official},description,plain,why,agents}], searched,
  skipped, alreadyHave, fromPlugins, note, models, costUsd, rate}`. Imports nothing: the helper card calls
  `skills.fetch` per collection and adds the skills to the agents on the graph.
* **Let's begin**: `engines.list`/`engines.check` carry `setup {label, maker, account, does, install, login, link}`
  (`lib/engines/setup.mjs`); `POST /api/engines/terminal {engine, step: install|login}` opens a visible PowerShell with
  that fixed command through `scripts/open-terminal.vbs` (base64 `-EncodedCommand` only).
* **Status (v10)**: `tests/integration/tools.test.mjs` (plugins, duplicates, add with a saved key and a real start,
  .mcp.json ops, skills on a stubbed GitHub, Let's begin). Live: plugin `playwright` seen on this PC and an add of the
  same command refused; two real Find skills runs (Haiku, $0.05 and $0.03); a visible terminal opened and closed with
  a harmless command; pages looked at in light and dark at 1440 and 700 px.
