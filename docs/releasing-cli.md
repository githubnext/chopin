# Releasing the chopin CLI

The `chopin` CLI is the connector in `apps/connector`, compiled into one
executable per platform. It is released as GitHub release assets of this
repository by [`.github/workflows/release-cli.yml`](../.github/workflows/release-cli.yml),
and installed with the scripts in `apps/connector/install`. See
[Install the chopin CLI](local-experiments.md#install-the-chopin-cli) for the
user side.

## One-time setup

A repository administrator must create the `chopin-cli-release` environment in
**Settings → Environments**, add the people who may approve a release as
**Required reviewers**, and preferably limit its deployment tags to `cli-v*`.
Without that environment and its reviewers, nothing stops a pushed tag from
publishing on its own.

## Cut a release

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
   on updated signatures. A detection fails the release.
5. The publish job then waits for approval of the `chopin-cli-release`
   environment. A required reviewer approves it from the workflow run.
6. Once approved, it attests every binary's build provenance, generates SPDX
   and CycloneDX SBOMs (kept as workflow artifacts and checked for secrets),
   and creates the `cli-v0.2.0` release with the binaries, `checksums.txt`,
   `install.sh` and `install.ps1`, marked as the latest release so the
   `releases/latest/download/` install commands use it.

To check a published binary, download it and run
`gh attestation verify chopin-linux-x64 -R githubnext/chopin`.

If the workflow fails before the release is created, fix the cause, delete the
tag (`git push origin :refs/tags/cli-v0.2.0`) and push it again on the fixed
commit, or release the fix as the next version. Do not replace the assets of a
published release: its `checksums.txt` and attestations name their digests.

The binaries are not code-signed or notarized. Installs through `curl` and
`irm` carry no download mark, so neither Gatekeeper nor SmartScreen blocks them.
