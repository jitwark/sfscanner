# Design system

> Status: current
> Last verified: 2026-09-24
> Owner: Community Hub maintainers
> Source of truth: `app/app/globals.css`, `app/src/ui/primitives/`, `app/app/layout.tsx`

The design system's source of truth. Where this document and the code disagree, the code is
right and this document is a bug — every token value, contrast ratio, radius and file size below
was read from `app/app/globals.css`, `app/app/layout.tsx` and `app/src/ui/` on the date above.

The shipped system is **dual-mode on one accent hue: green `#76b900`**, applied identically in
both modes. Dark is the default: the root element is rendered with `data-theme="dark"`
(`app/app/layout.tsx:107`), and the bootstrap script falls back to `dark` even when there is no
stored choice (`app/src/ui/theme/theme-script.ts:7`). Light mode is one toggle away and is not
inferred from the operating system. The accent is a single hue with no second brand colour; the
severity and node-category families are separate ordered and categorical token sets alongside it.

---

## Token architecture

Tailwind v4's `@theme` block in `globals.css` (lines 3–100) maps semantic `--color-*` tokens onto
mode-specific `--theme-*` custom properties, which are redefined per `[data-theme]` selector:

```
@theme {
  --color-page: var(--theme-page);
  --color-accent: var(--theme-accent);
  --color-sev-critical: var(--theme-sev-critical);
  ...
}

:root, [data-theme='light'] { --theme-page: #ffffff; --theme-accent: #76b900; ... }
[data-theme='dark']        { --theme-page: #0f1720; --theme-accent: #76b900; ... }
```

Components consume the semantic layer (`bg-page`, `text-accent`, `border-hairline`) via Tailwind
utility classes generated from `--color-*`. Nothing in application code references `--theme-*`
directly. That indirection is what makes a full re-theme a one-file change: rewrite the two mode
blocks in the 251-line `globals.css` and every `--color-*` consumer follows without a component
edit.

Two things about that block are worth stating plainly, because they read as contradictions:

- The light values sit on `:root, [data-theme='light']` (lines 107–142) and the dark values on
  `[data-theme='dark']` (lines 144–178). `:root` alone would therefore render light if a root
  element ever arrived without the attribute; the shipped default never does, because `layout.tsx`
  stamps `dark` server-side and the bootstrap script re-stamps it. The CSS comment above the block
  (lines 102–106) claims the opposite — that `:root` exists so unhydrated state renders in dark
  mode. The comment is wrong; the code is right.
- `color-scheme` is declared per mode so native form controls and scrollbars match.

## Current token table

Every value below is measured by `npm run check:contrast`, which reads this same
`app/app/globals.css` and fails if a token cannot be read against a surface it lands on. It passes
114 pairs across both modes with 9 documented exemptions. The numbers here are therefore not
documentation of intent; they are the values that shipped.

### Light mode — `:root, [data-theme='light']`

| Token | Value | Role |
| --- | --- | --- |
| `--theme-page` | `#ffffff` | the page ground |
| `--theme-panel` | `#ffffff` | a card — the same white as the page, separated by hairlines |
| `--theme-raised` | `#f7f7f7` | a card on a card, and what carries the step below the panel |
| `--theme-hairline` | `#cccccc` | decorative separator between related rows |
| `--theme-hairline-strong` | `#5e5e5e` | a boundary that carries information — 6.48:1 on panel, 6.05:1 on raised |
| `--theme-ink` | `#000000` | body copy — 19.60:1 on `raised` |
| `--theme-muted` | `#595959` | secondary copy |
| `--theme-faint` | `#595959` | de-emphasised copy — 7.00:1 on panel; the same value as `muted` |
| `--theme-accent` | `#76b900` | **a fill only.** Green on white is 2.41:1 |
| `--theme-accent-text` | `#265300` | the same hue, taken down until it can carry a word — 9.05:1 |
| `--theme-accent-border` | `#3f8500` | the boundary for anything filled with `accent`, and the global focus ring — 4.60:1 |
| `--theme-accent-ink` | `#000000` | what reads on the accent fill — 8.71:1 |
| `--theme-accent-dim` | `#ebf7d0` | a tint behind opaque text |
| `--theme-structure` | `#3f8500` | structural marks and chart chrome — never copy |
| `--theme-band` | `#000000` | hero, CTA, footer, code |
| `--theme-band-raised` | `#1a1a1a` | a raised surface inside a band |
| `--theme-on-band` | `#ffffff` | copy on a band — 21.00:1 / 17.40:1 |
| `--theme-on-band-muted` | `rgba(255, 255, 255, 0.7)` | secondary copy on a band — composites to ≈10.02:1 / 8.97:1 |
| `--theme-sev-low` | `#066747` | validated ordered severity ramp (light) |
| `--theme-sev-medium` | `#8f5400` | |
| `--theme-sev-high` | `#bd1455` | |
| `--theme-sev-critical` | `#7f1d1d` | 10.02:1 on panel |
| `--theme-sev-unknown` | `#595959` | |
| `--theme-cat-purple/blue/green/orange/pink` | `#6248bf` / `#3f5fa5` / `#006b64` / `#a33e18` / `#a8306f` | node families, unordered |

### Dark mode — `[data-theme='dark']`

| Token | Value | Role |
| --- | --- | --- |
| `--theme-page` | `#0f1720` | deeper than the band, so a band still reads as raised |
| `--theme-panel` | `#172033` | = the band colour |
| `--theme-raised` | `#243b53` | |
| `--theme-hairline` | `#36475a` | |
| `--theme-hairline-strong` | `#7b8fa3` | 3.45:1 on `raised` |
| `--theme-ink` | `#f2f6f9` | 14.97:1 on panel |
| `--theme-muted` | `#b5bfca` | |
| `--theme-faint` | `#a9b8c6` | |
| `--theme-accent` / `--theme-accent-text` / `--theme-accent-border` | `#76b900` | in dark the three converge: 7.48:1 on the page, and no separate boundary value is needed |
| `--theme-accent-ink` | `#000000` | what reads on the accent fill |
| `--theme-accent-dim` | `rgba(118, 185, 0, 0.16)` | a tint behind opaque text |
| `--theme-band` / `--theme-band-raised` | `#172033` / `#243b53` | identical to panel and raised — the band is a light-mode device |
| `--theme-on-band` | `#ffffff` | |
| `--theme-on-band-muted` | `#cdd6de` | 11.05:1 on the band |
| `--theme-sev-low` | `#34d399` | validated ordered severity ramp (dark) |
| `--theme-sev-medium` | `#fbbf24` | |
| `--theme-sev-high` | `#ff94a5` | |
| `--theme-sev-critical` | `#ff9797` | 5.55:1 on `raised` |
| `--theme-sev-unknown` | `#a9b8c6` | |
| `--theme-cat-purple/blue/green/orange/pink` | `#c8baf9` / `#95bcf5` / `#5eead4` / `#f3a36b` / `#ff9dcb` | lightened for the dark surfaces |

**Why `accent` and `accent-text` are two tokens.** They hold the same hue and differ in light mode,
where the fill is 2.41:1 and the text value is 9.05:1. One token would make the unreadable choice
the convenient one; `check:contrast` additionally refuses to let any text role resolve to the fill.

## Where colour literals live

Application surfaces are token-driven, but "no colour literal outside `globals.css`" is no longer
true and is not worth pretending. The literals that do exist are:

- **Three** in one explanatory comment — `app/src/ui/analytics/risk-matrix.tsx:18-19` documents the
  contrast calculation its alpha ceiling is derived from.
- **Eleven** in the deterministic static-SVG preview generator,
  `app/src/ui/detail/node-flowchart-fallback.ts:4-11,63,79-80`. These are SVG presentation
  attributes (`fill`, `stroke`) written into markup, which is the one place a class name cannot
  carry the value. They are part of a byte-stable generated artifact, not a second design system.
- **Two** in a test fixture, `app/src/ui/detail/static-preview.test.tsx:10`.

Every rendered class name still resolves through `--color-*`.

## Contrast rules

- Body text: **4.5:1** minimum (WCAG 1.4.3).
- Large text and non-text UI components (borders, icon-only controls): **3:1** minimum (WCAG
  1.4.11).
- `--color-structure` (`--theme-structure`) is exempt by contract: it is a structural/chart mark
  only, is documented at `globals.css:56` as failing AA for text, and must never be used as a text
  or icon colour on its own.
- Disabled-control text is exempt from the AA floor under WCAG 1.4.3 but must never carry live,
  interactive copy.
- The global focus ring is `var(--color-accent-border)` (`globals.css:230-234`), not
  `--color-accent`: 4.60:1 against the light page and 4.29:1 against light `raised`, against the
  accent's 2.41:1. Audit finding R-13 was the reason for the swap; do not move it back.

## Closed defect: `--theme-hairline-strong` (C-01)

**Finding C-01** (`docs/audit/2026-09-04/03-WEBSITE-FRONTEND.md`, P1) recorded
`--theme-hairline-strong` in light mode as `rgba(91,82,103,.34)` — ≈1.6:1 against the panel, well
under the 3:1 floor WCAG 1.4.11 sets for a control boundary. The migration plan's proposed fix was
`#7d8f9e`; the value that actually shipped is `#5e5e5e` (opaque), which measures **6.48:1** on the
panel and **6.05:1** on `raised`. The defect is closed by the token value, and `check:contrast`
keeps it closed. Nothing in this document can close or reopen it.

## Severity and the retired risk ramp

One ordered ramp ships: `--color-sev-low/medium/high/critical/unknown`, used for findings *and* for
the workflow grade. The former `--color-risk-*` tokens no longer exist anywhere; `GradePill`
(`app/src/ui/primitives/pill.tsx`) maps grades onto the severity classes.

**The rule that must never be violated: severity is always direct-labelled.** The comment on the
categorical block (`globals.css:136`) states it explicitly — colour reinforces the order, it never
carries the identity alone. The light severity ramp is not monotonic in perceived luminance (low,
medium, high and critical do not form a smooth luminance gradient), so a colour-only reading of
"which step is this" can be wrong. A severity value is always rendered as an explicit word (`LOW`,
`CRITICAL`, …) next to its colour, never as colour alone. This applies to any new severity surface.

The risk matrix follows the same discipline: one hue stepped by alpha, with a computed ceiling of
`0.6` (`app/src/ui/analytics/risk-matrix.tsx:5-24`), because dark mode is the binding case and the
step must clear 4.5:1 at its darkest. It was 0.5 under violet and 0.4 under amber; the green
palette re-derived it, and `risk-matrix.test.tsx` re-derives it from the shipped values rather than
trusting the comment.

## Surfaces: a three-step scale, two hairlines

Every surface is one of exactly three steps — **page → panel → raised** — reused everywhere rather
than each screen inventing its own stack (`--color-page` document background, `--color-panel` a card
or section, `--color-raised` something above a panel: an open popover, a hovered row, a tooltip).
In light mode page and panel are both `#ffffff`, so the step is carried by `raised` and by the
hairlines; in dark mode all three differ.

Two hairline tokens, not one, because they answer different questions:

- `--color-hairline` — **decorative.** Card edges, section dividers. Not accessibility-regulated
  (WCAG does not require a minimum contrast for purely decorative borders).
- `--color-hairline-strong` — **functional.** Form-control boundaries — input borders, select
  borders, anything a user must be able to see is a control edge. WCAG 1.4.11 requires **3:1**
  against the adjacent surface for this class of element.

## Type scale

Ten steps in the `@theme` block, `--text-2xs` through `--text-5xl` (0.75rem / 12px, 0.8125rem,
0.875rem, 1rem, 1.125rem, 1.3125rem, 1.625rem, 2.0625rem, 2.625rem, 3.375rem / 54px). Headings
(`h1`–`h3`) use the display family at weight 600 with `letter-spacing: -0.028em` and
`text-wrap: balance`; body text uses the sans family with `text-wrap: pretty`. Figures — result
counts, node counts, grades, byte sizes — always render with `font-variant-numeric: tabular-nums`
(the `.tabular`, `th`, `td` rule) so columns stay aligned and numbers do not jitter as they update.
Machine facts — node types, SHAs, code, counts in a technical context — always render in the mono
family via `code`, `kbd`, `samp`, or `.mono`.

## The self-hosted font decision, and why

Three families: **Inter** (body/sans), **Outfit** (display/headings), **JetBrains Mono**
(code/figures) — declared as `--font-sans`, `--font-display`, `--font-mono` in the `@theme` block
and loaded via `next/font/google` in `app/app/layout.tsx:32-34`, each with `subsets: ['latin']`,
`display: 'swap'` and a CSS variable on the root element.

The comment at `app/app/layout.tsx:12-31` records why this matters more than it looks:

> Before this change, the design tokens named Inter, Outfit and JetBrains Mono, but none of them
> were loaded: there was no `next/font`, no `@font-face`, no stylesheet link, and zero `.woff2`
> assets in the export. They silently fell back to the platform UI font and the display/body
> distinction never rendered.
>
> `next/font/google` self-hosts at build time, which keeps the static export self-contained and
> makes no request to Google at runtime.

The same comment records the one part that is not settled: the `<link rel="preload" as="font">` that
`preload: true` (the default) is documented to emit is absent from a local Windows export. That is a
Next 16.3.4 webpack-path defect, not a configuration mistake, and it is tracked in `STATUS.md`
(FE-02). The Linux runner that builds the published export emits the preload. Do not hand-write the
link and do not switch bundlers for it.

## The seven primitives

`app/src/ui/primitives/` holds exactly seven shared components, each a thin wrapper over tokens
rather than a styled clone:

| Primitive | File | Role |
| --- | --- | --- |
| `Button` | `button.tsx` | `primary` / `outline` / `outline-on-dark` / `secondary` / `ghost` / `ghost-link` variants, two sizes (`36`/`44`) |
| `Panel` | `panel.tsx` | The panel/raised surface step, with optional `interactive` state and corner accent |
| `Chip` | `chip.tsx` | Toggleable filter/tab element, `active` state |
| `LicenceBadge` | `badge.tsx` | Small mono label on a raised surface with a hairline border |
| `GradePill` | `pill.tsx` | Grade indicator — severity colour plus the explicit grade word, never colour alone |
| `CornerSquare` | `corner-square.tsx` | The square accent mark on panel corners, four positions, three sizes |
| `Skeleton` | `skeleton.tsx` | Loading placeholder, sized via `width`/`height` props |

Everything else in `app/src/ui/` composes these rather than reimplementing surface, radius, or
colour handling independently.

## Radius, spacing, motion, z-scale

| Token | Value | Note |
| --- | --- | --- |
| `--radius-control` / `--radius-input` / `--radius-badge` / `--radius-panel` | `2px` | one 2px geometry across controls, inputs, badges and cards |
| `--radius-hero-card` | `0px` | the hero card is square by design |
| `--spacing` | `0.25rem` (4px) | Tailwind's base spacing unit — the whole spacing scale derives from this one value |
| `--ease-out` / `--ease-out-quint` | `cubic-bezier(0.22, 1, 0.36, 1)` | the one easing curve used everywhere |
| `--dur-state` / `--duration-state` | `120ms` | state changes (hover, active) |
| `--dur-enter` / `--duration-enter` | `180ms` | entrances |
| `--dur-exit` / `--duration-exit` | `110ms` | exits |
| `--z-sticky` | `20` | sticky headers/bars |
| `--z-sheet` | `40` | sheets/drawers |
| `--z-popover` | `60` | popovers/menus |
| `--z-toast` | `80` | toasts/alerts |

Both `--dur-*` and `--duration-*` spellings are declared with identical values; components use the
Tailwind `duration-*` classes. `@media (prefers-reduced-motion: reduce)` collapses all animation and
transition durations to `0.01ms` and forces `scroll-behavior: auto`, applied globally rather than
per-component.

---

## Historical: how the palette got here

Kept because the migrations explain the token shapes, and because two of them were corrected by
measurement rather than by taste. These sections describe **past** states; the tables above are the
shipped ones.

- **Violet era.** The original system was dual-mode violet (`--theme-violet`, accent `#c4b5fd`) with
  dark as the default. No `--theme-violet` token exists anywhere today.
- **Ink-teal and amber (2026-09-05).** A migration plan's central claim held: because the
  application is token-driven, rewriting the two mode blocks in one file reskinned the entire site,
  and no component needed a colour change. `--theme-copper`, `--color-structure-text`,
  `--color-text-on-indigo`, `--color-text-on-danger` and `--color-risk-critical-text` were retired
  in that pass.
- **NVIDIA engineering palette and 2px geometry (`a13e926`, 2026-09-05).** The accent moved from
  amber to green `#76b900`, `--theme-band` became a light-mode device (dark bands equal the dark
  panel), and the radius scale collapsed to 2px. Contrast that the amber palette had solved had to
  be re-derived: `--theme-accent-text` stayed a separate token because green on white is 2.41:1, and
  the static-SVG preview palette, which is not token-driven, kept its own values.
- **Canonical severity tokens (`a86e998`, 2026-09-23).** The severity ramp was re-derived against
  the shipped surfaces — the dark critical value in particular — and the light-mode focus ring moved
  from `--color-accent` to `--color-accent-border`.

Each of those steps was caught or confirmed by a gate rather than by review: `check:contrast`
(pair-wise contrast), `check:accent-usage` (component files that bypass the accent tokens) and
`risk-matrix.test.tsx` (re-derives the risk-matrix alpha ceiling from the shipped palette rather
than trusting the comment that states it).
