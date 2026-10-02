# Jev quality review

Reviewed the complete feature diff against current main
`bae7818597895841b0adbe9c023c0a57194af96e`, integrated by merge `d22862a6`.
Historical extraction checks are separate from this review's fresh verification.

## Coverage

| Reviewer    | Areas                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain      | Conversation state/replay, policy, quotes, corrections, research detection, outbox and card adapters; conversation protocol and related tests |
| Durability  | PostgreSQL/memory contracts, document staging/recovery, questions and decision records, lifecycle mirrors                                     |
| Browser     | Web/editor/question/dialect UI, evidence and annotations, current mounted components, retained browser scenarios and fixtures                 |
| Coordinator | Planner jobs/tools, Chat/harness, authorization, research transport, remaining protocol, config/wiring, contained runners and documentation   |

Reviews checked repository standards and extraction intent separately. Changes
received independent re-review; test support under `src` was distinguished from
runtime code. Working path assignments and detailed audit reports were retained
in `/private/tmp/jev-quality-coverage.tsv` and `/private/tmp/jev-*-audit.md`.

## Confirmed changes

- Refined option labels now retain stance identity and reach model context;
  original quoted evidence remains intact.
- Planner asks and cancellation stage their document/records/maps before commit;
  failure preserves the live draft. Cancellation durably mirrors discard.
- Ordinary Planner questionnaires remain available beyond classifier capacity,
  using the existing unlinked-card representation.
- Child documents hide unsupported research offers and reject their UI action.
- Removed unmounted DecisionLayer/placement hooks and unused AddOption component;
  retained the current ResolvedLayer and useful behavior tests.
- The contained runner selects successful heading/refine/prose, prompt, evidence
  and collaborative stress scenarios instead of one reader-denial case.
- Added real PostgreSQL reconstruction across fresh processes: accepted document,
  conversation and receipts survive; a running job becomes durably interrupted once.
- Job contexts are pruned by reachable live and committed work, preserving
  in-flight acceptance and winning Save claimants.
- The 12-thread window selects recently touched live decisions without changing
  small-context order or model confidence thresholds.
- Pending card actions reserve event slots before authority commits; exhaustion
  leaves drafts available and returns an explicit failure.
- Forwarded live decided-prose anchors into the editor's questionnaire store;
  written prose now receives its marker and hover relationship.
- Pending option requests retain an Escape-capable field. Late responses preserve
  cancellation and the user's current focus, including a reopened composer.
- Consolidated duplicate research fixtures while retaining publication, retry,
  cancellation, and reconnect coverage. Updated retained browser assertions to
  the mounted interface, keyed option protocol, and native text geometry.

Final check results and remaining limits belong in
[the co-worker handoff](jev-quality-handoff.md).
