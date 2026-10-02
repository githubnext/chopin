# Jev feature quality handoff

## Starting point

Review and improve `Maggie/jev-chat-product` for a co-worker to continue safely.
The last application-source commit is
`a423b0b3ddda8877114f4a42adb6d54462b0635b`.
The handoff adds this document only; it does not change application behavior.

Fetched origin/main on 2 October 2026:
`bae7818597895841b0adbe9c023c0a57194af96e`.
It contains three commits after the branch's incorporated main
`f75d6d693e896c8689835cb835e925d3b5ef5a17`. Integrate current main, inspect its
interaction with the feature, and rerun verification before final handoff.

## What is here

This is a conversation/decisions workflow, not just the Jev HTTP client.
It includes interpretation policy, message evidence and correction, durable
conversation effects, decision records/projections, scoped Planner jobs/tools,
research consent/offers, and integration with the current interface.
Conversation processing is opt-in; some shared editor fixes are outside its flag.

The final diff against incorporated main at the application-source SHA had
847 changed files, 96,485 added lines and 2,216 removed lines:

| Purpose                                           |  Added | Removed |
| ------------------------------------------------- | -----: | ------: |
| Application source, including retained source     | 26,202 |   1,923 |
| Tests, fixtures, memory adapters and test runners | 67,003 |     224 |
| Documentation/source inventory                    |  3,150 |      22 |
| Project and reviewed design configuration         |    130 |      47 |

Application net growth was 24,279 lines. Gross additions include code extracted
from existing main modules. The memory adapter, scripted runner and storage
contract composers are test support despite their source paths. No generated
bundle, screenshot corpus or evaluation dataset accounts for this diff.

One concrete cleanup candidate is the unmounted historical
`packages/editor/src/decision-layer.tsx` (458 additions). Verify import reachability
and preservation requirements before removing it; shared ResolvedLayer helpers
are active. The 2,818-line extraction ledger is historical evidence, not a concise
current onboarding guide.

## Historical verification, not a fresh release claim

At the application-source SHA on 1 October:

- Offline suite: 3,512 passes, 2 guarded PostgreSQL skips, 0 failures.
- Workspace/E2E types, repository CI and an exact-commit image/client build passed.
- Real-component Chromium suite: 97 passes.
- One unchanged PostgreSQL-backed authenticated reader-denial case passed.

The last case proves denial to a reader, not successful heading/refine/prose work.
Its original callback SHA256 was
`f94089afd213441d03be97eeba2340968ca5f80a80d03d942b8f017be7cc688a`.
Paid-provider quality, successful end-to-end Planner effect execution,
PostgreSQL process-restart reconstruction and the full release/browser matrix
remain open. Execute fresh checks at the final review SHA, including real storage
contracts; skipped suites do not count as verification.

## Review entry points

Read [architecture](architecture.md), [storage](storage.md),
[hosted Planner](hosted-agent.md), [background jobs](background-jobs.md),
[authentication](authentication.md) and the repository AGENTS.md before changes.
Use [the extraction ledger](jev-product-extraction.md) and
[owned-source inventory](jev-product-source-map.tsv) when checking intended scope
and retained scenario coverage. Consult the
[implementation lifecycle](implementation-lifecycle.md) when reviewing tasks and
run claims.

Review by subsystem, with explicit worker ownership and independent re-review.
Prioritize persistence before publication, fenced/idempotent effects, restart and
interruption semantics, authorization and tool boundaries, bounded queues/context,
state-machine clarity, and current browser/editor behavior. Preserve useful tests
and their assertions while simplifying unnecessary production or test scaffolding.
Keep fixes small, verifiable and committed; leave an accurate list of open limits.
