# Focus indicator system

Status: approved design direction

## Problem

Chopin has one global focus-ring style, but no rule for what happens when a focused control sits inside `overflow: hidden`, a scrollport, or another clipping boundary. The callout picker exposed the gap: its ring was correct, but its viewport cut the ring off.

The same risk exists in picker shells, tab strips, toolbars, table rails, change chips, cards, and grouped lists. Adding padding to each component would fix individual screenshots without making the next component safer.

## Goals

- Keep the current 2px brand-coloured focus indicator.
- Draw it outside controls by default.
- Draw it inside controls when a real clipping or scrolling boundary would crop it.
- Make the choice explicit and reusable instead of repeating component CSS.
- Catch clipped focus indicators with one system-level browser assertion.
- Preserve current keyboard behaviour, layout, and motion.

This work does not redesign focus management, keyboard navigation, control colours, or component states.

## Design

### One focus dialect

The theme owns the focus indicator's colour, width, and offset as shared custom properties. The global `:focus-visible` rule consumes them. Components may change their hover or selected fill when focused, but do not redefine the outline's geometry.

The default offset remains positive, so ordinary controls keep the existing outside ring.

### Focus boundaries

A clipping or scrolling element that can contain focusable descendants declares `data-focus-boundary`. Inside that boundary, the shared offset becomes negative and the same 2px indicator is drawn inside each control.

The attribute belongs on the element that clips, not on a convenient outer wrapper. Nested boundaries need no special handling because the inset offset is inherited.

This is a rendering contract, not a new interaction primitive. It does not change focus order, active descendants, scrolling, or event handling.

### Classify overflow before marking it

Not every use of overflow is a focus boundary:

1. **Cosmetic clipping:** If `overflow: hidden` exists only to round a card, list, or popup, remove the clipping. The shell can draw its edge while first and last children carry the appropriate corner radii. Outside focus rings can then remain outside.
2. **Necessary clipping or scrolling:** If the surface genuinely scrolls, masks off-screen content, or constrains measured chrome, retain the overflow and mark it as a focus boundary.
3. **Non-interactive clipping:** Image crops, cursor labels, ellipsised text, and code overflow with no focusable descendants need no focus treatment.

This prevents `data-focus-boundary` from becoming a plaster placed on every `overflow` declaration.

### Initial migration

The first pass audits these known interactive surfaces:

- the callout type viewport;
- repository and document pickers;
- plan and questionnaire tab strips;
- formatting and slash-menu surfaces;
- table rails and the touch toolbar;
- agent-change chips;
- sidecar cards and the hosted channel list.

The current callout-specific padding change is replaced by the shared boundary contract.

## Governance

The existing `focus.test.ts` remains the static guard for one focus dialect. It expands to scan CSS as well as component markup and refuses component-level focus geometry that bypasses the shared properties. Intentional state styling remains local.

The browser suite gains one reusable assertion for focus visibility. Given the active element, it compares the painted outline bounds with every clipping ancestor. A positive-offset ring must fit; an inset ring is already contained. Representative keyboard paths use this helper across overlays, scrollports, and grouped controls rather than embedding geometry code in an individual component test.

The assertion runs while opening motion is active as well as after the surface settles. A focus indicator that appears only after an animation ends is still clipped.

## Success criteria

- No keyboard focus indicator is cropped by an ancestor.
- Ordinary controls retain the existing outside ring.
- Necessary clipping surfaces use the same ring inset, without extra layout padding.
- Cosmetic clipping is removed from interactive composites where practical.
- Components do not introduce independent outline widths, colours, or offsets.
- Static checks, types, and representative browser tests pass.
