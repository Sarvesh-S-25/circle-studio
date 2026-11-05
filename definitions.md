# Circle Studio: review and improvement definitions

Review date: 22 October 2026. This document preserves the original review and acceptance criteria. Implementation was subsequently authorized by the user; current build status and test evidence are in [connections.md](connections.md). Statements describing the repository below refer to the review baseline, not the latest implementation.

The recommendation is to keep Circle Studio's current design and local desktop experience, and finish Codex support across the whole product. The missing work is mostly shared data and behavior: selecting Codex should consistently select its conversation, model, limits, activity, and terminal action everywhere.

This document covers the project's feature map, existing task notes, relevant backend/frontend paths, engine adapters, desktop scripts, installer/updater, and test coverage. It is a static product and implementation review, not a claim that every line or runtime behavior has been verified. Existing test reports and memory measurements are identified as historical. No app instance, live AI session, installer, updater, or test suite was run for this review. Runtime data contents and credentials were not opened; disk measurements used file metadata only. Only this document was created.

## 1. What to keep and what to do first

Keep the circles, graph, compact bar, desktop cards, widgets, light/dark themes, keyboard access, local storage, and CLI sign-ins. Keep the small Node-built-ins architecture and existing engine adapters. A framework migration or whole-app rewrite would distract from your main need.

Recommended order:

1. **Make Codex reliable:** protocol compatibility, correct selected engine/model, process failure handling, and honest approval behavior.
2. **Make conversations durable:** preserve old chats, list Codex history, resume the selected conversation, and keep every surface on that conversation.
3. **Show correct limits and activity:** provider-specific readings, timestamps, unknown states, context usage, and correct project totals.
4. **Remove unnecessary Claude dependencies:** workflow helper, Advisor, Find skills, catalog summaries, and connection advice.
5. **Improve RAM, storage, and installation:** measure the complete process footprint, bound caches, reduce repeated reads, preserve data through updates, and offer release downloads.
6. **Add useful task completion and optional achievements:** completion backed by evidence, without rewarding token spending or unnecessary agent calls.

Priority definitions: **P0** = correctness or data preservation before calling Codex support complete; **P1** = core usability and provider parity; **P2** = worthwhile follow-up; **P3** = optional experiment. Effort: **S** = narrow change, **M** = several connected modules, **L** = protocol/storage/platform work. These are relative sizes, not time promises.

## 2. Current support: the important distinctions

| Capability | What the repository currently implements | Recommended result |
|---|---|---|
| Codex chat | `backend/lib/engines/codex.mjs` starts an app-server process, streams text, handles some approvals/questions, resumes its saved thread, and reads token events. It explicitly says `liveVerified: false`. | Keep the adapter; establish compatibility and a recorded live acceptance run. |
| Codex usage | `backend/lib/usage.mjs` already reads Codex session token totals. | Extend and correct this foundation; do not describe Codex usage as entirely absent. |
| Earlier conversations | `cchistory.mjs`, the history routes, and the chat history interface read Claude transcripts. | A common conversation browser with provider-aware history adapters. |
| Limits | `limits.mjs` stores Claude five-hour/week readings in one record; the widget and bar consume it. | Separate Codex/Claude account readings and dynamically described windows. |
| Model selection | Codex adapter exposes `models: []`; main Chat has a Claude-only picker. The graph allows a free-text model. | One available-model source shared by Chat, graph, widgets, and bar. |
| Workflow helper and Advisor | Routes invoke `claude.advise`; Find skills and catalog summaries also rely on Claude/Haiku. | Choose an available supported provider explicitly and validate its output. |
| Skills | Codex install target `.agents/skills` already exists. Library partitions lack a dedicated `codex` value, although engine filters include Codex. | Clear compatibility and scope controls; avoid a cosmetic partition rename becoming a storage migration. |
| Connections | Codex configuration can be listed/tested; its TOML reader is intentionally limited. Change/repair plans mainly target Claude. | Show effective configuration and support narrowly scoped, reviewed Codex changes only after format support is proven. |
| Terminal button | `terminal.mjs` searches for `claude.exe` and launches `claude --resume`. | Launch/focus the engine and conversation selected by the user. |
| Desktop experience | Shared requests, widgets, bar, notices, and live runs exist. Several chat/history/model assumptions are Claude-specific. | Preserve the UI while using one conversation selection and one normalized event stream. |
| Task/progress information | Board parsing, stage states, activity rings, and notices exist. No general achievement system was found. | Separate activity from verified task completion; optional achievements later. |

## 3. Concrete findings to prioritize

These are source findings or clearly labeled risks, not bugs reproduced in a live application during this review.

### F01 — Codex protocol compatibility needs a fresh gate

**Evidence:** [Codex adapter](backend/lib/engines/codex.mjs), `thread/start`, sends `approvalPolicy: 'untrusted'`. Its comment records schema checking against CLI 0.154.0. [Existing research](docs/research/engines.md) describes that historical check.

Current official guidance says explicit `approval_policy = "untrusted"` is retired. It also says `on-request` permits operations allowed by the sandbox without asking. Therefore, changing the string is not sufficient to preserve Circle Studio's promise that every command/edit is shown first. A project trust setting is a distinct mechanism with its own effects; it should not be silently written to users' configuration. Validate the installed app-server schema and actual behavior before choosing a migration. This is a compatibility risk against current guidance, not proof that the historical binary rejects the existing RPC value. [Official approval guidance](https://learn.chatgpt.com/docs/agent-approvals-security).

**Task CX-01 · P0 · L:** establish supported CLI versions, feature negotiation, and approval behavior. Distinguish “Circle shows requests the engine raises” from “every operation is intercepted.” Prompts alone do not enforce the latter. Apply permissions to resumed threads as well as new ones. Where the engine cannot meet a selected mode, explain the limitation and offer a supported mode.

**Done when:** a real temporary-folder check covers reads, in-project edits, commands, outside-project operations, denied operations, and resumed sessions; displayed promises match observed behavior.

### F02 — Desktop chat selection can override an explicit engine

**Evidence:** [Overlay routes](backend/routes.overlay.mjs), `sayTo`, first carries on a recent Claude conversation and then sets `engineId = note ? 'claude' : chosen || ...`. It forwards a chosen model only when the result is Claude.

**Task CX-02 · P0 · M:** resolve the user's explicit engine/thread choice before any “continue latest” behavior. Capture project, provider, conversation, model, and node when Send is pressed. Use that immutable target for queued messages and replies.

**Done when:** a recent Claude terminal chat cannot divert a message explicitly addressed to Codex; switching projects or models after queuing cannot redirect queued work.

### F03 — A configured node model is displayed but can be omitted from execution

**Evidence:** [Session broker](backend/lib/sessions.mjs) computes `run.model = model || node?.model || null`, but calls `adapter.runTurn` with the original `model` argument.

**Task CX-03 · P0 · S:** resolve the effective model once, validate it for the selected provider, and pass the same value to execution and display. Report the actual model returned by the engine when available; “default” is not an actual model name.

**Done when:** a graph agent's configured model reaches its adapter without a separate model choice in Chat; changing providers cannot carry over an incompatible Claude model name.

### F04 — New chat does not preserve a Circle conversation archive

**Evidence:** [Records](backend/lib/records.mjs), `Chats.reset` and `Chats.link`, replace the single saved record for a project/node/engine. `append` retains 200 messages. [Chat UI](frontend/js/views/chat.js) says earlier conversations remain accessible, but the history browser reads Claude records. The engine's own original files may survive; Circle's archive and rediscovery are the missing part.

**Task CH-01 · P0 · L:** introduce stable Circle conversation IDs and a separate “currently selected conversation” pointer. New chat creates a record; continuing another chat selects or forks it without replacing unrelated history. Migrate existing records without rewriting provider transcripts.

**Done when:** create three Codex chats, restart, and reopen each; a chat longer than 200 messages remains recoverable through paging or export; upgrading preserves existing Claude and Codex conversations.

### F05 — An engine exit can leave a turn waiting

**Evidence:** [RPC peer](backend/lib/engines/rpc.mjs) rejects pending RPC requests when the child exits. After `turn/start` resolves, [Codex adapter](backend/lib/engines/codex.mjs) waits on a separate completion promise that is settled by completion, abort, or recognized sign-out events. There is no child-exit settlement wired to that promise. Its stderr pipe is also not consumed by this adapter/RPC path.

**Task CX-04 · P0 · M:** settle turns exactly once on process exit/error, drain stderr into a bounded redacted diagnostic buffer, and give initialization/RPC requests deadlines. Use a liveness indication for long turns, not a short timeout that kills legitimate work or someone considering an approval. Prefer a graceful interrupt before a timed process-tree termination.

**Done when:** a fake engine exiting after accepting a turn releases the run and pending cards; a large stderr stream cannot stall it; duplicate finish/exit events do not save duplicate answers.

### F06 — Plan limits can belong to the wrong provider or be stale

**Evidence:** [Limits](backend/lib/limits.mjs) stores one Claude reading. [Feed](backend/lib/feed.mjs), `limitsView`, turns an elapsed reset into `pct: 0` and “new” without a fresh provider reading. Overlay usage consumes the same object regardless of the selected engine.

**Task US-01 · P0 · M:** store readings by provider and a local opaque account/profile identity; attach observation time and source to each window. Render expired readings as awaiting refresh. Do not substitute Claude limits for missing Codex data.

**Done when:** switching providers changes the label and reading together; unavailable, stale, signed-out, and genuine zero usage are distinguishable.

### F07 — Project totals and activity can misrepresent Codex

**Evidence:** [Stats](backend/lib/stats.mjs), `computeStats`, reads `app.chats.get(p.id)`, the legacy Claude main-chat key. [Agent states](backend/lib/agentstate.mjs) initializes the main session with `engine: 'claude'` and does not replace that field with the live run's engine. External activity uses Claude files and recent modification times.

**Task US-02 · P1 · M:** aggregate all project conversations once, retain provider identity, and prefer explicit run lifecycle evidence. Use “recent activity” for timestamp-based observations. A quiet transcript is not proof of success.

**Done when:** a Codex-only project has correct chat counts, engine labels, and running states on Home, widgets, bar, and graph.

### F08 — Codex usage needs accounting validation

**Evidence:** [Usage](backend/lib/usage.mjs) groups folders by basename, attributes a session's cumulative tokens to its session-directory day, and adds `reasoning_output_tokens` to `output_tokens`. A model field is captured only from the first matching turn context. The Codex cache has no explicit eviction limit.

**Task US-03 · P1 · M:** identify folders by canonical full path, calculate daily usage from per-event deltas where reliable, and validate whether reasoning tokens are a subset before summing. Track model changes and distinguish lifetime thread totals from individual turn usage. Avoid adding the same usage from both Circle records and provider transcripts.

**Done when:** fixtures cover same-named folders on different paths, a session spanning midnight, a resumed old session, model changes, cumulative resets, and missing fields. Unknown amounts stay unknown.

### F09 — Completion counts currently include cancelled work

**Evidence:** [Health](backend/lib/health.mjs), `readBoard`, classifies done, closed, cancelled, and superseded rows as not open; [Stats](backend/lib/stats.mjs) calculates `done = total - open`. Agent state also uses transcript age to infer “done.”

**Task TK-01 · P1 · M:** preserve separate task outcomes and add explicit completion evidence. Keep operational activity rings separate from task completion rings.

**Done when:** cancelling a task does not earn a completion or achievement; a recently stopped or failed agent does not mark its stage complete.

### F10 — Pending requests should not be removed by retention

**Evidence:** [Inbox](backend/lib/inbox.mjs), `add`, truncates the entire project list to 1,000 records, without reserving pending entries. This is an edge case, but important for an always-running control room.

**Task AP-01 · P1 · M:** retain active requests until resolved/expired, prune completed records separately, and load older audit records on demand. Keep original provider request/question IDs instead of using question text as the sole identity.

**Done when:** more than 1,000 historical records cannot make an outstanding approval unanswerable; repeated question wording still receives the correct separate answers.

## 4. Codex conversations and limits: proposed experience

### Official protocol basis

The current app-server documentation describes `thread/list`, `thread/read`, `thread/turns/list`, `thread/resume`, `thread/fork`, and archive operations. Model discovery uses `model/list`. Limits use `account/rateLimits/read` and `account/rateLimits/updated`; windows include duration, usage percentage, and reset time. List methods support pagination. Thread-list defaults can omit sources, so source filters need deliberate handling. Newer account usage/reset-credit methods also exist, but availability must be checked against the installed version and authentication. [Official app-server reference](https://learn.chatgpt.com/docs/app-server).

These are integration options, not proof that Circle can attach to every independently running Codex terminal, desktop process, cloud task, or ChatGPT conversation. Local thread history and control of a live external session are different capabilities.

### CH-02 · P1 · L — A common conversation browser

Add provider, project, title, last activity, source, and status to each row in the existing Earlier conversations view. Offer All / Codex / Claude filters and search. Show archived items separately. Keep chat previews short and load transcript pages on demand.

Use the provider's supported history interface first. If a read-only local-file fallback is needed, isolate it behind a versioned adapter, honor `CIRCLE_CODEX_HOME`/`CODEX_HOME`, handle truncated JSONL lines, and never modify provider-owned databases or logs. Restrict results to the selected project unless the user opens an all-project view. Handle Windows case, spaces, worktrees, and duplicate folder names.

**Done when:** an existing local Codex conversation appears in the correct project, opens without starting a model turn, and retains its provider/thread identity when continued. Pagination works with thousands of chats.

### CH-03 · P1 · M — One selected conversation across every surface

Persist a small selection record: project, Circle conversation ID, provider, external thread ID, optional workflow node, model choice, and supported reasoning setting. Chat, widget, overlay, desktop card, and editor export refer to that record or an explicit pinned selection.

Offer distinct actions: **Read**, **Continue**, **Continue as a copy**, **New chat**, **Archive**, **Export**. Changing the engine starts/selects that engine's conversation. A cross-provider handoff should show a reviewed summary, not imply the second provider inherits the first provider's hidden state.

**Done when:** a notification opens the exact conversation that produced it; replying from any surface adds one message to the same conversation; a newer unrelated transcript does not steal selection.

### CH-04 · P1 · M — Reliable composing and recovery

Move the queue from a page-local array to the broker. Persist drafts per conversation; allow queued messages to be edited, removed, or reordered before submission. Distinguish queued messages from in-turn steering. Handle transient disconnection by reconnecting to the existing run, not resending the prompt automatically.

Add a client message ID for deduplication, run status reconciliation after reconnect, and saved partial responses for interrupted turns. Store a minimal recovery checkpoint during long runs instead of relying solely on the final transcript append.

**Done when:** closing the widget, restarting the browser, or losing an SSE connection does not duplicate a turn or silently lose a queued message. Restarting the server reports interrupted work honestly.

### CX-05 · P1 · M — Models, reasoning, and a capability matrix

Populate selections from the adapter, cache by CLI/account identity, and refresh after sign-in/version changes. Preserve an explicit user selection. Show only supported reasoning choices. Provide a clear “engine default” option with the effective model once known.

Expand capabilities beyond `chat`/`resume`: history, fork, archive, limits, structured output, image input, approval categories, external observation, and live control. A missing capability should give an explanation or a narrower action. Installed, authenticated, supported, and tested are separate states.

**Done when:** the same selected Codex model reaches Chat, graph node chat, widget, bar, and terminal handoff, or the unavailable capability is explained before sending.

### CX-06 · P1 · M — Complete useful event rendering

Normalize text, tool status, file changes, command output, questions, usage, retry, failure, and completion into the shared event model. Keep lengthy output behind expandable details. Handle resolved/cancelled requests so old cards disappear. Unknown event types should not crash a conversation; unknown approval types should never become automatic consent.

**Done when:** a Codex edit and test run visibly show changed files, command outcome, and pending questions, rather than only an answer plus a generic command label.

### US-04 · P1 · M — A provider-aware limits card

Keep the current compact card, with a provider label and a clear **used** or **remaining** value. Suggested display:

> Codex · account profile A  
> Current window: 62% used · resets in 1h 18m  
> Longer window: unavailable  
> Updated 20 seconds ago · Refresh

Numbers above are illustrative, not a reading from this PC. Name windows from the reported duration; only say “5 hours” or “Week” when that is the actual window. Keep account quotas, thread context capacity, token activity, and monetary estimates visually distinct. Do not add percentages across providers or projects.

Refresh on meaningful account/usage events and when a relevant view opens, with backoff and a manual Refresh button. Avoid starting an AI turn merely to refresh limits. At a reset boundary, show pending refresh until a new observation arrives. Offer optional threshold notifications with cooldowns, never repeated notices on every poll.

**Done when:** missing windows, multiple buckets, an offline account, expired readings, sign-out, account switching, and reset boundaries all display correctly.

## 5. Tasks and achievements

“Achievement method” can mean how to deliver improvements or a feature that records accomplishments. Implementation steps and acceptance criteria are included throughout this document; this section also defines the optional accomplishment feature.

### TK-02 · P1 · M — An actual project task view

Today `readBoard` expects a six-column `TX-...` Markdown table and exposes the first eight rows in its summary. Keep that existing import path, but add a complete pageable task view with title, owner, provider, stage, status, dependencies, acceptance criteria, and evidence links.

Suggested states: **Planned → Working → Needs you / Blocked → Ready for review → Done**. Keep **Cancelled** and **Superseded** separate. Mark imported status as imported, and make malformed rows visible instead of silently treating a partial import as the whole board.

A task is Done when its stated checks pass and the required reviewer accepts it. A successful model turn alone is insufficient. Record the relevant test result, reviewed diff, document, or manual verification. Do not run commands simply to manufacture evidence.

**Done when:** users can find every task, see why it is blocked, navigate to its supporting conversation, and distinguish reviewed completion from an agent's claim.

### TK-03 · P2 · M — Optional local achievements

Keep this small, off by default, and integrated into a Progress widget or project summary. Examples:

| Achievement | Evidence needed | Counting rule |
|---|---|---|
| First verified task | One completed task with its acceptance evidence | Once per project |
| First Codex workflow | A Codex task run, required checks, and accepted result | Once per project; setup alone does not qualify |
| Review complete | An actual reviewed change attached to a task | Once per review ID |
| Milestone complete | All required tasks accepted; optional tasks excluded from denominator | Once per milestone version |
| Recovery ready | A backup restored successfully into an isolated location | Record the successful verification, not just a download |
| Consistent progress | Accepted work on separate local dates | Optional; no penalty for breaks |

Implementation proposal: a compact append-only completion ledger keyed by project/task/event ID, with rule version, evidence reference, timestamp, provider, and whether it was imported. Replayed events do not award twice. Reopened tasks update progress; the historical record remains explainable. Importing old logs should not flood notifications.

Do not reward tokens consumed, raw chat count, time spent waiting, granting permissions, or spawning more agents. Do not equate Circle achievements with provider credits or quota resets. If provider-issued rewards are ever displayed, label their origin and keep redemption separate from local badges.

**Done when:** replay, timezone changes, reopening, cancelled work, and imported history do not inflate achievements; users can disable the entire feature.

## 6. Suggestions for every major component

The following tasks complement the detailed tasks above. Existing names and locations make them traceable without changing the current layout.

| ID / priority / size | Component and source | Suggested improvement and completion check |
|---|---|---|
| UI-01 · P1 · M | Home, `views/home.js`, `stats.mjs` | Make preferred-provider activity and “needs you” accurate. Done when a Codex-only user sees meaningful totals and no Claude setup requirement. |
| UI-02 · P1 · S | Project header, `views/project.js`, `components/permissions.js` | Show active provider, folder, and conversation consistently. Internally migrate the legacy `permissions.claude` meaning to a neutral permission with backward compatibility. Done when existing permissions survive and the label describes the actual permission. |
| WF-01 · P1 · M | Workflow, `workflow.mjs`, `graph/*`, `render.mjs` | Supply a small Codex-first starter and provider-aware model validation; retain saved graph positions. Done when a new Codex-only workflow can be created, chatted with, and exported without Claude files being required. |
| WF-02 · P1 · M | Workflow writing, `ops.mjs`, `changes.mjs` | Prefer selective updates or managed sections so writing workflow changes does not replace hand-written agent instructions. Done when unrelated instructions survive and conflicts are shown in the diff. |
| WF-03 · P2 · M | Checkpoints, versions, patterns | Distinguish workflow instructions from an actually executed scheduler; show evidence for passed gates and real handoffs only. Add version diff/restore previews and pattern compatibility labels. Done when a graph edge or elapsed time alone cannot mark a gate passed. |
| AI-01 · P1 · L | Helper, Advisor, Find skills, catalog summaries, MCP advice; `routes.workflow.mjs`, `routes.engines.mjs`, `routes.catalog.mjs`, `routes.connections.mjs` | Introduce a shared read-only/structured-task runner with provider selection, output validation, cancellation, and visible errors. Done when all five tasks work with Claude unavailable and a supported Codex configuration. |
| AI-02 · P2 · M | Reader and condense helpers, `helper.mjs`, `condenseguard.mjs`, seed hook | Keep existing Claude behavior explicitly labeled. Offer Codex-native context management or reviewed handoff summaries only after capability validation; preserve original material. Done when the UI does not promise a Claude hook works in Codex and reports measured context reductions without invented money savings. |
| SK-01 · P1 · M | Library, skill editor/importer, `skills.mjs`, `skillfind.mjs`, `render.mjs` | Add clear provider filters, import provenance/revision, duplicate detection, install scope, and support files. Add Find skills directly to Library. Done when a Codex-only skill and a shared Codex/Copilot skill install in the intended location without duplicate copies. |
| SK-02 · P2 · M | Skill updates and discovery | Preview upstream changes, flag locally modified skills, and search beyond Claude-branded collections. Done when updating a skill does not overwrite local edits without review. |
| MC-01 · P1 · L | Connections and Keys, `connections.mjs`, `mcpmanage.mjs`, `vault.mjs` | Separate “configured,” “reachable,” “authenticated,” and “available in this run.” Check effective Codex configuration; avoid rewriting unsupported TOML forms. Done when a connected-looking server that is not loaded by the chat is labeled accurately. |
| MC-02 · P2 · M | Connection repair | Add provider-specific reversible operations behind capabilities, with exact scope, backup, and retest. Keep connector credentials distinct from AI-provider sign-in. Done when a Codex change leaves other TOML settings intact and failure restores the previous configuration. |
| MD-01 · P2 · S | Mods, `views/mods.js`, `mods.mjs`, seed mods | Keep Claude-specific mods; identify engine compatibility per item and offer relevant Codex skills/plugins separately. Done when selecting Codex never attempts `claude plugin` or treats a Claude UI hook as portable. |
| AP-02 · P1 · M | Inbox, request dialogs, desktop cards | Group by project/thread, preserve request IDs, show origin and current status, and handle late replies idempotently. Done when answering on one surface clears all copies and a second click cannot execute twice. |
| AP-03 · P2 · M | Team alerts, `alerts.mjs`, Inbox | Offer desktop actions for supported team questions using the existing reviewed-file-change path. Done when unsupported file formats remain a clear “Open question” action. |
| DS-01 · P1 · M | Desktop bar, widgets, `tiles.js`, `feed.mjs`, both PowerShell scripts | Pin provider/thread per chat tile; synchronize state; use provider-aware names and limits. Done when two project widgets cannot display or reply into each other's conversation. |
| DS-02 · P2 · M | Overlay and native windows | Test mixed DPI, multiple monitors, keyboard focus, Escape, off-screen layout recovery, reduced motion, and small screens. Done when layouts remain reachable after disconnecting a monitor. |
| DS-03 · P1 · M | Terminal and editor actions, `terminal.mjs`, `ide.mjs`, overlay routes | Resolve the selected engine/thread; distinguish focusing a real running terminal from opening a new resumed session. Done when Codex Terminal does not launch Claude and concurrent writers cannot silently share one conversation. |
| NT-01 · P2 · S | Notices and reply cards, `notices.mjs`, `replies.mjs` | Use deep links to exact chats; offer quiet hours and per-event controls while preserving urgent approvals. Done when a completion notice opens its original answer and notifications remain deduplicated. |
| HL-01 · P1 · M | Health, Team, discovery, `health.mjs`, `team.mjs`, `discover.mjs` | Recognize Codex instructions/configuration alongside legacy team files. Treat missing optional Claude structures as not applicable. Done when a healthy Codex-only folder does not look broken. |
| CO-01 · P1 · M | Cost, `cost.mjs`, `pricing.mjs`, `views/cost.js` | Consider a label such as “Usage & cost”; show provider, unit, coverage, and source. Preserve subscription/API-estimate distinction. Done when token totals are not shown as a bill or used to fabricate account quota. |
| GU-01 · P2 · S | Ask Circle, command palette, `guide.mjs`, `overlay.mjs` | Retain offline help; choose the preferred available provider for AI help and describe commands by capability. Done when `/usage`, `/model`, `/resume`, and unsupported slash commands explain what they actually do. |
| UX-01 · P2 · M | Chat rendering, `views/chat.js`, `markdown.js` | Preserve scroll position while reading older messages, show a new-message indicator, and expand long tools on demand. Add copy/export and drafts. Done when streamed output does not drag a reader away from an earlier message. |
| UX-02 · P2 · M | Accessibility, tokens, charts, graph | Retain visual identity; audit focus restoration, screen-reader announcements, non-color status labels, keyboard graph actions, and both themes. Done when an approval-to-resume journey can be completed by keyboard. |
| ON-01 · P1 · M | Let's begin, engine setup, Settings | Detect existing tools, choose a preferred engine, explain sign-in status, and offer retry/diagnostics without reinstalling. Done when Codex-only onboarding reaches a usable chat and unknown authentication is not described as verified. |
| DX-01 · P2 · M | Contracts, tests, documentation | Add shared engine behavior tests plus version-specific protocol fixtures; centralize release metadata and capability text. Done when fake tests, real smoke evidence, and documentation clearly identify their different coverage. |

For Codex skills specifically, official guidance describes progressive loading of skill instructions, `.agents/skills` discovery in repository ancestors, and optional `agents/openai.yaml` metadata. Preserve supporting files and show the effective location rather than installing everything into Claude's directory. [Official skills documentation](https://learn.chatgpt.com/docs/build-skills).

## 7. RAM and performance

### What is already optimized

Keep these existing improvements: dynamic frontend view imports, transcript metadata caching, streamed JSONL reading in usage parsers, cached engine detection, slower aggregate usage refreshes, and visibility checks on several polling loops. The current code already contains these; adding them again is not a new improvement.

The repository's [historical measurements](WHAT-IS-WHERE.md) report roughly 70–77 MB server private memory and 18–43 MB widget working set after trimming, while widget committed memory stayed around 202 MB. Those measurements are from 18 October and are not fresh measurements from this review.

Windows working set means currently resident pages. Trimming it does not prove allocations disappeared; accessing removed pages can cause page faults. The current PowerShell host runs garbage collection and working-set trimming every minute. Evaluate responsiveness and private committed memory as well as the smaller visible working set. [Microsoft working-set documentation](https://learn.microsoft.com/en-us/windows/win32/memory/working-set).

### PF-01 · P1 · M — Measure the actual product footprint

Add a lightweight local Diagnostics view, collected only while open or during an explicit measurement. Include server, desktop host, owned engine children, browser impact where attributable, request counts, cache sizes, and active subscriptions. Distinguish app overhead from the engine doing work. Shared Edge processes make exact attribution imperfect; disclose that rather than assigning all Edge memory to Circle.

For the Node process, record RSS, heap, and external memory separately. Node exposes these through `process.memoryUsage()` and offers a faster RSS-only call. Buffer memory is included in external memory, so do not add overlapping fields into a total. [Node 24 process documentation](https://nodejs.org/docs/latest-v24.x/api/process.html#processmemoryusage).

**Done when:** the same documented idle/active scenarios can be compared before and after a change, with no growing process count or monotonic retained-memory growth after repeated use.

### PF-02 · P1 · M — Bound caches and update incrementally

`usage.mjs` and `cost.mjs` retain file caches without explicit eviction; the Claude history summary cache clears wholesale above its cap. Replace this with bounded entry/byte budgets and recent-use eviction. Aggregate counters rather than keeping every historical token record in memory indefinitely.

For growing logs, keep a byte offset, partial-line buffer, file identity, and cumulative counter baseline. Read only appended bytes when safe; rebuild on replacement/truncation. File notifications can trigger refreshes, with a slow reconciliation fallback. Avoid a watcher for every archived transcript.

**Done when:** repeated refreshes of unchanged histories do not reread whole logs; rotating/truncated files remain correct; memory remains bounded with thousands of sessions.

### PF-03 · P1 · M — Share work and render only changes

Use the existing event stream to invalidate relevant provider/project summaries. Deduplicate simultaneous requests from bar, widgets, Home, and Chat. Keep slow usage aggregation separate from approvals. Add single-flight guards and cancellation/generation checks to avoid overlapping polling and stale responses replacing newer selections.

Throttle chat repainting and avoid rebuilding all previous Markdown/tool nodes for every chunk. Keep polling or event connections needed for pending approvals alive even when decorative panels are hidden. Debounce editor chat-page writes and avoid rewriting the entire transcript on every small text update.

**Done when:** opening five widgets does not multiply full history scans by five; hidden panels do no decorative work; approval responsiveness remains at least as good as today.

### PF-04 · P2 · L — Consider a lighter desktop host only after measuring

First profile the existing WPF visual tree, timer callbacks, event handlers, HTTP responses, and window disposal. If PowerShell hosting remains the dominant unavoidable cost, prototype a small compiled host that preserves the same feed and appearance. Compare it with the current host using identical scenarios. A different host adds packaging and maintenance work and is not a guaranteed RAM reduction.

Do not adopt Electron solely to solve RAM usage. Do not keep a permanent Codex process alive merely to save startup time without measuring the idle cost. A bounded reusable session process with an idle timeout is an option after lifecycle correctness, with independent cancellation and strict event routing.

**Done when:** an alternative shows a reproducible improvement in private memory, startup, and interaction latency, with the existing desktop features intact. Otherwise keep the current host.

### Measurement plan for future implementation

| Scenario | Collect | Proposed acceptance rule |
|---|---|---|
| Cold launch, no engine running | Ready time, process count, RSS/private bytes | Compare against a repeatable baseline; no provider model calls during startup |
| Idle app and six widgets for 30 minutes | CPU, memory trend, requests, bytes read | Stable retained memory and no growing child-process count |
| Open/close bar and chat 100 times | Timers, listeners, handles, draft state | Resources return close to the settled baseline; drafts survive |
| One and several active agent turns | App overhead vs engine memory, time to first visible text | Limits on concurrency; no cross-thread event routing |
| 1,000 chats and a large transcript | Page latency, peak memory, bytes read | Paged UI and bounded memory; no full reread on an unchanged refresh |
| Pending approval with all windows hidden | Delivery and reply latency | No lost request or optimization-induced delay regression |

Set numerical budgets from these measurements on a named machine. A blanket “under 50 MB” promise would be unsupported today.

## 8. Storage and retention

Read-only local size snapshot, rounded binary MiB; these are logical file sizes, not compressed download size or installed runtime memory:

| Folder | Files | MiB |
|---|---:|---:|
| `backend` | 106 | 0.83 |
| `frontend` | 69 | 0.67 |
| `scripts` | 11 | 0.18 |
| `tests` | 102 | 3.30 |
| `docs` | 10 | 0.22 |
| `contracts` | 1 | 0.02 |
| `data` | 45 | 0.40 |
| `.git` | 859 | 2.76 |

These selected folders exclude other root files and external Node/engine installations. They do not measure the user's Codex or Claude history directories. Runtime source size is already small; long-term history, backups, duplicated exports, and distribution dependencies deserve more attention than source minification.

| Task | Proposal | Completion check |
|---|---|---|
| ST-01 · P1 · M | Add a Storage page showing Circle chats, indexes/cache, exports, backups, skills, and logs separately. Show provider-owned history as an external location only when requested. | Clear attribution of what Circle owns; never imply external provider logs are disposable cache. |
| ST-02 · P1 · M | Publish retention rules: chats durable by default; caches rebuildable; logs rotated by age/bytes; archive completed Inbox records; retain pinned workflow versions. | Cleanup previews category, size, and effect; pending approvals and active chats are excluded. |
| ST-03 · P1 · L | Add export and backup/restore for chats, project registry, workflows, templates, skills, and settings. Keep provider authentication out of exports. Handle vault portability explicitly. | Restore into an isolated folder, verify integrity, and report connector keys that must be re-entered for another Windows account. |
| ST-04 · P2 · M | Separate installed code from mutable data for an installer distribution, retaining an explicit portable mode. Use a versioned, recoverable migration from existing `data/`. | Upgrades and uninstall preserve user data according to the shown choice; old installs are discovered. |
| ST-05 · P2 · M | Keep normalized history metadata and offsets rather than complete duplicate provider logs. Add a local search index only when needed. | Search and paging remain fast; the index can be rebuilt without losing user annotations or Circle-only chats. |

The existing app already caps notices at 60, Inbox records at 1,000 per project, and active chat records at 200 messages. These limits need a visible retention/archive policy, rather than just raising caps. Atomic JSON files remain reasonable for small settings. Consider a transactional local index only if measured history scale justifies it; migrating every file to a database is unnecessary.

## 9. Easier downloads, installation, and updates

The current installer checks for Node 24 and opens its download page if missing. Git clones can update through the app; ZIP installs require manual replacement and data copying. Those are concrete friction points in [README](README.md), [installer](Install%20Circle%20Studio.cmd), and [updater](backend/lib/updater.mjs).

GitHub Releases can distribute tagged versions, notes, and binary assets. Use that for a clear, tested download rather than making the moving source-branch ZIP the main end-user option. [GitHub release documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

| Task | Suggested approach | Completion check |
|---|---|---|
| DL-01 · P1 · M | Publish one recommended Windows installer, a portable ZIP, and a separate source/developer route. Show version, supported Windows versions/architecture, size, and release notes. | A new user can identify the right file without understanding Git. |
| DL-02 · P1 · L | Provide Node through a deliberate packaging choice: bundle a supported runtime, or offer a guided prerequisite installer. Install only the AI tools the user chooses. | Works on a clean Windows account without Node, npm, Git, or pre-existing engine PATH entries; handles cancellation and offline failure. |
| DL-03 · P1 · L | Support updates for non-Git installs: staged download, integrity/authenticity verification, versioned replacement, data preservation, failure rollback, and deferred restart during work. | A portable/installed copy upgrades without manual data copying; interrupted download or failed launch leaves a working previous version. |
| DL-04 · P2 · M | Sign distributed executables/installers and publish checksums, license notices, and build provenance. Define release/stable channel metadata. | The artifact matches its version and verification metadata; checksum alone is not described as proof of publisher identity. |
| DL-05 · P2 · M | Add uninstall/repair entries and an optional package-manager channel once the installer is stable. | Repair restores application files without removing chats; uninstall asks separately about user data. |
| DL-06 · P1 · S | Use one release identity across package metadata, What's new, download page, and update feed. | Version labels and the actual downloaded artifact agree. |

MSIX with App Installer is one later distribution option with automatic update/repair support, subject to OS version and packaging constraints. Assess it against the hotkey, background host, shortcuts, and data-location requirements before adopting it. It is an option, not a prerequisite for Codex support. [Microsoft App Installer guidance](https://learn.microsoft.com/en-us/windows/msix/app-installer/auto-update-and-repair--overview).

Exclude tests, research notes, browser recordings, `.git`, and personal data from an end-user runtime package while keeping required seeds, scripts, contracts, notices, and licenses. Keep the complete source distribution available separately. Benchmark compressed sizes before choosing a packaging technology.

## 10. Existing backlog: how to carry it forward

The task notes live mainly in `WHAT-IS-WHERE.md` sections 14–15 and the decisions/spec documents. There is no tracked `docs/tasks` board for Circle Studio itself; references to `BOARD.md`/`ALERTS.md` describe files in managed projects.

| Existing item | Recommendation |
|---|---|
| Many “Try v17.x” entries | Consolidate into a regression checklist: bar, terminal, questions, notifications, widgets, queue, limits, and restart. Preserve historical evidence without treating every old try-it entry as a new feature. |
| Finish real Codex verification | Promote to the first release gate; current code still labels it unverified. Old sign-out observations are not evidence of current account state. |
| Main/master publishing and website deployment | Recheck current repository/remote state during future release work. Do not execute old branch/merge/push recipes based on historical notes. The website is outside this repository and was not inspected here. |
| Terminal approvals and questions | Add provider-specific verification. Existing Claude terminal hooks are not a Codex integration mechanism. |
| Sample project's condensation and connector cleanup | Keep as optional project-specific work, separate from general product tasks. Do not modify real projects to test a release. |
| Lighter desktop host | Retain as PF-04, after measurement. |
| Voice | P3: optional Windows dictation/read-aloud investigation. Confirm supported local OS behavior and provide a text fallback; no need to add paid speech infrastructure for the current objective. |
| Sign-in within the app | Keep the reliable engine-owned sign-in first. An embedded terminal adds input, resizing, process, and packaging complexity; only build it if onboarding evidence justifies it. |

Documentation also needs reconciliation later: the spec introduction mentions 46 routes while the current contract contains 111; it says 30-second engine detection caching while the registry uses 60 seconds. `package.json` is 1.2.0 while the feature notes use v17.x and a date-based What's new identity. These do not necessarily break the app, but make support and releases harder to understand.

## 11. Suggested delivery sequence and definition of done

| Delivery | Tasks | Dependency / exit condition |
|---|---|---|
| A — Trustworthy Codex execution | CX-01–04, US-01, focused approval/lifecycle fixtures | Supported protocol and honest permissions; no wrong-engine sends or indefinitely stuck exited turns. |
| B — Durable conversations | CH-01–04, CX-05–06, DS-01/03, AP-01/02 | Stable thread identity and preserved history before sharing it across all surfaces. |
| C — Useful Codex dashboard | US-02–04, UI-01/02, HL-01, CO-01, ON-01 | Codex-only account sees accurate usage, activity, setup state, and limits. |
| D — Complete provider parity | AI-01, WF-01/02, SK-01, MC-01 | Helpers and workflows work without a hidden Claude prerequisite. |
| E — Efficient daily use and distribution | PF-01–03, ST-01–04, DL-01–03/06 | Measured resource improvements and clean-machine installation/update with preserved data. |
| F — Optional refinement | Remaining P2/P3 tasks, TK-02/03, PF-04 | Add after the core experience is reliable; achievements depend on TK-01 and durable completion evidence. |

For each future implementation task: record the behavior being changed, implement the narrowest shared fix, preserve existing data, verify its acceptance condition, and then update relevant help/spec/release notes. This document itself authorizes no implementation or release operation.

Before calling Codex support complete, check:

- [ ] Codex-only setup works with Claude absent.
- [ ] Selected provider, project, conversation, and effective model agree across Chat, bar, widgets, cards, and terminal actions.
- [ ] Existing local Codex chats can be read and deliberately continued without starting an unintended turn.
- [ ] New chat, archive, restart, export, and migration preserve recoverable conversation history.
- [ ] Approvals/questions reach the right surface; deny, cancel, late answer, and duplicate click behave correctly.
- [ ] Permission claims are backed by real supported-version behavior, including resumed threads.
- [ ] Engine crashes, sign-out, disconnects, unsupported RPCs, and long turns reach an honest recoverable state.
- [ ] Account quotas, context usage, token counts, estimates, and missing values remain distinct.
- [ ] Provider/profile switching cannot display another account's cached limits as current.
- [ ] Usage aggregation handles cumulative counters and does not double-count the same work.
- [ ] A real temporary-folder Codex smoke run is recorded with CLI version and actual outcomes; fake-protocol tests remain labeled as such.
- [ ] Existing Claude/Copilot behavior is checked for regressions; unsupported capabilities remain explicit.
- [ ] RAM/CPU/storage claims include the scenario and measurement method.
- [ ] The distributed installer and updater are tested on a clean Windows account, including failed updates and restoration.

No code, settings, existing documentation, project data, provider configuration, or Git history was changed as part of this review.
