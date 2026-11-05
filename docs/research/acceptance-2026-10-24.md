# Native notifications and terminal return — 24 October 2026

Requested: test notification answering on this PC, investigate the reported terminal/chat thread error, and deliver a
final version. Version 1.3.1 distinguishes these fixes from the previous 1.3.0 package. No Git mutations were performed.

## Verified on this PC

- `tests/e2e/native-notification-smoke.ps1` displayed the real WPF Codex request/completion cards against a private
  circle-demo temporary project. Actual native button handlers sent Allow, Deny, Blue, and a typed
  CIRCLE_NATIVE_TYPED_OK answer. HTTP audit status and the fake Codex adapter output confirmed all four responses.
  Screenshots render only the test's own visual tree. No global keyboard injection or real-project writes.
- The initial harness queried only pending requests when waiting for a resolved audit record. Corrected it to all
  statuses. Its WPF test host now exits explicitly after assertions, window closure and mutex disposal; final exit zero.
- The running real app's notification-test endpoint accepted a labeled test. The earlier sender returned true as soon
  as it spawned PowerShell and ignored actual failure. The corrected sender loads the ToastNotification WinRT type
  explicitly, checks Enabled status, sets a CircleStudio group, and awaits helper completion with an eight-second bound.
  The Settings test awaits the asynchronous outcome; a regression fixture verifies false does not become a truthy Promise.
- After the corrected sender ran, Windows Notification Center contained one matching Circle test notification, with
  notifier status Enabled. The preceding query found zero. This confirms Notification Center delivery for that test,
  not that a banner was visually seen. No other notifications were printed or removed.

## Terminal findings and changes

This PC has Codex CLI 0.164.0. `scripts/codex-terminal-smoke.mjs --real` uses three small signed-in turns in a new
temporary folder, with no tools/file changes: Circle adapter → codex exec resume → Circle adapter. All three returned
their exact markers, and the returned provider ID remained stable. The final adapter also created an independent
provider fork and read its inherited history successfully. Raw report: tests/e2e/shots/codex-terminal-roundtrip.json.

Found a separate reproducible targeting bug: the browser Terminal action omitted its displayed Circle UUID, and the
backend resumed whichever conversation was active instead. The action now captures that UUID and reasoning choice;
scoped reads resolve its provider ID without changing another active selection. A pending Codex copy materializes its
provider fork before Terminal opens, preserving the original. Invalid/missing records cannot silently open another chat.
Integration and actual browser request capture verify this. Codex fork writes are not shared as read-only queries.

Resume/fork now request excludeTurns to avoid loading entire paginated histories. This follows the
[official App Server continuation guidance](https://learn.chatgpt.com/docs/app-server).
Saved-chat errors restore the sent text as a draft if no newer draft exists. A browser-injected dummy thread-move error
verified the visible error and recovered input; it made no model call and does not reproduce the user's upstream error.

The user's exact thread-error text has not been supplied. No matching thread error was found in current Circle active
chat records, and the real round-trip did not reproduce it. The targeting defects are fixed; the exact reported error
remains unconfirmed. Two simultaneously active interactive writers were not included in the successful sequential check.

## Sources and limits

Microsoft documents that desktop toasts need a valid registered AppUserModelID and describes notification history:
[desktop toast requirements](https://learn.microsoft.com/en-us/windows/win32/shell/quickstart-sending-desktop-toast),
[ToastNotificationHistory](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.toastnotificationhistory).
The sender uses the installed PowerShell AppUserModelID, confirmed through Get-StartApps on this PC. Independent Codex
terminal/desktop-app notifications do not enter Circle's broker. Native answering evidence uses fake Codex; real CLI
evidence is the scoped resume/fork test above. Signing/publication and physical mixed-DPI acceptance remain separate.
