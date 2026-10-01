# Circle Studio: design identity ("Open Ring")

Calm, precise, keyboard-first. It is a quiet instrument panel used for hours, not a marketing page.
Everything below is a **strong default**: change it if you find something better, but keep the
tokens-only rule (`docs/design-rules.md`) and keep the contrast script passing.

Ground truth files (already written and checked): `frontend/css/tokens.css` (all values, light and
dark), `frontend/js/icons.js` (69 icons plus `sigilSvg`), `frontend/logo.svg`, `frontend/favicon.svg`,
`scripts/check-contrast.mjs` (exits 0: 104 required pairs per theme pass).

## 1. Idea

The team is a **circle of agents**; a human closes the circle at each gate. So the identity is a
ring:

* **The mark** is an open ring with a bead in its gap (`mark`, `logo.svg`). The same shape is the
  **loader** (`spinner`, one turn per `--dur-spin`, still under reduced motion).
* A **gate** is the ring with the gap empty (`gate`: a human decision waits here); `gate-done` fills
  the gap (the human has been through).
* An **agent** is one bead on a ring (`agent`); a **team** is three (`team`).
* Model tiers are gauges: `tier-haiku` (empty circle), `tier-sonnet` (half), `tier-opus` (full).
* A **project sigil** (`sigilSvg(seed)`) is a closed ring with the bead at one of twelve hours, so each
  project has a stable, distinct dial without emoji or colour.
* Only rings and dots are round. Rectangles stay crisp (radius 3, 5, 8 px).

## 2. Themes and palette (from `tokens.css`)

| Role | Light "Vellum" | Dark "Graphite" |
|---|---|---|
| `--c-bg` (the desk: frame and rail) | `#eeeeeb` | `#111718` |
| `--c-surface` (the sheet: content, cards) | `#fafaf8` | `#182020` |
| `--c-surface-raised` (menus, dialogs, drawers) | `#ffffff` | `#202828` |
| `--c-sunken` (wells, table heads) | `#e8e7e3` | `#0b1111` |
| `--c-text` / `-soft` / `-faint` | `#192323` / `#4a5555` / `#758080` | `#e0e8e8` / `#afbaba` / `#778383` |
| `--c-accent` petrol (agents, primary action) | `#016e73` | `#29a0a6` |
| `--c-gate` brass (human gates) | `#715700` | `#dbbb56` |
| ok / warn / danger / info | `#1b6c36` / `#974c00` / `#b02a2d` / `#3a60aa` | `#6fd087` / `#f9aa60` / `#ff847f` / `#8fb9f7` |
| `--c-focus` (ink ring, never a brand colour) | `#070c0d` | `#ffffff` |

Each status colour has a `-soft` background (`--c-ok-soft` etc.). Diff colours:
`--c-diff-add-bg/fg`, `--c-diff-del-bg/fg`; code wells `--c-code-bg`; overlays `--c-hover`,
`--c-press`, `--c-scrim`. Theme switching: `data-theme="light|dark"` on `<html>`; with no attribute the
OS setting wins. Optional density: `data-density="compact"` (`--tap`, `--h-row` shrink); coarse
pointers get bigger targets automatically.

Colour is never the only signal: every status also carries an icon or a word.

## 3. Type, space, shape, motion

* Fonts (system only): UI `Segoe UI Variable Text`, display `Segoe UI Variable Display`, mono
  `Cascadia Mono`/`Cascadia Code`/`Consolas`.
* Scale: `--fs-xs` 12, `-s` 13 (diffs, dense tables), `-m` 14 (interface), `-l` 16 (section titles,
  chat prose), `-xl` 20 (view titles), `-2xl` 28 (empty states, drop overlay). Weights 400/500/600.
  Line heights `--lh-tight` 1.2, `-normal` 1.45, `-loose` 1.65.
* Space: 4px base, `--sp-1` .. `--sp-8` = 4, 8, 12, 16, 24, 32, 48, 64.
* Shape: `--r-s` 3, `--r-m` 5, `--r-l` 8, `--r-pill`; borders `--bw` 1px (hairline) and `--bw-strong`
  2px (the ring stroke: focus, gate, selected edge, timeline). Cards use hairlines, not shadows;
  shadows (`--sh-1..3`) are for floating layers only.
* Motion: `--dur-fast` 100, `--dur-med` 180, `--dur-slow` 300 ms, `--ease`. Reduced motion zeroes them.
* Layout tokens: `--rail-w` 16rem, `--content-max` 80rem, `--panel-w` 24rem (inspector drawer),
  `--tap` 2.25rem, `--icon-s/m/l`, `--measure` 72ch, widths `--w-s/m/l/xl`, `--h-row`, `--h-bar`,
  z-index `--z-rail` 20, `--z-modal` 50, `--z-drop` 70, `--z-toast` 90.

## 4. Component inventory (class prefix `cs-`)

rail (taskbar) · create box · skill card · project item (drop target) · tabs (roving arrows) ·
agent tab / role chip · model chip (tier icon + name) · engine chain chip (`gemini > copilot > codex >
self`) · inspector drawer · diff viewer (file list, hunks, add/remove rows, command list, warnings) ·
modal · confirm dialog · toast (aria-live) · menu · command palette · shortcut sheet · drop overlay ·
phase card on a vertical timeline with a gate ring · pin button · status pill (ok/warn/danger/info)
· form controls · `kbd` hint · empty state · banner (freeze, corrupt data, trust notice) · loader ring.

## 5. Views (wireframes at about 1280 px)

Shell and home:

```
+--------------+---------------------------------------------------------------+
| (o) Circle   |  Good afternoon.                          [Claude: signed in] |
| Studio       |  What do you want to create today?                            |
| [ What do you|  [_____________________________________________________] Enter|
|  want to     |  Recent projects       Most used skills      Needs attention  |
|  create...]  |  (o) codegraph         frontend-design  12   2 proposed ADRs  |
| MOST USED    |  (o) circle-studio     skill-creator     9   backend frozen   |
|  frontend-.. |                                                               |
| RECENT       |                                                               |
|  (o) codegr. |                                                               |
| Home Library |                                                               |
| Advisor Sett.|                                                               |
| Claude o  ◐  |                                                               |
+--------------+---------------------------------------------------------------+
```

Project header and tabs: name, path (copy), chips (frozen lane, N proposed ADRs, drift), tabs
`Plan · Team · Skills · Health · Chat` (Alt+1..5).

Plan builder (vertical timeline, phases reorderable; a gate is a ring on the line):

```
 Plan   lanes: [x] frontend [x] backend [x] contract [ ] migrations   [x] local only
 (o) Research      researcher  [skill chips]                 gate: Choose options   [on]
  |  Plan          planner                                   gate: Open questions   [on]
 (o) Stack         stack-advisor                             gate: G3 accept ADR    [on]
  |  Security      security  (design review, before G3)      (findings shown at G3)
 (o) Split         splitter                                  gate: G1 ratify        [on]
 (o) Design        designer, design-tooling                  gate: G2 pick          [on]
  |  Build         fe-builder be-builder executor            task gates
 (o) Deploy        deployer                                  gate: choose target
 ! warning: Split sits before Stack (a change request may follow G3)
                                          [ Review & write brief + config ]
```

Team matrix with the inspector open (click any agent or skill tab):

```
 Team (19)  Set default engine for all: [gemini v]              +----------------+
 CORE     [splitter opus] [executor opus] [auditor opus]        | researcher     |
 BUILD    [fe-builder sonnet] [be-builder sonnet] [qa sonnet]   | Tier  o haiku  |
 RESEARCH [researcher haiku !drift] [scaler sonnet off]         |       o sonnet |
 ...                                                            |       o opus   |
                                                                | Engines        |
                                                                | 1 gemini  ^ v  |
                                                                | 2 copilot ^ v  |
                                                                | 3 codex   ^ v  |
                                                                | 4 self (last)  |
                                                                | [Review changes]
                                                                +----------------+
```

Library grid (skill cards: name, description, files, source, uses; drag handle; `A` = add to
project), editor (split edit / preview), GitHub import wizard (URL -> pick -> confirm, with rate-limit
remaining), chat (transcript, mode switch Read-only / May edit with a confirmation dialog, model
picker, stop), advisor (file picker or drop, summary, three columns Keep / Build / Issues, a pin button
on every item), health (freeze, ADRs, secrets, tiers/drift, git mode, board composer), diff review
modal (file list with +/- counts, hunks, "commands that will run", warnings, Cancel / Apply), command
palette (Ctrl+K), shortcut sheet (?), drop overlay ("Drop a folder or .md to import").

Narrow widths (about 700 px and below): the rail becomes a drawer toggled with Ctrl+B; the inspector
overlays the content instead of sitting beside it.

## 6. Keyboard

`Ctrl+K` palette · `/` focus the create box · `?` shortcut sheet · `Esc` closes the top overlay ·
`g` then `h/p/l/a/c` go home/project/library/advisor/chat · `Alt+1..5` project tabs · `Alt+Up/Down`
reorder a plan phase · `Ctrl+Enter` submit in editors and chat · arrows move within lists and tab
sets · `A` on a focused skill or agent = "add to project". Dialogs trap focus and restore it.
