# Weekly useEffect review workflow

## Goal

Run a Codex-backed GitHub Agentic Workflow every Wednesday at 09:30 in the
`Europe/London` timezone. It audits every React Effect in the repository and,
when it finds a correctable violation, opens one draft pull request per
independent violation. A run may create at most five pull requests.

## Workflow shape

- Source: `.github/workflows/weekly-use-effect-review.md`; gh-aw generates and
  commits its matching `.lock.yml` file.
- Trigger: cron `30 9 * * 3` with `timezone: Europe/London`, plus
  `workflow_dispatch` for a deliberate manual run.
- Engine: `codex`, authenticated through the repository `CODEX_API_KEY` (or
  `OPENAI_API_KEY`) secret.
- The agent checks `useEffect`, `useLayoutEffect`, `useInsertionEffect`, and
  custom Effect-like hooks. It follows the repository's review-use-effect
  rules: identify the synchronization boundary, classify the intent, prefer
  render-time or event-driven code where appropriate, and audit dependencies,
  cleanup, Strict Mode behavior, stale responses, and lint suppressions.

## Pull request policy

- Only independently reviewable, high-confidence fixes qualify for a PR.
- Each PR changes one violation, targets the default branch, is a draft, and
  contains the finding, rationale, and verification performed.
- Five PRs is a hard per-run limit. Remaining findings are left for later
  runs; no summary issue is created.
- PRs are not stacked and no fallback issue is created.
- Protected files and configuration are blocked. The workflow must not modify
  instructions, manifests, lockfiles, `.github/`, or other protected paths.
- The agent runs the narrowest relevant verification for each fix. It must not
  open a PR if the appropriate check fails or cannot be identified.

## Guardrails and failure behavior

The agent runs with read-oriented repository access. Code writes travel only
through gh-aw's `create-pull-request` safe output, configured with `max: 5`,
draft PRs, blocked protected files, no issue fallback, and no stacked PRs.
Invalid credentials, compilation failures, or failed verification create no
pull request. A run with no violations completes without a PR.

## Acceptance checks

1. `gh aw validate weekly-use-effect-review` accepts the Markdown workflow.
2. `gh aw compile weekly-use-effect-review` generates its lock file.
3. The generated workflow schedules Wednesday 09:30 in London time and offers
   a manual dispatch trigger.
4. The safe-output configuration permits at most five independent draft PRs
   and rejects protected-file changes.
5. The repository is initialized for the Codex engine and has the required
   OpenAI secret before the workflow is pushed and enabled.
