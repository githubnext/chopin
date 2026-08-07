---
id: "003"
title: Rebuild the design tokens
status: done
branch: task/003-rebuild-design-tokens
pr: "https://github.com/githubnext/chopin/pull/28"
stacked_on:
blocked_reason:
---

## Context

The full system was designed on canvas, and the canvas is readable over MCP —
open the frames rather than working from the images.

- Colour — https://www.figma.com/design/Px4tP6QSzRgNe6St0Yah64?node-id=45-2
- Type — https://www.figma.com/design/Px4tP6QSzRgNe6St0Yah64?node-id=22-2
- Surfaces & edges — https://www.figma.com/design/Px4tP6QSzRgNe6St0Yah64?node-id=26-2
- Shadows — https://www.figma.com/design/Px4tP6QSzRgNe6St0Yah64?node-id=30-2
- Hairlines — https://www.figma.com/design/Px4tP6QSzRgNe6St0Yah64?node-id=50-2

![the five type rungs, with line heights and the job each does](images/003-type-scale.png)
![the three shadow levels on every ground the app uses](images/003-shadows.png)

Today's theme layer is light-only and deliberately small: three surfaces, two
text levels, one border weight, no spacing tokens, and seven type rungs — four
of which sit inside a 4px band.

## Goal

Replace the theme layer with the designed system: warm olive neutrals, petrol
as the single accent, four text levels, five type rungs, half-step spacing,
three shadows, and a hairline ring in place of every border.

## Notes

Values, all authored in OKLCH:

- Neutral ramp, hue 95 — 50 `#FCFCFA`, 100 `#F8F8F6`, 150 `#F4F4F1`,
  200 `#ECECE9`, 300 `#DCDBD7`, 400 `#ACABA5`, 500 `#78766E`, 600 `#605E56`,
  700 `#47453F`, 750 `#34332E`, 800 `#252420`, 850 `#171613`, 900 `#0E0D0A`,
  950 `#040302`
- Brand `#06707E`, hover `#045A66`, wash `#DCF6FA`, ink `#045D69`
- Success `#3B793F`, warning `#AB7302`, destructive `#D54D4C`
- Surfaces — page white, ground gray-150, hover and inset gray-100,
  selected gray-200, control fill gray-200 with gray-300 on hover
- Text — primary gray-900, secondary gray-700, tertiary gray-600,
  quaternary gray-500
- Type — 13/20, 15/22, 17/27, 24/30, 32/38
- Spacing — keep the 4px multiples, add the half-steps 2, 6, 10 and 22
- Shadow tint `--shadow-color: 14 13 10`; the stop values are in the Figma
  file's shadow spec table and in the second image above
- Edges — two weights, and which one applies depends on whether the edge is
  meant to be looked at. Passive edges take the hairline, black at 7%: pane
  seams, card rings, list and table dividers. Anything a person aims at and
  reads state from takes the control edge, black at 20%: text inputs,
  textareas, radios, checkboxes. Both are 1px, dropping to 0.5px on retina.
  A disabled control drops back to the 7% hairline, so it recedes on its edge
  as well as its fill.

These values are settled where the canvas specimens disagree: use `#F8F8F6`
for gray-100, `#F4F4F1` for gray-150, `#D54D4C` for destructive, and 7% black
for the hairline.

Rejected, and why:

- Cool neutrals at hue 285, which the app uses today. They read clinical, and
  faintly violet in the mid steps against a warm accent.
- A separate interaction blue. Brand now carries focus rings, unread dots and
  links, so the palette has one accent rather than two competing ones.
- A serif for document prose. Four screen serifs were tried; Inter throughout
  won because the 13/15/17 steps already separate chrome from document.
- The seven-rung type scale. 11 and 12 were indistinguishable, and hierarchy
  inside the chrome is better carried by the four text colours than by a
  fourth tiny size.

Use design judgement on the type-rung remap. There are roughly 63 usages of
the two rungs being removed; most become the 13px rung, but some are
decorative and could simply go. Decide each rather than sweeping.

Warning at `#AB7302` measures 4.03:1 against white — fine as a badge wash with
dark ink, which is how it is used. Do not build a filled warning button on it.

`gray-400` stays in the ramp for disabled glyphs and decorative rules. It is
2.31:1 against white and must never carry text.

## Acceptance

Palette

- [x] The neutral ramp has 14 steps at OKLCH hue 95
- [x] Brand is `#06707E` and is the only accent in the theme
- [x] Focus rings, unread dots and primary buttons all resolve to brand
- [x] No token in the theme is a blue other than brand

Text

- [x] Four text tokens exist: primary, secondary, tertiary, quaternary
- [x] Each of the four measures at least 4.5:1 against white
- [x] No text anywhere resolves to `gray-400`

Type

- [x] Exactly five type rungs exist: 13, 15, 17, 24 and 32px
- [x] No `text-2xs` or `text-xs` class remains in the codebase
- [x] Chat message bodies render at 15px, document prose at 17px

Edges and depth

- [x] Three shadow tokens exist: resting, raised and overlay
- [x] `--shadow-color` is `14 13 10`
- [x] A hairline ring utility renders 1px, dropping to 0.5px on retina
- [x] Exactly two edge tokens exist: black at 7% and black at 20%
- [x] Pane seams, card rings and list dividers all resolve to the 7% token
- [x] Text inputs, textareas, radios and checkboxes all resolve to the 20%
      token, and a disabled one falls back to 7%
- [x] No element renders a solid grey border

Evidence

- [ ] Screenshots of the chat pane, the document, and an open menu attached
      to the PR
