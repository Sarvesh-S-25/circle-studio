# Build connections and evidence

Implementation ledger for `definitions.md`, updated 2026-10-24, version 1.3.1. The definitions document preserves the original review;
this file records current implementation, verified scope and remaining acceptance gates.

## Authorization and boundaries

- The user authorized roadmap implementation, dummy-engine/browser/native testing and measured resource optimization.
- The user handles Git branch creation, commits and pushing. No Git mutations were performed in this repository.
- Preserve the current visual design, localhost binding, CLI sign-ins and Node-built-ins architecture.
- Tests use isolated data/fake engines/temporary projects. Real Codex probes below were separately authorized.
- Signing, publishing and hardware/account acceptance require real evidence; local fixtures do not establish them.

## Current result

The local implementation covers the roadmap features below. Final regression: **329 tests, 326 passed, 3 skipped,
0 failed**. The skipped cases require an optional reference folder. No universal claim of live provider or OS acceptance.

Codex notification faults were reproduced and corrected: short-run suppression, missing browser completion delivery,
and denied/default browser permission suppressing native fallback. Exact saved-chat notices now retain run identity.
Settings has a no-model-call notification test. This covers Circle-started Codex chats; independent Codex terminal/app
events are outside the integration. The corrected sender produced a matching Windows Notification Center entry on this
PC. Actual native WPF Allow/Deny/option/typed-answer handlers all reached fake Codex successfully. Banner visibility
has not been confirmed by the user. Full evidence: [24 October acceptance](docs/research/acceptance-2026-10-24.md).

Terminal now captures the displayed saved conversation UUID and reasoning. Pending Codex copies get an independent
provider fork before Terminal opens, preserving the original and other active selections. Failed sends retain a draft.
Real CLI 0.164.0 adapter → CLI resume → adapter and independent fork/readback passed. The user's exact thread-error
text was requested but has not been supplied; that exact error did not reproduce and is not claimed resolved.

## Roadmap implementation ledger

| Tasks | Local implementation | Verification / scope |
|---|---|---|
| CX-01–04 | Codex protocol/lifecycle handling, explicit provider/model selection, graceful interrupt with tree-kill fallback | CLI 0.163.0 scoped real temporary-folder read/edit/command/resume/deny/interrupt evidence; fake exits/deadlines/stderr tests. Live fork/additional request categories remain acceptance gates. |
| CX-05–06 | Dynamic models/reasoning, visible capabilities, bounded command output and request resolution | Adapter/contract/integration checks; browser fake model and reasoning persistence. Unsupported request categories refuse rather than consent. |
| CH-01–04 | Durable conversations/indexes, archive/read/select/export, provider copies, paged history, captured persistent queue/recovery | Fake/browser history and restart checks; failed persistence retains checkpoint and suppresses queued advancement. Exact saved-chat targets cross main/node/widget paths. |
| US-01–04 | Provider/profile-separated limits with stale/unknown states; daily cumulative-counter deltas; all-conversation usage and truthful outcomes | Unit/integration fixtures plus real read-only Codex account limits query. Usage is observation, not billing. |
| TK-01–03 | Tasks, dependencies, typed acceptance evidence/references, board import, opt-in idempotent local achievements | Fake/browser accepted task evidence; reopened prerequisite invalidates dependent acceptance. No spending-based awards. |
| UI-01–02 | Dashboard totals include saved Codex conversations; neutral permission migration; provider/model header | Regression and fake/browser checks; explicit selections retained even if not advertised. |
| WF-01–03 | Codex-first starter, managed instruction sections, preserved positions, detailed version comparisons/restore/pins, compatibility labels | Unit/integration fixtures; reviewed handoff records keep source evidence. Graph edges alone do not establish execution or passed gates. |
| AI-01–02 | Shared provider-selected validated runner across five advice tasks; reviewed editable context handoff drafts | Claude-absent fixtures. Handoff preserves original and prepares a new draft without a model turn; character sizes do not imply token or money savings. Claude condense hooks remain labeled. |
| SK-01–02 | Codex/shared partitions, official collection discovery, scope/provenance/support files, exact-byte update previews | Offline GitHub/blob-integrity/local-change fixtures; no unreviewed overwrite. |
| MC-01–02 | Effective configured/reachable/authenticated/run states; reviewed managed Codex TOML changes; backup/retest rollback | Real read-only effective-config query; failed-probe fixture restores exact original. Intervening changes block unsafe rollback. |
| MD-01 | Claude-only mods labeled, Codex users directed to compatible Library skills | Regression fixtures; no Claude plugin invocation for Codex items. |
| AP-01–03 | Canonical IDs/status/late-answer refusal; completed audit archives; native supported team-question review/apply | HTTP/unit fixtures and actual dummy WPF reviewed answer application. Unsupported formats retain Open question. |
| DS-01–03 | Independent provider/node/conversation UUID pins, captured model/reasoning/send identity, shared unique window keys, off-screen recovery | Product/overlay/window identity fixtures; native dark/light cards and primary-monitor recovery. Physical mixed-DPI/multi-monitor/focus acceptance remains. |
| NT-01 | Exact-chat completion cards, short Codex notices, permission-aware native fallback, preferences/quiet hours and test button | Dedicated quick-Codex/denial/fallback/control regression. Real toast requested; visible delivery unconfirmed. External Codex apps are not observed. |
| HL-01, CO-01, GU-01 | Codex instruction/config health, provider-aware commands/help and Usage & cost labeling | Unit/integration checks; estimates remain provider-specific and missing readings stay unknown. |
| UX-01–02, ON-01 | Scoped drafts, editable queue, paged/exportable history, non-forced scroll/latest marker, honest unknown sign-in state | Fake/browser checks, light/dark narrow/wide review; Settings long-path wrapping fixed. 100 panel lifecycles retain no chat timers/listeners. |
| PF-01–04 | Bounded page/index/offset caches, byte-range transcript paging, incremental tokens, concurrent-query sharing, explicit process sampling and disposal | Isolated history comparison and completed 30-minute soak below. No unmeasured desktop-host replacement or whole-product RAM claim. |
| ST-01–05 | Storage attribution, retention controls, generated-only cleanup preview, checksummed backup/isolated restore, streamed downloads, durable metadata/offsets | 13-entry browser backup/download/restore integrity checks; pending approvals/chats/provider histories excluded from cleanup. |
| DL-01–06 | Verified Node runtime ZIP, portable/per-user code-data separation, staged release updater, archive/manifest checks, launch probe, repair/uninstall and generated download metadata | Actual artifact stage/launch and installer/failed-update fixtures. Unsigned and unpublished; certificate/website/clean-account steps remain external. Optional package-manager channel deferred until installer acceptance. |
| DX-01 | Extended contracts/regressions, spec/decisions/help/news/README/map, reproducible dummy/native/performance/release tools | Latest counts and artifact evidence recorded here; no Git changes committed or pushed. |

## Verification record

| Check | Result |
|---|---|
| Initial read-only Git status | Only untracked definitions.md, no tracked modifications. |
| Baseline | 303 tests: 300 passed, 3 skipped. Sandbox child spawning failed EPERM; authorized unsandboxed run passed. |
| Final full npm test | 329 tests: 326 passed, 3 skipped, 0 failed, about 19 seconds (1.3.1). |
| Contrast | 104 required pairs passed in each theme. |
| Browser | Isolated demo on 127.0.0.1:4397; fake model/reasoning/history/approval/task flows. Reviewed handoff saved as draft. Settings test correctly reports fake native service cannot submit. Fresh light/dark 700px and 1280px bounds checked without page overflow. |
| Component lifecycle | tests/e2e/component-soak.js: 100 node-chat open/close cycles, zero retained intervals and zero retained chat listeners, including immediate-close import races. |
| Browser backup download | Completed, 93,078 bytes, 13 entries, recorded by Browser.downloadProgress on the streamed backend; every decoded entry SHA-256 verified. Raw report: tests/e2e/shots/browser-download-events.json. |
| Backup restore | Dummy JSON preview and verified restore of 13 files into a separate temporary data folder; entry hashes checked. |
| Native WPF | tests/e2e/native-smoke.ps1: actual dark/light rendered team cards, reviewed answer applied, simulated off-screen position recovered. Own dummy project/process only; no global typing or user-screen capture. |
| Native Codex answer controls | tests/e2e/native-notification-smoke.ps1: Allow, Deny, Blue and a typed answer sent by real WPF handlers; API audit and fake Codex output verified. Final harness exit zero. |
| Windows notification | Corrected sender returned true after helper completion; Notification Center contained one matching Circle test entry. Previous check had zero. Notifier Enabled; no banner-seen claim. |
| Terminal return / provider copy | Real Codex 0.164.0 sequential adapter/CLI/adapter markers passed, fork history readable; exact saved-target integration and browser capture passed; browser-injected error preserved draft. |
| Release staging | Real bundled runtime ZIP checksum/manifest/staging plus private-data health launch passed with scripts/verify-release.mjs; no shortcuts/registry writes. |
| Physical hardware / clean account / signing | Not performed. |

## Resource measurements

Reproducible evidence: [memory record](docs/research/memory-2026-10-23.md).

- A 20,000-message/1,000-conversation synthetic paging comparison measured peak RSS 163,426,304 → 110,968,832 bytes
  (about 32% lower), settled RSS 137,371,648 → 109,072,384 bytes, and approximately 99% fewer bytes read. This measures
  the storage workload, excluding browser, WPF and providers; it is not a total-app RAM promise.
- The six-client HTTP soak completed 1,800 seconds, 121 samples and 726 requests. RSS ranged 77,836,288–94,638,080 bytes;
  first/last samples were 83,525,632/89,583,616. Listener count stayed three and engine children stayed zero. Heap varies
  with GC. Raw report: tests/e2e/shots/perf-soak.json. It does not simulate six actual browser/WPF visual trees.
- Native smoke rendering used about 227 MB private / 265 MB resident including PowerShell compiler/WPF and rendered
  bitmaps; it is not an idle-host measurement. No universal native-memory reduction is claimed.

## Real Codex evidence

Separately approved `node scripts/codex-smoke.mjs --real` used a new temporary project and existing CLI sign-in.
CLI 0.163.0 read/command/resume/deny/outside-read denial/interrupt checks passed. Initial shell-write did not create a
file and was not counted as an edit success. Approved native apply_patch follow-up created result.txt with the exact
expected text, then read it back. Queries returned models, a fixture thread/messages, account limits and configured MCP.
Detailed scope: [Codex acceptance record](docs/research/codex-2026-10-22.md).

Notification evidence: [notification record](docs/research/notifications-2026-10-23.md). WinRT notifier status was Enabled;
the approved labeled dummy toast returned requested:true. Neither fact proves visible delivery. No external terminal/app
hook is implemented or claimed.

## Artifact and remaining release gates

Current output folder: `release/final-1.3.1/` (version 1.3.1). The final rebuild manifest/checksum and isolated launch report
in that folder are authoritative. Older release folders are stale development snapshots. Outputs are Git-ignored.

**Current 1.3.1 runtime ZIP:** 35,786,232 bytes / 212 entries, bundled checksum-verified Node 24.13.1. SHA-256:
`ecb1d68bfdf77509e179934b748e838b1f8367182702576929b6a21a26c129ec`.
Final 1.3.1 artifact staging and isolated health launch passed; `release/final-1.3.1/verification.json` records the result.
The running app at port 4380 reported version 1.3.1 with zero busy work and no stale code during the acceptance pass;
it has automatic idle restart enabled. Dummy QA browsers/server were closed after the checks. No real project was modified.
After the last source change, the live instance's idle auto-restart loaded current code; the guarded restart check
reported it was already current. No active work was stopped. Version 1.3.1 / stale:false / busy:0 confirmed afterward.

Previous 1.3.0 runtime ZIP: **35,785,338 bytes / 212 entries**, bundled Node 24.13.1 verified against its official
checksum, complete runtime license included. SHA-256: `6b3d6a717107ec47c0e8bba8369bf70816eae743d18591f05ff49bb925a808a1`.
`release-info.json` and `DOWNLOAD.md` contain matching download identity. Artifact remains unsigned and unpublished.
The previous artifact staging/isolated launch passed. Removed six explicitly scoped obsolete
generated extraction/staging folders under release, freeing 535.2 MiB. Old ZIP snapshots and the final verification
workspace remain. Closed the four active roadmap QA browser sessions and stopped the isolated demo; real application
data/server were not touched. Restart the real application into this code to load notification fixes.

Still requires external acceptance/setup:

- Authenticode certificate/signing and actual GitHub release asset publication.
- Separate download website location/access; use generated release-info.json and DOWNLOAD.md for a single identity.
- Clean Windows account installation, shortcuts/repair/uninstall and offline/cancellation acceptance.
- Physical mixed-DPI/multi-monitor/focus and visible banner acceptance (Notification Center delivery is now verified).
- Additional real Codex fork/question/request categories before expanding supported live claims.
- User branch/commit/push. No Git mutations were performed by the agent.
