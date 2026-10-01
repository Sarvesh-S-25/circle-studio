# Engine facts (probed 2026-09-30)

Real probes on this PC by four read-only agents; the lead spot-checked the Claude one. Every claim is either verified (a command was run and its output is in `evidence`) or listed under *Unverified*. Nothing here was copied from a model's memory.
Windows spawn rules: never through a shell; run `claude.exe` directly, run Copilot as `node <npm>/@github/copilot/npm-loader.js`, run the standalone Gemini CLI as `node gemini.js` (the `.cmd` shim breaks). No API keys anywhere.

## codex  (codex-cli 0.154.0)

- Logged in here: **no**. Check without a model call: codex login status  (prints 'Not logged in'; no model call)
- Login: codex login (not run; also --with-api-key). Not attempted per rules.
- Turn argv: `codex exec --json --cd <folder> --sandbox workspace-write --skip-git-repo-check -m <model> -`
- Prompt via: stdin ('-' or omit prompt), or positional PROMPT
- Working folder: the chosen working folder (also passed with -C/--cd)
- Stream: JSONL on stdout (--json)
- Sessions: {"resume": "codex exec resume <SESSION_ID> [PROMPT] (or --last); verified in help: 'codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]' with --last and --json. App-server: thread/resume {threadId,...}. Also codex exec fork.", "idWhere": "thread_id in the thread.started JSONL event (docs example); thread/start response in app-server"}
- Shell: {"available": true, "enable": "Built in. Sandbox selected with -s/--sandbox read-only|workspace-write|danger-full-access (help-verified; docs say read-only is the exec default). Use workspace-write; never danger-full-access. --add-dir adds extra writable dirs.", "confinement": "Sandbox policy applied to model-generated shell commands, rooted at --cd folder. There is also 'codex sandbox' subcommand.", "caveats": "Not run live (not logged in). On Windows the schema has windowsSandbox/setupCompleted and windows/worldWritableWarning notifications, so Windows sandbox setup may need a first-run step. exec has no approval-relay channel."}

### Host relay (approvals and questions)
- approvals: **relayable**, questions: **relayable**, verified live: **False**
- Mechanism: codex app-server over stdio (default --listen stdio://; also unix://, ws://). JSON-RPC-like: client sends initialize {clientInfo:{name,title,version}} then 'initialized' notification, then thread/start {cwd, model, approvalPolicy, sandbox}, turn/start {threadId, input:[{type:'text',text}]}. Server-initiated requests (schema-verified in ServerRequest.json): item/commandExecution/requestApproval, item/fileChange/requestApproval, item/permissions/requestApproval, item/tool/requestUserInput, mcpServer/elicitation/request, item/tool/call. Client replies with a JSON-RPC response with the same id: command/file decision enum accept | acceptForSession | decline | cancel (command also has acceptWithExecpolicyAmendment); user-input response has {answers}. Notifications: item/started, item/completed, item/agentMessage/delta, item/commandExecution/outputDelta, turn/started, turn/completed, thread/tokenUsage/updated, serverRequest/resolved. Interrupt via turn/interrupt.
- exampleRequest: `{"method":"item/commandExecution/requestApproval","id":<n>,"params":{"threadId":"..","turnId":"..","itemId":"..","command":"..","cwd":"..","reason":".."}}  (param names from generated JSON schema)`
- exampleResponse: `{"id":<n>,"result":{"decision":"accept"}}`

- Skills: {"supported": true, "format": "folder <name>/SKILL.md with YAML frontmatter name + description; optional scripts/, references/, agents/openai.yaml (docs)", "projectDir": ".agents/skills (cwd up to repo root)", "userDir": "$HOME/.agents/skills (also /etc/codex/skills admin; built-in system skills). App-server has skills/list and skills/extraRoots/set."}
- Instructions file: AGENTS.md (AGENTS.override.md takes precedence per directory; global ~/.codex/AGENTS.md; walked from git root to cwd; combined cap project_doc_max_bytes 32 KiB; project_doc_fallback_filenames configurable)
- Usage fields: {"tokens": "exec --json: turn.completed.usage {input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}. App-server thread/tokenUsage/updated {threadId, turnId, tokenUsage:{total, last}} each a breakdown {inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens, totalTokens} (schema-verified).", "contextWindow": "app-server tokenUsage.modelContextWindow (int64 or null) -> Context% = last.totalTokens / modelContextWindow (schema-verified field; formula is my suggestion). Not in exec --json per docs example.", "cost": "No cost field found in schema or docs; there are account/rateLimits/read, account/rateLimits/updated and account/usage/read requests instead. Compute cost yourself or omit."}
- Models: {"flag": "-m, --model <MODEL> (also -c model=\"...\" ; app-server thread/start model)", "available": ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-daybreak-blue-latest", "gpt-daybreak-red-latest", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.2", "codex-auto-review"], "cheapest": "gpt-5.4-mini (unverified guess from name; no pricing checked; access without login untested)"}

### Event shapes
- **thread.started**: `{"type":"thread.started","thread_id":"0199a213-..."}` (session id for resume (from docs example))
- **turn.started**: `{"type":"turn.started"}`
- **item.started/item.completed**: `{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"..."}}` (item types: agent_message, reasoning, command_execution, file_change, mcp_tool_call, web_search, plan update)
- **turn.completed**: `{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}`
- **turn.failed / error**: `(documented event names only)`

### Unverified
- No model turn was run; the exec JSONL event shapes and usage fields come only from https://learn.chatgpt.com/docs/non-interactive-mode (developers.openai.com/codex/noninteractive 308-redirected there; the redirect target is server-supplied and I did not independently confirm it is an official OpenAI host)
- App-server handshake, thread/start, turn/start examples from https://learn.chatgpt.com/docs/app-server (note: that page shows 'tool/requestUserInput' and array-style permissions, which differ from the local schema's 'item/tool/requestUserInput'; trust the local schema, and confirm via generate-json-schema at runtime)
- Skills paths from https://learn.chatgpt.com/docs/build-skills
- AGENTS.md rules from https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Exact JSON-RPC framing over stdio (newline-delimited JSON, whether the jsonrpc field is omitted) not tested
- Whether approvalPolicy values are camelCase enums such as unlessTrusted/onRequest/never: only the docs example was seen
- Whether exec --json can emit approval requests: assumed no; exec is non-interactive
- Windows sandbox behaviour with workspace-write and whether unlogged-in use of codex is possible
- Cheapest model and cost fields
- codex mcp --help and codex login --help beyond 'status' and '--with-api-key' were only partly read

### Risks
- Docs and local schema disagree on some method names; generate the schema with the installed version at build time and pin to it
- app-server is marked experimental and the protocol may change between versions
- Codex requires a login (ChatGPT or API key) to run turns; the human has none, so this engine cannot be used yet
- Docs domain redirected to learn.chatgpt.com; treat content as unverified documentation
- Never use danger-full-access or bypass flags; codex exec cannot relay approvals, so use app-server for the popup flow

### Evidence
- Codex not logged in | `codex login status` -> `Not logged in`
- exec flags: --json, -C/--cd, -s sandbox modes, -m, --skip-git-repo-check, --ephemeral, --output-schema | `codex exec --help` -> `-s, --sandbox <SANDBOX_MODE> [possible values: read-only, workspace-write, danger-full-access]; -C, --cd <DIR>; --json Print events to stdout as JSONL; -m, --model <MODEL>; --skip-git-repo-check`
- exec resume exists | `codex exec resume --help` -> `Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT] ... --last ... --json`
- app-server transports and schema generators | `codex app-server --help` -> `generate-ts, generate-json-schema; --listen <URL> stdio:// (default), unix://, ws://IP:PORT, off`
- Server->client request methods | `codex app-server generate-json-schema --out schema; grep methods in ServerRequest.json` -> `item/commandExecution/requestApproval item/fileChange/requestApproval item/permissions/requestApproval item/tool/requestUserInput mcpServer/elicitation/request item/tool/call`
- Client request methods | `grep methods in ClientRequest.json` -> `thread/start thread/resume thread/fork turn/start turn/interrupt turn/steer thread/compact/start skills/list model/list account/read account/rateLimits/read ...`
- Approval decision enums | `read CommandExecutionRequestApprovalResponse.json / FileChangeRequestApprovalResponse.json` -> `accept, acceptForSession, decline, cancel (file change); command adds acceptWithExecpolicyAmendment`
- Token usage shape | `read ThreadTokenUsageUpdatedNotification.json` -> `properties threadId, tokenUsage, turnId; ThreadTokenUsage {last,total,modelContextWindow}; breakdown {inputTokens,cachedInputTokens,cacheWriteInputTokens,outputTokens,reasoningOutputTokens,totalTokens}`
- User-input schema fields | `read ToolRequestUserInputParams.json / Response` -> `params: autoResolutionMs,isBlocking,itemId,questions,threadId,turnId; response: answers`
- Start/resume params | `read ThreadStartParams/TurnStartParams/ThreadResumeParams.json` -> `thread/start: approvalPolicy, cwd, model, sandbox, config, baseInstructions, developerInstructions, ephemeral; turn/start: threadId, input, cwd, model, effort, sandboxPolicy, approvalPolicy, outputSchema; thread/resume: threadId, cwd, model, sandbox ...`
- Model catalog listable offline | `codex debug models` -> `slugs: gpt-6-astra, gpt-5.6-sol, ..., gpt-5.4-mini, gpt-5.2, codex-auto-review`

## copilot  (1.0.88)

- Logged in here: **yes**. Check without a model call: No dedicated no-model status subcommand found (copilot login --help lists only login flow; env tokens COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN also honoured). Practical no-model-call check verified: spawn `copilot --acp`, send initialize then session/new; session/new returned a sessionId with no model call while logged in (initialize itself returns authMethods:[copilot-login] regardless). Behaviour when logged out NOT tested (not allowed to log out). Alternative: check credential presence out of band.
- Login: copilot login   (browser web flow on desktop; --device-code for headless; --with-token reads a token on stdin)
- Turn argv: `node %APPDATA%\npm\node_modules\@github\copilot\npm-loader.js -p <prompt> --output-format json --deny-tool shell --deny-tool write --log-level error --no-auto-update [--model <m>] [-C <dir>] [--add-dir <dir>]`
- Prompt via: argv -p <text>; help text says piped stdin also works with -p-less mode (unverified). Exit code 0 on success.
- Working folder: chosen working folder (or pass -C <dir>)
- Stream: JSONL, one event per line (--output-format json). Streaming deltas appear as assistant.message_delta; --stream on|off flag exists.
- Sessions: {"resume": "--resume[=<id|prefix|name>], --continue (most recent), --session-id=<uuid> (resume existing or set UUID for new), -n/--name to name a session; `copilot sessions` subcommand manages saved sessions. In ACP, initialize advertises loadSession:true and sessionCapabilities list/close. Resume not exercised live.", "idWhere": "final `result` JSONL line: sessionId. In ACP: session/new result.sessionId."}
- Shell: {"available": true, "enable": "Built-in shell tool exists (permission kind shell(...)). Enabled by not denying/excluding it; in ACP, a shell call triggers session/request_permission which the host answers allow_once/allow_always/reject_once. Headless -p needs --allow-tool 'shell(cmd:*)' patterns (never --allow-all-tools) to run without a prompt.", "confinement": "Path verification is on by default: file access limited to cwd (+ temp dir, disable with --disallow-temp-dir) plus --add-dir dirs; --allow-all-paths disables it. No OS sandbox by default (`copilot help sandbox` topic exists, not read); shell commands themselves are only gated by permission patterns, so the host should treat shell confinement as approval-based, not filesystem-enforced.", "caveats": "Help text says --allow-all-tools is 'required for non-interactive mode' but a -p run with --deny-tool shell/write succeeded (exit 0) for a no-tool prompt; behaviour when a tool needs approval in -p mode not tested (likely denied). Shell-tool execution itself was not run because the permission was rejected in the ACP probe."}

### Host relay (approvals and questions)
- approvals: **relayable**, questions: **unknown**, verified live: **True**
- Mechanism: ACP over stdio (`copilot --acp`, newline-delimited JSON-RPC 2.0). Agent sends session/request_permission request with options allow_once/allow_always/reject_once; host replies with a JSON-RPC result. Questions (ask_user tool, disable with --no-ask-user) not exercised over ACP; unknown how they surface (probably elicitation or a permission-like request).
- exampleRequest: `{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{"sessionId":"f6cd547f-...","toolCall":{"toolCallId":"call_hY9C...","title":"Run requested echo command","kind":"execute","status":"pending","rawInput":{"command":"echo hello","commands":["echo hello"]}},"options":[{"optionId":"allow_once","kind":"allow_once","name":"Allow once"},{"optionId":"allow_always","kind":"allow_always","name":"Always allow"},{"optionId":"reject_once","kind":"reject_once","name":"Deny"}]}}`
- exampleResponse: `{"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"cancelled"}}}  (I sent 'cancelled'; CLI treated it as reject: tool_call_update status failed, rawOutput {message:'The user rejected this tool call.',code:'rejected'}. To allow, standard ACP is {outcome:{outcome:'selected',optionId:'allow_once'}} - the 'selected' form was not sent, unverified.)`

- Skills: {"supported": true, "format": "SKILL.md files (per `copilot skill --help`)", "projectDir": ".github/skills/, .agents/skills/, or .claude/skills/", "userDir": "~/.copilot/skills/ or ~/.agents/skills/ (also plugins, and custom dirs via `copilot skill add`); --add-dir loads that dir's .github/skills and .github/agents as trusted"}
- Instructions file: AGENTS.md and related files (per --no-custom-instructions help: 'AGENTS.md and related files'); `copilot instruction list` inspects sources and printed 'No instruction sources found.' in the empty scratch folder. Exact list of related files (.github/copilot-instructions.md, CLAUDE.md) not verified.
- Usage fields: {"tokens": "ACP: session/prompt result usage {inputTokens:11948, outputTokens:27, totalTokens:11975, thoughtTokens:0, cachedReadTokens:0, cachedWriteTokens:11945}. JSONL mode: no per-turn token totals in the final result; only session.usage_checkpoint totalNanoAiu/totalPremiumRequests and result.usage premiumRequests/durations (token counts appeared only in other nested fields I did not identify).", "contextWindow": "ACP: session/update usage_update {used:12079,size:272000} gives context used and window size, so Context % = used/size (about 4.4% in probe).", "cost": "Premium requests (result.usage.premiumRequests=1) and totalNanoAiu=209367500 in usage_checkpoint; no USD. --usage-output-file <file> writes final usage JSON (not run); --max-ai-credits caps spend."}
- Models: {"flag": "--model <model> (or 'auto'); --reasoning-effort none|minimal|low|medium|high|xhigh|max; --context default|long_context; --auto-tier efficiency|balance|intelligence|fast", "available": ["gpt-6-luna (the only model listed by Auto routing in this account's probe: availableModels:[\"gpt-6-luna\"])"], "cheapest": "Not determined. Default Auto picked gpt-6-luna. Full model list not enumerated (no list-models subcommand seen; ACP session/new returned no model list in the truncated output)."}

### Event shapes
- **session.auto_mode_resolved**: `{"type":"session.auto_mode_resolved","data":{"chosenModel":"gpt-6-luna","routingMethod":"auto_v2","availableModels":["gpt-6-luna"]},...}` (default model is Auto; shows which model was routed to)
- **session.mcp_servers_loaded / session.tools_updated**: `{"type":"session.tools_updated","data":{"model":"gpt-6-luna"},"ephemeral":true}` (startup; built-in github-mcp-server connects (~4s))
- **user.message**: `{"type":"user.message","data":{"content":"Reply with one word: ok",...}}` (echo of prompt)
- **assistant.turn_start**: `{"type":"assistant.turn_start","data":{"turnId":"0"}}` (turn begins)
- **assistant.message_delta**: `{"type":"assistant.message_delta","data":{"messageId":"...","deltaContent":"ok"},"ephemeral":true}` (streamed text chunk)
- **assistant.message**: `{"type":"assistant.message","data":{"content":"ok","model":"gpt-6-luna","toolRequests":[],...}}` (final full message plus toolRequests)
- **assistant.turn_end / assistant.idle**: `{"type":"assistant.turn_end","data":{"turnId":"0"}}` (turn finished)
- **session.usage_checkpoint**: `{"type":"session.usage_checkpoint","data":{"totalNanoAiu":209367500,"totalPremiumRequests":1,"modelCacheState":[...]}}` (cost in nano AI units and premium request count)
- **result**: `{"type":"result","sessionId":"8e8cda8d-...","exitCode":0,"usage":{"premiumRequests":1,"totalApiDurationMs":2926,"sessionDurationMs":12483,"codeChanges":{"linesAdded":0,"linesRemoved":0,"filesModified":[]}}}` (final line: session id, exit code, usage summary)

### Unverified
- Login-state check while logged OUT (not tested); no dedicated status subcommand seen in --help
- Whether ACP permission reply {outcome:'selected',optionId:'allow_once'} is accepted (only 'cancelled' sent); standard ACP shape from protocol knowledge, not run
- How ask_user questions surface over ACP (not exercised)
- Session resume flags (--resume/--continue/--session-id and ACP session/load) not run live; from --help text
- Exact instruction files read (AGENTS.md confirmed only via --no-custom-instructions help text; .github/copilot-instructions.md and CLAUDE.md not verified)
- Whether .claude/skills is actually loaded (from `copilot skill --help` text only)
- Model list and cheapest model; only gpt-6-luna seen via Auto routing
- Whether -p mode auto-denies tools needing approval (help says --allow-all-tools 'required for non-interactive mode')
- Shell command actually executing within folder confinement; `copilot help sandbox` not read
- Per-turn token counts in JSONL mode (grep showed 'tokens' fields in nested startup data, not mapped)
- --usage-output-file content shape

### Risks
- Each turn costs a premium request (both probes used ~1 each); Auto model may choose a pricier model
- Startup ~4s to connect built-in github-mcp-server; consider --disable-builtin-mcps for speed and to avoid GitHub tool exposure
- Built-in GitHub MCP server and web-fetch (url permissions) are enabled by default; app should deny url/mcp tools or use --available-tools
- Path confinement is permission-based, not an OS sandbox; do not rely on it as a security boundary
- Default --allow-all/--yolo/--allow-all-tools must never be passed; ACP allow_all config option defaults off but a host could toggle it, do not
- The VS Code shim copilot on PATH is not the real CLI; must launch via node + npm-loader.js (or the copilot.exe under node_modules/@github/copilot/node_modules/@github/copilot-win32-x64)
- Tokens counts of ~12k for a trivial prompt (large system prompt), so Context % starts around 4% of a 272000 window
- Copilot session files/logs write under ~/.copilot by default (use --log-dir to redirect); probes did create a session there

### Evidence
- Real CLI launched via node + npm-loader.js, version 1.0.88 | `node "$APPDATA/npm/node_modules/@github/copilot/npm-loader.js" --version` -> `GitHub Copilot CLI 1.0.88.`
- consult.mjs launches copilot with -p and deny-tool write/shell, plain text | `Read consult.mjs lines 767-781` -> `const flags = ['--log-level','error','--deny-tool','write','--deny-tool','shell', ...]; const args = ['-p', p, ...flags];`
- Headless JSON streaming turn works, default model Auto -> gpt-6-luna | `node npm-loader.js -p "Reply with one word: ok" --output-format json --deny-tool shell --deny-tool write --log-level error --no-auto-update` -> `exit=0; {"type":"assistant.message_delta","data":{..."deltaContent":"ok"}...} ... {"type":"result","sessionId":"8e8cda8d-...","exitCode":0,"usage":{"premiumRequests":1,"totalApiDurationMs":2926,"sessionDurationMs":12483,"codeChanges":{...}}}`
- ACP mode exists and initialize handshake works | `node acp.mjs (spawn npm-loader.js --acp; send initialize protocolVersion 1)` -> `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true},"promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},"sessionCapabilities":{"close":{},"list":{}}},"agentInfo":{"name":"Copilot","title":"Copil`
- ACP session/new gives modes agent/plan/autopilot and an allow_all toggle (default off) | `same, session/new {cwd,mcpServers:[]}` -> `result.sessionId ...; configOptions: mode (agent|plan|autopilot), allow_all currentValue "off" (on|off); available_commands_update lists /add-dir /allow-all /permissions /autopilot /compact ...`
- Permission requests relay to the host over ACP; usage and context reported | `node acp2.mjs (initialize, session/new, session/prompt 'Run the shell command: echo hello'), answering permission with cancelled` -> `UPD {"sessionUpdate":"usage_update","used":12079,"size":272000}; UPD tool_call kind execute rawInput {command:'echo hello'}; PERM session/request_permission with options allow_once/allow_always/reject_once; tool_call_update status failed code rejected; PROMPT_RESULT {"stopReason":"end_turn","usage":`
- Skills dirs from help text of the installed CLI | `node npm-loader.js skill --help` -> `Project   .github/skills/, .agents/skills/, or .claude/skills/ ; Personal  ~/.copilot/skills/ or ~/.agents/skills/`
- Tool permission pattern syntax | `node npm-loader.js help permissions` -> `shell(command:*?), write(path?), <mcp-server-name>(tool-name?), url(domain-or-url?); denial always takes precedence over allow`
- Flags present in --help | `node npm-loader.js --help` -> `-p/--prompt, --output-format text|json, --allow-tool, --deny-tool, --available-tools, --excluded-tools, --add-dir, -C <directory>, --resume, --continue, --session-id, --acp, --no-ask-user, --no-custom-instructions, --usage-output-file, --model, --stream on|off, --allow-all-paths, --secret-env-vars`

## agy (Google Antigravity CLI; consult bridge engine "gemini")  (1.2.12)

- Logged in here: **yes**. Check without a model call: No no-model-call status command exists (subcommands: agent, changelog, install, mcp, models, plugin, remote-control, update). `agy models` lists models and succeeded, which implies working auth (not proven to be a pure local check). The only definitive check is a one-word turn, which succeeded (SUCCESS).
- Login: 
- Turn argv: `agy -p <prompt> --output-format stream-json --model gemini-3.8-flash-low --print-timeout 1m`
- Prompt via: -p argv, or with --input-format stream-json (requires --output-format stream-json) NDJSON on stdin: {"event":"user","message":{"content":"..."}}, one turn per line (used by consult.mjs when prompt is too long for argv)
- Working folder: per-run working folder (init event echoes cwd); add --add-dir for more folders
- Stream: stream-json = NDJSON, one object per line with an "event" key
- Sessions: {"idWhere": "conversation_id in the init event, every step_update and the result event", "resume": "--conversation <id> resumes by ID; -c/--continue resumes most recent (both from --help; resume not run live)"}
- Shell: {"available": true, "enable": "Tool run_command exists but headless auto-denies it (permission \"command\"). Enabling needs an allow-rule under permissions.allow in agy settings.json, e.g. command(<target>) (per agy's own stderr hint), or --dangerously-skip-permissions (forbidden). --sandbox \"Run in sandbox with terminal restrictions enabled\" exists (not tested). --mode accept-edits|plan exist.", "caveats": "Edits to settings.json were out of scope, so a working allow-rule was not tested. Whether allow rules can be scoped to a folder is unverified.", "confinement": "--sandbox flag (unverified how strong); cwd plus --add-dir define the workspace"}

### Host relay (approvals and questions)
- approvals: **not-relayable**, questions: **unknown**, verified live: **True**
- Mechanism: Headless -p / stream-json mode cannot prompt: the run_command permission was auto-denied and reported only after the fact in result.denied_actions plus a stderr message. No permission-request event and no reply channel were observed on stdin. The tool list contains ask_permission, ask_custom_permission and ask_question, but no event for them was seen and no ACP flag exists in --help. Possible workarounds (not verified): allow-rules in settings.json, --remote-control, or --prompt-interactive with a PTY.
- exampleRequest: `(none observed)`
- exampleResponse: `(none observed)`

- Skills: {"supported": true, "format": "Slash commands and skills are expanded in print mode (--disable-slash-commands turns it off). Skill folder layout was not determined.", "projectDir": "unknown", "userDir": "unknown"}
- Instructions file: unknown. Not determined for agy; the standalone gemini CLI uses GEMINI.md, but this was not confirmed for agy.
- Usage fields: {"tokens": "usage {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens} on each DONE agent_response step_update and on the result event. A trivial turn already used about 12.2k input tokens (system and tool prompt).", "contextWindow": "No context-window size field in the output. Context % would need a hard-coded per-model window (unverified).", "cost": "No cost field."}
- Models: {"flag": "--model <id> (plus --effort low|medium|high|max)", "cheapest": "gemini-3.8-flash-low", "available": ["gemini-3.8-flash-high/medium/low", "gemini-3.7-flash-high/medium/low", "gemini-3.6-flash-high/medium/low", "gemini-3.1-pro-high/low", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]}

### Event shapes
- **init**: `{"event":"init","conversation_id":"f80f...","init":{"model":"gemini-3.8-flash-low","cwd":"...","tools":["ask_custom_permission","ask_permission","ask_question","run_command","view_file",...],"permission_mode":"request-review"}}` (First event: conversation id, model, cwd, full tool list, permission mode)
- **step_update (text)**: `{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"pong"}}` (Streaming text delta; state ACTIVE then DONE)
- **step_update (done, usage)**: `{"step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":5.36,"usage":{"input_tokens":12249,"output_tokens":19,"thinking_tokens":18,"cache_read_tokens":0,"total_tokens":12268}}}` (Per-step token usage)
- **step_update (tool)**: `{"step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello"}}}}` (Tool call start/finish (note: it was shown as DONE even though the command was auto-denied))
- **result**: `{"event":"result","result":{"conversation_id":"...","status":"SUCCESS","response":"pong\n","duration_seconds":5.6,"num_turns":1,"usage":{...},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}` (Final event; denied_actions present when a permission was auto-denied; response can be empty on SUCCESS)

### Unverified
- Session resume via --conversation <id> / -c: read from --help only, not run.
- --sandbox behaviour, --mode accept-edits|plan behaviour, --remote-control: help text only.
- permissions.allow rule syntax and the settings.json location: quoted from agy's stderr hint only.
- ask_question / ask_permission tools: seen only in the init tools list, never triggered.
- Skills and instruction-file locations for agy: not determined.
- Whether agy has an ACP mode: none in --help; `agy --acp` was not run.
- The --output-format json single-object shape: taken from consult.mjs, not re-run.

### Risks
- Without settings.json allow-rules the agent has no usable shell headless, and a tool call can show DONE while the result carries denied_actions, so the app must read result.denied_actions.
- Permission and question popups cannot be relayed over -p / stream-json as observed. Real popups need another mechanism.
- About 12k input tokens of overhead per turn, and no cost or context-window field.
- The consult bridge treats an empty SUCCESS as a failure; the app must do the same.
- Google OAuth account use: the standalone gemini CLI is now refused, which makes agy the only working Google route on this account.

### Evidence
- Version | `agy --version` -> `1.2.12`
- stream-json headless turn works with the cheapest model and reports usage | `agy -p "Reply with one word: pong" --output-format stream-json --model gemini-3.8-flash-low` -> `{"event":"result","result":{"status":"SUCCESS","response":"pong\n","num_turns":1,"usage":{"input_tokens":12249,"output_tokens":19,"thinking_tokens":18,"total_tokens":12268}}} (exit 0)`
- Headless auto-denies the shell command; no relay to the host | `echo '{"event":"user","message":{"content":"Run the shell command: echo hello..."}}' | agy --input-format stream-json --output-format stream-json --model gemini-3.8-flash-low` -> `result.response "" and "denied_actions":[{"action":"command","display_name":"RunCommand"}]; stderr: 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. com`
- Model list and no ACP flag in help | `agy models; agy --help` -> `gemini-3.8-flash-low  Gemini 3.8 Flash (Low) ...; help lists --continue, --conversation, --input-format, --mode, --sandbox, --remote-control, --json-schema, but no --acp`
- consult.mjs already encodes the agy argv facts | `Read .claude/scripts/consult.mjs lines 741-752 and SKILL.md` -> `agy -p <prompt> --output-format json --print-timeout Nm --model --effort; stream-json stdin {"event":"user","message":{"content":p}}; empty response with denied_actions is treated as the 'empty' failure class; --web (--mode plan) is denied headless (web_unavailable)`

## gemini (open-source Gemini CLI)  (0.58.0)

- Logged in here: **no**. Check without a model call: No no-model-call status command. Any headless run fails at auth: 'IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products'. This is an account/tier block, not a plain logged-out state. Login was not changed. Over ACP, the `initialize` reply lists authMethods (oauth-personal, gemini-api-key, vertex-ai, gateway) and needs no auth.
- Login: 
- Turn argv: `gemini -p <prompt> -o stream-json -m <model> --skip-trust --approval-mode default|auto_edit|plan`
- Prompt via: -p argv (appended to stdin if present), or plain text on stdin (consult.mjs does this for long prompts)
- Working folder: working folder; --include-directories adds more; --skip-trust trusts the workspace for this session
- Stream: -o text | json | stream-json (choices from --help). The stream-json event shapes were NOT observed because the turn failed at auth (exit 1).
- Sessions: {"idWhere": "--session-id <uuid> lets the caller choose the ID; --list-sessions lists them (from --help)", "resume": "-r/--resume latest|<index>; --session-file <json>; --delete-session <index> (help text only; not run). ACP initialize also reports loadSession:true."}
- Shell: {"available": true, "enable": "Default approval-mode prompts for tools. --approval-mode choices: default, auto_edit, yolo (forbidden), plan (read-only). -s/--sandbox is a boolean flag; --policy <files> loads Policy Engine rules (--allowed-tools is deprecated). A shell tool was not exercised because auth is blocked.", "caveats": "Not run live. Whether the shell tool is available and how it is confined in headless mode is unverified.", "confinement": "-s/--sandbox (boolean) and --policy files; folder scoping not verified"}

### Host relay (approvals and questions)
- approvals: **relayable**, questions: **unknown**, verified live: **False**
- Mechanism: ACP (Agent Client Protocol, JSON-RPC over stdio) via `gemini --acp` (--experimental-acp is deprecated). The initialize handshake was run live and answered. Standard ACP defines a session/request_permission call from agent to client, which is what a host popup would answer, but no permission request was observed because no session/prompt turn is possible without auth. Questions to the human via ACP are unknown.
- exampleRequest: `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}`
- exampleResponse: `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"authMethods":[{"id":"oauth-personal","name":"Log in with Google"},{"id":"gemini-api-key",...},{"id":"vertex-ai",...},{"id":"gateway",...}],"agentInfo":{"name":"gemini-cli","title":"Gemini CLI","version":"0.58.0"},"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true,"audio":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true}}}}`

- Skills: {"supported": true, "format": "`gemini skills list|enable|disable|install|link|uninstall` with --scope (from `gemini skills --help`). Skill file format not verified.", "projectDir": "unknown; likely .gemini/skills, not verified", "userDir": "unknown; likely ~/.gemini/skills, not verified"}
- Instructions file: GEMINI.md by convention. Not verified in this run, and AGENTS.md support was not tested.
- Usage fields: {"tokens": "Not observed. The stream-json result stats fields are unverified.", "contextWindow": "unknown", "cost": "unknown"}
- Models: {"flag": "-m/--model <name>", "cheapest": "gemini-2.5-flash-lite was requested but the turn never ran; unverified. No model listing command exists.", "available": []}

### Event shapes

### Unverified
- Everything past initialize: session/new, session/prompt, session/request_permission and the tool-permission relay could not be run because auth is blocked (IneligibleTierError).
- stream-json event shapes and token, context and cost fields: never seen.
- Skill folder locations, GEMINI.md and AGENTS.md handling, shell tool confinement, --sandbox behaviour: not exercised.
- A first attempt to launch ACP through the .cmd shim with shell:true failed (a space in the path); the working script spawns node with the bundle path directly.
- Whether an API-key or Vertex login would work: not tried, since the rules forbid touching keys or config.

### Risks
- The standalone gemini CLI is unusable with this Google-account login today (IneligibleTierError), so the app cannot count on it. agy is the working Google route.
- The Windows .cmd shim breaks when spawned with shell:true; spawn node on gemini.js directly.
- Deprecation: --experimental-acp is deprecated in favour of --acp; --allowed-tools is deprecated in favour of the Policy Engine.

### Evidence
- Version | `gemini --version` -> `0.58.0`
- Headless turn is blocked by an account tier error | `gemini -p "Reply with one word: pong" -o stream-json -m gemini-2.5-flash-lite --skip-trust` -> `exit 1; Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google`
- ACP mode exists and the initialize handshake works with no auth or model call | `node acp.mjs (spawns node gemini.js --acp --skip-trust, sends an initialize request)` -> `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"authMethods":[...],"agentInfo":{"name":"gemini-cli","version":"0.58.0"},"agentCapabilities":{"loadSession":true,...}}}`
- Flags available (help) | `gemini --help` -> `--acp, --experimental-acp, --approval-mode {default,auto_edit,yolo,plan}, -s/--sandbox, --policy, -o {text,json,stream-json}, -r/--resume, --session-id, --list-sessions, --include-directories, --skip-trust, -m; subcommands mcp, extensions, skills, hooks, gemma`
- consult.mjs already encodes gemini argv | `Read consult.mjs lines 753-756` -> `gemini --prompt <p> --output-format json [--model m]; stdin plain when the prompt is too long`

## claude  (2.1.285 (Claude Code))

- Logged in here: **yes**. Check without a model call: claude auth status  (local, no model call; prints JSON with loggedIn:true, authMethod:"claude.ai", subscriptionType; it also prints email/orgName, so the app must parse only loggedIn/authMethod/subscriptionType and never store or show the rest)
- Login: claude auth login (interactive; not run)
- Turn argv: `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --replay-user-messages (optional: echoes user lines with isReplay:true) --verbose --model haiku --permission-mode manual --permission-prompt-tool stdio --tools Read,Grep,Glob,Bash,AskUserQuestion --settings {"disableAllHooks":true}`
- Prompt via: Bidirectional mode: one JSON line per user turn on stdin: {"type":"user","message":{"role":"user","content":"..."}}. Keep stdin open for further turns or permission answers; end stdin after the last result to let the process exit 0. Text mode (no --input-format, prompt piped on stdin then closed) also works but has no way to answer control_requests. Do not set --permission-prompts none in bidirectional mode: with none (or with --permission-prompts host but no --permission-prompt-tool stdio) anything that would prompt is auto-rejected and no control_request is ever emitted.
- Working folder: the chosen project folder (Bash starts there; init.cwd echoes it). CLAUDE.md, .claude/skills and settings in that folder are loaded.
- Stream: NDJSON on stdout, one JSON object per line
- Sessions: {"idWhere": "system/init.session_id on every turn and result.session_id (identical; also equals the .jsonl name under ~/.claude/projects). --session-id <uuid> can pin it up front (help text only).", "resume": "claude -p --input-format stream-json --output-format stream-json --verbose ... --resume <session_id>  (run in the same working folder). Verified: same session_id kept, prior context recalled. Also works without restarting: send several user lines on one stdin in one process (multi-turn), one result per turn. --fork-session gives a new id on resume; --continue resumes the latest in cwd; --no-session-persistence disables saving (help text only)."}
- Shell: {"available": true, "enable": "Put Bash in --tools (e.g. --tools Read,Grep,Glob,Bash) and run with --permission-mode manual --permission-prompt-tool stdio, then answer every can_use_tool control_request for Bash yourself. Under --permission-mode dontAsk --permission-prompts none Bash is listed but non-read-only commands are auto-denied (read-only ones such as a bare `echo` are auto-allowed even there). --allowedTools \"Bash(<pattern>)\" can pre-approve patterns (help text only, not probed).", "confinement": "NOT confined by Claude Code on this machine. Bash starts in the cwd but can read other folders: a command 'ls C:/Users/sarve/Desktop/A2G' still produced a control_request, and when allowed it listed that folder. The sandbox setting does nothing on Windows: with --settings {\"sandbox\":{\"enabled\":true}} stderr said 'Sandbox disabled: ... Windows sandbox is not active on this session (feature gate off) ... Commands will run WITHOUT sandboxing'. So the host must do the confinement in its permission handler: deny when request.blocked_path is present or when the command text mentions a path outside the folder (cd .., absolute paths, ~, $HOME, env vars, network tools), and auto-approve only what it judges safe. blocked_path is best-effort, not a security boundary.", "caveats": "Compound commands (a && b) produce one control_request with permission_suggestions per subcommand and decision_reason_type subcommandResults. A read-only command inside the cwd may not prompt at all, so the handler is not called for every Bash call. Bash on this box runs through Git Bash; init also reports a powershell_path. The --restricted flag (help text only, not probed) removes Bash unless --tools names it, ignores user/project/local settings and confines the FILE tools to the working directories, but its help says nothing about confining Bash itself."}

### Host relay (approvals and questions)
- approvals: **relayable**, questions: **relayable**, verified live: **True**
- Mechanism: Bidirectional stream-json over stdio: start with --input-format stream-json --output-format stream-json --verbose --permission-mode manual --permission-prompt-tool stdio (flag is hidden from claude --help but accepted; help for --permission-prompts only mentions it). claude writes {type:control_request, request_id, request:{subtype:can_use_tool, tool_name, input, tool_use_id, ...}} on stdout and blocks that tool call; the host answers with a control_response line on stdin carrying the same request_id and response {behavior:allow|deny,...}. The process keeps running and the same turn continues. AskUserQuestion uses the same channel with requires_user_interaction:true, answered by allow + updatedInput.answers.
- exampleRequest: `{"type":"control_request","request_id":"6ef0abd4-c37a-4e55-8174-cf5d5b74eee2","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Do you prefer tabs or spaces for indentation?","header":"Indentation","options":[{"label":"Tabs","description":"Use tab characters for indentation"},{"label":"Spaces","description":"Use space characters for indentation"}],"multiSelect":false}]},"tool_use_id":"toolu_01Lij415cH1v54BfPns4y3dD","requires_user_interaction":true}}`
- exampleResponse: `{"type":"control_response","response":{"subtype":"success","request_id":"6ef0abd4-c37a-4e55-8174-cf5d5b74eee2","response":{"behavior":"allow","updatedInput":{"questions":[{"question":"Do you prefer tabs or spaces for indentation?","header":"Indentation","options":[{"label":"Tabs","description":"Use tab characters for indentation"},{"label":"Spaces","description":"Use space characters for indentation"}],"multiSelect":false}],"answers":{"Do you prefer tabs or spaces for indentation?":"Tabs"}}}}}`

- Skills: {"supported": true, "format": "Folder per skill containing SKILL.md with YAML frontmatter (name, description) and a markdown body. Verified: a project skill appeared in system/init.skills and slash_commands. --disable-slash-commands ('Disable all skills' in help) empties both lists (34 skills / 73 slash commands down to 0 / 0) but did NOT stop CLAUDE.md from loading. Plugin skills appear namespaced as plugin:skill.", "projectDir": ".claude/skills/<name>/SKILL.md inside the working folder (verified by probe)", "userDir": "~/.claude/skills/<name>/SKILL.md (directory exists on this machine, contents not read; that user-level skills are loaded from it is documented behaviour, not probed here)"}
- Instructions file: CLAUDE.md in the working folder (verified: the model answered PELICAN-77 from CLAUDE.md). AGENTS.md was NOT read (model answered UNKNOWN for its HERON-11 codeword), so a shared AGENTS.md needs an @-import from CLAUDE.md or --append-system-prompt. --bare skips CLAUDE.md auto-discovery (help text).
- Usage fields: {"tokens": "Per API call: assistant.message.usage and stream_event message_start/message_delta usage = {input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens, output_tokens_details.thinking_tokens}. Per turn (result.usage): same fields summed over the turn's API calls (turn 2 of the resume probe showed only its own 10+278+16942 input tokens), plus iterations[]. result.modelUsage[<model id>] = {inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, costUSD, contextWindow, maxOutputTokens, thinkingTokens}. Total tokens for a node label = input + cache_read + cache_creation + output.", "contextWindow": "Only in result.modelUsage[model].contextWindow (200000 for haiku); NOT in system/init, so the first turn has no denominator until its result arrives (cache it per model, or fall back to a table). Context percentage = (last assistant message usage.input_tokens + cache_read_input_tokens + cache_creation_input_tokens) / contextWindow, using the LAST API call of the turn (or the last message_delta usage), not result.usage which sums calls. Example from the recording: 10+278+16942 = 17230 / 200000 = 8.6%. Sonnet/opus window size not probed (a 1M variant may exist per the claude-api skill note '[1m]'; unverified).", "cost": "result.total_cost_usd (USD). Observed to be CUMULATIVE per process: turn 1 = 0.035004, turn 2 = 0.0375792, and turn 2's own tokens price at about 0.0026 at haiku list prices, so the difference matches. A fresh --resume process starts again from zero. modelUsage[..].costUSD carries costBasis:\"list\" (list price, not what a subscription is billed). Subscription quota is in rate_limit_event.rate_limit_info.utilization (five_hour, seven_day)."}
- Models: {"flag": "--model <alias|full id>  (aliases named in help: fable, opus, sonnet; haiku also worked). Also --fallback-model, --effort low|medium|high|xhigh|max.", "available": ["haiku (resolved to claude-haiku-4-5-20251001, verified)", "sonnet (alias, help text, not run)", "opus (alias, help text, not run)", "fable (alias, help text, not run)"], "cheapest": "haiku"}

### Event shapes
- **system/init**: `{"type":"system","subtype":"init","cwd":"...","session_id":"eea69fe9-...","tools":["Bash","Glob","Grep","Read",...],"mcp_servers":[...],"model":"claude-haiku-4-5-20251001","permissionMode":"default","slash_commands":[...],"skills":[...],"claude_code_version":"2.1.285","capabilities":["interrupt_receipt_v1",...]}. Re-emitted at the start of EVERY turn in a multi-turn process, same session_id.` (Carries session_id, resolved model id, cwd, permissionMode, tool list, skills. No token or context-window numbers.)
- **system/status and system/thinking_tokens**: `{"type":"system","subtype":"status","status":"requesting"} ; {"type":"system","subtype":"thinking_tokens","estimated_tokens":127,"estimated_tokens_delta":77}` (Progress noise, safe to ignore or use for a spinner.)
- **stream_event**: `{"type":"stream_event","event":{"type":"message_start"|"content_block_start"|"content_block_delta"|"content_block_stop"|"message_delta"|"message_stop", ...},"session_id":"...","parent_tool_use_id":null}. message_start.event.message.usage = input-side tokens; message_delta.event.usage = final usage for that API call.` (Raw Anthropic streaming events (only with --include-partial-messages); thinking_delta text is empty on this build, only estimated_tokens.)
- **assistant**: `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_...","role":"assistant","content":[{"type":"tool_use","id":"toolu_...","name":"Bash","input":{"command":"..."}}],"usage":{"input_tokens":10,"cache_creation_input_tokens":1698,"cache_read_input_tokens":18568,"output_tokens":3}},"parent_tool_use_id":null,"session_id":"..."}` (One event per content block (thinking, text, tool_use); the same message.id repeats.)
- **control_request (permission)**: `{"type":"control_request","request_id":"f65ab2c7-...","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"mkdir d && echo hi > d/a.txt","description":"..."},"description":"...","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"mkdir d *"}],"behavior":"allow","destination":"localSettings"}],"decision_reason_type":"subcommandResults","blocked_path":"C:\\Users\\sarve\\Desktop\\A2G" (only present when the command touches a path outside the cwd),"tool_use_id":"toolu_..."}}` (Emitted AFTER the assistant tool_use line; the turn is paused until the host writes a control_response with the same request_id.)
- **control_request (AskUserQuestion)**: `{"type":"control_request","request_id":"6ef0abd4-...","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","input":{"questions":[{"question":"Do you prefer tabs or spaces for indentation?","header":"Indentation","options":[{"label":"Tabs","description":"..."},{"label":"Spaces","description":"..."}],"multiSelect":false}]},"tool_use_id":"toolu_...","requires_user_interaction":true}}` (A question arrives BOTH as an assistant tool_use block (name AskUserQuestion) and as a can_use_tool control_request with requires_user_interaction:true. Render the popup from request.input.questions.)
- **control_response (host -> claude) allow**: `{"type":"control_response","response":{"subtype":"success","request_id":"<same id>","response":{"behavior":"allow","updatedInput":{<the original request.input, optionally edited>}}}}` (Allow. updatedInput is required in practice; echo request.input back unchanged.)
- **control_response deny**: `{"type":"control_response","response":{"subtype":"success","request_id":"<same id>","response":{"behavior":"deny","message":"Denied by host probe"}}}` (Deny. The tool_result the model sees is is_error:true with content = message; turn continues and ends normally with subtype success.)
- **control_response for AskUserQuestion answer**: `{"type":"control_response","response":{"subtype":"success","request_id":"<same id>","response":{"behavior":"allow","updatedInput":{"questions":[<original questions array>],"answers":{"Do you prefer tabs or spaces for indentation?":"Tabs"}}}}}` (answers is a map from the exact question text to the chosen option label; the model then receives 'Your questions have been answered: ...="Tabs"' and continues.)
- **user (tool_result)**: `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_...","content":"(Bash completed with no output)","is_error":false}]},"tool_use_result":{"stdout":"","stderr":"","interrupted":false}}` (Tool output. Denied calls have is_error:true. With --replay-user-messages the host's own prompt is also echoed as a user line with isReplay:true, and (observed) the host's control_response lines are echoed back on stdout too; ignore echoes.)
- **rate_limit_event**: `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"seven_day","utilization":0.81,"unifiedWindows":{"five_hour":{"utilization":0.4,"resetsAt":...},"seven_day":{...}}}}` (Subscription usage windows; useful for a quota badge.)
- **result**: `{"type":"result","subtype":"success","is_error":false,"session_id":"...","num_turns":1,"result":"Done.","total_cost_usd":0.0111,"usage":{"input_tokens":18,"cache_creation_input_tokens":2253,"cache_read_input_tokens":38834,"output_tokens":544},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":18,"outputTokens":365,"cacheReadInputTokens":28542,"cacheCreationInputTokens":2143,"costUSD":0.0089,"contextWindow":200000,"maxOutputTokens":32000}},"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_...","tool_input":{...}}],"stop_reason":"end_turn","terminal_reason":"completed","duration_ms":8129}` (One per turn; the host sends the next user line after it. permission_denials lists calls auto-denied (dontAsk / --permission-prompts none), and is [] when the host answered the prompts.)

### Unverified
- Interrupting a running turn or changing permission mode mid-process with other control_request subtypes (init.capabilities lists interrupt_receipt_v1, interrupt_cancel_queued_v1, msg_lifecycle_v1; the request shapes were not sent). No documentation was read.
- User-level skills in ~/.claude/skills being loaded: the folder exists (entries 'SKILL.md' and 'synced') but I did not probe it or read docs; project-level loading is verified.
- Context window for sonnet/opus/fable (only haiku's 200000 was observed); 1M-context variants and how to select them are unverified.
- Whether --allowedTools "Bash(...)" pre-approval patterns, --add-dir, --append-system-prompt, --mcp-config, --strict-mcp-config, --setting-sources and --restricted behave as their help text says: only their help lines were read, none was run (help text in help.txt). There is no --max-turns flag in this version's help.
- Whether total_cost_usd is cumulative per process in all cases: inferred from two turns' arithmetic, not from documentation.
- Whether control_response echoes appear on stdout only because --replay-user-messages was set: seen with the flag (s3b runs), not seen without it (s4), not tested in isolation.
- Behaviour when stdin closes while a control_request is pending, and whether a request can time out, was not tested.
- Windows sandbox feature gate: the message says the gate is off for this session; whether it can be turned on is unknown.

### Risks
- Bash is unsandboxed on Windows. The only guard is the host's handler, and read-only commands inside the cwd may be auto-allowed with no control_request at all; a model can also reach outside via cd, ~, env vars, or interpreters (node -e, python -c). Treat blocked_path as a hint and deny by default (allow-list of command prefixes, reject absolute or .. paths, never approve network or git push style commands without a popup).
- --permission-prompt-tool stdio is not in claude --help; it may change or vanish in a later version. Pin the Claude Code version and re-run the probe (harness.mjs plus s3b/s4 configs) on upgrade.
- If the host never answers a control_request the turn hangs forever; the app needs its own timeout that answers deny, plus a kill path.
- Do not combine --permission-prompt-tool stdio with --permission-prompts none or an unanswered stdin: prompts would be silently auto-rejected (looks like the model 'asking for permission' in prose).
- The model's own can-I-run-this prose after a denial looks like a question but is not a control_request; only AskUserQuestion produces a structured question.
- account/orgs leak: claude auth status prints e-mail and organisation; the login probe must parse only loggedIn/authMethod/subscriptionType. system/init also prints cwd, memory_paths and a named-pipe path, so do not forward raw init to a shared UI.
- Every process start with default settings loads all user and plugin skills, MCP servers and CLAUDE.md files (init showed 34 skills, several MCP servers pending); for a predictable graph node use --disable-slash-commands, --strict-mcp-config, --setting-sources project and the disableAllHooks setting, and expect a 15k to 21k token cache-creation cost on the first call.
- Subscription 7-day utilization was already 0.81 (allowed_warning) at probe time, so heavy fan-out of Claude nodes may hit the limit; rate_limit_event should be surfaced.
- Probe leftovers: scratch subfolders contain circle-probe-dir-allow (created by an allowed mkdir) and the skillprobe and confine folders; all are inside the scratch folder only.

### Evidence
- Version and login state without a model call | `claude --version ; claude auth status` -> `2.1.285 (Claude Code)
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", ..., "subscriptionType": "pro" }  (email and org fields omitted on purpose)`
- Relevant flags exist in help; --permission-prompt-tool is NOT listed in help but --permission-prompts mentions it; there is no --max-turns flag in this version's help | `claude --help` -> `--input-format <format> ... "text" (default), or "stream-json" (realtime streaming input)
--permission-prompts <target>  Who answers permission prompts with --print: "host" (the SDK host or --permission-prompt-tool) or "none" ...
--permission-mode <mode> (choices: "acceptEdits","auto","bypassPermiss`
- Under dontAsk + --permission-prompts none a read-only echo runs with no prompt, but a mkdir/redirect command is denied and listed in permission_denials | `node harness.mjs s2b.json  (claude -p --output-format stream-json --verbose --model haiku --permission-mode dontAsk --permission-prompts none --tools Read,Grep,Glob,Bash ; stdin text: 'Run the shell command: mkdir circle-probe-dir && echo hi > circle-probe-dir/a.txt')` -> `tool_result: "Permission to use Bash has been denied because Claude Code is running in don't ask mode. ..."
result: "permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_01HE1B1JMzGXWUvVwiKqKvZJ","tool_input":{"command":"mkdir circle-probe-dir && echo hi > circle-probe-dir/a.txt",...}}],"nu`
- stream-json input with --permission-prompts host but WITHOUT --permission-prompt-tool: no control_request, the call is auto-rejected | `node harness.mjs s3-allow.json  (... --input-format stream-json --output-format stream-json --permission-mode manual --permission-prompts host --tools Read,Grep,Glob,Bash)` -> `tool_result is_error:true "This Bash command contains multiple operations. The following parts require approval: mkdir circle-probe-dir-allow, echo hi" with tool_result_meta non_execution_kind:"user-rejected"; no control_request line in the recording`
- --permission-prompt-tool stdio makes claude emit control_request; allow lets Bash run (directory really created) | `node harness.mjs s3b-allow.json  (... --permission-mode manual --permission-prompt-tool stdio --tools Read,Grep,Glob,Bash)` -> `IN  {"type":"control_request","request_id":"f65ab2c7-b733-459c-9f68-85f311668300","request":{"subtype":"can_use_tool","tool_name":"Bash",...,"decision_reason_type":"subcommandResults","tool_use_id":"toolu_01WNpY2g..."}}
OUT {"type":"control_response","response":{"subtype":"success","request_id":"f65`
- Deny works and the turn still ends cleanly | `node harness.mjs s3b-deny.json` -> `OUT {"..."request_id":"79f7c154-...","response":{"behavior":"deny","message":"Denied by host probe"}}
IN tool_result {"content":"Denied by host probe","is_error":true,...,"non_execution_kind":"permission-rule"}; model: 'The command was blocked by a host probe ...'; no circle-probe-dir-deny directory`
- AskUserQuestion arrives as tool_use block plus can_use_tool control_request with requires_user_interaction:true, and an allow response carrying answers continues the turn | `node harness.mjs s4.json  (prompt: 'Use the AskUserQuestion tool to ask me whether I prefer tabs or spaces, with two options, then stop.'; --tools Read,Grep,Glob,Bash,AskUserQuestion --permission-mode manual --permission-prompt-tool stdio)` -> `IN assistant tool_use name:"AskUserQuestion" input.questions[0].question:"Do you prefer tabs or spaces for indentation?" options Tabs/Spaces
IN control_request ... "tool_name":"AskUserQuestion",...,"requires_user_interaction":true
OUT control_response ... "behavior":"allow","updatedInput":{"question`
- Resume keeps session and context; multi-turn in one process also works | `node harness.mjs s5a.json (two user lines) then node harness.mjs s5b.json (... --resume eea69fe9-4c2b-4d57-a2dc-b6aa8fe76c5b, new process)` -> `s5a: turn1 'OK' (cost 0.035004), turn2 'ZEBRA-42' (cost 0.0375792), both session eea69fe9-...
s5b (fresh process with --resume): init session eea69fe9-... ; answer 'ZEBRA-42'`
- Usage, cost and context-window fields | `node (parse of s5a-turn1.jsonl result events)` -> `result keys: duration_api_ms,stop_reason,session_id,total_cost_usd,usage,modelUsage,permission_denials,terminal_reason,...,num_turns,subtype,result,duration_ms
modelUsage: {"claude-haiku-4-5-20251001":{"inputTokens":10,"outputTokens":222,"cacheReadInputTokens":0,"cacheCreationInputTokens":16942,"cos`
- Project skill loads, CLAUDE.md is read, AGENTS.md is not, --disable-slash-commands removes all skills | `cwd=skillprobe (has .claude/skills/circle-probe/SKILL.md, CLAUDE.md with PELICAN-77, AGENTS.md with HERON-11): claude -p --output-format stream-json --verbose --model haiku --permission-mode dontAsk --permission-prompts none --tools Read,Grep,Glob [--disable-slash-commands]` -> `run A: init.skills includes circle-probe: true, nskills 34, nslash 73; answer 'Project codeword: PELICAN-77 | Agents codeword: UNKNOWN'
run B (--disable-slash-commands): circle-probe in skills: false, nskills 0, nslash 0; answer still 'Project codeword: PELICAN-77'`
- Bash is not confined to the folder; the permission request flags outside paths via blocked_path; the Windows sandbox is off | `cwd=confine: claude -p --input-format stream-json --output-format stream-json --verbose --model haiku --permission-mode manual --permission-prompt-tool stdio --tools Bash [--settings {"sandbox":{"enabled":true}}] ; prompt 'Run this exact shell command and nothing else: ls C:/Users/sarve/Desktop/A2G'` -> `control_request ... "input":{"command":"ls C:/Users/sarve/Desktop/A2G"} ... "blocked_path":"C:\\Users\\sarve\\Desktop\\A2G"
deny run: permission_denials shows the Bash call; allow run with sandbox enabled: STDERR '⚠ Sandbox disabled: sandbox is enabled but the Windows sandbox is not active on this s`

