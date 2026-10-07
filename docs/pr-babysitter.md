# PR babysitter

Two workflows keep open, same-repository PRs targeting `main` ready for human
review. Drafts are included and stay drafts. Add the `no-babysit` label to opt a
PR out of both workflows. Fork PRs and PRs targeting another branch are skipped.
Neither workflow approves or merges a PR.

- **Rebase open PRs** runs after a push to `main`, every four hours, or manually.
  It uses the same GitHub GraphQL rebase operation as
  [`gh pr update-branch --rebase`](https://cli.github.com/manual/gh_pr_update-branch),
  with `expectedHeadOid` to reject an intervening branch change. Clean rebases
  start normal PR CI. A conflict leaves the branch untouched and receives one
  comment per head/main pair; authentication or unexpected API failures fail the
  workflow rather than generating comments on every PR.
- **PR CI fixer** runs after a failed or timed-out `ci` run, hourly, or manually.
  Trusted preprocessing selects at most three previously unreported failures on
  current PR heads, oldest updated PRs first. Codex reads the logs, reproduces the
  defect, and proposes a small verified commit through
  [gh-aw's guarded branch output](https://github.github.com/gh-aw/reference/safe-outputs-pull-requests/).
  Uncertain fixes, protected-file changes, and unavailable reproductions receive
  a diagnosis instead. After two consecutive `[ci-fix]` commits, a PR receives
  diagnosis only until another change resets the limit.

Both use one workflow concurrency group, so rebasing and fixing do not run
against the same branches simultaneously. GitHub still guards against human
pushes during either workflow. Repository content and CI logs are treated as
untrusted evidence. The agent has a read-only GitHub credential; its writes pass
through gh-aw's separate inspection and application jobs.

## Setup

Create these **repository Actions secrets** under Settings → Secrets and
variables → Actions:

| Secret                | Purpose                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `CODEX_API_KEY`       | OpenAI API key used by the Codex engine.                                                                                |
| `PR_MAITENANCE_TOKEN` | Fine-grained GitHub PAT restricted to this repository, with **Contents: read/write** and **Pull requests: read/write**. |

The PAT needs organization approval if required by `githubnext`. It is used only
by trusted rebasing and safe-output jobs, never given to the agent. An equivalent
GitHub App installation credential can replace it later. Unlike the automatic
`GITHUB_TOKEN`, it lets branch updates
[trigger normal CI](https://github.github.com/gh-aw/reference/triggering-ci/).
No workflow-write permission is requested: the fixer cannot edit workflows.

The OpenAI key is billed to its API project. See
[Codex authentication](https://learn.chatgpt.com/docs/auth) and
[gh-aw's Codex setup](https://github.github.com/gh-aw/engines/codex/).
The fixer caps the agent at 40 minutes, 120 turns, 500 estimated AI Credits per
run, and 2,000 per rolling day; gh-aw's output inspection has its own budget.

Merge the workflow PR into `main` to activate the schedules and completion
triggers. The Markdown source and its generated `.lock.yml` must both be present.
Use the Actions tab's **Run workflow** button for either manual run. A manual CI
fixer run still obeys deduplication and the two-fix limit. Delete that head's
`pr-ci-fix` comment to request reinvestigation without changing the branch.

## Maintenance

Edit `.github/workflows/pr-ci-fix.md`, then regenerate with the repository's
installed compiler (`gh aw` v0.86.2):

```sh
gh aw compile pr-ci-fix --strict
bun test scripts/pr-maintenance
bun run ci
```

Commit the source and generated workflow together. Review the Actions job
summary for rebases and each PR's latest babysitter comment for fixes or blockers.
A verified local check or queued push does not mean a PR is merge-ready; wait
for GitHub's CI on the latest head and perform the usual human review.
