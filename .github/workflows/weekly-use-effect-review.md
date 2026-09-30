---
on:
  schedule:
    - cron: "18 9 * * 3"
      timezone: Europe/London
  workflow_dispatch:

imports:
  - shared/dprint-verification.md

permissions:
  contents: read
  copilot-requests: write

runtimes:
  bun:
    version: "1.4.2"

steps:
  - name: Install repository dependencies
    run: bun install --frozen-lockfile

engine: copilot

safe-outputs:
  create-pull-request:
    title-prefix: "[use-effect] "
    draft: true
    max: 5
    fallback-as-issue: false
    protected-files: blocked
    excluded-files:
      - bun.lock
    allowed-branches:
      - "automation/use-effect/*"
---

# Weekly React Effect review

Review the entire repository for incorrect React Effects. Inspect `useEffect`,
`useLayoutEffect`, `useInsertionEffect`, and custom hooks that behave like an
Effect. Treat each Effect as a synchronization boundary.

For every Effect, identify its component or hook and source location. Ask which
external system it synchronizes with. Valid external systems include browser or
DOM APIs, network requests, timers, subscriptions, storage, third-party
widgets, analytics, and non-React stores.

Classify the intent as `derive-render`, `handle-event`, `reset-or-adjust-state`,
`external-sync`, `data-fetch`, or `escape-hatch`.

- Replace derived state with render-time derivation; use `useMemo` only for an
  expensive pure computation or an identity contract.
- Move interaction-driven work into the event handler or command that caused it.
- Prefer a `key` for whole-subtree resets and a clearer state shape for partial
  adjustment.
- Prefer `useSyncExternalStore` for external stores.
- For data fetching kept in an Effect, handle cancellation or stale responses.
- For a genuine external synchronization Effect, keep it only when dependencies
  reflect the values that require resynchronization, cleanup mirrors setup, and
  it tolerates Strict Mode. Treat dependency suppressions as investigation leads,
  not sufficient evidence of incorrect behavior.

Before changing an Effect, trace its callers and lifecycle. Establish which
values can actually change while the component remains mounted, including plugin
initialization, update hooks, and keyed remounts. Identify a concrete failure or
measurable unnecessary work, its reachable trigger, and how the change resolves
it. A dependency suppression alone does not justify a PR.

Preserve setup/cleanup ownership: cleanup must release the resources and notify
the consumers associated with that setup. Explain any intentional callback
changes. Follow React's ref rules: do not introduce render-time ref assignments
or hide dependencies behind refs solely to satisfy lint.

Only fix high-confidence violations. Each pull request must contain exactly one
independent violation, start from the default branch, and use a branch named
`automation/use-effect/<short-slug>`. Do not stack or combine pull requests.
Zero findings is a successful run. Five pull requests is a maximum, not a target;
leave remaining findings for a later run.

Do not change dependency manifests, lockfiles, workflow files, agent
instructions, or other protected files. Do not create an issue or pull request
when a finding is uncertain, a focused verification cannot be identified, or
the verification fails.

Before proposing each fix, run the narrowest relevant check. Use `bun test` for
logic covered by unit tests, `bun run types` for TypeScript changes, `bun run ci`
for formatting and lint-sensitive changes, and `bun run e2e` only when the
changed Effect alters browser behavior that cannot be covered without a browser.
Run verification that exercises the claimed failure or measures the unnecessary
work. Confirm any cited lint rule is enabled. If required tools or checks are
unavailable, report the limitation and create no PR.

In each draft PR, explain the Effect's location and classification, why the old
Effect was incorrect, its reachable trigger, the relevant caller/lifecycle
evidence, the selected refactor, and the verification command and result.
