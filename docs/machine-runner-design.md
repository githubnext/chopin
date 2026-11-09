# Machine runner: one-command install, sandboxed runs and automatic updates

## Goal

Adding a machine to Chopin should take one command and no decisions. Work that Chopin runs on that machine should never touch the person's own files, credentials or network beyond what the run needs. The machine should then keep itself current without anyone running a command, and without stopping work that is under way.

This is a design document and changes no code. It records what install, runs and updates do today, the published designs it draws on (Devin's above all), the alternatives, and a design in six stages that can each ship on its own:

1. **Automatic connector updates.** The service updates itself to the release the server recommends, only when idle, even when the server's minimum has passed it. It verifies a signed release manifest, keeps the previous binary, and a launcher that the swap never replaces rolls back a release that cannot start or connect.
2. **One-command install.** One command, copied from the Machines page with a short-lived pairing key in it, installs `chopin` and the sandbox runtime, pairs, installs the service, detects what isolation the machine can give, and asks for nothing except one operating-system privilege, offered only where it unlocks a microVM.
3. **Runs in a microVM.** Every build, investigation and prototype runs in a fresh Microsandbox microVM. The agent loop stays on the host in the `chopin connect` supervisor, jailed, and an agent that cannot route its tools into the VM is refused; the VM is the hands. Egress is denied by default, and the guest sees only a placeholder for a repository-scoped GitHub App installation token.
4. **Process-sandbox fallback.** A machine without hardware virtualization runs the same work on the host in a clean environment inside a process sandbox: Anthropic's sandbox runtime on macOS and on Linux where bubblewrap can make a user namespace, a Landlock-and-seccomp sandbox on Linux where it cannot (Ubuntu 24.04 and later, which no privilege step changes), and MXC on Windows. The sandbox never holds a GitHub credential; the connector clones, pushes and opens pull requests for it. The Machines page says which sandbox a machine uses, and a machine that has none takes no work until its owner chooses.
5. **Blueprints and snapshots.** A Devin-style `.chopin/blueprint.yaml`, drafted by the agent, is built into a snapshot that every run boots from. A failed build never replaces the last good snapshot. Idle runs sleep and wake.
6. **Desktop, browser and live view.** The VM has a full Linux desktop with Chrome, a computer tool, live view and takeover, VS Code in the browser, and "Test the app" recordings attached to the pull request.

The eight maintainer decisions that shape this design are recorded in [Maintainer decisions](#maintainer-decisions), each with where it is applied and any refinement or exception, which [Open questions](#open-questions) asks about again. The update stage builds on Stage 4 ("Connected machines") of the zero-downtime upgrades design in [PR #791](https://github.com/githubnext/chopin/pull/791) (branch `zero-downtime-design`, not yet on `main`); [What changes relative to #791](#what-changes-relative-to-791) says exactly what is kept, resolved and replaced.

Every `path:line` citation was read in this checkout (base `adb17d09`). **(inferred)** marks a conclusion drawn from code or documentation that was not run. Results from the Microsandbox spike are marked **(spike)**, and results of a Landlock experiment run for this document are marked **(experiment)**; both ran on Ubuntu 24.04 and are described in [Proven, inferred and untested](#proven-inferred-and-untested). Unknowns are collected in [Open questions](#open-questions).

## Decision: the process sandbox goes first, through MXC, and replaces the microVM plan for now

The maintainer chose to do what Codex CLI and Claude Code do: run each agent on
the person's machine inside the operating system's own process sandbox, with no
microVM, separate filesystem or image, and no new infrastructure. The sandbox is
MXC (`@microsoft/mxc-sdk`, 1.0.0 request contract, telemetry never opted in) on
every system: Seatbelt on macOS, bubblewrap on Linux and ProcessContainer on
Windows 11 24H2 and later. It is built, and it replaces Stage 3's Microsandbox
microVM and Stage 4's srt and Landlock tiers for now; decisions 3 and 5 below,
and the Microsandbox, srt and Landlock reviews, stay as the record of what was
considered and are not built. Auto-update, the one-command installer,
blueprints, snapshots and the desktop are not part of it.

What was built: one `Sandbox` seam in the connector that every agent and Planner
process a run uses goes through (the two ACP `initialize` start checks, which send
the agent nothing, don't); one MXC policy (writes only to the run's worktree, the places
in its git directory where commits and refs go and its own worktree's entry there,
and the agent's own state; reads of the rest of the disk (on Windows, a
ProcessContainer's baseline: the profile, the tool directories and the working
directory, see the Sandbox section) except
credentials, other runs' files and the machine token; egress denied outright
with a loopback allow-list proxy as the only way out, because no MXC engine
filters by name); a probe that launches a command that does nothing in the same
shape and labels the machine on `chopin status` and the Machines page,
`Sandboxed (macOS Seatbelt / Linux bubblewrap / Windows ProcessContainer)` or
`Not sandboxed: <reason and the one fix>`; and `--require-sandbox`, off by
default, to refuse runs where there is none. The credentials the agent has are
not hidden, as in Codex and Claude Code; the sandbox holds no placeholder for a
GitHub token. Where no sandbox works, runs go on unsandboxed, labeled. See
[Sandbox](chopin-cli.md#sandbox).

On Ubuntu 24.04 and later the fix is one `sudo` that installs `slirp4netns` and
adds an AppArmor profile permitting `userns` for the two programs MXC makes its
namespaces with, instead of lifting the restriction for every program. Of the
earlier plan this makes Landlock unnecessary. MXC's Node SDK could not be used
to start processes, because it makes their streams with `net.Socket({ fd })`,
which Bun does not implement, so the connector runs the executor the SDK package
ships, which takes the same request JSON on all three systems. Linux was run for
real; macOS and Windows were not run on real hardware.

## Today

### Install and pairing

- **Two ways to add a machine.** The Machines page offers **Local**, approved in the browser, and **Cloud**, paired with a single-use key; either way the person copies one command that runs the installer and then `chopin connect` (`docs/chopin-cli.md:29-39`). The Local dialog shows a keyless command and says "It prints a link; open it here and approve" (`apps/web/src/experiments/machine-setup.tsx:432-446`). The Cloud dialog embeds a freshly minted key (`apps/web/src/experiments/add-server.tsx:291-306`). Both commands come from `setupCommand` (`apps/web/src/experiments/setup-commands.ts:105-144`).
- **The agent is a separate step.** "The agent must be installed and signed in first" (`docs/chopin-cli.md:41-44`). The built-in agents install with `npm install -g` and sign in on the machine (`packages/protocol/agents.ts:67-96`).
- **The pairing key.** A key looks like `chopin_k_` and 43 characters (`apps/connector/src/machine.ts:38`). It works for ten minutes (`apps/server/src/experiments/pairing-keys.ts:6-7`), is kept only as a hash in process memory, belongs to the sign-in that minted it, and is revoked by minting another (`:36-43`, `:86-101`). Where machines hold their own GitHub authorization, the key carries it to the machine (`apps/server/src/experiments/routes.ts:1261-1278`, `:1285-1321`). The connector reads it from `--key` or `CHOPIN_PAIRING_KEY`, clears the variable (`apps/connector/src/machine.ts:40-54`), sends it once (`:240-250`), and ignores it on a machine already paired (`apps/connector/src/main.ts:595-600`).
- **The agent is checked before a key is spent.** With `--install-service`, the connector starts the agent once and refuses to pair unless it answers ACP `initialize`, "so a pairing key isn't spent on an agent that can't start or isn't signed in" (`apps/connector/src/main.ts:521-551`).
- **The installers.** `install.sh` serves Linux and macOS on x64 and arm64, installs to `~/.local/bin` and says "Nothing here needs, or asks for, administrator rights" (`apps/connector/install/install.sh:19`, `:86-88`). Without a version it installs the newest release, not the server's recommendation (`:123-132`). It always checks the SHA-256 against `checksums.txt`, and checks the build provenance attestation only when `gh` is installed (`:150-163`). Given `connect` or `pair`, it runs that command once installed (`:34-42`, `:190-198`). `install.ps1` serves Windows x64 only (`apps/connector/install/install.ps1:27`), installs to `%LOCALAPPDATA%\chopin\bin` and needs no administrator rights (`:19-20`).
- **Deployment setups.** `CHOPIN_SETUP_AGENTS` lets a deployment put its own setup command, a template with `{key}`, `{name}` and `{origin}`, before the built-in agents (`packages/protocol/agents.ts:41-55`, `docs/self-hosting.md:491-525`). A wrapper that runs `chopin connect` and `chopin service install` with `--key` fits there **(inferred)**.

### The service

- The service is a systemd user unit on Linux, a LaunchAgent on macOS and a Task Scheduler task on Windows (`apps/connector/src/service.ts:12-18`). On Linux it needs linger; when `loginctl` refuses to enable it, install stops and prints `sudo loginctl enable-linger` for an administrator to run (`:366`, `:883-902`).
- Each manager restarts a connector that exits: systemd with `Restart=always` after 5 s and no start limit (`apps/connector/src/service.ts:190`, `:197-198`), launchd with `KeepAlive` and a 10 s throttle (`:240-243`), Task Scheduler up to 999 times a minute apart (`:329`). On Windows the task runs only while the person is logged on (`:368-369`), and a stop request goes through a file, because Task Scheduler sends no signal (`:1002-1046`, `apps/connector/src/main.ts:576-577`).
- `chopin service status` reports `restart-pending` when the running connector's version differs from the installed binary's (`apps/connector/src/service.ts:1048`, `:1179-1194`). The connector's lock records the version it runs (`apps/connector/src/workspace.ts:236-246`).

### Updates

- **`chopin update`** (`apps/connector/src/main.ts:908-919`) installs the version named, else the one `GET /api/connector/version` recommends, else the newest release (`apps/connector/src/update.ts:172-186`, `:229-240`). An older release needs `--allow-downgrade` (`:245-250`). It downloads the asset and `checksums.txt` and checks the SHA-256 (`:256-271`). **It verifies a signature only if `gh` is installed** and `CHOPIN_VERIFY_ATTESTATION` is not `0` (`:277-290`). It runs the download with `--version` (`:291-298`) and replaces the binary atomically, on Windows by renaming the running `.exe` aside (`:105-148`); the next start deletes the old one (`:150-155`, `apps/connector/src/main.ts:905`).
- **An update stops running work.** `restartAfterUpdate` restarts a running service at once (`apps/connector/src/service.ts:1429-1464`), and the connector's SIGTERM handler reports running work as stopped (`apps/connector/src/main.ts:568-575`).
- **Version checks on the server.** The connector speaks protocol 6 (`apps/connector/src/version.ts:3-9`). The server accepts protocols 2 to 6 (`apps/server/src/experiments/routes.ts:232`) and refuses anything else with `connector-update-required`, naming the command that fixes it (`:270-301`), as HTTP 409 (`:1246`). `GET /api/connector/version` publishes the range and the recommended release (`:1251-1253`), which is `CONNECTOR_VERSION` or the connector version built beside the server (`apps/server/src/config.ts:196-210`, `docs/releasing-cli.md:89-94`).
- **A refused service loops.** The connector classifies the 409 as `update-required` (`apps/connector/src/machine.ts:478`) and stops with the server's message (`apps/connector/src/connection.ts:34-49`, `:271-277`). The process exits with status 1 (`apps/connector/src/main.ts:929-935`), and systemd, with no start limit, starts it again every 5 s into the same refusal **(inferred)**.
- **The Machines page** shows an **Update** badge and a **Copy update command** item when a machine runs another version than the recommended one (`apps/web/src/experiments/machine-list.tsx:222-231`, `:469-477`); the command is a plain `chopin update` (`apps/web/src/experiments/setup-commands.ts:73-74`).

### Where work runs

- **One run at a time, on the host.** The work loop awaits each run before it polls again (`apps/connector/src/connection.ts:386-424`) and counts runs in progress (`:195-204`). A run gets a worktree from a registered checkout or a clone in the base dir (`apps/connector/src/run.ts:240-256`, `apps/connector/src/workspace.ts:524-563`), and the agent is spawned as a host process in that worktree with the connector's own environment plus the run's variables (`apps/connector/src/acp.ts:56-68`, `:195-201`; `apps/connector/src/run.ts:277-287`).
- **The agent executes its own tools.** `initialize` offers no client capabilities (`apps/connector/src/acp.ts:130-136`). The documentation says it plainly: "Local execution uses the agent's ordinary OS permissions, skills and configured services. A worktree organizes edits; it is not a sandbox." and "The connector does not advertise client-hosted filesystem or terminal tools; supported agents execute their own local tools." (`docs/local-experiments.md:94-100`). The built-in agents approve their own tools: Copilot CLI with `--allow-all`, Atomic with `ATOMIC_ACP_HEADLESS=1` (`packages/protocol/agents.ts:67-96`).
- **Prototypes refuse pushes by configuration only.** A spike's environment rewrites every push URL to a scheme Git cannot push to (`apps/connector/src/workspace.ts:496-509`). The agent's process could undo that by setting its own Git configuration **(inferred)**.
- **Builds use sub-agents and extra worktrees.** The build prompt requires sub-agents and gives the agent a folder for extra worktrees (`apps/connector/src/implementation.ts:119-139`, `apps/connector/src/run.ts:283-284`). Processes the agent started are stopped when the run ends (`apps/connector/src/run.ts:454-459`).
- **A shared machine** runs teammates' work as its owner, and "the agent runs with the owner's GitHub account" (`AGENTS.md:189-194`).

### GitHub credentials

- The server gives a machine its owner's **user-to-server token** of the GitHub App, for a repository the owner can push to and the installation can write (`apps/server/src/experiments/machine-github.ts:1-6`, `:30-57`; route at `apps/server/src/experiments/routes.ts:1569-1586`). The connector writes it to a 0600 file, renews it 25 minutes before expiry (`apps/connector/src/github-token.ts:4-5`, `:27-32`), and gives the agent `GH_TOKEN`, `GITHUB_TOKEN` and a credential helper that reads the file (`:105-122`, `:150-173`). Pushes and pull requests are made "as you" (`docs/chopin-cli.md:670-690`).
- A user-to-server token is not scoped to one repository; it reaches every repository that the person and the installation share **(inferred from GitHub's token model)**.
- **The server holds no App private key.** Its GitHub App settings are the slug, client ID and client secret (`docs/self-hosting.md:382-384`), and no code in `apps/server/src` mints installation access tokens (a search for the installation-token endpoint found none). It cannot issue a repository-scoped installation token today.

### Releases

- A `cli-v*` tag (`.github/workflows/release-cli.yml:8-10`) builds five binaries (`apps/connector/scripts/build-binaries.ts:13-19`), writes `checksums.txt` (`.github/workflows/release-cli.yml:78-84`), attests build provenance (`:303-310`) and publishes the binaries, checksums and both installers (`:312-342`). The publish job runs only after a reviewer approves the `chopin-cli-release` environment (`:279-291`, `docs/releasing-cli.md:115-125`).
- "The binaries are not code-signed or notarized" (`docs/releasing-cli.md:135-136`).
- CI compiles the Linux and Windows binaries, runs a bridge smoke test from the Linux one, starts the Windows one on Windows and tests `install.ps1` against a fake release (`.github/workflows/ci.yml:424-474`).

### The starting point: #791's Stage 4

The zero-downtime design in PR #791 ends with "Stage 4: connected machines". Its sections say:

- **Update only when idle.** `chopin update` installs the binary and, for a running service, sets the existing `restart-pending` state instead of restarting at once; the connector restarts itself when idle, meaning "no build or investigation running, and no Planner backend holding a live run or an open question". `chopin update --now` keeps today's behaviour, and `chopin status` says that an update is waiting.
- **Optional automatic update.** A service could install the server-recommended release when idle, left as "a product and supply-chain decision" in its open question 11 ("Connector support").
- **Resume paused runs afterwards.** Builds need nothing because idle means none runs; Planner backends could save a resumption descriptor and resume across their own restart, which needs that design's persisted Planner holds.
- **What cannot be done to a running agent.** The connector owns the coding agent's standard input and output over ACP, so a connector restart ends the agent's conversation; hence idle-only.
- **Support window.** Keep the current connector protocol and the two before it; raise the minimum only after 30 days of logs show no machine below it, after one release advertised a `deprecatedBelow` field and a date; never refuse calls that belong to a build already running.
- Its size was M, about 3–5 engineer-weeks.

## Reference review

Each source below was opened for this document on 2026-11-07.

**Devin's design.** This design copies it as closely as Chopin's shape allows (decision 1).

- [What We Learned Building Cloud Agents](https://cognition.com/blog/what-we-learned-building-cloud-agents): containers share a kernel, "making a kernel-level escape a real security threat", so every Devin session gets a microVM with its own kernel; "agents running in dedicated VMs can use a full browser, desktop applications, and arbitrary tool stacks"; and Devin snapshots "full machine state at the hypervisor level — memory, process trees, and filesystem", so compute shuts down while idle and the session resumes "when a CI result or review comment arrives". _Decision here:_ a microVM per run, snapshots, and sleep and wake.
- [Devin environment blueprints](https://docs.devin.ai/onboard-devin/environment/blueprints): a blueprint is built into a snapshot, "a frozen, bootable image of the environment that sessions start from"; `initialize` runs during builds only, `maintenance` runs during builds and "is surfaced to the agent at session start (not auto-executed)", `knowledge` "is reference information, not executed", and `clone` overrides clone defaults for a repository. "Every session boots a fresh copy". Devin "inspects your repository, figures out which tools, runtimes, and dependencies are needed, and generates the blueprint for you". After a failed build "The snapshot is not usable", while "By default, Devin uses the latest successful build's snapshot"; builds refresh about every 24 hours, and steps time out after 3 hours. _Decision here:_ `.chopin/blueprint.yaml` with the same four sections and the same semantics (decision 2).
- [Devin Outposts](https://docs.devin.ai/cloud/outposts/overview): "Devin's agent loop (inference and planning) continues to run in Devin's cloud, while all command execution, file edits, and repository access happen on machines you operate". A worker "opens an outbound connection", "claims" a waiting session, and needs only "outbound HTTPS access". Optional dependencies are ffmpeg for recordings, Chrome, and a display ("Linux machines need a running X session (`DISPLAY` set for the worker, e.g. Xvfb)"). Cognition notes that Outposts "shifts significant infrastructure and operational responsibility to the customer", including isolation. _Decision here:_ Chopin's connector already has the Outposts shape (outbound only, claim, run); the missing piece is the isolation Devin leaves to the customer, which this design supplies with a microVM on the person's own machine.
- [Devin Computer Use](https://docs.devin.ai/work-with-devin/computer-use): a full desktop, a computer tool, and a Chrome instance whose CDP endpoint listens on port 29229 (stated in the page's translated versions), so Playwright scripts can drive the same logged-in browser. _Decision here:_ the same desktop and browser in the guest image (Stage 6).
- The research notes behind this document also cover live view and takeover over VNC, "Use Devin's machine" opening VS Code on the VM, and "Test the app" recordings; those pages were not re-read for this revision, so their details are cited from the notes, not quoted.

**Microsandbox** ([superradcompany/microsandbox](https://github.com/superradcompany/microsandbox), Apache-2.0). A local-first microVM runtime on libkrun. Its README lists "Linux with KVM, macOS with Apple Silicon, or Windows 11 with WHP enabled" and calls Windows support "preview". The 0.7.13 SDK declares full (memory and disk) and disk-only snapshots, forks, volumes, port publishing and secret environment variables in its type definitions; the spike ran only image boot, exec, network policy and secret substitution **(spike)**. _Decision here:_ the microVM backend (decision 3).

**smolvm** ([smol-machines/smolvm](https://github.com/smol-machines/smolvm/), Apache-2.0). "Branchable microVMs for AI agents", embeddable, with a declarative Smolfile and a portable `.smolmachine` artifact, on macOS, Linux and Windows. _Decision here:_ the named alternative. It was not spiked; the hands interface in Stage 3 keeps the backend replaceable.

**Anthropic sandbox runtime** ([anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime), `srt`, Apache-2.0, a "Beta Research Preview"). It wraps a process tree with `sandbox-exec` on macOS and bubblewrap on Linux, with network access only through host proxies that enforce domain allow lists. Writes are allow-only; reads are allowed except denied regions. `credentials` with `mode: "mask"` "puts a sentinel in its place inside the sandbox and has the proxy substitute the real value back on egress", which needs TLS termination. On Linux it needs bubblewrap, socat and ripgrep, and "Both bubblewrap and the seccomp isolation layer need capability-bearing user namespaces": on Ubuntu 24.04 and later the AppArmor restriction must be relaxed (`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, or an AppArmor profile that grants `userns`). It has no mode without them. Its default Windows backend needs an elevated install; its experimental `windows.backend: 'mxc'` uses MXC instead. _Decision here:_ the fallback on macOS and on Linux where bubblewrap already makes a user namespace, with its Linux dependencies bundled. No privilege step changes which Linux machines have one. Its masking is not used, because the process sandbox holds no GitHub credential at all (Stage 4).

**Landlock and seccomp** (the kernel's [Landlock documentation](https://docs.kernel.org/userspace-api/landlock.html) and the [`seccomp_unotify(2)`](https://man7.org/linux/man-pages/man2/seccomp_unotify.2.html) manual page). Landlock "empowers any process, including unprivileged ones, to securely restrict themselves". It first appeared in Linux 5.13 and must be among the kernel's enabled security modules. It restricts files by hierarchy and, from ABI 4, TCP bind and connect by port (UDP from ABI 10), never by address; a sandboxed process may ptrace, and so read the sensitive `/proc` files of, only processes in its own domain. Seccomp user notification lets a supervisor answer a trapped system call, and from Linux 5.9 install a file descriptor of its own in the caller (`SECCOMP_IOCTL_NOTIF_ADDFD`). The manual page warns that letting a trapped call continue "can not be used to implement a security policy", because the caller can rewrite its arguments meanwhile. _Decision here:_ the Linux fallback where bubblewrap cannot make a user namespace, built so that no trapped call ever continues (Stage 4).

**MXC** ([microsoft/mxc](https://github.com/microsoft/mxc/), Microsoft Execution Containers, and its "containment options and platform support" and quickstart pages on Microsoft Learn). A policy-driven containment layer with .NET, TypeScript and Rust SDKs. On Windows its process backend is ProcessContainer; MXC v1.0.0's V1 SDKs create ProcessContainer, IsolationSession and WSLc containers on Windows, while "Windows Sandbox, MicroVM, and Hyperlight are experimental". The quickstart needs Windows 11 24H2 or later. srt's README adds what it measured under MXC's BaseContainer tier: no install step and no UAC, but MSYS2 programs such as Git Bash do not start; `network.tlsTerminate` is refused, so request headers cannot carry masked credentials; the network fence admits only the host proxy on loopback, "closed by measurement, not by promise"; and the SDK needs Node 24 or later. _Decision here:_ the Windows fallback (decision 3), with no GitHub credential inside it.

**Computer-use tools.** [agent-browser](https://github.com/vercel-labs/agent-browser/) drives Chrome over CDP, including an existing browser with `--cdp`. [agent-desktop](https://github.com/vercel-labs/agent-desktop) reads and operates desktop apps through the accessibility tree; on Linux it uses AT-SPI over D-Bus, and its Linux examples ran on "Xvfb with the openbox window manager". _Decision here:_ both in the guest image as the computer tool (decision 1).

**GitHub CLI attachments.** [`--attach`](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli) on `gh pr create`, `gh pr edit` and `gh pr comment` uploads images and videos and rewrites local references to the uploaded URL; "You need push access to the repository to attach files." _Decision here:_ the way "Test the app" recordings reach the pull request, untested with an installation token.

**ACP client capabilities.** The ACP SDK the connector pins (1.6.0) defines `fs/read_text_file`, `fs/write_text_file` and the `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill` and `terminal/release` methods, which an agent may call on its client instead of touching the disk itself. _Decision here:_ the first way the agent's hands reach the VM (Stage 3).

**pdd-kit**, a separate project outside this repository, only consumes the CLI: its `pdd-kit connect` runs `chopin connect` and `chopin service install` and passes `--key`. This design keeps both commands and the `--key` flag, so such a wrapper keeps working.

## Approaches considered

Where the agent loop runs:

| Approach                                                                                   | Benefit                                                                                                                                                                       | Cost                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent on the host under `chopin connect`, tools executed in the VM (Devin's split; chosen) | Model credentials and agent state never enter the box the agent's commands control. The connector already owns the agent's ACP connection (`apps/connector/src/acp.ts:93-96`) | Third-party agents execute their own tools today (`docs/local-experiments.md:94-100`). Every agent must route its tools through the connector, and one that cannot is not eligible ([open question 1](#open-questions)). Sub-agents and extra worktrees must route too |
| Agent inside the VM, with its model credential as a host-substituted placeholder           | Works with any agent unchanged: its own tools are already inside                                                                                                              | The brain and its state live where untrusted commands run; the model API must be reachable from the guest; every agent needs its own login inside each VM image. Contradicts decision 1                                                                                |
| Agent and tools on the host as today                                                       | Nothing to build                                                                                                                                                              | No isolation: "A worktree organizes edits; it is not a sandbox"                                                                                                                                                                                                        |
| Agent on the host, its built-in shell pointed at a shim that runs commands in the VM       | No agent cooperation needed for commands                                                                                                                                      | Fragile: agents spawn `bash -c` and other programs directly, not through `$SHELL`, and file edits would need the worktree shared with the host. A shim that misses one path runs code on the host                                                                      |

Sandbox backend (decision 3):

| Approach                                | Benefit                                                                                                                                                                | Cost                                                                                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Microsandbox microVM (chosen)           | Own kernel per run, sub-second start **(spike)**, egress policy and secret placeholders built in **(spike)**, an SDK that loads into a compiled Bun binary **(spike)** | About 117 MB of runtime per platform **(spike)**. `/dev/kvm` access on Linux needs one administrator step. macOS needs a signed binary with the hypervisor entitlement. Windows is preview |
| smolvm microVM (alternative)            | Single binary, branchable machines, macOS, Linux and Windows                                                                                                           | Not spiked. Its snapshot, network-policy and secret features would need the same evaluation                                                                                                |
| Containers (Docker, Podman)             | Familiar, fast                                                                                                                                                         | Shared host kernel, which Devin rejects for agent workloads. Needs a daemon or rootless setup on every platform; Docker Desktop on macOS and Windows runs its own VM anyway                |
| MXC's MicroVM backend                   | One SDK for both tiers on Windows                                                                                                                                      | Experimental and not creatable through the V1 SDK. Windows only                                                                                                                            |
| A full VM manager (QEMU, Lima, Hyper-V) | Mature                                                                                                                                                                 | Seconds to minutes to boot, larger images, administrator steps on every platform                                                                                                           |

Fallback without hardware virtualization (decision 3):

| Approach                                                                                                                      | Benefit                                                                                                                              | Cost                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| srt on macOS and on Linux with user namespaces, a Landlock-and-seccomp sandbox on Linux without them, MXC on Windows (chosen) | No daemon, network allow lists through a host proxy, and a fallback without any privilege on Ubuntu 24.04 and later **(experiment)** | Shared kernel. Three bundled helpers for srt on Linux. The Landlock sandbox is Chopin's own code in the security boundary and weaker than bubblewrap (no PID or mount namespace). MXC needs Windows 11 24H2 or later and breaks Git Bash |
| srt alone on Linux                                                                                                            | One Linux sandbox, maintained elsewhere                                                                                              | No fallback on Ubuntu 24.04 and later: srt has no mode without capability-bearing user namespaces, and Ubuntu's own bubblewrap fails there **(experiment)**                                                                              |
| srt's own Windows backend (`srt-win`)                                                                                         | Masking and a fail-closed network fence                                                                                              | Needs a one-time elevated install that creates a local user account; alpha                                                                                                                                                               |
| No fallback: refuse runs without a hypervisor                                                                                 | One isolation model                                                                                                                  | Cloud VMs without nested virtualization and Intel Macs could not run work at all                                                                                                                                                         |

Environment definition (decision 2):

| Approach                                                           | Benefit                                                                                                                                           | Cost                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.chopin/blueprint.yaml`, Devin's sections, agent-drafted (chosen) | Devin's proven model: build once into a snapshot, boot fresh copies, keep the last good build. Knowledge and maintenance reach the agent's prompt | A new file format to document and validate. The agent must draft and verify it                                                                                                                |
| `devcontainer.json` (the spike's first idea)                       | Widely present in repositories                                                                                                                    | Lifecycle commands mix build-time and session-time work, many images assume Docker features a microVM does not provide, and it has no `knowledge`. Kept only as a hint for the drafting agent |
| A Dockerfile per repository                                        | Precise                                                                                                                                           | People must write and maintain it; no place for maintenance or knowledge                                                                                                                      |

Update verification (decision 6):

| Approach                                                                        | Benefit                                                                                                            | Cost                                                                                                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An Ed25519-signed release manifest, public keys compiled into `chopin` (chosen) | Verified in-process on every machine with no extra tool; one signature covers the binary, runtime and image digest | A long-lived signing key held in the release environment, and a rotation plan ([open question 4](#open-questions))                                           |
| `gh attestation verify` (today, optional)                                       | Keyless; provenance tied to the workflow                                                                           | Runs only when `gh` is installed (`apps/connector/src/update.ts:277-290`), so most services verify only a checksum fetched from the same place as the binary |
| Verify the Sigstore attestation in-process                                      | Keyless and always on                                                                                              | A Sigstore client and trust-root updates inside the binary; heavier than one signature check                                                                 |

How the binary updates (decision 6):

| Approach                                    | Benefit                                                                               | Cost                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A user-level self-updating binary (chosen)  | Same path on every system, no administrator rights, already how `chopin update` works | The updater, its rollback and its signing are Chopin's to maintain                                            |
| OS package managers (Homebrew, apt, winget) | Familiar upgrades                                                                     | Several channels to publish to, updates on the package manager's schedule, often administrator rights         |
| `npm install -g`                            | One channel                                                                           | Needs Node.js, global installs need write access to a shared prefix, and the runtime's native parts are large |

Rolling back a release that cannot start (decision 6):

| Approach                                                                                                                 | Benefit                                                                                                                                 | Cost                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A launcher, a copy of the last release that passed probation, starts the service's binary and counts its starts (chosen) | It counts a start before the new binary runs, so a binary that crashes at load is still rolled back. No second program to build or sign | A second copy of `chopin` on disk and a small resident parent process                                                                                                                                       |
| Probation counted by the new binary itself                                                                               | Nothing new to ship                                                                                                                     | A binary that crashes before its first line never counts, so it is never rolled back                                                                                                                        |
| The service manager's own restart accounting                                                                             | Nothing to ship                                                                                                                         | systemd runs without a start limit, launchd throttles and Task Scheduler retries a fixed number of times (`apps/connector/src/service.ts:190`, `:240-243`, `:329`), and none of them can swap a binary back |
| A dedicated small native launcher                                                                                        | Tiny and rarely changed                                                                                                                 | A second program to build, sign, notarize and update on every platform                                                                                                                                      |

GitHub credential for runs (decision 4):

| Approach                                                                                                                                | Benefit                                                                                                                                                                               | Cost                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Repository-scoped App installation token held by the host: a placeholder in the microVM, nothing at all in the process sandbox (chosen) | One repository, two permissions, one hour; the sandboxed side never holds it **(spike for the placeholder)**. Needs no TLS termination in the process sandbox, so works under MXC too | The server needs the App's ID and private key. Pushes and pull requests come from the App's bot identity, not the person ([open question 2](#open-questions)). In the process sandbox the agent pushes and opens pull requests through the connector's tools |
| srt's credential masking in the process sandbox                                                                                         | `git push` and `gh` work unchanged                                                                                                                                                    | Needs TLS termination and a CA in the sandbox. MXC refuses it, so on Windows the real token would sit inside the sandbox                                                                                                                                     |
| The owner's user-to-server token (today)                                                                                                | Pushes as the person                                                                                                                                                                  | Reaches every repository the person and installation share; today the agent holds it in plain text                                                                                                                                                           |
| The host's `gh` login behind the placeholder under `AUTH_MODE=local`                                                                    | Nothing to configure                                                                                                                                                                  | Not repository-scoped                                                                                                                                                                                                                                        |
| A fine-grained personal access token                                                                                                    | Repository-scoped                                                                                                                                                                     | People must create, store and rotate it                                                                                                                                                                                                                      |

## Maintainer decisions

The maintainers decided the following before this document was written. Each entry says where it is applied. Where the design refines a decision, or cannot apply it everywhere, the entry says so plainly and [Open questions](#open-questions) asks about it again.

1. **Copy Devin's design as closely as possible, including the full desktop and browser.** Applied in Stages 3 and 6: a microVM per run; the agent loop on the host in the `chopin connect` supervisor and the VM as the hands; a Linux desktop in the VM (Xvfb, a light window manager, Chrome with CDP, ffmpeg) with agent-browser and agent-desktop as the computer tool; live view, takeover and browser VS Code relayed to a Machine pane; "Test the app" recordings attached to the pull request.
2. **The environment is a Devin-style blueprint.** Applied in Stage 5: `.chopin/blueprint.yaml` with `initialize`, `maintenance`, `knowledge` and `clone`, drafted by the agent and built into a snapshot; a failed build never replaces the last good snapshot; `devcontainer.json` is not required and is read only as a hint.
3. **Open source first: Microsandbox for microVMs, smolvm as the alternative, and a process-sandbox fallback.** Applied in Stages 3 and 4: Microsandbox behind a replaceable hands interface; without hardware virtualization (no KVM or WHP, an Intel Mac, or a declined privilege), runs use the host in a clean environment inside Anthropic's sandbox runtime on Linux and macOS or MXC on Windows, and the Machines page shows which. **Refinement:** on Linux where bubblewrap cannot make a user namespace (Ubuntu 24.04 and later, which no privilege step changes), the process sandbox is a Landlock-and-seccomp sandbox in the connector instead, because srt has no mode without user namespaces; without it decision 5's fallback would not exist there ([The Landlock tier](#the-landlock-tier), [open question 13](#open-questions)).
4. **GitHub access is a repository-scoped App installation token behind a placeholder, and egress is denied by default.** Applied in Stages 3 and 4. The default allow list is the Chopin server, the model API, GitHub and package registries. Two refinements and one exception:
   - **Refinement:** in microVM mode the agent runs on the host (decision 1), so the guest's own list leaves out the model API and the Chopin server, which only the host-side agent needs ([Network rules](#network-rules)).
   - **Refinement:** in the process sandbox the sandboxed side does not get a placeholder either. It holds no GitHub credential at all, and the connector clones, pushes and opens pull requests for it on the host ([GitHub through the connector](#github-through-the-connector)). This is stricter than a placeholder, and the only way to keep the token out of the sandbox under MXC, which cannot terminate TLS ([open question 14](#open-questions)).
   - **Exception:** under `AUTH_MODE=local` without the App's private key there is no installation token. The sandboxed side still holds nothing, never the host's `gh` login. The connector uses the person's own Git and `gh` login on the host, as local mode does today, and only for the run's repository and branch, so the repository scope is enforced by the connector's code rather than by the credential ([open question 3](#open-questions)).
5. **Install is one command with an embedded short-lived pairing key.** Applied in Stage 2: `curl | sh` on macOS and Linux and `irm | iex` on Windows; it installs `chopin`, the sandbox runtime and an agent bundle where relevant, pairs, installs the service, detects isolation, pre-pulls the base image, and asks for no AI or GitHub login. The only extra prompts are one `sudo` on Linux for `/dev/kvm`, where this user cannot open it (the service then starts under `sg kvm`), an administrator prompt and a reboot on Windows to enable Windows Hypervisor Platform, and none on macOS, whose binary is signed and notarized with the `com.apple.security.hypervisor` entitlement. No other privilege is asked for: the Linux step does not touch user namespaces or AppArmor, and a machine without a usable `/dev/kvm` gets no step at all. Without the privilege the machine works at once in fallback mode on macOS, on Windows 11 24H2 and later, and on Linux wherever bubblewrap can make a user namespace or the kernel has Landlock, which includes Ubuntu 24.04 and later **(experiment)**. **Exception:** two kinds of machine have no process sandbox at all, and the one privilege decision 5 allows does not give them one: Linux with neither Landlock nor usable user namespaces (a kernel older than 5.13, or without Landlock enabled, where bubblewrap cannot make a user namespace), and Windows older than 11 24H2, which cannot jail a microVM's host-side agent even with Windows Hypervisor Platform on. Such a machine is "Not isolated" and is never used silently: it takes no work, and says why, until its owner turns on **Run unisolated** on the Machines page or the machine is upgraded to a newer kernel or Windows. After that every run on it is labelled "Not isolated", and automatic work is still refused ([No isolation is never silent](#detecting-isolation), [open question 7](#open-questions)).
6. **Automatic update is on by default.** Applied in Stage 1: the service updates itself to the server's recommended release only when idle (no build, investigation, or Planner with a live run or open question), verifies checksum and signature, keeps the previous binary, and rolls back if the new one does not start or connect, through a launcher that the swap never replaces. Below the server's minimum the update is forced: it ignores the off switch and the newer-only rule, but still waits for idle. Meanwhile the machine takes no new work, and the server keeps answering the calls of work already running. One release manifest pins `chopin`, the sandbox runtime and the base image digest. The binary is user-level and self-updating; `chopin update` stays for manual updates and downgrades.
7. **There are no users yet, so rollout is 100 % at once.** Applied in every stage: each release goes to every machine on every platform at once, under one manifest. A platform that cannot use a feature in that release reports what it can do (for example `process` instead of `microvm`) rather than waiting for a later wave. There is no percentage rollout, no platform-by-platform sequence and no 30-day deprecation window. What remains protects running work: the idle gate, rollback, and the server answering the calls of work already running.
8. **Connecting AI accounts (Copilot, ChatGPT, Claude) in the web app is out of scope.** It is named as a follow-up in [Out of scope](#out-of-scope). Until it ships, an agent that needs a sign-in on the machine is reported on the Machines page with its sign-in command; install never stops to ask for it.

## Chosen design

The parts and where each runs:

```text
Chopin server  <── HTTPS, outbound only ──  chopin connect (the service, on the host, started by its launcher)
                                              ├─ coding agent over ACP (host; jailed by the process sandbox)
                                              │    └─ its tools → the connector's ACP fs/terminal and chopin-machine MCP
                                              ├─ hands: Microsandbox SDK from runtime/<version>/ ── one microVM per run
                                              │    (or a process sandbox: srt, Landlock or MXC)       ├─ /workspace (clone)
                                              │                                                       ├─ desktop, Chrome, VS Code (Stage 6)
                                              │                                                       └─ egress allow list, placeholder secrets
                                              └─ GitHub installation token and model credentials (host only)
```

### Stage 1: automatic connector updates

The outcome: every connector run by the service updates itself to the release its server recommends, within about an hour of the recommendation changing, whenever the machine is idle. A connector whose protocol the server's minimum has passed takes no new work until it is idle, then updates. It never stops running work, and it returns to the previous release by itself if the new one cannot start or connect. Nobody has to run a command.

#### The release manifest

Each `cli-v*` release gains two assets, `manifest.json` and `manifest.json.sig`. The manifest names everything a machine runs for that release, with each file's size and SHA-256:

```json
{
	"version": "0.1.0",
	"protocol": 7,
	"chopin": {
		"linux-x64": { "asset": "chopin-linux-x64", "sha256": "…", "size": 123 }
	},
	"runtime": {
		"linux-x64": {
			"asset": "chopin-runtime-linux-x64.tar.zst",
			"sha256": "…",
			"size": 123,
			"microsandbox": "0.7.13"
		}
	},
	"image": {
		"reference": "ghcr.io/githubnext/chopin-runner",
		"digests": { "linux/amd64": "sha256:…", "linux/arm64": "sha256:…" }
	},
	"processSandbox": {
		"linux-x64": { "asset": "chopin-sandbox-linux-x64.tar.zst", "sha256": "…", "size": 123 }
	},
	"agents": { "atomic": { "linux-x64": { "asset": "…", "sha256": "…", "size": 123 } } }
}
```

- `runtime` and `image` appear from Stage 3, `processSandbox` with the first of Stages 3 and 4 (it also jails Stage 3's agent), and `agents` from Stage 2; a manifest before then names only `chopin`. One manifest is one tested combination. A machine never mixes parts of two manifests, so a runtime or image fix ships as a `chopin` release (decision 6). The launcher below is a copy of `chopin`, not another asset.
- The publish job signs the manifest with an Ed25519 key held as a secret of the `chopin-cli-release` environment, which only runs after a reviewer approves it (`.github/workflows/release-cli.yml:279-291`). `chopin` carries the current public key and the next one, so the key can rotate across one release.
- `chopin` verifies the signature in-process and then each file's SHA-256 against the signed manifest. Bun's WebCrypto supports Ed25519 **(inferred; to confirm in the compiled binary)**. `checksums.txt` and the provenance attestations stay for people and for the installers, and `gh attestation verify` still runs as an extra check where `gh` is installed.

#### When a service updates

- **Checks.** At start, then every 60 minutes with up to 15 minutes of jitter, and at once on a 409 `connector-update-required`. The check reads `GET /api/connector/version`, which already returns the protocol range and recommended release (`apps/server/src/experiments/routes.ts:1251-1253`). A registration answer may also carry the recommended version, an additive field older connectors ignore, so a server deploy is noticed without waiting for the hourly check **(inferred)**.
- **Target.** The recommended release when it is newer than the running one. An older recommendation is installed automatically only when the running connector's protocol is outside the server's range; otherwise a downgrade stays manual (`chopin update <version> --allow-downgrade`).
- **Who updates.** Only the service. A connector a person runs in a terminal says an update is available and how to install it, but never replaces itself under that terminal.
- **Off switch.** On by default (decision 6). `chopin service install --no-auto-update` turns it off for a person who pins a version. A connector below the server's minimum still updates, at its next idle moment, because the server gives it no new work. The off switch never protects running work; the idle gate does, for every update.

#### The idle gate

Idle means all of:

1. **No run.** No build, investigation or prototype running or claimed: the work loop's `running` count is zero (`apps/connector/src/connection.ts:195-204`).
2. **No busy Planner.** No Planner this machine runs has a live run or an open question. The connector cannot see that, because Planner backends are separate commands that attach to the server on their own (`apps/connector/src/main.ts:621-641`). The server holds the attachments, their runs and their questions. Connector protocol 7 adds a read-only `machine_activity` call that names the documents whose Planners on this machine are busy. A connector talking to a server without the call treats every Planner backend it runs as busy **(inferred to be safe)**.
3. **Nobody watching.** No person is attached to a run's live view or VS Code (Stage 6).

Once idle, the connector stops polling for work, checks idleness once more to close the race with a claim answered meanwhile, swaps the binary and restarts. Work offered in that gap waits in the server's queue for the machine **(inferred)**. The gap is a restart: about 5 s under systemd and up to a minute under Task Scheduler (`apps/connector/src/service.ts:197-198`, `:329`). An idle Planner backend is stopped with the connector and attaches again after the restart, so its document may show the Planner disconnected for those seconds **(inferred)**.

A machine that is never idle keeps serving, and `chopin status` and the Machines page say "Update to 0.1.0 waits for the current build to finish".

**A forced update** (the connector's protocol is below the server's minimum) ignores the off switch and the newer-only rule, but waits for the same idle gate, Planners included: an attached Planner backend may hold a live run or an open question even though the server would refuse it a new credential (`apps/server/src/experiments/routes.ts:1503-1506`). Until the machine is idle:

- **The connector takes no new work.** It stops polling for work and does not pair, and it keeps its running build, investigation or prototype and its attached Planner backends. Protocol 7 treats a 409 `connector-update-required` on a request for new work as "update pending", where today's connector stops on it (`apps/connector/src/connection.ts:34-49`, `:271-277`).
- **The server keeps answering the calls of work already running.** Today every connector route refuses a protocol outside the range (`apps/server/src/experiments/routes.ts:270-301`), except a coding agent's own MCP calls that carry no protocol header (`:279`). Below the minimum the server instead answers a connector's calls for the runs it already holds as claimed by that machine, its token renewals and `machine_activity`, and leaves attached Planner backends attached; it refuses only new work, pairing and new Planner credentials. This widens #791's rule that a running build's calls are never refused to all running work.
- **The Machines page says so:** "Update required: waits for the build in score to finish", or "for an open question in Release notes". A machine held below the minimum by a Planner's open question takes no new work until the question is answered or the Planner is stopped ([open question 10](#open-questions)).

Every connector that can update itself speaks protocol 7 or later and behaves this way. An older one stops with today's message, and is updated by hand once (below).

#### Swap, launcher and rollback

The binary stays user-level and updates itself, with no operating-system package manager and no `npm install -g` (decision 6). The previous binary is kept beside it as `chopin.previous` (`chopin.previous.exe` on Windows). From Stage 3 the runtime lives in `<data>/runtime/<version>/` under the user's data directory, and the previous runtime and image stay until the new release passes probation.

**The launcher.** Today the service definition names `chopin` itself (`apps/connector/src/service.ts:180-196`). From this stage it names `chopin-launcher`, a copy of the last release that passed probation, run as `chopin-launcher launch`. It is the same program, so there is nothing else to build or sign, and the swap never replaces it: it is refreshed from the new binary only after that binary has passed probation. The launcher, not the new binary, keeps the count, so a binary that crashes before its first line still counts.

1. **Prepare.** Download and verify the manifest and each file. Run the new binary with `--version`, as today (`apps/connector/src/update.ts:291-298`), and with a new `self-test --server <origin>` that reads the configuration, loads the runtime, fetches `GET /api/connector/version` and checks that its own protocol is in range. Only a binary that passes is swapped in.
2. **Swap.** Extend `replace` (`apps/connector/src/update.ts:105-148`) to keep the old binary as `chopin.previous`, and record `{ from, to, at, starts: 0 }` in `update.json` in the base dir. Then exit with a distinct status, and the service manager starts the launcher again (`apps/connector/src/service.ts:197-198`, `:240-243`, `:329`).
3. **Count.** On every start during probation, the launcher adds one to `starts` and writes it down before it starts the new binary as its child. It stays as a small parent: it passes stop requests on and exits with the child's status, so every exit of the child, at load or later, becomes another start of the launcher.
4. **Acknowledge.** The new binary writes its progress to `update.json`: `waiting-for-server` at each retry while the server does not answer, `refused` while it answers with a refusal, and `connected` after its first successful registration (`apps/connector/src/machine.ts:314-333`). `connected` ends probation, and the launcher then replaces itself with the new binary by the same atomic replace.
5. **Roll back.** Still in probation, the launcher restores `chopin.previous` and the previous runtime, records the failed version and starts the old binary when `starts` passes three, when the binary has been `refused` for ten minutes, or when it has written nothing for ten minutes (a hang, which the launcher ends by stopping it). A server that does not answer is an outage, not the new binary's fault, so time spent `waiting-for-server` counts only while the server answers the launcher: during probation the launcher fetches `GET /api/connector/version` itself once a minute while the child reports `waiting-for-server`, and rolls back when the server has answered it for ten minutes and the child has not connected. The old binary reports "Update to 0.1.0 failed and was rolled back" and does not try that version again until the server recommends another or a person runs `chopin update`.

The first release with the launcher is installed by hand once, with `chopin update` and then `chopin service install`, which rewrites the service definition to name the launcher (`apps/connector/src/service.ts:831-962`).

#### What `chopin update` becomes

- Its arguments stay (`apps/connector/src/main.ts:908-919`). It uses the signed manifest, and for a running service it leaves the service `restart-pending` until idle, as #791 proposed. `chopin update --now` restarts at once, which is today's behaviour.
- `chopin status --json` gains an `update` key (`state`: `current`, `waiting-for-idle`, `required`, `downloading`, `probation`, `rolled-back` or `off`; `target`; `reason`). The report's keys are stable, so the field is additive (`apps/connector/src/status.ts:34-37`).

#### Server and Machines page

- The connector reports its update state in a new optional header. A server ignores a header value it does not expect (`packages/protocol/connector.ts:8-11`).
- The Machines page replaces the **Update** badge with the state: "Updates when idle (build running)", "Update required: waits for the build to finish", "Updated to 0.1.0", or "Update to 0.1.0 failed; back on 0.0.24". **Copy update command** stays only for a connector in a terminal or with automatic updates off.
- The protocol range stays. With no users (decision 7), `min` can be raised in the same deploy as the release that needs it, because every service updates itself at its next idle moment and the server keeps answering its running work meanwhile; a terminal connector gets today's 409 with its fix. The 30-day log gate and the `deprecatedBelow` release from #791 are dropped.

#### Failure modes

| Failure                                                                                                        | Effect                              | Handling                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest signature or a checksum does not match                                                                | Nothing is installed                | Logged and reported; retried at the next check. A mismatch that persists is a release defect                                                                           |
| The new binary exits at once, or crashes at load before its first line                                         | It never registers                  | The launcher counted each start before starting it. After three, it restores `chopin.previous` with no person involved                                                 |
| The new binary runs but the server refuses it, it hangs, or it cannot reach a server that answers the launcher | Probation does not end              | After ten minutes of refusals, of silence, or of `waiting-for-server` while the server answers the launcher, the launcher stops it and rolls back                      |
| The new binary connects but misbehaves later                                                                   | Probation has ended                 | The server can recommend the previous release; a connector outside its protocol range is then downgraded automatically, still only when idle. Otherwise by hand        |
| The launcher copy itself is damaged                                                                            | The service cannot start            | The swap never writes it, so only a damaged disk or a person can. `chopin service install` from either binary writes a new one; this is the one case recovered by hand |
| The machine is never idle                                                                                      | The update waits, forced or not     | Status and the Machines page say why. Below the minimum it takes no new work, and the server keeps answering its running work                                          |
| A claim is answered while the connector decides it is idle                                                     | A build could start during the swap | The second idle check after polling stops                                                                                                                              |
| The server is unreachable during probation                                                                     | No registration                     | Probation waits; only answers from the server count against the new binary                                                                                             |
| Windows: the running `.exe` cannot be replaced                                                                 | —                                   | The existing rename-aside (`apps/connector/src/update.ts:125-144`) and recovery of an interrupted swap (`:90-103`), for the binary and the launcher alike              |
| The signing key leaks                                                                                          | Someone could sign a manifest       | Rotate to the next compiled-in key in a release, then drop the old one; the attestation still ties binaries to the workflow ([open question 4](#open-questions))       |

#### Tests

- **Unit** (extending `apps/connector/src/update.test.ts` and `apps/connector/src/service.test.ts`): signature checks (good, tampered, unknown key, rotated key), checksum mismatch, target choice (newer, older, forced by protocol), the idle gate (running work, busy Planner, a server without `machine_activity`, and a forced update that still waits for each), the launcher's counting and each rollback rule, service definitions that name the launcher, the Windows rename path for binary and launcher, and the `update` status key.
- **Server** (extending `apps/server/src/experiments/routes.test.ts`): below the minimum, a held run's calls, token renewals and `machine_activity` are answered, and claims, pairing and new Planner credentials are refused.
- **Release workflow:** extend `apps/connector/scripts/release-workflow.test.ts` to require the manifest and its signature among the assets.
- **Integration with a fake release and a fake server** (as `apps/connector/install/install.test.ts` does for `install.ps1`): the service updates when idle; waits through a fake build; after a 409 takes no new work, finishes a fake build and keeps a fake Planner's open question, and updates only when both are done; rolls back a replacement that exits at once, one that crashes at load (a truncated binary), one the server refuses, and one that hangs; does not roll back while the server is unreachable.
- **End to end:** a fake connector mid-build is told of a new release, and the build finishes before the restart, in the style of `e2e/build-restart.e2e.ts`; the same with the server's minimum raised past the connector mid-build.

#### Rollout and size

- 100 % at once, on every platform, under one manifest (decision 7). The first release with the updater and the launcher is installed by hand once, because earlier releases do not update themselves.
- **M, about 4.5–6 engineer-weeks:** manifest and signing in the release workflow (1), the idle gate, `machine_activity` and the server answering a below-minimum connector's running work (1–1.5), swap, launcher and rollback under three service managers (1.5–2), status and Machines page (0.5), tests (0.5–1).

### Stage 2: one-command install

The outcome: **Add machine** shows one command for any machine, local or cloud, with a fresh pairing key in it. Run once, it leaves the machine paired, running as a service, isolated as well as it can be, and current. The person is asked nothing, except at most one operating-system privilege, offered only where it turns the fallback into a microVM: a `/dev/kvm` this user cannot open on Linux, or Windows Hypervisor Platform switched off. Declining it never leaves a machine silently unisolated.

#### The command

```sh
curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | \
  CHOPIN_URL=https://your-chopin-instance.example CHOPIN_PAIRING_KEY=chopin_k_… sh -s -- setup --agent copilot
```

```powershell
$env:CHOPIN_URL = 'https://your-chopin-instance.example'; $env:CHOPIN_PAIRING_KEY = ($token = 'chopin_k_…'); Remove-Variable token
& ([scriptblock]::Create((irm https://github.com/githubnext/chopin/releases/latest/download/install.ps1))) setup --agent copilot
```

A bare `irm … | iex` cannot pass arguments to the script, so the PowerShell command keeps the scriptblock form the Machines page already uses for `connect` (`apps/web/src/experiments/setup-commands.ts:128-137`).

- Local and Cloud become one dialog: both mint a key (decision 5), with today's ten-minute lifetime and **Re-generate install script**. Pairing in the browser without a key stays available through `chopin pair`.
- The key travels as today: in the environment of `sh` alone, or set in the PowerShell session and removed by `install.ps1` afterwards (`apps/web/src/experiments/setup-commands.ts:105-120`).
- `install.sh` and `install.ps1` learn a third command, `setup`, beside `connect` and `pair` (`apps/connector/install/install.sh:34-42`). With `CHOPIN_URL` set, they install the server's recommended release instead of the newest one (`:123-132`). The installers keep verifying the binary's SHA-256 over HTTPS, as today; `chopin setup` then verifies the signed manifest for everything else.

#### What `chopin setup` does

1. **Pair** with the key, naming the machine as `--name` or its hostname, exactly as `chopin pair --key` does (`apps/connector/src/machine.ts:240-250`).
2. **Install the release's parts** for this platform from the signed manifest: the sandbox runtime (Stage 3), the process-sandbox helpers (Stages 3 and 4), and an agent bundle where relevant, such as Atomic with `atomic-acp` or a deployment's own bundle, under the user's data directory with its own Node.js. An agent already on the `PATH` that answers ACP `initialize` is used as it is.
3. **Ask for no AI or GitHub login.** Where machines hold their own GitHub authorization, it already arrives with the key (`apps/server/src/experiments/routes.ts:1261-1266`). An agent that cannot start, or is not signed in, no longer stops setup as it stops `connect --install-service` today (`apps/connector/src/main.ts:521-551`). Setup records the failure, which `chopin status` already reports, and the Machines page shows the agent's sign-in command. Signing in from the web app is the follow-up of decision 8.
4. **Detect isolation** (below) and offer the privileged step only when it would give a microVM (a `/dev/kvm` this user cannot open on Linux, or Windows Hypervisor Platform switched off), with a process sandbox to jail the agent, and a terminal is attached.
5. **Install the service** with today's `installService` (`apps/connector/src/service.ts:831-962`), with linger folded into the privileged step where that step is offered on Linux, and today's administrator message otherwise (`apps/connector/src/service.ts:883-902`).
6. **Start the base-image pull** (Stage 3). The service finishes it in the background; the Machines page shows its progress, and a run that arrives first waits for it with "Preparing the machine" on its card.
7. **Say one thing:** "Connected as build-box-1. Isolation: microVM. Preparing the base image in the background."

`chopin connect --install-service` keeps working, so scripts and wrappers such as pdd-kit that pass `--key` to `chopin connect` and `chopin service install` are unaffected. They gain the rest by calling `chopin setup` **(inferred; pdd-kit is outside this repository)**.

#### Detecting isolation

| System  | microVM when                                                                                                           | Process sandbox when                                                                                                                                                                                                                            | Not isolated when                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Linux   | `/dev/kvm` opens read-write for this user. If it exists but answers EACCES, the privileged step can fix it **(spike)** | No usable `/dev/kvm` (a cloud VM without nested virtualization, or the person declined), and either bubblewrap can make a user namespace (srt) or the kernel has Landlock (the Landlock tier, which is what Ubuntu 24.04 gets **(experiment)**) | Neither: user namespaces are unusable and the kernel is older than 5.13 or runs without Landlock enabled             |
| macOS   | Apple silicon with the hypervisor available and a signed `chopin`                                                      | An Intel Mac                                                                                                                                                                                                                                    | Never expected: `sandbox-exec` ships with macOS                                                                      |
| Windows | Windows Hypervisor Platform is on, probed by asking the runtime to create a partition **(inferred)**                   | WHP is off and MXC's process container is available (Windows 11 24H2 or later) and loads                                                                                                                                                        | Windows older than 11 24H2, with or without WHP (there is nothing to jail the host-side agent), or MXC does not load |

The probe runs at setup, at every service start and hourly, so a privilege granted later or a reboot is picked up with no command. The connector reports the result in a new optional header, `chopin-connector-isolation` (`microvm`, `process` with its backend `srt`, `landlock` or `mxc`, or `none`, with a reason), which the owner sees beside the machine's system (`packages/protocol/connector.ts:8-14`). `microvm` also needs a process sandbox to jail the host-side agent (Stage 3), so a machine with a hypervisor but no process sandbox (Windows older than 11 24H2 with WHP on, or a Linux kernel with neither Landlock nor usable user namespaces) reports `none`.

**No isolation is never silent.** A machine whose probe says `none` takes no work. Its row on the Machines page says why ("This kernel has neither Landlock nor usable user namespaces") and offers what would fix it: a kernel with Landlock or usable user namespaces, or Windows 11 24H2 or later. No privilege step applies to these machines, because the one step decision 5 allows does not give them a process sandbox. Its owner may instead turn on **Run unisolated**. Work a person starts then runs on the host as today, and the run card and the machine's row say "Not isolated"; automatic work (`LIVE_BUILD` rebuilds and `LIVE_SPIKES` prototypes, `AGENTS.md:180-188`) is still refused ([open question 7](#open-questions)). This is the exception to decision 5 recorded in [Maintainer decisions](#maintainer-decisions). Until a sandbox stage ships, every machine runs work as today and is labelled "Not isolated"; the refusal starts with the first sandbox stage, since before it every machine would be refused.

#### The privileged step

- **Linux: one `sudo`, only where it unlocks `/dev/kvm`.** Setup offers it only when a `/dev/kvm` exists but this user cannot open it, and a process sandbox exists to jail the agent. It prints exactly what will run, then runs it once:

  ```sh
  sudo sh -c 'gpasswd -a <user> kvm && loginctl enable-linger <user>'
  ```

  `gpasswd` worked for a domain account in the spike, where `/dev/kvm` was `0660 root:kvm` and logind's ACL covered only the active desktop seat **(spike)**. Only when needed, the same script installs a udev rule making `/dev/kvm` 0666 (a distribution without a `kvm` group). The script also enables linger, which the service needs whether or not KVM is involved; without this step, today's administrator message applies (`apps/connector/src/service.ts:883-902`). The new group applies only to new sessions **(spike)**, so the systemd unit's `ExecStart` runs the connector under `sg kvm -c …` and no logout is needed (`apps/connector/src/service.ts:180-196`) **(inferred; `sg` under systemd was not run)**. A machine with no `/dev/kvm`, or with one this user can already open, gets no privileged step; its process sandbox is the Landlock tier, or srt where bubblewrap already makes a user namespace, with no `sudo` involved.
- **Windows: an administrator prompt and a reboot.** Setup asks for elevation to run `Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -NoRestart`, then says "Restart Windows to finish. Until then this machine runs work in the process sandbox." The service's hourly probe notices the change after the reboot.
- **macOS: nothing to ask.** The release must be signed with a Developer ID, carry the `com.apple.security.hypervisor` entitlement and be notarized; today it is none of these (`docs/releasing-cli.md:135-136`). The release workflow gains a signing and notarization step (on a macOS runner, or with a cross-platform signing tool on Linux), with the certificate and notarization key as secrets of the release environment. Every Mach-O in the runtime that calls Hypervisor.framework (at least `msb`, possibly the `.node` addon) is re-signed with the same identity **(inferred; untested)**.
- **Declined, no terminal, or no privileged step offered.** The machine works at once in the process sandbox: srt where bubblewrap can make a user namespace, or on Linux without that the Landlock tier **(experiment)**. The Machines page shows `chopin setup --isolation` where the privileged step would upgrade the machine to a microVM. Nothing else changes when it is run. Only a machine with no process sandbox at all is "Not isolated", and takes no work until its owner chooses (above).

The installers' promise of no administrator rights (`apps/connector/install/install.sh:19`, `apps/connector/install/install.ps1:19-20`, `docs/chopin-cli.md:123-125`) becomes "nothing needs administrator rights; one optional step asks for them to enable hardware isolation".

#### Failure modes

| Failure                                                                               | Effect                                                                         | Handling                                                                                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| The key expired or was used                                                           | Pairing is refused                                                             | Today's message: copy a new command (`apps/connector/src/machine.ts:31-32`)                                           |
| The agent is not signed in                                                            | Runs would fail to start                                                       | Setup finishes; the Machines page shows the sign-in command. The agent's start failure is reported as today           |
| `sudo` is not available, or the password prompt is declined                           | No microVM                                                                     | The process sandbox now (srt, or the Landlock tier); `chopin setup --isolation` later                                 |
| Linux with neither Landlock nor usable user namespaces, or Windows older than 11 24H2 | No isolation                                                                   | No work; the Machines page names the fix, and the owner may choose **Run unisolated**, which labels every run         |
| The group change does not reach the service                                           | The runtime panics with "Error creating the Kvm object: Error(13)" **(spike)** | The probe catches EACCES before any run and reports the fix instead of failing a run                                  |
| The base image pull fails or the disk is full                                         | Runs cannot start in a microVM                                                 | Retried with backoff; the Machines page says why; runs wait, or use the process sandbox once Stage 4 has shipped      |
| Windows: the reboot never happens                                                     | WHP stays off                                                                  | The machine keeps running in MXC (Windows 11 24H2 and later), and the Machines page keeps saying a restart is pending |
| macOS: notarization is missing on a release                                           | Gatekeeper may block, and the hypervisor is refused                            | The release workflow fails if signing or notarization fails; nothing unsigned is published                            |

#### Tests

- **Unit:** the setup command builder for both shells (`apps/web/src/experiments/setup-commands.test.ts`), the isolation probe's decision table with fake hosts (KVM, user namespaces, Landlock, MXC), the privileged script for each combination (group, udev, linger), a check that no privileged step is offered on a machine without a `/dev/kvm` to unlock, `sg` wrapping in the unit, and the refusal of work on a `none` machine until **Run unisolated**.
- **Installers:** `install.sh` and `install.ps1` against a fake release and a fake server, choosing the recommended version and running `setup` (extending `apps/connector/install/install.test.ts`).
- **CI on a KVM runner:** GitHub's hosted Linux runners expose `/dev/kvm` to a udev rule **(inferred; not tried here)**. A job installs from a fake release, pairs with a test key, and checks that the probe reports `microvm`, then `process` with `/dev/kvm` hidden, then the Landlock backend with user namespaces refused.
- **Manual matrix before each change to this stage:** Ubuntu 24.04 with and without KVM and with the privilege declined, a kernel without Landlock, macOS on Apple silicon and Intel, Windows 11 with WHP on and off, and Windows 10 without WHP.

#### Rollout and size

- The new dialog ships for everyone at once (decision 7). The privileged step appears only once a release's manifest carries a runtime (Stage 3), since until then it would unlock no microVM.
- **M, about 4.5–6 engineer-weeks:** `setup` and the installers (1–1.5), the probe on three systems (1), the privileged steps (0.5–1), macOS signing and notarization in the release workflow (1), the Machines page dialog, isolation label and **Run unisolated** (0.5–1), tests (0.5).

### Stage 3: runs in a microVM

The outcome: on a machine whose probe says `microvm`, every build, investigation and prototype runs in its own fresh microVM, driven by an agent whose tools all reach that VM. The agent loop runs on the host under `chopin connect`, jailed; every command, file edit and repository operation of the run executes in the VM. Neither the GitHub token nor the agent's model credentials enter the VM, and the VM can reach only the hosts on its allow list. Shipped alone, this stage refuses what it cannot run that way, with the reason; it never runs an agent and its tools on the host.

#### Packaging the runtime

- A compiled Bun binary does not resolve bare package names, and ignores `NODE_PATH`. The spike's working layout is a `runtime/` folder holding `microsandbox/`, its JavaScript pre-bundled into one file so that `../../native/index.cjs` resolves, and the platform package: on linux-x64 a 42 MB `.node` addon, the 54 MB `msb` and the 21 MB `libkrunfw`, about 117 MB in all. `chopin` loads it with a dynamic `import()` of the bundled entry and sets `NAPI_RS_NATIVE_LIBRARY_PATH` to the `.node` file **(spike)**.
- The release ships that folder as one archive per platform, pinned by the manifest and installed to `<data>/runtime/<version>/`. Microsandbox's documentation lists Node.js 22 or later; Bun 1.4.4 worked for everything the spike ran **(spike)**.
- Microsandbox runs Linux guests on Linux x64 and arm64 with KVM, macOS on Apple silicon, and Windows x64 and arm64 with WHP (preview). `chopin` is released for Windows x64 only (`apps/connector/scripts/build-binaries.ts:13-19`).

#### One run

1. **Claim** the work as today.
2. **Create the VM** from the base image (from Stage 5, from the repository's snapshot), with 2 vCPUs and 4 GiB of memory by default. A cold create with the image cached took 426–488 ms, a warm create 357–368 ms, and the first command 18–25 ms **(spike)**; memory and disk limits were not tested.
3. **Apply the network rules and secrets** below.
4. **Get the repository** inside the guest, over HTTPS with a credential helper that answers `username=x-access-token` and `password=$GH_TOKEN`, where `GH_TOKEN` is only the placeholder. A private clone worked this way, and also with the placeholder in the URL; an `http.extraHeader` with `Authorization: Bearer` did not authenticate **(spike)**. A run whose commit exists only in a registered checkout on the host (`docs/local-experiments.md:78-81`) gets it as a `git bundle` the connector copies into the guest **(inferred)**. Extra worktrees for builds live in the guest too. Under `AUTH_MODE=local` without the App's key, the guest gets no credential at all; the repository arrives as a bundle and leaves through the connector ([GitHub through the connector](#github-through-the-connector)).
5. **Start the agent on the host** with the session's working directory set to the guest path, `/workspace`, and its tools routed to the VM (below).
6. **End:** report as today, stop the VM, and keep its disk until run retention removes it, as worktrees are kept today (`docs/chopin-cli.md:660-668`). A new `chopin run shell <run id>` boots a kept run's disk for inspection.

#### The hands

A run's tools reach the VM through a small `Hands` interface in the connector (execute a command with streaming output, read, write and list files, publish a guest port to host loopback, stop). Its backends are `microvm` (Microsandbox), `process` (Stage 4) and `host` (today's behaviour, used only before a sandbox stage ships and on a machine whose owner chose **Run unisolated**). The agent reaches the hands in three ways:

1. **ACP client capabilities.** `initialize` advertises `fs.readTextFile`, `fs.writeTextFile` and `terminal` instead of nothing (`apps/connector/src/acp.ts:130-136`), and the connector answers `fs/*` and `terminal/*` requests through the hands.
2. **A `chopin-machine` MCP server**, served by the connector beside its existing bridge (`apps/connector/src/run.ts:313-352`), with `shell`, `read_file`, `write_file` and `edit_file` tools (and Stage 6's computer tools), all executed through the hands. Chopin's existing run tools (`read_implementation`, `report_pr` and the rest) are unchanged, except that the investigation bridge's image upload, which reads a file from the worktree today (`docs/local-experiments.md:88-92`), reads it through the hands.
3. **The agent's own execution tools turned off.** A new optional `sandbox` field on `CodingAgent` (`packages/protocol/agents.ts:8-36`) holds the flags and environment that disable an agent's built-in shell and file tools, and the agent versions they were verified with. Copilot CLI and Atomic have not been tried this way ([open question 1](#open-questions)). Sub-agents run inside the agent's process, so they use the same routes **(inferred)**.

**Which agents run in the VM.** This stage runs only an agent whose tools all reach the hands, and checks that rather than trusting it:

- **Before the run.** The agent's entry has `sandbox` settings; the version its ACP `initialize` answer names (`agentInfo`) is one they were verified with; and its `agentCapabilities` accept the `chopin-machine` MCP server. ACP 1.6.0 defines all three fields **(inferred from the SDK's types)**.
- **During the run.** Every tool call the agent reports in `session/update` whose kind touches a machine (`read`, `edit`, `delete`, `move`, `search`, `execute` or `fetch`) must match a request the connector served through the hands. The first one that does not stops the run, and that agent version is marked unrouted on this machine.
- **Otherwise refused.** An agent that fails either check is not started on a microVM machine. The run card says "Copilot CLI can't run its tools inside the VM yet", the Machines page lists for each agent whether it runs in the VM, and the person can pick one that does. Once Stage 4 has shipped, such an agent runs there instead, agent and tools together in the process sandbox and labelled so: Stage 4 widens this stage, which does not depend on it.

**The agent's own jail.** On the host, the agent process itself runs in a process sandbox: it may write only its own state directory and a scratch directory, may not read the person's home beyond its own configuration, and may reach only its model API and the connector's loopback bridge. A built-in tool that slips through therefore cannot touch the host's files or network, and the check above stops the run. The jail is the mechanism Stage 4 uses (srt, the Landlock tier or MXC, [Backends](#backends)), applied to the agent alone; whichever of the two stages ships first builds it ([Order and dependencies](#order-and-dependencies)). A machine that cannot jail the agent, because its probe finds no process sandbox, does not take this stage's work: the agent never runs unjailed on the host.

Permission requests keep today's flow (`apps/connector/src/run.ts:381-406`).

#### Network rules

Egress is denied by default (decision 4); ingress to the guest is denied except the loopback ports Stage 6 publishes. The proposed default allow list, by who needs each entry:

| Entry              | Hosts                                                                                                                | Guest (microVM) | Agent jail (microVM mode) | Process sandbox (Stage 4) |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------- | ------------------------- |
| Chopin server      | `APP_ORIGIN`'s host                                                                                                  | No              | Yes (MCP)                 | Yes                       |
| Model API          | The agent's model endpoints, listed per agent beside its `sandbox` settings                                          | No              | Yes                       | Yes                       |
| GitHub             | `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `uploads.github.com`         | Yes             | No                        | Yes, with no credential   |
| Package registries | npm, PyPI, crates.io, the Go module proxy, Maven Central, RubyGems, and the base image distribution's package mirror | Yes             | No                        | Yes                       |

- Microsandbox enforced a default-deny policy with per-domain allow rules, and blocked `https://example.com` **(spike)**.
- Additions come from the repository's blueprint on its default branch (Stage 5), never from the run's own branch, so an agent cannot widen the list for itself. Who may add hosts beyond that is [open question 9](#open-questions).

#### Secrets

- **GitHub, in the microVM.** `POST /api/connector/github-token` (`apps/server/src/experiments/routes.ts:1569-1586`) gains a run scope. For it the server mints an installation access token for the one repository with only `contents: write` and `pull_requests: write`, valid for an hour. That needs two new server settings, the App's numeric ID and its private key, beside today's App settings (`docs/self-hosting.md:382-384`). The connector holds the token in memory and gives it to Microsandbox as a secret for `github.com` and `api.github.com`. The guest sees only a placeholder (`$MSB_GH_TOKEN…`); the host substitutes the real token for the allowed hosts only. With a placeholder, `GET api.github.com/user` returned the right login, and no real token appeared in the guest's environment or Git configuration **(spike)**. Pushing with an installation token has not been tried: the spike's push dry-run got 403 from both guest and host with the token it used, which points at that token and repository, not the sandbox **(spike)**.
- **Renewal.** A run longer than an hour needs a new token behind the same placeholder. The SDK declares secret-policy modification **(not tried)**; if that does not work, the connector runs its own substituting proxy for the guest, as srt does.
- **Model credentials** never enter the VM, because the agent runs on the host.
- **What changes for people.** Pushes and pull requests come from the App's bot identity, not the person; the guest sets the person's name and email as the commit author **(inferred)**. "Which GitHub account pushes" (`docs/chopin-cli.md:670-690`) and the shared-machine rule (`AGENTS.md:189-194`) change when this ships. [Open question 2](#open-questions) asks whether that attribution is acceptable.
- **`AUTH_MODE=local`** gives machines no token today (`apps/server/src/experiments/routes.ts:1569-1575`), and their runs use the person's own `gh` and Git login (`docs/chopin-cli.md:681-683`). A local server given the App's ID and private key mints installation tokens like any other, and nothing differs. Without them, the guest gets no credential and no placeholder; in particular it never gets the host's `gh` login, which is not repository-scoped. The run's commit arrives as a bundle from the person's checkout, which local mode already requires (`docs/chopin-cli.md:216-220`), and pushes and pull requests go through the connector, which uses that login on the host for the run's repository and branch only. This is the exception to decision 4 recorded in [Maintainer decisions](#maintainer-decisions).

#### GitHub through the connector

Where the sandboxed side may not hold even a placeholder (the process sandbox of Stage 4 on every system, and `AUTH_MODE=local` without the App's key in either mode), the connector does the run's GitHub work on the host:

- **In.** The connector keeps a bare mirror of the repository in its data directory and fetches into it with the credential. A run's clone is made from the mirror before anything runs in the sandbox. In the process sandbox the mirror is readable but not writable from inside, and the run's `origin` fetches from it; a microVM gets it as a `git bundle`. A `fetch_repository` tool refreshes the mirror on request.
- **Out.** The `chopin-machine` MCP server gains `push_branch` and `pull_request`. `push_branch` has the hands write a `git bundle` of the named branch inside the run, imports the bundle into the mirror on the host, and pushes that one branch to the run's repository with the credential. A bundle is data: nothing the run wrote is executed, or read as Git configuration or hooks, on the host **(inferred from Git's bundle format)**. `pull_request` opens, edits, views or comments on pull requests in the run's repository, reading any attachment out of the run through the hands.
- **Inside the sandbox**, `git push` and `gh` find no credential. The run's Git credential helper prints which tool to use instead, and the run's instructions name the tools.
- **The credential** is the installation token where the server has the App's key, so GitHub enforces the repository scope. Under `AUTH_MODE=local` without the key it is the person's own Git and `gh` login on the host, used only for the commands above, so the connector enforces the scope ([open question 3](#open-questions)).

None of this needs TLS termination or a CA inside the sandbox, so it works the same under srt, the Landlock tier and MXC **(inferred; untested)**. Renewing the installation token is the connector's business alone.

#### Failure modes

| Failure                                                                                            | Effect                                                                          | Handling                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/dev/kvm` becomes unusable after setup                                                            | VM creation fails with EACCES **(spike)**                                       | The probe runs before every run; the run waits with the reason on its card, or uses the process sandbox once Stage 4 has shipped, and the Machines page shows the fix                |
| The agent cannot route its tools (no `sandbox` settings, or a version they were not verified with) | It cannot run in the VM                                                         | Refused before it starts, with the reason on the run card and the Machines page; once Stage 4 has shipped, it runs in the process sandbox instead                                    |
| The agent ignores the routing and uses a built-in tool                                             | The tool runs on the host, inside the agent's jail                              | The jail limits it to its scratch directory, its model API and the bridge. The connector sees the unrouted call, stops the run and marks that agent version unrouted on this machine |
| The machine has no process sandbox to jail the agent                                               | The agent cannot be jailed                                                      | The probe reports `none`, so this stage's work is refused and the Machines page names the cause; Stage 2's rules for "Not isolated" apply                                            |
| A command needs a host not on the list                                                             | It fails with a network error                                                   | The agent sees the refusal; the run's log names the denied host so a blueprint can add it                                                                                            |
| The installation token expires mid-run                                                             | Pushes and API calls fail                                                       | Renewal behind the same placeholder, or the connector's own proxy                                                                                                                    |
| The App cannot write the repository                                                                | No token                                                                        | Today's `app-cannot-push` message (`apps/connector/src/github-token.ts:9-13`). Outside `AUTH_MODE=local` the run goes on without push access and its card says why                   |
| The VM runs out of memory or disk                                                                  | The command fails or the VM stops                                               | Limits shown on the run card; the blueprint can raise them within the machine's capacity                                                                                             |
| The connector restarts mid-run                                                                     | The agent's conversation ends (#791's "What cannot be done to a running agent") | Stage 1's idle gate keeps updates away from runs. A crash reports the run failed and destroys its VM                                                                                 |
| Windows: Microsandbox's preview runtime fails                                                      | No microVM                                                                      | Refused with the reason, or the process sandbox once Stage 4 has shipped                                                                                                             |

#### Tests

- **Unit:** the `Hands` contract against a fake backend, ACP `fs/*` and `terminal/*` handlers, the agent's `sandbox` settings and the eligibility check (no settings, an unverified `agentInfo` version, an unrouted tool call that stops the run), composing the allow list per mode, the server's token request (repository and permissions) against a fake GitHub, `push_branch` and `pull_request` against a fake GitHub and mirror, and a check that no real token appears in what the fake backend receives.
- **On a KVM CI runner:** repeat the spike as a test from the compiled binary with its runtime folder (boot, placeholder, blocked egress, private clone), and add what the spike could not do: push to a throwaway branch of a test repository with an installation token, and a run longer than the token's hour.
- **End to end:** the fake-harness server with a fake agent that uses ACP `terminal`; a build whose commands run in the VM, asserting that nothing changed on the host outside the run's directory; and a fake agent without `sandbox` settings, refused with its message on the run card.
- **The agent jail:** on Linux (both process-sandbox backends) and macOS runners, a jailed fake agent cannot read a file planted in `HOME` or reach a host off its list.

#### Rollout and size

- One release turns it on for every platform at once (decision 7): its manifest carries `runtime`, and every machine whose probe says `microvm` uses it. A machine that cannot run a microVM with that release (Windows if WHP support has not worked, an unsigned macOS build) reports `process` or `none` and is handled as Stages 2 and 4 say; nothing waits for a later wave.
- **L, about 10–13 engineer-weeks** for its own parts: runtime packaging and release (1.5), `Hands`, ACP fs and terminal, and the MCP tools (2–3), agent settings and the routing checks (1), VM lifecycle, clone and bundles (1.5), network rules (0.5–1), installation tokens and their renewal (1.5–2), macOS and Windows bring-up (2–3), tests within each. It also needs the parts it shares with Stage 4 (5–7 weeks), which whichever of the two ships first builds ([Rough size](#rough-size)).

### Stage 4: process-sandbox fallback

The outcome: a machine without hardware virtualization, or whose person declined the privileged step, still runs every run in a clean environment that cannot read the person's files, reach hosts off the allow list, or hold a GitHub credential. The Machines page says "Process sandbox" and which one. This stage also widens Stage 3: on a microVM machine, an agent that cannot route its tools runs here, agent and tools together, instead of being refused.

#### Backends

| System  | Backend              | Used when                                                               | Needs                                                                                                                                                                                        |
| ------- | -------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | srt (bubblewrap)     | bubblewrap can make a user namespace                                    | Static bubblewrap, socat and ripgrep in the archive the manifest pins **(inferred to be feasible; untested)**. Bubblewrap must already make a user namespace; no privilege step changes that |
| Linux   | The Landlock tier    | bubblewrap cannot (Ubuntu 24.04 and later), and the kernel has Landlock | Linux 5.13 or later with Landlock enabled, and no privilege **(experiment)**                                                                                                                 |
| macOS   | srt (`sandbox-exec`) | There is no microVM                                                     | Bundled ripgrep                                                                                                                                                                              |
| Windows | MXC                  | WHP is off, on Windows 11 24H2 or later                                 | MXC's TypeScript SDK or srt's `windows.backend: 'mxc'`; per srt, Node 24 for the SDK. Whether it loads in a compiled Bun binary is untested                                                  |

srt's own Windows backend is not used because it needs an elevated install. Git Bash and other MSYS2 programs do not start in MXC's BaseContainer tier, so agents use cmd or PowerShell there.

#### The Landlock tier

srt on Linux needs capability-bearing user namespaces, which Ubuntu 24.04 and later withhold from unprivileged processes, and Ubuntu's own bubblewrap fails there ("setting up uid map: Permission denied") **(experiment)**. The Landlock tier needs no namespace and no privilege. A small native helper in the process-sandbox archive (`chopin-sandbox`, one per Linux architecture, because Bun cannot run code between fork and exec) starts each sandboxed command:

- **Files.** The child restricts itself with Landlock before it executes the command: read and execute on the system and toolchain directories the run needs, read and write on the run directory and its temporary directory, nothing else. In the experiment the person's home could not be listed, read or written, and the run directory could **(experiment)**.
- **Network.** A seccomp filter refuses `socket()` for everything but TCP over IPv4 and IPv6 (no UDP, raw, netlink or Unix sockets; `socketpair` still works), refuses `io_uring_setup` and sends with `MSG_FASTOPEN`, either of which could connect without `connect()`, and hands every `connect()` to the helper's parent, outside the sandbox. The parent reads the address. For the connector's proxy or its loopback bridge, it connects a socket of its own to its own copy of that address and installs it in the caller's place (`SECCOMP_IOCTL_NOTIF_ADDFD`); anything else fails with `EACCES`. No trapped call is ever let continue, which is the use the `seccomp_unotify(2)` manual page warns against, so a caller that rewrites its arguments meanwhile gains nothing. Landlock's TCP rule (ABI 4) allows `connect` only to those ports, as a second fence the kernel enforces. In the experiment, Landlock alone let a connection to a remote host on the allowed port through (it restricts ports, not addresses), and let UDP and the session bus's Unix socket through; with the filter and its supervisor all three failed with `EACCES`, while the allowed address worked and carried data **(experiment)**. Traffic to allowed hosts goes through the connector's proxy with `HTTP_PROXY` and `HTTPS_PROXY`, as under srt on Linux; a tool that ignores them cannot connect.
- **Other processes.** Landlock lets a sandboxed process ptrace, and so read the sensitive `/proc` files of, only processes in its own domain. In the experiment the environment and memory map of the person's other processes were refused, and their command lines were readable **(experiment)**.
- **What it gives up against bubblewrap.** No PID or mount namespace, so the person's process list and command lines are visible; on kernels before Landlock ABI 6 the sandbox can signal the person's other processes; and anything that needs a Unix socket of its own (a database listening on one) fails. The Machines page calls it "Process sandbox (Landlock)". On a machine with a usable `/dev/kvm`, the privileged step moves its runs to a microVM, with the agent's jail chosen as Stage 3 says; no Chopin privileged step moves a machine without one to srt.

The experiment's wrappers are scratch code; the helper, the proxy and real toolchains under it are untested.

#### The run

- **A clean environment.** A fresh clone in `<base>/runs/<run id>` from the connector's mirror, never the person's checkout (a local-only commit arrives as a `git bundle`); a fresh `HOME` inside the run directory; an environment reduced to `PATH`, locale, terminal and the run's own variables; reads of the person's home denied except the toolchain directories the agent needs; writes only to the run directory and temporary files.
- **The agent runs inside the same sandbox as its tools.** This is weaker than the microVM in a way the Machines page and run card say plainly: the agent's own model credential is readable by its tools, as it is today.
- **Network.** The proxy enforces the process-sandbox column of the allow list in [Network rules](#network-rules).
- **GitHub.** The sandbox holds no GitHub credential and no placeholder, on every system. Clones, fetches, pushes and pull requests go through the connector ([GitHub through the connector](#github-through-the-connector)). Under MXC, which cannot terminate TLS, this is what keeps the token out of the sandbox. srt's masking is not used.
- **What the fallback lacks.** No snapshots, no root inside (a blueprint's `initialize` cannot run, so runs use the host's toolchains and `maintenance` runs per run), and no desktop: browser checks run headless and "Test the app" records no video.

#### Failure modes

| Failure                                                          | Effect                                                                                                            | Handling                                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bubblewrap cannot make a user namespace                          | srt refuses to start                                                                                              | The Landlock tier, where the kernel has Landlock                                                                                                                   |
| The kernel has neither Landlock nor usable user namespaces       | No process sandbox on Linux                                                                                       | "Not isolated": no work until a kernel with Landlock or usable user namespaces is installed, or the owner chooses **Run unisolated** (the exception to decision 5) |
| A tool needs a directory the policy denies                       | The command fails with a permission error                                                                         | srt reports violations (on macOS from the system log), the Landlock helper logs each refusal, and the run log names the path                                       |
| A tool ignores the proxy variables or needs UDP                  | It cannot connect                                                                                                 | Stated limitation, as under srt on Linux; the run log names the refused destination                                                                                |
| A build uses Chromium's namespace sandbox or rootless containers | It fails: srt blocks nested namespaces, and the Landlock tier cannot make them where user namespaces are withheld | Stated limitation; the microVM has none                                                                                                                            |
| The agent runs `git push` or `gh`                                | No credential                                                                                                     | The credential helper names the connector's tools                                                                                                                  |
| MXC's SDK does not load under compiled Bun                       | No Windows fallback                                                                                               | Ship a small Node-based helper for MXC; until then such machines are "Not isolated" and take no work unless their owner chooses                                    |

- **Tests:** unit tests of the policy built for a run (paths, environment, hosts) and of the backend choice; integration on Linux and macOS runners asserting that a run cannot read a file planted in `HOME`, cannot reach `example.com`, holds no GitHub credential, and pushes a branch through `push_branch` to a fake GitHub; the same on a Linux job with user namespaces refused, for the Landlock tier, plus the experiment's cases as tests (a remote host on the proxy's port, UDP, a Unix socket, `io_uring`, `MSG_FASTOPEN`, a `connect` address rewritten while trapped); a Windows 11 24H2 runner for MXC if one is available, otherwise a manual check.
- **Rollout and size:** one release turns it on for every platform at once (decision 7), and a machine uses it whenever its probe says `process`. **S, about 2–3 engineer-weeks** for its own parts: the clean environment and run policy (1), agent and tools together through the `process` backend of the hands (0.5–1), tests (0.5–1). It also needs the parts it shares with Stage 3 (5–7 weeks), which whichever of the two ships first builds ([Rough size](#rough-size)).

### Stage 5: blueprints and snapshots

The outcome: a repository's environment is described once, in `.chopin/blueprint.yaml`, and built into a snapshot, so every run starts with its tools and dependencies already installed. A failed build never replaces the last good snapshot. A run that waits sleeps and wakes.

#### The file

```yaml
initialize:
  - name: Rust toolchain
    run: curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
  - run: apt-get install -y --no-install-recommends pkg-config libssl-dev
maintenance:
  - run: cargo fetch
knowledge:
  - name: test
    contents: cargo test --workspace
  - name: lint
    contents: cargo clippy --workspace -- -D warnings
clone:
  submodules: true
  lfs: false
```

The four sections mean what Devin's do: `initialize` installs tools and runs only during builds; `maintenance` installs project dependencies during builds and is shown to the agent at the start of a run, not run automatically; `knowledge` is never executed and goes into the agent's prompt beside the existing instructions (`apps/connector/src/implementation.ts:119-187`); `clone` adjusts how the repository is cloned. `devcontainer.json` is not required.

- **Read from the default branch.** A run's own branch cannot change the environment of later runs, nor widen the allow list for itself.
- **Drafted by the agent.** For a repository without one, an environment run asks the agent to read the repository (README, lockfiles, CI workflows, and `devcontainer.json` as a hint only), write a blueprint, build it in a VM and iterate until the build passes. It then opens a pull request adding the file. Until that merges, the person's machine may use the draft's snapshot for that repository, labelled "draft environment".

#### Builds

1. Boot the base image named by the release manifest.
2. Run `initialize` as root in the guest, clone with `clone`'s options through the placeholder token, then run `maintenance`. Each step has a time limit (proposed: 1 hour; Devin allows 3).
3. Check the result: the clone exists and the working tree is clean.
4. Save a disk snapshot named by the repository's node ID, the blueprint's digest and the base image's digest. Only a successful build moves the repository's "last good" pointer. A failed build keeps the old one, and the Machines page and run cards say "Environment build failed; runs use the build from 3 November".

Builds start when the default branch's blueprint changes (noticed at the next run), when the release manifest names a new base image, about every 24 hours while the machine is idle, and when a person presses **Rebuild environment**. Because the guest only ever holds placeholders, a snapshot cannot capture a real GitHub token **(inferred)**; other data a blueprint writes can persist, so snapshots stay in the 0700 state directory.

#### Runs from a snapshot

A run boots a fresh copy of the last good snapshot, fetches its commit, and gets `maintenance` and `knowledge` in its prompt. Session changes never flow back into the snapshot.

#### Sleep and wake

A run that ends its turn with a pull request open in a living document, where rebuilds are expected, is saved with memory and disk (the SDK's `full` scope) and stopped. The next rebuild of that document on this machine resumes it, with its processes and caches, instead of booting fresh. A sleeping run is discarded when its pull request merges or closes, or after seven days. Resume has not been tried; if it proves unreliable, a disk-only snapshot that restarts processes on wake (Devin's choice for macOS guests) is the fallback.

Snapshots and sleeping runs share a per-machine disk budget (proposed: 20 GB), evicted least recently used first, shown beside the run sizes `chopin status` already reports (`apps/connector/src/status.ts:97-101`).

| Failure                                          | Effect                                     | Handling                                                                                                   |
| ------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| A blueprint step fails or times out              | No new snapshot                            | The last good snapshot stays; the build's log is kept and linked from the Machines page                    |
| No good snapshot exists yet                      | Runs would start bare                      | Runs boot the base image and run `maintenance` themselves, as Devin's "included" repositories do           |
| The blueprint asks for a host off the allow list | The step fails with a network error        | The log names the host; the blueprint may add it (open question 9)                                         |
| Resume fails                                     | The sleeping run is lost                   | Boot fresh from the last good snapshot; the rebuild proceeds from the pull request branch as it does today |
| The disk budget is exceeded                      | Old snapshots or sleeping runs are evicted | Least recently used first; never the last good snapshot of a repository in use                             |

- **Tests:** schema validation of blueprints; the build state machine (success moves the pointer, failure and timeout do not, concurrent triggers collapse into one build); on a KVM runner, a build of a small repository's blueprint, a run from its snapshot, and a sleep and resume of a run with a process still running.
- **Rollout and size:** a repository without a blueprint behaves as in Stage 3. **L, about 6.5–9 engineer-weeks:** the schema and the drafting run (1.5–2), builds and the last-good pointer (1.5–2), runs from a snapshot (1), sleep and wake (1.5–2.5), the disk budget (0.5), tests (0.5–1).

### Stage 6: desktop, browser, live view and "Test the app"

The outcome: the agent can use a full Linux desktop and a real browser in the VM, people can watch and take over the desktop, or work in VS Code on the VM, from a Machine pane in Chopin, and a build's pull request gets a recording of the app being tested.

#### The desktop in the base image

- Xvfb with a light window manager (openbox), at Devin's 1024×768 by default; Chrome (Chromium on arm64 guests, where Google Chrome is not published for Linux **(inferred)**) with a CDP endpoint on a fixed port; ffmpeg; D-Bus and the AT-SPI bridge for accessibility; x11vnc with a WebSocket bridge; openvscode-server; agent-browser and agent-desktop; `git` and `gh`.
- The image is multi-architecture, published to the GitHub Container Registry and pinned by digest in the release manifest. Its size is not known yet; the Machines page shows the download.

#### The computer tool

`chopin-machine` gains `computer` (screenshot, move, click, drag, type, key, scroll, wait, zoom, and start and stop recording, returning screenshots as images), `browser` (agent-browser against the guest's CDP endpoint) and `desktop` (agent-desktop's accessibility snapshot and actions). All of them run inside the guest through the hands, so the agent needs no published port for its own use.

#### Live view, takeover and VS Code

- The machine only makes outgoing requests (`docs/chopin-cli.md:9-10`), so the relay is connector-initiated: for each viewer the connector publishes the guest's VNC or VS Code port to host loopback and opens an outbound WebSocket to a new server relay route; the server joins it to the viewer's browser socket. The browser shows a **Machine** pane beside the run card with two tabs: **Desktop**, a VNC client that shows the newest frame rather than a backlog, and **VS Code**, openvscode-server for the run. Both tabs use the same relay. A person may pop either tab out into its own browser tab; that is optional and changes nothing else.
- **Take over** pauses the agent's computer tool, which answers "a person has control of the desktop" until the person hands control back. **VS Code** is the pane's second tab; it opens openvscode-server for the run over the same relay.
- Who may view, take over or open VS Code is [open question 8](#open-questions). The proposal: anyone who can see the run card may watch; only the person who started the run and the machine's owner may take over or open VS Code. A person attached to either holds the machine non-idle for Stage 1.

#### "Test the app"

After a build opens its pull requests, a second turn in the same VM plans checks from the diff, starts the app with the blueprint's `knowledge` commands, drives it with the computer and browser tools, and records the screen with ffmpeg. The connector attaches the video and key screenshots to the pull request with `gh pr comment --attach` (GitHub CLI 2.99.0 or later in the image). Whether an installation token may upload attachments is untested; if not, the files are uploaded to Chopin as run artifacts and the comment links to them.

| Failure                                                 | Effect                   | Handling                                                                |
| ------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| Port publishing does not work on a platform             | No live view or VS Code  | The agent's tools are unaffected; the pane says the view is unavailable |
| The relay drops                                         | The pane freezes         | It reconnects; nothing in the run depends on a viewer                   |
| A person and the agent both drive the desktop           | Conflicting input        | Takeover pauses the agent's computer tool                               |
| The app does not start                                  | No recording             | The comment says what failed, with the last screenshot                  |
| Attachment upload is refused for the installation token | The comment has no media | Chopin-hosted artifacts and links                                       |

- **Tests:** unit tests of the computer tool's command mapping and of the relay's pairing and authorization; on a KVM runner, a run that opens a page in the guest's Chrome, takes a screenshot through the tool, and records five seconds of video; an end-to-end test of the Machine pane, with its Desktop and VS Code tabs, against a fake connector relay.
- **Rollout and size:** the image change rides a release manifest; the pane ships for everyone at once. **L, about 9–11 engineer-weeks:** the image (1.5), computer and browser tools (1.5–2), the relay and the Machine pane (2.5–3), VS Code (1), "Test the app" and recordings (1.5–2), tests (1–1.5).

## What changes relative to #791

The zero-downtime design's Stage 4 is the starting point for Stage 1 here.

| #791 Stage 4                                                                                                         | Here                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chopin update` sets `restart-pending` and the connector restarts when idle; `--now` restarts at once                | Kept unchanged                                                                                                                                                                                       |
| Idle: no build or investigation, no Planner backend with a live run or open question                                 | Kept, with prototypes and Stage 6 viewers added, made checkable (protocol 7's `machine_activity` lets the connector ask the server about its Planners), and applied to forced updates too            |
| Optional automatic update, an open question (its open question 11, "Connector support")                              | **Resolved: on by default** (decision 6), with an off switch that does not stop forced updates                                                                                                       |
| Downloads "already verified like the installer's"                                                                    | **Changed:** that is a checksum plus an attestation only when `gh` exists. Now a signed manifest is verified in-process on every machine                                                             |
| No rollback                                                                                                          | **Added:** the previous binary is kept, and a launcher that the swap never replaces counts starts and rolls back                                                                                     |
| One binary                                                                                                           | **Added:** one manifest pins `chopin`, the sandbox runtime and the base image digest                                                                                                                 |
| Support window: current protocol plus two, raise `min` only after 30 days of logs, a `deprecatedBelow` release first | **Dropped** (decision 7): no users yet, so `min` can rise with the release that needs it; every service updates itself, and a connector below `min` takes no new work until it is idle, then updates |
| Never refuse calls that belong to a build already running                                                            | Kept and widened: below the minimum the server answers the calls of all work already running (builds, investigations, prototypes and attached Planners) and refuses only new work                    |
| Planner backends resume across their own restart with a saved resumption descriptor                                  | Not changed here; it still depends on #791's persisted Planner holds. The idle gate makes it unnecessary for updates                                                                                 |
| Agent connection and browser support windows                                                                         | Not changed here                                                                                                                                                                                     |
| Size M, 3–5 engineer-weeks                                                                                           | Stage 1 is M, 4.5–6 engineer-weeks: signing, the launcher and rollback are added, the support-window work is dropped                                                                                 |

## Proven, inferred and untested

**Proven in the spike** (one Ubuntu 24.04 machine, linux-x64, Bun 1.4.4, Microsandbox 0.7.13; scratch code outside the repository):

- A microVM boots from an OCI image (`alpine/git`) from Bun, with guest kernel 6.12.113. A cold create with the image cached took 426–488 ms, a warm create 357–368 ms, and the first command 18–25 ms.
- The host's home directory does not exist in the guest.
- Egress is denied by default with per-domain allow rules; `https://example.com` was blocked.
- A secret given to the guest is a placeholder; the host substitutes the real token for the allowed host only. `GET api.github.com/user` with the placeholder returned the right login, and no real token was in the guest's environment or Git configuration.
- A private repository clones through a credential helper (or a URL) carrying the placeholder; `Authorization: Bearer` in `http.extraHeader` did not authenticate.
- A compiled Bun binary loads the runtime from a `runtime/` folder with `NAPI_RS_NATIVE_LIBRARY_PATH`; the runtime is about 117 MB on linux-x64.
- `/dev/kvm` is `0660 root:kvm` with a logind ACL for the active desktop seat only; SSH sessions and system services get EACCES, an ACL added by hand is reset within seconds, and `gpasswd -a <user> kvm` fixes it (for a domain account too) in new sessions or under `sg kvm`.

**Proven in a Landlock experiment for this document** (an Ubuntu 24.04.5 machine, linux-x64, kernel 6.8 with `kernel.apparmor_restrict_unprivileged_userns=1`, run without any privilege; two small C wrappers, about 220 lines, outside the repository), marked **(experiment)**:

- Ubuntu's own bubblewrap 0.9.0 cannot sandbox an unprivileged user there: it fails with "setting up uid map: Permission denied", and with a network namespace with "loopback: Failed RTM_NEWADDR: Operation not permitted". No AppArmor profile for it ships in `/etc/apparmor.d`.
- Landlock ABI 4 is available to an unprivileged process. Under it the home directory could not be listed, read or written, the run directory could, and `git init` and `git commit` worked with `HOME` in the run directory.
- Landlock alone refused TCP connections to ports other than the allowed one, but let through a connection to a remote host on the allowed port, UDP, and a connection to the session bus's Unix socket.
- With a seccomp filter and a supervisor that answers `connect()` by installing a socket of its own, all three failed with `EACCES`, while the allowed loopback address worked and carried data. Direct name resolution failed, as it should.
- A sandboxed process could not read the environment or the memory map of a same-user process outside the sandbox; it could read its command line.

**Inferred** from code or documentation, not run: the refused service's restart loop; the safety of the idle gate's server check and of the queue holding work during a restart; the server answering a below-minimum connector's running work; the launcher's counting under each service manager; WebCrypto Ed25519 in the compiled binary; `sg kvm` in a systemd `ExecStart`; probing WHP by creating a partition; bundling static bubblewrap, socat and ripgrep; the Landlock tier on other kernels from 5.13 with Landlock enabled; the Landlock tier jailing the agent on an Ubuntu 24.04 machine whose `/dev/kvm` the privileged step opens; a Git bundle carrying a push without anything the run wrote being executed on the host; ACP 1.6.0's `agentInfo` and tool-call kinds being enough to check routing; carrying local-only commits as bundles; the guest setting the person as commit author; snapshots holding no real token; Chromium rather than Chrome on arm64 guests; GitHub-hosted Linux runners exposing `/dev/kvm`; pdd-kit adopting `chopin setup`.

**Untested**, stated plainly:

- **macOS**, including the `com.apple.security.hypervisor` entitlement on the shipped and re-signed binaries, and notarization.
- **Windows**, including Microsandbox's preview WHP support and MXC's SDK inside a compiled Bun binary.
- **Push with a repository-scoped installation token**, and `gh --attach` with one.
- **Long builds**, such as a Rust project verified with Verus, and memory and disk limits.
- **Snapshot and resume**, of disk and of memory.
- **Port publishing**, which live view and VS Code need.
- **devcontainer.json images** and lifecycle commands (now only a hint, but a drafting agent will read them).
- Copilot CLI and Atomic with their built-in tools off and their work routed through ACP client capabilities or MCP.
- Renewing an installation token behind a live placeholder.
- **The Landlock tier** beyond the experiment: the helper itself, a real allow-list proxy, agents and toolchains (Node, Bun, compilers, package managers) under it, arm64, and other distributions and kernels.
- **GitHub through the connector:** the mirror, `push_branch` and `pull_request`, and agents using them instead of `git push` and `gh`.
- **Rollback by the launcher**, under systemd, launchd and Task Scheduler.
- **MXC's network fence**, which srt describes as "closed by measurement, not by promise".

## Cross-cutting concerns

### Order and dependencies

- Stage 1 comes first, because every later stage reaches machines through its manifest without anyone running a command.
- Stage 2 can ship any time; its privileged step and image pull do something only once a manifest carries a runtime (Stage 3). Until a sandbox stage ships, every machine is labelled "Not isolated" and runs work as today.
- Stage 3 needs Stage 1's manifest. Stages 3 and 4 share the `Hands` interface, the allow list and its proxy, the process sandbox (srt, the Landlock tier and MXC), which jails Stage 3's agent and holds Stage 4's agent and tools, and GitHub through the connector. Whichever ships first builds them, so neither stage needs the other. Shipped alone, Stage 3 refuses an agent that cannot route its tools into the VM; Stage 4, when it ships, runs that agent instead.
- Stage 5 needs Stage 3. Stage 6 needs Stage 3's base image and is independent of Stage 5.

### Observability

Chopin has no metrics endpoint; these start as structured log lines on the connector, with the owner-visible parts reported to the server.

- **Updates:** checks, targets, downloads, verification failures, time waiting for idle and time below the minimum, the launcher's starts, probation outcomes, rollbacks with the rule that caused them.
- **Isolation:** the probe's result, backend (srt, Landlock or MXC) and reason per machine, changes, and machines that chose **Run unisolated**.
- **Runs:** backend per run, VM create and first-command time, denied hosts and refused connections, token renewals, routed versus unrouted tool calls (an unrouted call stops the run and is a defect in an agent's `sandbox` settings).
- **Blueprints:** build durations and outcomes, snapshot sizes, evictions, resume successes and failures.

### Security

- **The update channel is the most powerful thing here.** It runs new code on every machine at once. The signing key lives only in the approved release environment, the public keys are pinned in the binary, and the attestation stays as a second, keyless check where `gh` exists.
- **The launcher** is a copy of a release that passed probation, and the swap never writes it, so a bad release cannot remove the means of undoing itself.
- **The pairing key** keeps today's protections: single use, ten minutes, a hash in memory, the minting sign-in only, never on a command line (`docs/chopin-cli.md:80-94`).
- **The privileged step** prints the exact command before asking, runs once, and never runs `chopin` itself as root. Adding a user to `kvm` lets every process of that user open `/dev/kvm`; the udev rule widens that to every local user and is used only where no `kvm` group exists.
- **The microVM boundary** is the primary isolation. The process sandbox shares the host's kernel and is stated as weaker; the Landlock tier is weaker still (no PID or mount namespace) and is Chopin's own code in the boundary. A machine with no sandbox takes no work unless its owner turns on **Run unisolated**, which labels every run and still refuses automatic work ([open question 7](#open-questions)).
- **Shared machines** gain the most: a teammate's run on a shared machine (`AGENTS.md:189-194`) can no longer read the owner's home directory.
- **Tokens:** the installation token is scoped to one repository and two permissions for one hour. It never enters the guest, which sees a placeholder, and never enters the process sandbox in any form. Model credentials stay with the host-side agent in microVM mode. Under `AUTH_MODE=local` without the App's key, the person's own login stays on the host, and the connector uses it only for the run's repository and branch.
- **Live view and VS Code** relay through the server on the connector's outbound connection, with per-viewer authorization; nothing listens on the machine's network.

### Out of scope

- **Connecting AI accounts (Copilot, ChatGPT, Claude) in the web app** (decision 8). This is the follow-up that removes the last on-machine sign-in.
- Running Planner backends (`--planner-command`) inside the sandbox; they keep running on the host as today.
- macOS and Windows guests, and testing native desktop or mobile apps on the host's own desktop.
- Pools of machines and more than one run at a time per machine.

## Corrections to existing docs found while researching

These are recorded here, not fixed, because this change is limited to this document.

1. `docs/chopin-cli.md:713-715` and the command table at `docs/chopin-cli.md:747` say `chopin update` installs "the release your Chopin server asks for". When the server cannot be asked, or recommends none, it installs the newest release instead (`apps/connector/src/update.ts:172-186`, `:233-239`).
2. A note for #791 rather than this repository: its Stage 4 says downloads are "already verified like the installer's". That is accurate but easy to over-read, because both verify a checksum always and a signature only when `gh` is installed (`apps/connector/src/update.ts:277-290`, `apps/connector/install/install.sh:159-163`).

When the stages ship, these statements change with them rather than being wrong today: "nothing needs administrator rights" (`apps/connector/install/install.sh:19`, `apps/connector/install/install.ps1:19-20`, `docs/chopin-cli.md:123-125`), "A worktree organizes edits; it is not a sandbox" (`docs/local-experiments.md:94-100`), "Which GitHub account pushes" (`docs/chopin-cli.md:670-690`), the shared-machine rule's GitHub account (`AGENTS.md:189-194`), and "The binaries are not code-signed or notarized" (`docs/releasing-cli.md:135-136`).

## Open questions

1. **Agents and their tools.** Can Copilot CLI and Atomic turn off their built-in shell and file tools and use ACP's `fs` and `terminal` capabilities or the `chopin-machine` MCP tools instead, sub-agents included? Decision 1's split depends on it. Stage 3 refuses an agent that cannot; Stage 4 runs it in the process sandbox, agent and tools together, even on a microVM machine. Would the maintainers rather run such an agent inside the VM with a placeholder model credential?
2. **Attribution.** With an installation token, pull requests and pushes come from the App's bot identity, not the person. Is that acceptable, with the person as commit author and named in the pull request body (as `requestedBy` already is, `apps/connector/src/implementation.ts:111-117`)?
3. **The App's private key and `AUTH_MODE=local`.** Repository-scoped tokens need the App's ID and private key on the server. Is that acceptable for self-hosted deployments? Without them, under `AUTH_MODE=local`, this design keeps the person's own login on the host and has the connector use it only for the run's repository and branch, an exception to decision 4. Is that acceptable, or should local mode require the key, or a fine-grained token limited to the repository that the connector checks before use?
4. **Signing key.** Is a long-lived Ed25519 key in the release environment acceptable, or should the connector verify the Sigstore attestation in-process instead? Who holds the next key?
5. **Apple Developer ID.** Who owns the signing certificate and the notarization credentials for the macOS release?
6. **Bundled agents.** May Chopin's release redistribute the agents it bundles (Copilot CLI's npm package, Atomic with `atomic-acp`) with a Node.js runtime? If not, setup installs them with the agent's own installer under a user-level prefix.
7. **Machines with no isolation.** A Linux machine with neither Landlock nor usable user namespaces, and a Windows machine older than 11 24H2, have no process sandbox at all, and the one privilege decision 5 allows does not give them one. This design gives them no work until the owner turns on **Run unisolated**, which labels every run "Not isolated" and still refuses automatic work (`LIVE_BUILD` rebuilds and `LIVE_SPIKES` prototypes, `AGENTS.md:180-188`). Is that the right default, should a machine whose owner opted in take automatic work too, or should **Run unisolated** not exist? A Windows machine older than 11 24H2 with Windows Hypervisor Platform on has one option this design does not take: run its tools in a microVM while the agent stays on the host unjailed. That isolates the tools better than **Run unisolated** does, but it breaks the rule that the agent never runs unjailed on the host (Stage 3), and the probe reports `none` for it. Should the maintainers accept that trade-off for such machines?
8. **Live view rights.** Who may watch a run's desktop, take it over, or open VS Code on its VM?
9. **Allow-list additions.** Beyond the defaults, may a repository's blueprint add hosts, may a machine's owner, or only the deployment?
10. **Never idle.** Is "wait until idle, however long" right, forced updates included? A machine below the minimum takes no new work meanwhile, so a Planner's open question that nobody answers keeps it out of service. Should a pending update stop taking new work after a bound (say a day) even when it is not forced, and should the Machines page offer to stop the Planner that holds a forced update?
11. **Base image hosting and size.** Is the GitHub Container Registry under this repository's organization the right home, and what size is acceptable to pre-pull on install?
12. **Snapshot budget.** What disk budget per machine for snapshots and sleeping runs, and should the owner set it on the Machines page?
13. **The Landlock tier.** It is Chopin's own native code in the security boundary, and weaker than bubblewrap. Should Chopin own it, or should such machines stay on the decision 5 exception until srt or another project offers a sandbox without user namespaces? A possible follow-up, not part of the install flow: an optional AppArmor profile that lets the bundled bubblewrap make user namespaces on Ubuntu 24.04 would move such machines to srt. It is a second privileged change beyond decision 5's one prompt, so should it be offered at all, and if so as a separate step?
14. **Agents without `git push` and `gh` in the process sandbox.** There the agent pushes and opens pull requests through the connector's tools. Is that acceptable, or should srt's masking (a placeholder with TLS termination) be used on Linux and macOS where it works, leaving the tools for Windows and local mode?

## Verification

How this document was checked:

- **Code citations.** Every `path:line` citation was read in this checkout, and a script confirmed that each cited file exists here and each line or range falls within it, and that every relative link resolves with exact casing.
- **The spike.** Results marked **(spike)** come from the Microsandbox spike's notes and scratch code, which were read for this document but not run again.
- **The Landlock experiment.** Run for this document on an Ubuntu 24.04 machine without privilege: Ubuntu's own bubblewrap, then a small C wrapper using Landlock and a seccomp supervisor, against a Python probe, `git` and `curl`. Its code is outside the repository; its results are marked **(experiment)**.
- **References.** Each linked source was fetched on 2026-11-07: Cognition's blog post, Devin's blueprint, Outposts and Computer Use documentation, Microsandbox's, smolvm's and sandbox-runtime's repositories (sandbox-runtime's README at commit `27fce0d`, for its Linux requirements and its MXC limits), MXC's platform-support page, the kernel's Landlock documentation and the `seccomp_unotify(2)` manual page, agent-browser and agent-desktop, and GitHub CLI's attachment documentation. The ACP method names and fields were read from the pinned SDK's built files.
- **#791.** Its Stage 4 and open question 11 were read from `docs/zero-downtime-upgrades-design.md` on the `zero-downtime-design` branch.
- **Not run.** No Chopin test was run for this document. `bun run ci` runs formatting, lint and token checks. Statements about what code does come from reading it, and are marked **(inferred)** where nothing confirmed them.

The proposed tests, summarized:

| Stage | New or changed tests                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Update unit tests (signature, target, idle gate including forced updates, launcher counting, rollback). Server routes below the minimum. Release workflow assets. Fake-release integration with replacements that exit, crash at load, never connect or hang. A mid-build update end to end |
| 2     | Setup command builder, isolation probe table (KVM, user namespaces, Landlock, MXC), privileged script, **Run unisolated**. Installers against a fake release and server. Probe on a KVM runner. A manual matrix on three systems                                                            |
| 3     | `Hands` contract, ACP fs and terminal, token scoping, agent eligibility and unrouted calls, the agent jail. The spike as a test on a KVM runner, plus a push and a long run. A build end to end with nothing changed on the host                                                            |
| 4     | Run policy and backend choice. Linux (bubblewrap and Landlock) and macOS runners asserting no home reads, no off-list hosts, no GitHub credential, and a push through the connector. The experiment's network cases. MXC on Windows 11 24H2 where available                                 |
| 5     | Blueprint schema and build state machine. A build, a run from its snapshot, and a sleep and resume on a KVM runner                                                                                                                                                                          |
| 6     | Computer tool mapping and relay authorization. A screenshot and a recording on a KVM runner. The Machine pane against a fake relay                                                                                                                                                          |

## Rough size

| Stage                                             | Size | Estimate             | Confidence                                                            |
| ------------------------------------------------- | ---- | -------------------- | --------------------------------------------------------------------- |
| 1. Automatic connector updates                    | M    | 4.5–6 engineer-weeks | Medium                                                                |
| 2. One-command install                            | M    | 4.5–6 engineer-weeks | Medium; macOS signing setup is the unknown                            |
| 3. Runs in a microVM                              | L    | 10–13 engineer-weeks | Low until open question 1 is answered and macOS and Windows are tried |
| 4. Process-sandbox fallback                       | S    | 2–3 engineer-weeks   | Medium                                                                |
| Shared by 3 and 4, built by whichever ships first | M    | 5–7 engineer-weeks   | Medium on Linux and macOS; low for the Landlock tier and on Windows   |
| 5. Blueprints and snapshots                       | L    | 6.5–9 engineer-weeks | Low until snapshot and resume are tried                               |
| 6. Desktop, browser, live view                    | L    | 9–11 engineer-weeks  | Medium                                                                |

The shared parts are srt with its bundled helpers on Linux and macOS (1.5–2), the Landlock tier's helper, `connect` supervisor and proxy (1.5–2), MXC on Windows (1–1.5), and GitHub through the connector (1–1.5). With them counted once, the stages add to 41.5–55 engineer-weeks. Stage 3 shipped alone, with the shared parts, is 15–20. Stages 1 and 2 alone, which give a one-command install that keeps itself current, are 9–12. Each estimate is the sum of the parts listed in its stage, not measured.
