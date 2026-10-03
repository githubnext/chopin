# Jev UI reconciliation

Branch: `Maggie/jev-chat-product`. Completed after the
[feature quality handoff](jev-quality-handoff.md), on 2 October 2026.
Main `3e57e40ea6da4920d8a6f8a8ee645ff6abadc898` is integrated through `8bcdf9da`.

## Cause and repair

Main's card redesign (`b44811c1`), presence updates (`7ed5ba76`) and resolved
reader (`c7c57b96`) were already ancestors of the branch. The Jev migration
overrode their composition; the redesign was not missing from the merge.

| Surface         | Migration problem                                                                | Reconciled behavior                                                                                          |
| --------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Open card       | `4a61031e` put people and source in an `aside` above the header                  | Main's header owns a trailing source slot and its existing presence component; participants are deduplicated |
| Actions         | `a21f05f6` retained both Cancel and Discard                                      | One Discard action, with confirmation and the existing server callback                                       |
| Resolved reader | `242af279` selected a separate renderer whenever Jev metadata existed            | Main's compact hover and expanded pinned reader serve both metadata and ordinary decisions                   |
| Workspace       | Main's right-hand Chat survived; the prototype's left-hand Chat was not migrated | Chat sits left using main's existing pane, resize control, persisted width and responsive modes              |

The duplicate `decision-surface.tsx`, its formatting helper, `ChosenList` and
160 lines of competing reader CSS are removed. The shared resolved action footer
supplies Jev's Discard/Reopen confirmation and pending states. The existing
request controller still guards permissions, duplicate requests and stale replies.

## Remaining differences from main

- `packages/visuals` is identical to main. The web theme adds Jev source styling
  and reverses only the split Chat panel's existing motion direction.
- `QuestionView`, `SidecarCard`, presence faces and the Decisions list remain the
  foundation. Jev adds suggestions, previous answers, refining state, sourced
  discussion participants and authoritative lifecycle status.
- The resolved reader adds source navigation and lifecycle actions to main's
  markup; it retains main's selected-answer check, folded alternatives and
  owner/date row. Additional discussion participants remain named in that row.
- Evidence and analysis are Jev-specific surfaces. Their tokens, avatars and
  source icon buttons use the shared design system; supporting/opposing people
  retain distinct accessible labels and the opposition ring.
- Extra editor CSS handles evidence placement, canonical card gaps, terminal
  collapse and a stable marker lane. Main's reader styles are unchanged.

Reviewed design-contract hashes were renewed for the four edited component
owners. Their caller-prop, finite motion-class and measured-geometry boundaries
retain the same exact cases; no exception was added or broadened.

## Verification

- 3,589 unit/domain tests passed; the three PostgreSQL-only guards were skipped.
- 58 affected application Chromium tests passed, covering mentions, references,
  decisions, pane resizing, focus, draft retention and responsive workspaces.
- 102 actual-component Chromium tests passed, including Jev reader lifecycle,
  source navigation, narrow geometry, shared drafts and stale acknowledgements.
- All 9 evidence browser tests passed again after adopting shared icon buttons.
- Type checks and client build passed. Repository CI preserves its four existing
  lint warnings, 221 reviewed design exceptions and existing design baseline.

The application tests used disposable PostgreSQL services and disabled model
calls. The live development server keeps Jev enabled and is signed in for local
testing. This reconciliation does not change the paid-provider semantic-quality
limit recorded in the earlier handoff.
