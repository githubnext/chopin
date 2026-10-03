# Jev live browser test — 2 October 2026

Tested `Maggie/jev-chat-product` at `d75b2998` in the signed-in local browser,
using the real Jev provider (`jev-1.13.0`) and hosted Planner. This was a bounded
single-browser pass, with nine submitted messages and three new decisions in
`MaggieAppleton/elves/silver-storm`.

## Confirmed flows

- A monitoring question created an inline decision; Chopin refined its title.
  Follow-up Sentry and Better Stack proposals became separate sourced options
  while refinement was running.
- A separate alert-delivery question created its own card. Refinement supplied
  Slack and Email options without adding them to the monitoring decision.
- Manual option entry added OpenTelemetry with Grafana. A repeated entry was
  rejected with “That option already exists”; the selected Sentry draft survived.
- Source navigation returned to the original question with an exact match.
- Review correction attached an unapplied email tradeoff as a reason. The form
  reported “Added to card”, and the resulting prose included that tradeoff.
- Save produced ordinary prose and resolved readers for both decisions.
- Resolved Discard confirmation could be cancelled with Keep it. Reopen restored
  all three monitoring options and the previous answer; saving Grafana replaced
  the Sentry paragraph rather than appending a contradictory second paragraph.
- A direct `@chopin` request added a three-item Browser test checklist.
- Reload preserved the chosen answers, option history, reviewed reason, checklist
  and chat history. The Decisions view showed both resolved records.
- A third temporary naming decision accepted a Smoke test option, then completed
  Discard. It left the document and remained attributed as Discarded in history.
- An unsent draft survived Chat → Document → Chat in the compact layout. The
  test draft was cleared afterward.

## Findings requiring follow-up

1. **Decision anchors become incorrect and overlap.** The monitoring reader first
   highlighted its actual Sentry paragraph correctly. After reopening/resaving
   as Grafana, adding the checklist through the Planner, reloading, and creating
   then discarding the naming card, both resolved markers highlighted the three
   checklist items. At a 893×850 viewport, both markers had the same rectangle:
   x=68.5, y=147.164, width=20, height=20. Clicking the Grafana marker opened Slack;
   pressing Enter on Grafana opened the correct reader but still highlighted the
   checklist. Thus record identity survives, while passage targeting/placement
   is incorrect. The exact mutation that first corrupts the anchors is not yet
   isolated.
2. **Re-deciding carries an old option's rationale into new prose.** Sentry was
   proposed with exception grouping and stack traces as its reason. After choosing
   the manually added Grafana option, the paragraph retained that rationale.
   The discussion had not supplied it for Grafana. `prosePrompt()` supplies the
   previous paragraph during re-deciding; this is a candidate boundary to inspect,
   not a confirmed root cause.
3. **Some useful messages are not applied automatically.** The initial combined
   alert question/options message was held because its excerpt's new-thread
   confidence was 45%; a clearer question succeeded. A later message containing
   the email tradeoff and “I prefer Slack for critical errors” had three excerpts
   marked “no useful role”. Review successfully recovered the tradeoff, but the
   preference remained unapplied. The held-question form only offers Option,
   Reason and Constraint for existing cards; it cannot create the held question.

The test records and checklist remain in the local document for inspection.
The original database/hosting decision was not changed. These findings are
observations from the live pass, not fixes or claims of complete stress coverage.
