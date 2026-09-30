# Approved colour hierarchy · 29 September 2026

Maggie explicitly chose the original red, then asked to reverse all audit-driven darkening. Shared red commit `09e99b2b` is included here as `223cb9cf`; chat/code restoration `6c063d8f` as `ee9f10ad`. Canonical policy content from `3d86ab04` is adapted in `apps/web/DESIGN.md` and its design sidecar. The separate enforcement document is left to its owning branch. The audit page's original supplementary label roles are restored too.

## Scope and measurements

| Approved role                                                     | Measured contrast | Nodes wide / narrow |
| ----------------------------------------------------------------- | ----------------- | ------------------- |
| Original Delete red, default/focus                                | 4.20:1            | 2 / 2               |
| Timestamps, tool count and elapsed time                           | 4.43:1            | 4 / 4               |
| Queued author, status and message                                 | 2.21–2.64:1       | 3 / 3               |
| Original syntax token colours                                     | 2.14–3.27:1       | 7 / 6               |
| Audit source paths, specimen-state labels and type-scale metadata | 4.12:1            | 45 / 45             |

The scan target is 4.5:1. The canonical Linux browser detects seven syntax tokens at both widths. The macOS browser detected one fewer narrow token in three repeated scans; changing vertical positioning did not affect either platform. The record includes the Linux-measured blue numeric token at 3.01:1. These are measurements of specific visible examples, not certification of every code colour, loading state or screen.

Each saved node includes an `approvedRole` explaining its authorization. Measurements were reviewed against the named roles before recording them; unapproved roles are not accepted.

The browser suite compares the complete rule/target/HTML/evidence fingerprints for exactly 61 nodes at each width. It neither disables contrast checking nor removes elements from the scan. All findings remain in axe JSON and readable summaries, with an attached explanation of the approved decision.

## Original-red negative checks actually run

Temporary browser probes first passed the unchanged approved specimen, then changed one thing. All six probes passed (three scenarios at two widths):

- Added a low-contrast hover button using a pale background: the unexpected extra finding was rejected.
- Changed the default red slightly: the changed fingerprint was rejected.
- Darkened the default red so its contrast finding disappeared: the stale expected entry was rejected.

The first extra-node probe used completely white-on-white text, which did not produce an automatic contrast violation; a visibly low-contrast background was then used. This reinforces the documented limit of automatic scans. Full reports include incomplete checks for manual review.

The original red probe source was removed after verification.

## Expanded boundary checks

Eight fresh browser probes passed (four scenarios at both widths), each starting by passing the unmodified approved example:

- Additional low-contrast primary text inside the conversation specimen was rejected.
- A changed original code token colour was rejected.
- Darkening an approved audit label removed its finding, and the stale expected entry was rejected.
- An unnamed added button was rejected by its unrelated accessibility rule.

These are now permanent `approval-boundary.e2e.ts` checks. Their assertions require the scan's specific finding-mismatch error, not an arbitrary browser failure. The suite contains 38 interface cases plus 8 boundary checks: 46 total. All 46 final Linux tests passed in 5.3 minutes, including these eight permanent rejection checks. [Current required GitHub checks](https://github.com/githubnext/chopin/pull/209/checks) verify the published commit against the saved references.
