# Importing skills from GitHub: what the real repositories look like

**Provenance.** The research agent probed the real GitHub API unauthenticated from this machine on
2026-09-29 and analysed the recursive trees and the front matter of **2,488 `SKILL.md` files**
(2,031 real files, the rest are symlink phantoms) in these public repositories: `anthropics/skills`,
`openai/skills`, `obra/superpowers`, `hashicorp/agent-skills`, `NVIDIA/skills`,
`ComposioHQ/awesome-claude-skills`, `alirezarezvani/claude-skills`, `glebis/claude-skills`,
`wshobson/agents`, `K-Dense-AI/scientific-agent-skills`, `netresearch/skill-repo-skill`,
`mikekelly/managing-skills`, plus `microsoft/vscode` for slashed-ref behaviour. The run was stopped
before its verification phase and before fixtures were saved, so the raw data lives only in the
agent's scratch folder (`.../scratchpad/gh`, `.../scratchpad/ghskills`); nothing here was
independently re-run. The statistics below were re-computed once from the agent's saved
`all_fm.json` while writing this file. **Fixtures to create during the build:** trimmed tree JSON
for `anthropics/skills` and 6-8 real `SKILL.md` heads (offline tests).

## 1. API behaviour (unauthenticated)

| Topic | Result |
|---|---|
| Rate limit | **60 requests/hour** per IP (`x-ratelimit-limit: 60`, `-remaining`, `-reset` epoch on every response; authenticated: 5,000/h). `raw.githubusercontent.com` requests are not part of the API count. A `GITHUB_TOKEN` from the environment may be used (never stored). Secondary limits (documented): max 100 concurrent requests, 900 points/min per endpoint. |
| Repo metadata | `GET /repos/{o}/{r}` gives `default_branch`, `private`, `archived`, `size` (KB), `license`. |
| Whole tree in one call | `GET /repos/{o}/{r}/git/trees/{ref}?recursive=1` (ref = branch, tag or commit sha). Response entries: `path, mode, type (blob|tree), sha, size (blobs), url`; top-level `sha, tree, truncated`. `truncated` was `false` for every repo probed, even 7,532 entries / 2 MB decoded (gzip'd on the wire). Still check it; if `true`, fall back to per-directory trees. |
| Sub-tree | `git/trees/main:skills` (colon unencoded or `%3A`) returns just that directory. |
| Conditional requests | `ETag` on trees; `If-None-Match` returns `304` with an empty body. |
| Slashed refs | `git/trees/release/1.140` and `git/trees/release%2F1.140` both work (`microsoft/vscode`); `raw.githubusercontent.com/{o}/{r}/release/1.140/path`, `.../refs/heads/release/1.140/path` and `%2F` all work. So `/tree/<ref>/<subpath>` URLs are ambiguous: try the first segment as the ref, then two, then three, stopping at the first 200. |
| Raw files | `https://raw.githubusercontent.com/{o}/{r}/{ref}/{path}` returns the exact bytes (`text/plain`); `Range` requests work (`206`). Binary files must be read with `arrayBuffer()`, never decoded as text. |
| Renamed repo | `GET /repos/old/name` returns **301** with `location: https://api.github.com/repositories/<id>` and a JSON body; follow it (same host only). Raw URLs under the old name kept working. |
| Errors | Unknown repo, unknown ref, unknown sub-path and a **private repo** all return `404 {"message":"Not Found","documentation_url":...,"status":"404"}` (indistinguishable: say "not found or private"). Code search (`/search/code`) returns **401** unauthenticated, so the app must be URL-driven. Rate-limit exhaustion is `403`/`429` with `x-ratelimit-remaining: 0` **[documented, not forced]**. |
| Cost of a scan | 2 API calls (repo metadata + recursive tree), plus one raw fetch per `SKILL.md` to read its name and description (not counted against the API limit). |

## 2. What is in a repository

Across the 12 repos: **2,489 skill directories** (a directory containing `SKILL.md`), 2,031 with at
least one regular file.

| Measure | p50 | p90 | p99 | max |
|---|---|---|---|---|
| files per skill | 2 | 12 | 55 | 312 (`openai/skills` cloudflare-deploy) |
| bytes per skill | 10 KB | 107 KB | 680 KB | 5.55 MB (`canvas-design`: 83 files incl. fonts) |
| longest relative path in a skill | 16 | 41 | 65 | 162 chars |
| `SKILL.md` size | 4.5 KB | 15 KB | 20 KB | 101 KB |

49% of skills are a single file. The biggest single files: a 2.36 MB `main.js`, a 1.26 MB `png`, a 450
KB `.d.ts`. 66 distinct extensions; `.md` 6,394 files, `.py` 1,776, `.json` 1,018, `.yaml` 700,
`.ttf` 108 (10.8 MB), `.png`, `.pdf`, `.xsd`. Zero-byte blobs exist (`__init__.py`, `.gitkeep`).

**Layouts:** `skills/<name>/` (most), `plugins/<plugin>/skills/<name>/`, `skills/.curated/<name>/`
(a dot directory), repo root (`glebis`: 99 skills at the root), and **a root-level `SKILL.md`**
(`mikekelly/managing-skills`: the skill *is* the repo). Duplicate folder names across a repo occur
(`openai-docs` twice under `.curated` and `.system`).

**Symlinks and mirrors:** `alirezarezvani/claude-skills` has 1,574 symlinks; **458 of the `SKILL.md`
entries are symlinks** (mode `120000`, blob content is the link target text, e.g.
`../../engineering-team/a11y-audit/skills/a11y-audit`) under `.gemini/`, `.codex/`, `.hermes/`,
`.vibe/` mirror trees. They are phantoms: raw fetch returns 34-51 bytes of path text. **Skip mode
`120000` and `160000` (submodule) entries and report them.**

**Name oddities:** one file is lowercase (`glebis/.../cognitive-toolkit/skill.md`), so match
`SKILL.md` case-insensitively, flag it, and store it as `SKILL.md`. Directory names starting with `-`
(`composio-skills/-21risk-automation`, 4 cases), spaces in file names (2), `<Name>` in file names (3,
illegal on Windows), one path of 204 characters (`hashicorp`).

## 3. Front matter of the 2,488 `SKILL.md` files

| Property | Result |
|---|---|
| EOL | LF 2,486, CRLF 2. No BOM. No text before the opening `---`. |
| Front matter present | 2,485; 3 files have none (`name`/`description` must be derived). |
| `description` style | double-quoted 1,263; plain 557; single-quoted 319; block `>` 152; `>-` 94; `\|` 92; `\|-` 6; double-quoted spanning lines 2. So **14% use block scalars** and a naive one-line parser is wrong for them. |
| `name` style | plain 2,172; double-quoted 313. |
| Extra top-level keys | `license` 945, `requires` 832 (a nested list or map), `metadata` 750 (map), `compatibility` 204, `version` 148, `tags` 135, `allowed-tools` 111, `author` 65, `compatible_tools` 43, `when_to_use` 31, `argument-hint` 28, `context` 23, `tools` 18, `triggers` 16, `disable-model-invocation` 8, `user-invocable` 4, and others. The parser must skip nested (indented) lines of keys it does not read. |
| `name` differs from folder | **94** (3.8%): e.g. `template` folder with `name: template-skill`; Composio's `Ahrefs Automation` (not a slug) in `ahrefs-automation/`; names like `-21risk-automation`, `anthropic_administrator-automation` (underscore). |
| `description` over 1,024 chars | 2 (p50 204, p90 672, max 1,161). |

## 4. Decisions that follow (the build implements these)

* **Library key = the directory name**, slugified to `^[a-z0-9]+(?:-[a-z0-9]+)*$` (lowercase, other
  runs become `-`, leading/trailing/double hyphens trimmed, max 64); for a root-level skill use the repo
  name. A declared `name` that differs is kept in the file untouched and shown as a note ("declared
  name: X"). On a key collision the import reports a conflict; `overwrite:true` replaces, otherwise the
  human renames (`-2` suffix offered).
* **Limits (per skill; all-or-nothing, nothing partial is left on disk):** at most **400 files**, **3 MB
  per file**, **12 MB total**; per import request at most **40 MB**. Skipped skills are listed with the
  reason. (These cover every skill seen: the 312-file, the 5.55 MB and the 2.36 MB single-file cases.)
* **Concurrency:** at most 4 raw fetches at a time, 15 s timeout each, at most 1 retry on 5xx; never
  retry on 403/429; show the reset time from `x-ratelimit-reset`.
* **URL grammar accepted** (after trimming): `https://github.com/{owner}/{repo}` with an optional
  `.git` suffix and trailing `/`; `.../tree/{ref...}/{subpath}`; `.../blob/{ref...}/{path}` where the
  path ends in `SKILL.md` (single skill); `www.github.com` is treated as `github.com`.
  `{owner}` and `{repo}` match `^[A-Za-z0-9_.-]{1,100}$` (and are not `.` or `..`). **Rejected:**
  `http:`, any other scheme, any other host (including `raw.githubusercontent.com`, gists, gitlab),
  userinfo (`user@`), an explicit port, IP-literal hosts, `git@github.com:o/r`, empty owner or repo,
  query strings that try to smuggle a path, control characters, and anything over 2,048 characters.
  Only `api.github.com` and `raw.githubusercontent.com` are ever contacted.
* **`safeRelPath(repoPath)`** (maps a repo path to a safe relative path under the skill directory, or
  `null`). Reject when any of: empty; starts with `/`; contains `\`, NUL, a control character
  (< 0x20 or 0x7F), a bidi/format character (Unicode `Cf`), or any of `: < > " | ? *`; any segment
  is empty, `.` or `..`; a segment ends with `.` or a space; a segment (before its first `.`, case
  insensitive) is `CON PRN AUX NUL COM0-9 LPT0-9` (including the superscript-digit forms); a segment
  matches `~\d` (8.3 alias); the resulting absolute path on disk exceeds **240** characters; two
  entries in one skill differ only by case or Unicode normalisation (collision on a case-insensitive
  filesystem). Then NFC-normalise. Where a repo path is rejected, the *whole skill* is skipped with the
  reason (`illegal characters in "init-xcode-app/.../<Name>App.swift"`), because a partial skill is
  worse than none. The 204-character `hashicorp` path will exceed the 240 limit under
  `C:\Users\sarve\Desktop\circle-studio-app\data\library\skills\...`; the message says so.
* **Front matter parsing** must handle: `>`/`>-`/`|`/`|-` block scalars, single and double quotes with
  escapes, multi-line double-quoted values, CRLF, a BOM, nested keys it ignores, and no front matter at
  all (wrap: add `name` and `description` = the first heading or first non-empty line, clipped to 200
  chars, and say the file was wrapped).
* **Imported skills are inert data.** The app never executes, imports or `spawn`s anything from a
  library skill; a skill only ever runs inside Claude Code after the human installs it in a project.

## 5. Error-handling table for the import routes

| Situation | Response |
|---|---|
| malformed or non-GitHub URL | `400 bad_request`, message says which rule |
| repo/ref/path 404 | `404 not_found`: "not found, or private" |
| rate limited (403/429, remaining 0) | `502 upstream` with `detail.resetAt`; no retry |
| network failure / timeout | `502 upstream` |
| tree `truncated:true` | per-directory fallback; if still too large, `413 too_large` naming the sub-path to try |
| no `SKILL.md` found | `200` with an empty list and a hint to paste a `/tree/...` URL |
| skill over limits or unsafe path | listed under `skipped` with the reason; the rest still import |
