# Circle Studio 1.3.2 verification

Verified on Windows x64 with Node 24.13.1, 2026-10-27.

Changes:

- Desktop HTTP polling uses .NET tasks instead of waiting on the WPF dispatcher. Each channel permits one batch in flight. Temporary feed failures retain existing tiles. Overlay fetches no longer accumulate when a response stalls.
- Browser event connections detect missing heartbeats after suspend, reconnect on network recovery, and replace pending approvals with a current server snapshot. Closing the connection removes timers and listeners. Ordinary API calls have bounded waits.
- Shortcut/background launches use a companion supervisor that logs exits and restarts crashed servers with backoff. Explicit Stop revokes its recovery token. Static file read errors no longer escape as unhandled stream errors.
- Codex terminal PermissionRequest hooks can be installed from Settings or `node scripts/circle.mjs hooks --engine codex --on`. Existing hooks are preserved and existing settings are backed up. Hook requests retain Codex identity through the Inbox and return the exact decision. Codex must be restarted and the hook reviewed/trusted through `/hooks`; installation alone does not authorize it.

Verification:

| Check | Result |
| --- | --- |
| Full automated suite | 329 passed, 3 skipped, 0 failed; `tests/test-run-sleep-final.log` |
| Forced server termination | Supervisor recovered with a new server PID; explicit Stop prevented resurrection |
| Simulated browser suspend | Missing heartbeat aborted the stale reader; online recovery reconnected; close removed watchers |
| Native stalled HTTP | 101 polls completed in 36 ms with one request pending; completion and simulated resume consumed/started the expected batches |
| Codex terminal hook | Exact Allow, Deny and terminal fallback; unrelated hooks preserved; backup and removal verified |
| Native WPF cards | Allow, Deny, option and typed answers reached the fake Codex adapter and original saved conversation |
| Browser settings | Setup preview and temporary hook installation checked; no browser JavaScript errors |
| Windows toast | Native submission succeeded; Notification Center contained the Codex test entry; notifier Enabled |
| Two-minute isolated soak | 54 requests from six clients, 9 samples; stable 3 listeners, 0 pending waiters, 0 provider children; RSS 73.2 to 69.9 MiB; maximum six-request batch 35 ms |
| Storage workload | 100 page opens across a 1,000-chat index and 20,000-message transcript in 73 ms |
| Release | ZIP checksum, manifest, staged installation and isolated bundled-runtime launch passed |

Final archive: `release/final-1.3.2-2026-10-27/circle-studio-1.3.2-windows-x64.zip`.

SHA-256: `997ea0e55731d044461fd23e9d0d3c7a9004dbe6dc9decb30244d2a92038e5de`.

Native screenshots and measurements: `tests/e2e/shots/sleep-2026-10-27/`.
Release installation report: `release/final-1.3.2-2026-10-27/verification.json`.

The live source installation was restarted while idle and reports current code. Its Codex terminal bridge is installed, pending the user's Codex hook trust review. Existing projects and chats were not used as test fixtures.

Limits: suspend was simulated; this did not put the user's PC to sleep. Native card and hook tests used fake engines, not paid model calls. Notification Center presence does not prove a visible banner. The short soak and storage workload are limited scenarios, not a whole-product memory or long-term stability guarantee. The package is unsigned. Completion notifications for independently launched Codex sessions are not implemented by the PermissionRequest bridge.

Official hook behavior and trust requirements: https://learn.chatgpt.com/docs/hooks
