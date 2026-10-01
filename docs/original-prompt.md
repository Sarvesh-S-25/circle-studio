# The human's original request (verbatim, 2026-09-29)

This is the highest authority in the folder. When anything else in `docs/` disagrees with it, this
wins. Everything else was derived from it.

---

/start circle-studio: a local app (single user, this Windows PC, no sign-in, no hosting, nothing leaves the machine) that is the control room for a Claude Code agent team.
- Skills library: import skills that already exist on GitHub (paste a repo URL, pick skills), keep them locally, and add my own with an editor for SKILL.md.
- Drag and drop: drag skills and agents onto a project or a phase of its plan to install or attach them; drop a folder or .md onto the window to import it.
- Click any agent or skill tab to change its model (opus/sonnet/haiku) and its external-engine order. The app writes the real files (models.json then apply-models.mjs, consult.config.json, roster.json, agent front matter) and shows the diff first.
- Project plan builder: I arrange phases and gates (research, plan, stack, security design review, split, design, build, deploy) and the app writes docs/brief.md and the config files.
- Chat inside the app, streaming, through my logged-in claude CLI (no API key stored), to explain what is going on and answer questions about the project. Read-only by default; anything that writes asks first.
- Advisor: give it any file and the claude CLI says what to keep, what to build and what the issues are; each item can be pinned to the plan.
- Left taskbar: my most-used skills, recent projects, and a "What do you want to create today?" box.
- Design: neat, calm, keyboard-friendly, its own identity, tokens only, light and dark.

Base document: C:\Users\sarve\Desktop\A2G\a2g\improvement.md. The app should remove the pain it lists: builders missing messages, hidden freezes, per-role model tiers, ADRs left proposed, secrets in .mcp.json, and a "human does git" option.

Proposed lanes: frontend, backend, shared contract; no migrations.

Checked on this machine: claude 2.1.284 is logged in (claude auth status, no model call); claude -p supports --output-format stream-json, --include-partial-messages, --resume, --permission-mode, --allowedTools and --json-schema. Node 24 is installed.

---

## What the human said afterwards (same day)

* "no need to use what is currently built and code and all just keep all this as a reference and
  rebuild urself in the design i decided and prompt i sent you": the existing folders
  (`C:\Users\sarve\Desktop\circle-studio` scaffold, `C:\Users\sarve\Desktop\claude-teams`) are
  reference only; build fresh from this prompt.
* "ultracode is only for planning": the planning stage may be exhaustive; the build should not spawn
  large multi-agent fan-outs unless the human asks.
* "research is taking too much usage and time ... no need to retest and overthink wasting time and
  resources": do not redo the research; spend usage on building and on checking what you build.
* "give it the benefit of building, don't be too fixated on the current project elements": the plan,
  spec, metrics and design in this folder are guidance; the builder may restructure, drop or replace
  them where it has a better idea (keeping the hard requirements above).
