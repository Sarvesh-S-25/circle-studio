# Claude CLI: live probes (claude 2.1.284, Windows 11, 2026-09-29)

**Provenance.** These are results from real runs made by the research agents on this machine, with
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` deleted from the child environment, on the logged-in
session, using the cheapest model where a model was needed. The raw outputs are saved in
`tests/fixtures/claude/` (`chat-read.jsonl`, `chat-resume.jsonl`, `advisor.json`,
`readonly-*.jsonl`, `write-*.jsonl`, `settings-*.jsonl`, `auth-status.txt`,
`spawn-kill-probe.mjs`). The research run was cut short by the usage limit and the human asked to
stop it, so nothing here was independently re-verified afterwards. Numbers marked *(read from a
fixture)* were re-read from the saved files while writing this page; everything else is the agents'
reported result. E-mail, org id and org name are redacted in the saved files.

## 1. Facts the build relies on

| # | Fact | Evidence |
|---|---|---|
| 1 | `claude auth status` prints JSON and exits 0 when logged in, in about 0.4 s, with no model call. Fields: `loggedIn`, `authMethod` (`claude.ai`), `apiProvider` (`firstParty`), `subscriptionType`, plus e-mail/org fields the app must never show or store. `--json` gives the same output. Logged out: exit 1 with JSON on stdout (`loggedIn:false`). | `auth-status.txt` |
| 2 | The prompt goes on **stdin** and works. Empty stdin is an error: `Error: Input must be provided ...`, exit 1. | probe `f-empty-stdin` |
| 3 | `--output-format stream-json` **requires `--verbose`** (else exit 1). `--include-partial-messages` requires stream-json (else exit 1). | probes `f-no-verbose`, `f-partial-without-stream` |
| 4 | `--permission-mode` accepts exactly `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`. | probe `f-bad-permmode` |
| 5 | `--json-schema` must be valid JSON (exit 1 otherwise). With `--output-format json` the validated object is in the result's **`structured_output`** field, and `result` holds the same JSON as a string. An unsatisfiable schema ends with `subtype: "error_max_structured_output_retries"`, `is_error: true`, `errors: [...]`, exit 1. | `advisor.json`, probe `advisor-a3-unsat` |
| 6 | `--resume <session_id>` continues a conversation: the second turn saw the first turn's content *(read from `chat-resume.jsonl`)*. A bogus session id emits a `result` event with `subtype: "error_during_execution"`, `is_error: true`, then exit 1. | `chat-resume.jsonl`, probe `f-bogus-resume` |
| 7 | **`--permission-mode plan` is not read-only.** In plan mode the model wrote its plan to `~/.claude/plans/<name>.md` with the Write tool. The strongest read-only setup is `--permission-mode dontAsk` plus `--tools Read,Grep,Glob` (the tool set itself is restricted, so no write tool exists). With that, "create a file" produced an explanation and no write. | `readonly-denied.jsonl` vs `readonly-notool.jsonl` |
| 8 | Write mode: `--permission-mode acceptEdits` with `--tools Read,Grep,Glob,Edit,Write`. `Bash` is not available (the model reported "no Bash tool"). With the default tool set and `--allowedTools Read,Grep,Glob,Edit,Write` only, a Bash call was denied: `This command requires approval`, listed in `permission_denials`. | `write-after-resume.jsonl`, `write-bash-denied.jsonl` |
| 9 | **Project hooks run under `-p`** by default (SessionStart hooks fired: `hook_started` events, and the team's `activity.py` appended to `.claude/state/activity.jsonl`, i.e. a "read-only" chat would write into the project). `--settings '{"disableAllHooks":true}'` stops them. | `settings-default.jsonl`, `settings-nohooks.jsonl` |
| 10 | `--setting-sources user` also disables project hooks, **but it also stops the project's `CLAUDE.md` from being loaded** (the model answered `NONE` when asked to quote it). `--settings {"disableAllHooks":true}` keeps `CLAUDE.md` (it quoted `# Project directives`). | `settings-user.jsonl`, `settings-nohooks.jsonl` |
| 11 | **A project's `.claude/settings.json` can redirect credentials.** The docs agent confirmed that a project-level `apiKeyHelper` hijacks the login under `-p`, and that `--setting-sources user` neutralises it. Project `env` (`ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`) is the same class of risk *[same mechanism, not separately tested]*. | docs agent, experiment with a mock API |
| 12 | **Do not use `--bare`.** In bare mode Anthropic auth is *only* `ANTHROPIC_API_KEY` or `apiKeyHelper`; OAuth and the keychain are never read, so it would break the "logged-in CLI, no API key" requirement. | `claude --help` text, docs [fetched by the research agent] |
| 13 | Untrusted workspace warning on stderr: `Ignoring N permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog...`. Hooks and everything else still ran. Passing `--tools` / `--allowedTools` on the command line avoids depending on project permission entries. | stderr of most probes |
| 14 | `system/init` reports `apiKeySource: "none"` when no API key is in use *(read from `chat-read.jsonl`)*: the app can show and assert this. | `chat-read.jsonl` |
| 15 | Startup and first token: default flags in a team project: `init` at about 4.3 s (2 hooks, 56-64 tools, 6 MCP servers, 80 slash commands). Lean flags (`--tools`, `--strict-mcp-config`, `--disable-slash-commands`, hooks off): `init` at 1.1-1.5 s, first text delta at about 3-6 s wall for a small question. Time-to-first-token reported by the CLI (`ttft_ms`): 0.8-2.1 s. | metas of `ro-rec`, `ss-nohooks`, `init-*` |
| 16 | Failure exit codes: bad flag values and bad schema exit 1 with a message on stderr; a missing binary or bad cwd makes Node's `spawn` fail with `ENOENT` (errno -4058 on Windows) before any output; logged-out runs exit 1. | probes `f-*` |
| 17 | Advisor cost and time: 5 KB of input took 18 s; 150 KB took 27 s (23 s API time), about 4 keep / 3 build / 4 issues, cost about 0.06-0.11 USD on the default model. `num_turns` is 2 because the structured-output call counts as a turn. | `advisor-a1`, `advisor-a2-big` |
| 18 | On POSIX, SIGTERM makes `claude -p` exit 143 and record no result for the running turn; SIGINT ends the turn. On Windows use the tree kill recipe in §5. | docs [fetched by the research agent] |
| 19 | **The requested tier is not necessarily the serving model.** In `chat-read.jsonl` (run with `--model haiku`) `system/init.model` is `claude-haiku-4-5-20251001`, but `message_start.message.model` and the result's `modelUsage` key are `claude-sonnet-5-5` (cost 0.126 USD for a tiny question) *(read from the fixture)*. The app must show the model named in `result.modelUsage` after the run, never the flag it passed, and must not promise a cheaper tier to the human. | `chat-read.jsonl` |

## 2. Event vocabulary actually seen (stream-json)

One JSON object per stdout line. `session_id` is on every event. Distinct shapes in `chat-read.jsonl`:

| `type` / `subtype` | Purpose | Fields the app uses |
|---|---|---|
| `system` / `hook_started`, `hook_response` | project hooks (absent when hooks are disabled) | ignore |
| `system` / `init` | first useful event | `session_id`, `model`, `permissionMode`, `tools[]`, `apiKeySource`, `cwd`, `claude_code_version` |
| `system` / `status` | `status: "requesting"` | ignore |
| `system` / `thinking_tokens` | thinking progress | ignore (or show a "thinking" hint) |
| `stream_event` / `message_start` | new assistant message | `ttft_ms` (top level of the event), `event.message.model` |
| `stream_event` / `content_block_start` | `content_block.type`: `text`, `thinking` or `tool_use` (`id`, `name`) | start a tool row for `tool_use` |
| `stream_event` / `content_block_delta` | `delta.type`: `text_delta` (**`delta.text`**), `input_json_delta` (`partial_json`), `thinking_delta`, `signature_delta` | forward `text_delta` as an SSE `text` event; accumulate `input_json_delta` per block index to build a tool summary |
| `stream_event` / `content_block_stop`, `message_delta`, `message_stop` | block and message boundaries; `message_delta.delta.stop_reason` | `tool_use` vs `end_turn` |
| `assistant` | complete message snapshot with `content[]` blocks (`text`, `thinking`, `tool_use` with full `input`) | tool `input` for the summary |
| `user` | tool results: `message.content[].type == "tool_result"` with `is_error` | mark a tool row ended (`ok = !is_error`) |
| `rate_limit_event` | `rate_limit_info.status`, `resetsAt` | may be shown in the footer; ignore otherwise |
| `result` / `success` (or `error_*`) | last event | `result` (final text), `is_error`, `session_id`, `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`, `stop_reason`, `usage`, `permission_denials[]` |

Unknown `type`/`subtype` values must be ignored, never fatal.

### Parser algorithm (for `backend/lib/claude.mjs`)

1. Read stdout as UTF-8 with a `StringDecoder`, split on `\n`, keep the trailing partial line, `JSON.parse` each complete line inside try/catch (skip non-JSON lines, note them at debug level).
2. `system/init` → emit `session {sessionId, runId, model}`; persist `session_id` for `--resume`.
3. `stream_event` with `event.type == "content_block_start"` and `content_block.type == "tool_use"` → remember `index → {id, name, json: ""}`; emit `tool {id, name, status:"start"}`.
4. `content_block_delta` `input_json_delta` → append `partial_json` to that index's buffer. `text_delta` → emit `text {delta}`.
5. `content_block_stop` for a tool block → parse the buffer, build a one-line summary (`Read docs/brief.md`, `Grep "freeze" in .claude/`), emit `tool {id, name, summary, status:"start"}` again with the summary if not sent yet.
6. `user` events with a `tool_result` → emit `tool {id, status:"end", ok}`.
7. `result` → emit `done {runId, sessionId, ms: duration_ms, costUsd: total_cost_usd, stopReason}` if `!is_error`; otherwise `error {code:"upstream", message}` using `result` / `errors[]`.
8. Process exit without a `result` event → `error {code:"upstream", message:"claude exited (code N) before finishing", detail: last 2 KB of stderr}`. If stderr contains `hasn't been trusted` treat it as a notice, not an error.
9. Client disconnect or `chat.stop` → `killTree(child)` (§5); emit nothing more.

## 3. Recommended argument lists

All three set the environment without `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`, use `cwd` = the project folder, and send the prompt on stdin. `M` is `--model <haiku|sonnet|opus>` when the user chose one, omitted for the CLI default.

**A. Read-only chat** (default; matches the `ro-rec` probe, which succeeded, 0 hooks, 3 tools, 0 MCP, 0 slash commands):

```
-p --output-format stream-json --include-partial-messages --verbose
--permission-mode dontAsk --permission-prompts none
--allowedTools Read,Grep,Glob --tools Read,Grep,Glob
--disallowedTools "Read(.env)" "Read(.env.*)" "Read(**/*.pem)" "Read(**/*.key)" "Read(**/id_rsa*)" "Read(**/.npmrc)" "Read(**/credentials*)"
--settings {"disableAllHooks":true} --strict-mcp-config --disable-slash-commands
[--resume <sessionId>] [M] --append-system-prompt "<explainer prompt>"
```

**B. Chat that may edit** (only after the human confirmed this message; matches `write-rec`):

```
same as A, except:
--permission-mode acceptEdits --allowedTools Read,Grep,Glob,Edit,Write --tools Read,Grep,Glob,Edit,Write
```

Never `Bash`. Never `--dangerously-skip-permissions`.

**C. Advisor** (one JSON result; matches `advisor-a3-unsat` for the flags and `advisor-a1/a2` for the schema):

```
-p --output-format json --json-schema '<schema JSON>'
--permission-mode dontAsk --permission-prompts none --tools ""
--settings {"disableAllHooks":true} --strict-mcp-config --disable-slash-commands
--no-session-persistence [M]
```

**Child environment.** Start from `process.env` and delete `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and the variables that mark the parent as a Claude Code session, which matters when the server is started from inside a Claude Code session (for example while testing): `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_EXECPATH` (the list the probe script `spawn-kill-probe.mjs` uses, line 105).

**Credential guard (required before A, B and C).** Before spawning, read the project's
`.claude/settings.json` and `.claude/settings.local.json`. If either contains `apiKeyHelper`, or an
`env` key that starts with `ANTHROPIC_`, or `CLAUDE_CODE_USE_`, or ends with `_BASE_URL`, or
`CLAUDE_CODE_OAUTH_TOKEN`, add `--setting-sources user` to the run. The trade-off (finding 10) is
that the project's `CLAUDE.md` is then not loaded; the app tells the human in one sentence
("This project's settings could redirect Claude's credentials, so they were ignored for this run").
Health lists the same finding as a warning.

The explainer system prompt (appended) says: you are Circle Studio's explainer for project
`<name>`; explain what the team is doing from the real files (`CLAUDE.md`, `docs/tasks/BOARD.md`,
`.claude/state/*.json`, `docs/adr/*`); you are in READ-ONLY mode (or WRITE mode is on for this
message) and must not claim to have changed anything you did not; never print secrets.

## 4. Failure table

| Situation | What the CLI does | What the app shows |
|---|---|---|
| binary not found / cwd missing | `spawn` throws `ENOENT` (errno -4058) | `not_ready` 503: "Claude CLI not found. Install it or set CIRCLE_CLAUDE_BIN." |
| logged out | exit 1, `result` with `is_error` or `auth status` `loggedIn:false` | `not_ready` 503: "Run `claude auth login` in a terminal." |
| bad session id on `--resume` | `result` `error_during_execution`, exit 1 | drop the stored session id and retry once without `--resume`, telling the human context was lost |
| empty prompt | exit 1, `Input must be provided` | `bad_request` |
| schema unsatisfiable / invalid output | `error_max_structured_output_retries`, exit 1 | `upstream` 502 with the reason |
| workspace not trusted | stderr notice only | informational banner, run continues |
| timeout | none (the app enforces 180 s advisor / no chat timeout but an idle heartbeat) | kill the tree, `upstream` 502 "timed out" |
| SIGTERM (POSIX) | exit 143, no result | treated as stopped |

## 5. Kill recipe (Windows)

`child.kill()` terminates only the root process. `taskkill /PID <pid> /T /F` (spawned without a
shell) walks the parent-pid links and terminates the whole tree; exit 0 = done, 128 = already gone.
Never kill by image name (other `claude.exe` / `node.exe` belong to other sessions). The working
implementation, with a `tasklist`-based verifier, is `tests/fixtures/claude/spawn-kill-probe.mjs`
(`killTree`, `listProcesses`, `descendantsOf`); copy `killTree` into `backend/lib/run.mjs`. Call it
while the child is still alive.

## 6. What was not established

* Whether a project-level `env` block with `ANTHROPIC_BASE_URL` redirects traffic under `-p`
  (assumed to behave like `apiKeyHelper`; the credential guard treats both as risky).
* Whether `--settings '{"apiKeyHelper":""}'` can override a project's helper without dropping the
  project source (not tried; the guard uses `--setting-sources user` instead).
* Why `--model haiku` was served by `claude-sonnet-5-5` in the recorded run (fact 19): not
  investigated. The UI displays what `result.modelUsage` reports.
