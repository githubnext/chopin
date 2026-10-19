# Releasing the chopin CLI

The `chopin` CLI is the connector in `apps/connector`, compiled into one
executable per platform. It is released as GitHub release assets of this
repository by [`.github/workflows/release-cli.yml`](../.github/workflows/release-cli.yml),
and installed with the scripts in `apps/connector/install`. See
[Use your own machine with Chopin](chopin-cli.md) for the user side.

## One-time setup

The publish job uses the `chopin-cli-release` environment, and its required
reviewers are the release's human approval. GitHub creates an environment that a
job names but that does not exist, with no protection, so the workflow's
`preflight` job checks the environment before publish runs and fails the release
unless:

- the environment exists;
- it has a **Required reviewers** rule with at least one reviewer; and
- its **Deployment branches and tags** are limited to **Selected branches and
  tags**, and the only rule is the tag pattern `cli-v*`.

The preflight reads these settings with the workflow's own `GITHUB_TOKEN`; the
job needs only `actions: read`, so no extra secret is involved.

A repository administrator sets the environment up once, in
**Settings → Environments** (`https://github.com/githubnext/chopin/settings/environments`)
or with `gh api`:

1. Look up the numeric id of each reviewer, a user or a team:

   ```sh
   gh api users/<login> --jq .id
   gh api orgs/githubnext/teams/<team-slug> --jq .id
   ```
2. Create the environment with its reviewers (up to six; `"type": "Team"` for a
   team), limited to selected branches and tags:

   ```sh
   gh api --method PUT repos/githubnext/chopin/environments/chopin-cli-release --input - <<'EOF'
   {
     "reviewers": [{ "type": "User", "id": <reviewer-id> }],
     "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
   }
   EOF
   ```
3. Allow only `cli-v*` tags to deploy to it:

   ```sh
   gh api --method POST repos/githubnext/chopin/environments/chopin-cli-release/deployment-branch-policies \
     -f name='cli-v*' -f type=tag
   ```
4. Check the result. The environment should list a `required_reviewers` rule,
   and the policies only `cli-v*` of type `tag`:

   ```sh
   gh api repos/githubnext/chopin/environments/chopin-cli-release \
     --jq '{protection_rules: [.protection_rules[] | {type, reviewers: [.reviewers[]?.reviewer.login]}], deployment_branch_policy}'
   gh api repos/githubnext/chopin/environments/chopin-cli-release/deployment-branch-policies \
     --jq '[.branch_policies[] | {name, type}]'
   ```

## Cut a release

When a change to the connector breaks compatibility with servers that are
already deployed, raise `CONNECTOR_PROTOCOL` in `apps/connector/src/version.ts`,
and the range a server accepts in `CONNECTOR_PROTOCOLS` in
`apps/server/src/experiments/routes.ts`. A server refuses a connector outside
its range and tells the person to run `chopin update <version>`.

Connector protocol 2 pairs a machine once and connects checkouts with its
stored machine token; a protocol 1 connector cannot connect to a server that
speaks it. Publish a `chopin` release built with protocol 2 before deploying a
server with this change, so `chopin update` has a release to install; the first
published release is `cli-v0.0.1`.

Connector protocol 4 adds the Planner poll: a connector run with
`--planner-command` also calls `wait_for_work` with the documents whose
Planners it runs, and the server answers with the ones its owner chose the
machine for. A server older than protocol 4 refuses a protocol 4 connector, so
deploy the server first, then publish a release built with protocol 4.

Connector protocol 6 includes the claimed document ID on build renewals and
status reports, so a completed rebuild can finish after assignment cleanup.
Older servers reject that extra field. Deploy the protocol 6 server first,
then publish a release built with protocol 6. The server still accepts protocols
2 through 5; their controllers omit the document ID and keep their existing
assignment-based behavior.

A server recommends the version in its own `apps/connector/package.json`
unless `CONNECTOR_VERSION` names another, and `chopin update` with no version
installs that release. Publish a release before deploying a server whose
`package.json` names it, or set `CONNECTOR_VERSION` to a published release
meanwhile; until then, `chopin update` against that server cannot download
what it recommends.

1. Set `version` in `apps/connector/package.json` to the new version, for
   example `0.2.0`, and merge that change. A release whose tag differs from
   this version fails before anything is built.
2. Optionally, run the **release-cli** workflow by hand from **Actions** with
   that version. This dry run builds the five binaries and runs the Microsoft
   Defender scan, but publishes nothing.
3. Tag the merged commit and push the tag:

   ```sh
   git tag cli-v0.2.0 <commit>
   git push origin cli-v0.2.0
   ```
4. The workflow builds `chopin-linux-x64`, `chopin-linux-arm64`,
   `chopin-darwin-x64`, `chopin-darwin-arm64` and `chopin-windows-x64.exe`,
   writes `checksums.txt`, and scans the Windows binary with Microsoft Defender
   on updated signatures. A detection fails the release. A read-only `sbom`
   job generates SPDX and CycloneDX SBOMs of the source and the binaries,
   checks them for secrets, and keeps them as the `chopin-cli-sbom` workflow
   artifact.
5. A `preflight` job checks the `chopin-cli-release` environment as described
   in [One-time setup](#one-time-setup), and the publish job then waits for
   approval of that environment. A required reviewer approves it from the
   workflow run.
6. Once approved, publish verifies the assets against `checksums.txt`, attests
   every binary's build provenance, and creates the `cli-v0.2.0` release with
   the binaries, `checksums.txt`, `install.sh` and `install.ps1`, marked as the
   latest release so the `releases/latest/download/` install commands use it.
   It is the only job that can write, and it runs only actions from GitHub's
   `actions` organization. Every action in the workflow is pinned to a full
   commit SHA.

To check a published binary, download it and run
`gh attestation verify chopin-linux-x64 -R githubnext/chopin`.

If the workflow fails before the release is created, fix the cause, delete the
tag (`git push origin :refs/tags/cli-v0.2.0`) and push it again on the fixed
commit, or release the fix as the next version. Do not replace the assets of a
published release: its `checksums.txt` and attestations name their digests.

The binaries are not code-signed or notarized. Installs through `curl` and
`irm` carry no download mark, so neither Gatekeeper nor SmartScreen blocks them.

## Notes for the next release

- Development builds that installed a service must run `chopin connect`, then
  `chopin service install` again: the service now runs its own copy of the
  settings, which older builds never saved.
