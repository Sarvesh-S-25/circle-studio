# Claude Code: documented behaviour the build depends on

**Provenance.** The docs pages below were fetched by the research agents on 2026-09-29 (the pages
redirect from `docs.claude.com` to `code.claude.com/docs/en/...`); two pages were saved in full to
the agents' scratch folder and re-read while writing this file: the skills page
(`https://code.claude.com/docs/en/skills.md`, title "Extend Claude with skills") and the Agent
Skills specification (`https://agentskills.io/specification`, source
`raw.githubusercontent.com/agentskills/agentskills/main/docs/specification.mdx`). The sub-agents
table below comes from the docs agent's fetch of `https://code.claude.com/docs/en/sub-agents` as it
appeared in its transcript; the page itself was not re-opened when writing this file
**[not re-opened]**. CLI flag facts come from `claude --help` and the live probes
(`docs/research/claude-live.md`). The research run was stopped before its verification phase, so
none of this was independently re-checked.

## 1. SKILL.md front matter (Claude Code)

Location: `.claude/skills/<name>/SKILL.md` in a project, `~/.claude/skills/<name>/SKILL.md` for the
user. The directory name is the default skill name.

| Field | Meaning (summary of the docs) |
|---|---|
| `name` | optional; command name; defaults to the directory name |
| `description` | recommended; what it does and when to use it; if omitted the first non-empty line of the body is used. `description` + `when_to_use` are truncated at 1,536 characters in the skill listing |
| `when_to_use` | extra trigger phrases, appended to the description |
| `argument-hint`, `arguments` | autocomplete hint; named positional arguments |
| `disable-model-invocation` | `true`: only the human can invoke it with `/name` |
| `user-invocable` | `false`: only Claude can invoke it |
| `allowed-tools` | tools pre-approved for the turn that invokes the skill (space/comma string or YAML list) |
| `disallowed-tools` | tools removed while the skill is active |
| **`model`** | **model to use while the skill is active, for the rest of that turn; same values as `/model`, or `inherit`** |
| **`effort`** | effort level while the skill is active: `low`, `medium`, `high`, `xhigh`, `max` |
| `context: fork`, `agent`, `background` | run in a forked subagent; which subagent type; background or wait |
| `hooks`, `paths`, `shell` | skill-scoped hooks; path globs that limit auto-activation; `bash` or `powershell` |
| `metadata`, `license`, `compatibility` | accepted, not acted on (Agent Skills spec fields) |

Agent Skills specification (the portable core): `name` 1-64 chars, lowercase letters, digits and
hyphens only, no leading, trailing or consecutive hyphens, **must match the parent directory name**;
`description` 1-1024 chars, non-empty; `compatibility` up to 500 chars; `metadata` a string-to-string
map; `allowed-tools` a space-separated string (experimental).

**Consequence for the app:** a skill *does* have a model setting, so the skill inspector can offer
the same opus/sonnet/haiku choice by writing `model:` in the project's copy of `SKILL.md` (plus
`inherit` as "no override"). It has no engine setting of its own; see `team-internals.md` §2 for how
an external-engine order is attached to a skill by name.

## 2. Subagent (`.claude/agents/<role>.md`) front matter

| Field | Notes |
|---|---|
| `name` (required), `description` (required) | unique id (no `:`); the filename need not match |
| `tools` | comma-separated string or YAML list; inherits all if omitted |
| `disallowedTools` | removed from the inherited or specified list |
| `model` | `sonnet`, `opus`, `haiku`, `fable`, a full model id, or `inherit` |
| `permissionMode` | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, `manual` |
| `maxTurns`, `effort`, `background`, `isolation` (`worktree`), `color`, `initialPrompt` | as named |
| `skills` | **skills preloaded into the subagent's context at startup (full content injected)** |
| `mcpServers`, `hooks`, `memory` | scoped MCP servers, hooks, persistent memory scope |

**Consequence:** "attach a skill to an agent" has a real file form, the agent's `skills:` line, but
the team's own 19 agents use only the four keys `name, description, model, tools`. The app writes
`skills:` only through the explicit `agent-field` op and shows the diff. The team's `apply-models.mjs`
accepts only `opus`, `sonnet`, `haiku` (`docs/research/team-internals.md` §1), so the model inspector
offers those three even though the CLI accepts more.

## 3. Headless (`-p`) flags used (checked against `claude --help` and the probes)

`-p/--print`, `--output-format text|json|stream-json`, `--include-partial-messages`,
`--verbose` (required with stream-json), `--resume <id>`, `--no-session-persistence`,
`--permission-mode <mode>` (choices in §2 of `claude-live.md`), `--permission-prompts none`,
`--allowedTools`, `--disallowedTools` (`Read(.env)` style patterns), `--tools <list>` (restricts the
tool set itself; `""` = none), `--append-system-prompt`, `--json-schema`, `--settings <file|json>`,
`--setting-sources user[,project[,local]]`, `--strict-mcp-config`, `--disable-slash-commands`,
`--model`, `--bare` (do not use, see below), `--dangerously-skip-permissions` (never).

## 4. Authentication

* `claude auth status` reports the login without a model call (`claude-live.md` fact 1).
* With `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or an `apiKeyHelper`
  present, a session may authenticate with those instead of the `/login` session (docs, skills page
  section on synced skills lists these cases). The app deletes the first two from the child
  environment and guards against `apiKeyHelper` in project settings (`claude-live.md` §3).
* `--bare` reads only `ANTHROPIC_API_KEY` or `apiKeyHelper` (never OAuth or keychain): **never use it**.

## 5. Stream and result events

See `claude-live.md` §2 for the events actually observed, with field paths.

## 6. Open items

* The SDK-message reference pages were fetched by the docs agent but their tables were not
  captured in this file; the live fixtures are the authority for event shapes.
* `claude-code-guide` documentation for settings precedence between `--settings` and project
  settings was not read; the credential guard avoids depending on it.
