# Circle Studio: rules for whoever works on it

**Read `WHAT-IS-WHERE.md` first, every time.** It is the map of what is built and where it lives, the current state
(git, what is on this PC, the human's to-do list), the known limits, facts learned by running things, and every request
and where it went. **Keep it true:** whenever you add, move, rename or remove a feature or file, change a limit, learn
a fact the hard way, or the state changes (tests count, git, what the human still has to do), update the matching
section of `WHAT-IS-WHERE.md` in the same piece of work, before your final report. Correct anything in it you find to be
wrong; never leave it describing something that is no longer so.

`docs/spec.md` is how it is built and what is fixed. `docs/original-prompt.md` is the human's own words (highest
authority); `docs/decisions.md` records every departure from them. `docs/research/` holds facts with provenance:
re-check them only by running things, not by re-researching.

## Hard rules

1. **Single user, this Windows PC, local only.** Bind `127.0.0.1`. No sign-in, accounts, hosting or telemetry.
2. **No API key, ever.** Never read, store or pass one; `cleanEnv()` for every child; never `--bare`.
3. **The human does git.** Do not run `git init/add/commit/push` here or in a project. Read-only git is fine.
4. **Diff first** for every write the app itself makes into a project (`changes.preview` then `changes.apply`, or the
   new-project file preview). The app's own `data/` folder is free.
5. **Agents ask first.** Chat is a real agent session in the project folder with a shell, and every command, edit and
   question is a request the human answers (popup plus Inbox). `backend/lib/policy.mjs` refuses dangerous requests and
   marks anything outside the project; Bash is not sandboxed on Windows, so that policy is the guard. Keep it strict and
   tested. Claude is told to send every Bash and edit to the app (`permissions.ask`), because it would otherwise run
   read-only commands such as `cat` on its own.
6. **Nothing depends on another folder.** No template folder, no reference project, no reserved ids. Templates live in
   `data/templates`; one is seeded once from `backend/seed/`. A template import reads one `workflow.json` and nothing else.
7. **Secrets are never echoed** in any response, diff, popup, log or error (`secrets.redact`).
8. **Design values only from `tokens.css`**; light and dark; every action reachable by keyboard; no inline script or
   style (CSP). Node 24 built-ins only; never spawn through a shell.
9. **Never touch the human's real projects or the running instance's `data/` in tests.** Use temp folders, a private
   port and the fake CLIs. The frontend only runs in a browser, so `tests/unit/frontend-syntax.test.mjs` parses every
   module; also look at changes in a real browser (light and dark, about 1280 and 700 px wide).

## How to work

Usage matters to the human: do not redo research, do not re-read large docs, build and check by running. Windows first:
`cmd`/PowerShell/Git Bash, CRLF files exist, paths have spaces, `taskkill /T /F` to stop a process tree. Finish with an
honest report: what works (with the commands you ran), what does not, what you skipped, what you deleted. Before that
report, update `WHAT-IS-WHERE.md` (sections 2 to 6 for files and features, 12 for the version log, 13 and 14 for the
state and the human's to-do list, 15 for limits, 16 for facts learned, 17 for the requests table).
