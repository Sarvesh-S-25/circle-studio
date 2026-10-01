# How the team's files actually behave (what Circle Studio must write)

**Provenance.** The research agent read the reference folders `C:/Users/sarve/Desktop/claude-teams`,
`.../circle-studio` (the scaffold) and `.../A2G/a2g` read-only and ran **scratch copies** of
`apply-models.mjs`, `consult.mjs` (against fake engine binaries), `guard.py`, `new-project.mjs` and
`verify-session.py`. Numbers and outputs below are from those runs. The research was stopped before
its verification phase, so none of it was independently re-run afterwards; items marked
**[unverified]** were not tested. Nothing in the reference folders was modified.

## 1. `models.json` and `scripts/apply-models.mjs`

* `models.json`: top-level `_comment`, `_allowed`, `_allowed_comment`, `_how_to_choose`, then
  `roles.<role> = { model, note }`. **Not** `JSON.stringify(x, null, 2)`: it has an inline
  `_allowed: ["opus", "sonnet", "haiku"]`, blank lines between groups and 87 lines; re-serialising
  changes about 81 lines. So edits are **text patches**. LF endings, ends with a newline, ASCII only.
  Measured edit primitives: setting a tier changes exactly one line (e.g. researcher, line 74);
  editing a `note` changes one line (the string must be JSON-escaped: quotes, backslash, backtick,
  non-ASCII all round-trip); adding a role changes four lines (a comma is added to the previous
  entry). Files that are CRLF keep their CRLF when only that line is replaced.
* `apply-models.mjs` (run with `cwd` = project root; it resolves paths from its own location):
  exit **0** applied or nothing to do (also `--check` with no drift), exit **1** `--check` found drift,
  exit **2** validation error, in which case *nothing is written*. Output shapes:
  `Applying models.json to .claude/agents/*.md`, `  change  researcher  opus -> haiku  (.claude/agents/researcher.md:4)`,
  `  DRIFT   researcher  opus -> haiku  (...)`, `  19 roles: opus 4, sonnet 12, haiku 3`,
  `N agent file(s) updated. Agent definitions load once, at session start - restart Claude Code ...`.
  It changes only the `model:` line, preserving CRLF/LF per file; a mixed-EOL file where only the
  model line is CRLF is handled (byte diff: exactly that line).
* Validation errors (all exit 2, nothing written): a tier not in `opus/sonnet/haiku` (case matters;
  `sonnet[1m]` is refused); a role with no `model`; a role with no agent file; an agent file with no
  `models.json` entry (including a stray `researcher.backup.md` in `.claude/agents/`; a
  `researcher.md.bak` is ignored); front matter missing, unterminated, or preceded by a **BOM**;
  zero or two `model:` lines in the front matter; `_allowed` present but different or reordered;
  invalid JSON; a `_comment` key inside `roles`. Unknown top-level keys are fine; `_allowed` absent
  is fine; a role given as a bare string (`"qa": "haiku"`) is accepted.
* Adding a role needs **three** things or `verify-session.py` fails: the agent file, a `models.json`
  entry, and a `## <role>` heading in `REFERENCE-LINKS.md` (§9). The app's own backups must live
  outside `.claude/agents/`.
* Current tiers in the reference project: 19 roles, opus 4 (splitter, executor, auditor,
  security), sonnet 12, haiku 3 (researcher, designer, design-tooling).

## 2. `.claude/consult.config.json` and `consult.mjs`

* This file **is** exactly `JSON.stringify(x, null, 2) + "\n"` (LF, verified by round trip), so a
  parse-modify-stringify write is byte-clean here. The app still uses the same text-patch code path
  for consistency, and checks the round trip before falling back.
* Shape: `default`, `failover[]`, `cooldownMinutes`, `engines.{gemini,codex,copilot}.{model,effort}`,
  `roles.<role>` = a string engine name **or** `{ engine, failover[], web, model }`.
* Behaviour measured with fake engines:
  * A role name that is **not** in the config gets the default chain (`gemini -> copilot -> codex ->
    self`) with **no warning**, and `consult.mjs --role some-skill-name q` works. A role that has its
    own `roles["<name>"]` entry gets that chain, so a **skill can have its own engine order** by
    being named as a role, *if the skill's instructions call `consult.mjs --role <skill-name>`*.
    (Whether the tracker/dashboard tolerates activity rows with an `agent` tag that is not one of
    the 19 agents was looked at but the result was not captured **[unverified]**.)
  * `default: "self"` + unknown role: immediate exit 3, no engine run; a *known* role keeps its own
    engine.
  * A role-level `model` string is also sent to the fallback engines (a Gemini model name reaches
    Copilot): the app should not write a role `model` unless asked.
  * `"claude"` as a role engine: exit 2 `unknown engine "claude"`; `"claude"` inside `failover` is
    skipped silently; `"auto"` is valid; an object with an empty `engine` falls back to the default.
  * **A `null`, `""` or `0` role entry crashes `consult.mjs --list`** with `TypeError: Cannot read
    properties of null (reading 'engine')` (exit 1). The app must only ever write strings or objects,
    and Health flags such entries.
  * Unknown top-level keys and unknown role keys are ignored.
  * Exit codes: 0 answered, 1 transient, 2 setup, 3 routed to `self`, 4 bad `--url`.
* `--list` on this machine (real): gemini OK (`agy.exe`), codex installed but **unavailable (auth)**,
  copilot OK; default gemini, failover `gemini -> copilot -> codex -> self`; quota cooldown 60 min,
  rate-limit 10 min. Per-role routing today: **copilot** first for auditor, be-builder, connector,
  executor, fe-builder, migrator, qa, security, splitter, versioner; **gemini** first (with web
  search on for deployer, designer, researcher, stack-advisor) for business-auditor, design-tooling,
  planner, scaler, texter. The app reads engine health from `.claude/state/engines.json`
  (`{ <engine>: { state, reason, since, until, lastOk } }`).

## 3. `.claude/state/roster.json` and "human does git"

* `{ "_comment": "...", "optional": { researcher, business-auditor, scaler, deployer, security,
  connector, qa, migrator } }`. In the reference working tree this file is **CRLF with no trailing
  newline** and equals `JSON.stringify(x, null, 2)` with CRLF; git stores it LF (this machine has
  `core.autocrlf=true`), so a working file can be CRLF while its blob is LF. **EOL must be detected
  per file at edit time, never assumed.**
* Readers: the dashboard (`scripts/tracker.mjs`) and the `/roster` command. `guard.py` does not read it.
* **Nothing in the team's files reads a `human_does_git` key** (or otherwise skips `versioner`).
  For the option to have effect the *team's own* files would have to change: `/team-up`
  (`.claude/commands/team-up.md`, which spawns `versioner`), `versioner.md`, and the git-write rule
  in `CLAUDE.md` / `guard.py`. The app must not write those (`.claude/**`, `CLAUDE.md` are the lead's
  control plane). What the app *can* write: the roster key, `push.md`, and the `.gitignore` block
  (§10), and it says plainly that the team must be told to skip `versioner`.

## 4. Agent front matter

* All 19 agents have the same four-key layout on lines 2-5 with LF endings, closing fence on line 6:
  `name`, `description`, `model` (**always line 4**), `tools`. Description length 70-239 characters;
  `deployer.md` and `stack-advisor.md` contain quotes, `splitter.md` contains non-ASCII.
* Lanes (`guard.py` `LANE_OF`): fe-builder -> `frontend`; be-builder and migrator -> `backend`;
  connector -> **`"both"`** (a quirk: freezing `frontend` or `backend` does **not** block connector;
  freezing `"both"` or `"all"` does).

## 5. `scripts/new-project.mjs`

* Run as `node <template>/scripts/new-project.mjs <target>` (from anywhere). Success: exit 0,
  stdout begins `Scaffolding a new project at: <target>` and ends with numbered next steps; it copies
  65 files (agents, commands, hooks, skills, the consult bridge, the dashboard, `CLAUDE.md`,
  `SETUP.md`, `HOW-TO-RUN.md`, `REFERENCE-LINKS.md`, `models.json`, `.mcp.json`,
  `contracts/schema.json`, doc templates, scripts) and runs `git init` (branch `master`, **no
  commits**). Not copied: `new-project.mjs`, `LICENSE`, `.claude/settings.local.json`,
  `.claude/state/engines.json`, `README.md`, `docs/brief.md`, `contracts/split.json`.
* Refusals, all **exit 2** with a message on stderr: missing target; target is the template or inside
  it; target is an ancestor of the template; target exists and is non-empty (`already exists and is
  not empty (N entries found)`); target is an existing file. An existing *empty* directory is
  allowed.
* Consequence for the app: creation must go through this script (never re-implemented), with the
  name validated first and the exact command shown for confirmation; relay stderr on exit 2.
  (Earlier in this session `../circle-studio` was found already scaffolded and non-empty, which is
  exactly this refusal.)

## 6. Freeze (`.claude/state/freeze.json`)

Shape `{"frozen": [...], "request_id": null|"CH-nnn", "paths": []}`. Measured with `guard.py` in a
scratch copy (Python 3.10):

| freeze.json | Blocked |
|---|---|
| missing, or `frozen: []` | nobody |
| `["frontend"]` | fe-builder |
| `["backend"]` | be-builder **and migrator** (not connector) |
| `["frontend","backend"]` (what `/change` writes) | fe-builder, be-builder, migrator |
| `["both"]` | connector only |
| `["all"]` | fe-builder, be-builder, migrator, connector (never qa, executor, texter, lead) |
| `["Backend"]`, `["split"]`, `paths` only, malformed JSON | **nobody** (case-sensitive; unknown names ignored; malformed fails **open**) |
| `frozen: "backend"` (a string) | be-builder, migrator (accepted) |
| `frozen: ["backend"], paths: ["backend/src/only-this.ts"]` | **the whole lane**: `paths` is ignored, both `only-this.ts` and `something-else.ts` are blocked |

Deny text: `Lane 'backend' is frozen for change CH-9. Stop, report what you are blocked on, and wait
to be woken.` This is what Health must say in plain words (whole lane, `paths` ignored, malformed
file means no freeze). `freeze-set` writes lane names from `frontend`, `backend`, `both`, `all` only.

## 7. ADR status lines

* Template line: `- **Status:** proposed | accepted | superseded by NNN` (that literal is the
  *template's* value, so `000-template.md` is not a proposed ADR).
* Real values seen (A2G): `accepted`, `accepted (supersedes ADR-004)`,
  `accepted (amended at G3; see "G3 decision" at the end)`, `superseded by ADR-007 (accepted
  2026-09-23)`. The status line is line 3 or 5 (after the title, an optional blockquote); **ADR 007
  is CRLF while the others are LF**, so EOL is per file. The word `status` also appears later in the
  body, so only the first status line **before the first `## ` heading** counts.
* Tracker regex: `/^-\s*\*\*Status:\*\*\s*(.+)$/mi`. App regex (validated on all A2G ADRs plus
  write tests): match `^(- \*\*Status:\*\*)([ \t]*)(.*?)(\r?)$` on the header block only; classify by
  the first word (`proposed`, `accepted`, `superseded`); an empty status matches an empty string
  (the tracker's regex would wrongly capture the next `- **Date:**` line, the app's must not).
  Writing `proposed`/`accepted` changed exactly one line and preserved CRLF in every test.
* Nothing in hooks enforces ADR status; the dashboard reads the gate from `*-stack.md`, and
  `/team-up` requires an accepted stack ADR. So the app's "proposed ADR" warning is a guard the team
  itself lacks (improvement.md §2.7).

## 8. `docs/tasks/BOARD.md`

* Table `| TX | Owner | Status | Source | Summary | Updated |` (six cells) under `# Board`.
  The dashboard parser **requires exactly six cells and silently drops any other row**: on the real
  A2G board 22 rows exist and 21 parse; TX-022 is dropped because an unescaped `|` made it seven
  cells. A newline inside a cell splits the row. Pipes in text must be written `\|`.
* A row written without spaces around the pipes still parses. A status value the team never used
  (`urgent`) is displayed as is, not dropped.
* **Recommended URGENT entry** (tested against the parser, top of the table, above existing rows):
  `| TX-<max+1> | <owner> | open | human (Circle Studio) | URGENT — <text>; supersedes TX-aaa, TX-bbb | <date> |`.
  A `U-001` style id also parses but `TX-nnn` matches the rest of the board. `team-up.md` already
  describes an URGENT board-row convention and builders read the top of the board first, which is
  exactly improvement.md Top 5 #2.

## 9. `verify-session.py` and `REFERENCE-LINKS.md`

* `verify-session.py` FAILs (exit 1) when: an agent has no `## <role>` heading in
  `REFERENCE-LINKS.md` (`REFERENCE-LINKS.md has a section per agent (missing: my-skill-agent)`);
  `models.json` and the agent files drift (`qa opus -> sonnet`); `models.json` names a role with no
  file. With those fixed it passes (14 PASS lines). It does **not** look at `.mcp.json`.
* So `agent-install` must also append a `## <role>` section (empty is fine: "If its section is
  empty, it does its research from scratch") to `REFERENCE-LINKS.md`, which the app may edit only
  for that one purpose, by appending, with the diff shown.

## 10. `push.md` and the local-only `.gitignore` block (from the human's own A2G project)

* `push.md` (A2G, LF, 2.6 KB) is a personal how-to, itself gitignored: title `# Pushing <name>`;
  a paragraph saying only code is pushed and which folders stay local; where to run the commands;
  **First push (once)** with `git branch -M main`, a check that prints nothing
  (`git status --porcelain -uall | grep -E "\.mcp\.json|\.claude/|CLAUDE\.md|docs/|contracts/|\.env"`),
  `git add .`, `git status`, `git commit -m`, `git remote add origin`, `git push -u origin main`, and
  the `gh repo create` alternative; **Every push after that**; **Before each push, check for
  secrets** (`git diff --cached | grep -iE "api[_-]?key|secret|token|password"`); plus dated notes.
  The app generates the same skeleton for the project's name and path; it never runs those commands.
* The `.gitignore` local-only block (A2G): a comment "Local-only: team tooling, planning artefacts
  and secrets ... only code goes to git" then `.mcp.json .claude/ CLAUDE.md SETUP.md START-HERE.md
  HOW-TO-RUN.md REFERENCE-LINKS.md trail.md models.json push.md scripts/ docs/ research/ business/
  contracts/`.
* **Two bugs in that block, both reproduced:**
  1. Unanchored `scripts/`, `docs/`, `contracts/` also ignore `backend/scripts/`, `backend/docs/`,
     `frontend/docs/`, `tests/contracts/`, `packages/app/CLAUDE.md` (real project code; A2G's own
     `backend/scripts/m2-measure.mjs` is affected). Anchoring with a leading `/` fixes it (tested).
  2. Ignoring `contracts/` makes `guard.py`'s task-complete gate **blind**: with a plain `.gitignore`
     a change to `contracts/api.json` without a CHANGELOG entry is blocked (exit 2); with the block
     it is allowed (exit 0).
  So the app's block uses anchored entries and **does not ignore `contracts/`** by default (the
  human can tick it, with the warning shown).

## 11. `.mcp.json`

Format `{ "mcpServers": { <name>: { type, url | command,args,env | headers } } }`, custom
formatting (inline arrays and objects; not `JSON.stringify`), LF. The safe placeholder is
`${VAR:-}` (empty default); the hazard is `${VAR:-<non-empty>}` or a literal key. `verify-session.py`
does not check it. The A2G copy holds a real key (redacted by the agent; the human should rotate it,
improvement.md §2.8).

## 12. Phases, gates and who runs them (SETUP.md §4) as plan-builder metadata

| id | Runs | Stops for the human at | Roster keys | Needs before it |
|---|---|---|---|---|
| research | researcher (+ business-auditor, scaler) | choosing among the options found | researcher, business-auditor, scaler | none |
| plan | planner | the open questions | (core) | research (if on) |
| stack | `/stack`: stack-advisor, then security design review when on | **G3** accept or amend the stack ADR | security | plan |
| security | security (design review, inside `/stack` before G3) | findings shown at G3 | security | plan; before G3 |
| split | `/split`: detect-codebase, splitter | **G1** ratify (`"status": "ratified"`) | (core) | accepted stack ADR |
| design | designer, design-tooling | **G2** pick a direction (`design/decision.md` with `Status: ratified`); skipped with no frontend | (core) | split |
| build | `/team-up`: fe-builder, be-builder, executor, versioner | task-completion gates | migrator, connector, qa | ratified split; accepted stack ADR; G2 if frontend; design review file if security on |
| deploy | deployer | choosing the deployment target | deployer | build |

`/team-up` refuses to start unless `docs/plan.md`, a ratified `contracts/split.json`, (with a
frontend) a ratified `design/decision.md`, and an accepted stack ADR exist, and (with `security` on)
`security/findings/design-review.md`.

## 13. Line endings summary (reference working tree)

| File | EOL | Final newline |
|---|---|---|
| `models.json`, `.claude/consult.config.json`, agents, `.mcp.json`, `.gitignore`, `CLAUDE.md`, `SETUP.md` | LF | yes |
| `.claude/state/roster.json` | **CRLF** | no |
| `.claude/state/freeze.json` (launcher) | LF, one line `{"frozen": [], ...}` | yes |
| `docs/changes/TEMPLATE.md` | CRLF | yes |
| ADRs | mixed (007 is CRLF) | yes |
| `trail.md` | partly CRLF | yes |
