# Codex notifications — 23 October 2026

**24 October follow-up:** the sender now loads the WinRT toast type explicitly and awaits actual helper completion.
One matching test toast was verified in Windows Notification Center, and real native Allow/Deny/option/typed-answer
controls reached the fake Codex adapter. See [current acceptance evidence](acceptance-2026-10-24.md). The statements
below describe the earlier pass; banner visibility remains unconfirmed.

Scope: chats started inside Circle Studio. External Codex terminal and desktop-app events do not enter Circle's broker.

Reproduced causes: completion was gated at 20 seconds; browser completion notices were not delivered through the
desktop-alert helper; a connected browser with denied/default permission suppressed the native fallback.
Completion now records every finished run, links its exact saved conversation, and deduplicates by run ID. Browser
notification permission is advertised on the event connection. A non-notifying browser permits the Windows fallback.
Completion/update preferences and quiet hours remain respected; urgent request/error handling remains separate.

`tests/integration/codex-notifications.test.mjs` passed quick fake-Codex completion, approval denial, browser-denied
native fallback, exact conversation identity, and completion-off audit preservation. Settings has an explicit test
button that submits no model turn. The isolated demo intentionally has a fake native service: its button correctly
reports inability to submit an OS notification. This is not evidence of a Windows delivery failure.

A separately approved labeled dummy native toast returned `requested: true`. WinRT's notifier setting returned
`Enabled`. Submission and enabled status do not establish that a toast was visually displayed. Windows notification
status is documented by [Microsoft ToastNotifier.Setting](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotifier.setting?view=winrt-26100).
