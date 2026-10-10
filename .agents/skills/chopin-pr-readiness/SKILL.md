---
name: chopin-pr-readiness
description: Prepares Chopin pull requests with final-head verification and diagnoses failing checks. Use before opening a Chopin PR, when fixing CI, or when getting a PR ready to merge.
---

# Chopin PR readiness

Keep one writer responsible for each branch through implementation, checks and
handoff. Work in small coherent slices. Read [AGENTS.md](../../../AGENTS.md) for
the repository's current commands, test boundaries and merge rules.

## Prepare

1. Resolve the repository from `git remote get-url origin`. Scope every GitHub
   command to it. Record the branch, base commit and `git rev-parse HEAD`.
2. Check the diff against its intended base. Identify shared files, dependencies
   on other PRs and who owns each branch. Fetch before deciding whether the base
   moved. Chopin permits rebase merging only: keep the proposed history linear.
   Use `gh-stack` when working on a dependent stack, if available.
3. After edits, run `bun run fix` and inspect its changes. Run **`bun run ci`**
   and **`bun run types`** on the proposed source; focused dprint/oxlint runs do
   not cover design contracts. A comment edit can invalidate a whole-file design
   exception hash. Review the affected data flow before renewing it.
4. Run relevant unit/domain tests. Use real Chromium for focus, selection,
   layout, scrolling and browser event ordering. For shared controls or layout,
   include nearby keyboard, navigation and responsive cases. Match the test
   layer to the behaviour; use the current test config to choose the project.
5. Before E2E, check listeners on 8788, 8789, 8791, 8792 and 8797 and coordinate
   shared databases/ports with other work. Stop only processes you own. Build
   this checkout before using `E2E_SKIP_BUILD=1`.
6. For workspace, dependency, lockfile or Docker changes, build the production
   image and exercise the changed runtime imports. Local type and unit checks
   do not prove Docker copied every required workspace or can install native
   dependencies.

## Diagnose red checks

Read the exact failed job/step and inspect its trace or browser summary. Classify
it as a change regression, stale assertion, flaky behaviour, packaging or
infrastructure. Compare with the captured base; a green base alone cannot rule
out a flake. Reproduce the narrow failing case before another full push.

Use `systematic-debugging`, if available. Synchronise browser tests on the real
state or event. Keep assertions that protect behaviour when an approved design
changes. Retry infrastructure once after identifying the cause; repeated
deterministic failures need a fix. Report unresolved failures by name.

## Hand off

Record which source revision each command checked. After another edit or rebase,
refresh the evidence for affected behaviour. Batch small feedback edits locally
before restarting the full CI suite.

Open a regular PR with an accurate description and an inline image using
`pr-visual-preview`. Use `testing-pr-previews` when deployed behaviour needs
verification. Watch **all required GitHub checks on the final head**, including
the browser and container jobs, using `land-prs` if available. Read retry counts
even when the browser job is green.

For CI reporting changes, inspect the uploaded artifact itself. Verify its
contents and recorded revision against the completed job, including retry data.

Handoff: PR URL, final head, verified checks and remaining risks. Preserve the
user's merge-approval boundary: obtain explicit authorisation for the reviewed
PR or identified set once its final checks are ready. Keep it ready until then.
