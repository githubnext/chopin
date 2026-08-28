# Design system audit

First pass completed 28 August 2026. **Health: 8/10.** The system is healthy, with a compact token
vocabulary and shared control primitives. The audit found a small amount of consumer drift rather
than a second, competing design system. There are no open P0, P1, or objective P2 findings after the
first correction pass.

## Catalogue

Run `bun run dev` and open `/design-audit`. The route is development-only and is excluded from the
production entry point.

The catalogue contains 31 review areas in four sections:

- foundations: semantic colours, typography, spacing, radii, elevation, and icons;
- controls: buttons, icon buttons, links, fields, choices, tabs, menus, and dropdowns;
- application surfaces: dialogs, lists, navigation, Conversation, Decisions, resolved comments,
  loading, empty, and error states;
- authored content: callouts, research, code, diffs, diagrams, formulae, images, and tables.

Authored examples use the canonical dialect importer and static Lexical renderer. Application
examples reuse production primitives where they can be rendered safely without a live room.

## System contract

- Type has five rungs and semantic ink roles with AA contrast on the page surface.
- Controls use three sizes: 28px icon and small controls, 32px medium controls, and 44px coarse
  pointer targets.
- Standard icon-button glyphs are 16px. Fourteen-pixel glyphs belong to compact navigation and
  disclosure roles; larger glyphs are status or content, not standard controls.
- Buttons have primary, secondary, ghost, and destructive tiers with shared hover, active, focus,
  and disabled states. Labels stay on one line.
- Depth has three roles: resting, raised, and overlay. Borders use passive and control edges.
- Dialogs use `NavigationDialog`; document cards and decision records retain their domain-specific
  structures rather than imitating dialogs.

## Findings and corrections

| Priority     | Finding and impact                                                                                                                                                | Correction and evidence                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1, resolved | A ready Research card rendered outside the editor lacked a positioning anchor, so its absolute open button covered the catalogue viewport and blocked navigation. | Made the card own its structural anchor through composable `SidecarCard` classes in `packages/editor/src/card.tsx:45` and `packages/editor/src/widgets/research.tsx:236`.      |
| P1, resolved | Compact navigation exposed `aria-current` without a visible selected state, so the mobile destination depended on accessibility metadata alone.                   | Added a page surface, primary ink, and resting elevation in `apps/web/src/theme.css:606`.                                                                                      |
| P2, resolved | Send actions used a 24px target and 18px glyph beside 28px icon buttons.                                                                                          | Moved the shared action onto the 28px/16px contract in `packages/editor/src/send-action.tsx:12`.                                                                               |
| P2, resolved | Pane, close, stop, sidebar, queued-message, and research-dismiss icon buttons mixed 14px and 18px artwork or 28px and 32px targets.                               | Normalized them to 28px targets with 16px glyphs; examples are `apps/web/src/workspace.tsx:150`, `apps/web/src/chat/chat.tsx:416`, and `apps/web/src/chat/transcript.tsx:136`. |
| P2, resolved | Shared button labels could wrap under pressure and produce inconsistent control heights.                                                                          | Added `white-space: nowrap` to the base utility at `apps/web/src/theme.css:207`.                                                                                               |
| P2, resolved | Sidebar collapse and Conversation close shipped identical SVGs under different names.                                                                             | Consolidated both onto `panel-close.svg`; `apps/web/src/icon-assets.test.ts:7` guards the boundary.                                                                            |
| P3, open     | Eighteen local SVGs contain fixed `#212121` artwork, so image-loaded interactive icons cannot inherit semantic active or disabled colours.                        | `apps/web/src/assets/icons/conversation.svg:15` is representative. Choose Phosphor or a colour-aware wrapper before migration.                                                 |

## Human review queue

These are coherent today but need product taste rather than mechanical normalization:

1. Desktop navigation deliberately uses a denser 14px icon role, while general controls use 16px.
   Confirm that distinction should remain.
2. The empty Decisions view is intentionally quiet: explanatory copy without illustration or CTA.
   Decide whether it needs stronger guidance.
3. A short Conversation anchors to the bottom and leaves open space above. Confirm that the
   messaging convention is preferable to top anchoring.
4. The project sidebar animates its width at `apps/web/src/navigation.css:198` so document space
   yields to it. A transform would be cheaper but would overlay rather than reflow the workspace;
   profile before changing the interaction.

The authored blockquote's three-pixel logical border is a conventional quotation affordance, not a
card accent, so it remains unchanged.
