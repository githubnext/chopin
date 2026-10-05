# Resolved decision card

## Problem

An answered decision currently becomes a gray panel with a separate “Decision” bar,
plain question/answer text, and provenance above the content. It no longer resembles
the open card that people just used. The Decisions tab already collapses resolved
history, so the card itself can preserve the context of the original choice.

## Approaches considered

1. **Restyle the existing summary with CSS.** Smallest diff, but the redundant bar
   and plain text still have the wrong hierarchy.
2. **Use the open card’s visual parts in a read-only resolved view.** Reuse the
   question mark, heading, lettered choice rows, selected state, and footer rhythm
   without presenting disabled inputs as an editable form. **Chosen.**
3. **Render the open form disabled.** Reuses more code, but disabled radios and
   checkboxes misrepresent a completed record and complicate the prose link.

## Design

- Answered cards use the same white rounded surface and quiet shadow as open cards.
  The separate “Decision” bar is removed. Discarded and expired states keep their
  subdued treatment; this change is about an answer that remains available to
  review or reopen.
- Each answered question uses the open card’s green decision mark and strong
  question heading. Original choices remain visible as static lettered rows. A
  chosen row uses the existing selected wash, filled letter tile, and check mark.
  A visually hidden cue also announces each chosen row to screen readers. Multiple
  selections show multiple chosen rows. A historical custom or unmatched answer
  remains visible as a selected text row.
- Attribution becomes quiet metadata below the choices: who answered and when.
  Reopen and Discard stay in the established footer, including the existing
  confirmation and error behavior. Read-only viewers see neither action.
- A linked question keeps one keyboard-operable “show in plan” control in its
  heading. Static choice rows do not add tab stops or pretend to be form fields.
- Multiple-question records show a question section for each answer in order.
  A missing projected answer keeps the current all-or-nothing “Saved decision”
  fallback rather than implying the partial record is authoritative.

## Boundaries and verification

`QuestionView` owns the resolved body and option presentation.
`QuestionnaireCard` supplies server-owned attribution and action callbacks;
`SidecarCard` supplies the surface. The record, wire protocol, and resolved-history
disclosure do not change.

Verify answer rendering for single, multiple, legacy text, and missing projections;
Reopen/Discard and read-only behavior; keyboard prose navigation; and 390px and
desktop layouts. Capture actual open and answered card screenshots for the PR.
