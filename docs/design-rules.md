# Design rules (machine-checkable)

"Tokens only" means the design values live in exactly one file, `frontend/css/tokens.css`, and
everything else reads them with `var(--name)`. These rules are written so a small test can enforce
them (suggested: `tests/unit/tokens.test.mjs`). They are defaults you may tighten; do not loosen the
first two without telling the human.

1. **No raw colours outside `tokens.css`.** No `#rgb`, `#rrggbb`, `rgb(`, `rgba(`, `hsl(`, `hsla(`,
   `color-mix(` with literals, or named colours other than `transparent`, `currentColor`, `inherit`
   in any other `.css` file or in JS style strings. (`frontend/logo.svg` and `favicon.svg` are
   image assets with their own colours and are exempt.)
2. **No raw sizes or durations outside `tokens.css`.** No number followed by `px`, `rem`, `em`, `ch`,
   `pt`, `cm`, `mm`, `in`, `ms` or `s`. Allowed: unit-less numbers (`line-height: 1`, `opacity: 0.6`,
   `flex: 1`), `%`, `fr`, `deg`, `vh`, `vw`, `dvh`, and `calc()` that multiplies a token by a unit-less
   number (`calc(var(--sp-4) * 3)`). The one exception: media and container query conditions
   (`@media (min-width: 60rem)`), because CSS cannot use variables there; keep those few breakpoints
   in one place at the top of `base.css` and comment them.
3. **Inline styles only carry custom properties**, e.g. `style="--depth: 2"` or
   `el.style.setProperty('--x', value)`. No `el.style.width = ...`, no `style="color: ..."`.
4. **Class names** use the `cs-` prefix and BEM-light (`cs-card`, `cs-card--selected`,
   `cs-card__title`). State that must be read by assistive tech uses ARIA attributes, not classes.
5. **Icons** come only from `frontend/js/icons.js` (`iconSvg(name, size)`); a name that is not in
   `icons` is a bug. Sizes are the tokens `s`, `m`, `l`, never pixels.
6. **Focus** is always visible: every interactive element shows `outline: var(--bw-strong) solid
   var(--c-focus)` (or an equivalent ring) on `:focus-visible`, offset by `var(--sp-1)` where it would
   clip. Never `outline: none` without a replacement.
7. **Motion** uses only `--dur-fast`, `--dur-med`, `--dur-slow`, `--dur-spin` and `--ease`. With
   `prefers-reduced-motion` those tokens are `0s`, so nothing needs a second code path.
8. **Both dark blocks in `tokens.css` are identical** (the explicit `[data-theme="dark"]` block and
   the `prefers-color-scheme` block), and every colour token is defined in light and dark.
9. **Contrast**: `node scripts/check-contrast.mjs` exits 0 (104 required pairs per theme pass AA:
   4.5:1 for text, 3:1 for UI shapes; `--c-text-faint` is for disabled and large text only).
10. **No external assets.** No web fonts, CDNs, analytics, or remote images; system fonts only.
