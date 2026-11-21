# Agents in NVX microVMs

Every agent process Chopin's connector starts on a paired machine runs in a
microVM of its own: each coding agent a Build, Run, Retry, investigation or
prototype starts, each Planner backend (cold or spare), the agent checks, and the
builds of agent images. The microVMs are
[NVX](https://github.com/microsoft/nvx), Microsoft Research's micro-VM sandbox on
top of OpenVMM. It boots a small Linux guest under the host's hypervisor: KVM or
the Microsoft Hypervisor (MSHV) on Linux, the Windows Hypervisor Platform (WHP)
on Windows.

This replaces the process sandbox completely: MXC with Seatbelt, bubblewrap and
ProcessContainer. There is no fallback to a process sandbox and no unsandboxed
mode. A machine that can't run NVX can't be paired or connected, and says why.

This document is the design and what was built. [Use your own machine](chopin-cli.md)
is the guide for the people who run `chopin`.

## Why a microVM

A process sandbox shares the host's kernel and sees the host's file system. It
needed a long list of exceptions to stay usable: read everything but known
credential paths, hide the connector's state directory, keep the person's git
directory read-only except where git writes, and then harden every git command the
connector ran in a tree an agent had written. Each exception was a place where a
mistake leaks.

A microVM inverts that. The guest sees only what the connector shares with it,
reaches only the one network endpoint it is given, and runs under its own kernel,
so a kernel bug in the guest is not a host compromise. And because an agent's
repository now lives inside its guest, the host never runs git in a tree an agent
wrote.

## Machines that can run it

| Host                         | Needs                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| Linux, x86_64                | Read and write access to `/dev/kvm` (KVM) or `/dev/mshv` (Microsoft Hypervisor), for the connector's user |
| Windows, x86_64              | The Windows Hypervisor Platform turned on                                                                 |
| macOS, any Arm64 host, other | Not supported: refused at pairing and connect                                                             |

NVX boots x86_64 guests only and has no macOS backend. The check
(`nvxSupport` in `apps/connector/src/nvx.ts`) reads the platform, the
architecture and whether the connector's user may read and write the hypervisor's
device. A Linux machine whose `/dev/kvm` belongs to a group the user isn't in is
told the one command that fixes it. Windows passes the check on x86_64; a machine
whose WHP is off fails its first microVM, which says so.

### Refusing a machine that can't run it

- **`chopin pair` and `chopin connect` refuse before they pair, use a pairing key
  or open a browser**, with words that say what the machine needs:

  ```text
  This machine can't run Chopin's work: Chopin runs each agent in its own microVM,
  which needs Linux or Windows on x86_64 with hardware virtualization. Your user
  can't read and write /dev/kvm.
  Fix: sudo usermod -aG kvm $USER, then log out and in again (for the chopin service,
  restart the machine or run: sudo systemctl restart user@$(id -u))
  ```

  A Mac, an Arm machine or one without virtualization is told there is nothing to
  fix there. `chopin status` shows the same words in its `Agents` row.
- **A machine paired before this release** that can't run NVX tells Chopin once,
  before `chopin connect` exits (`POST /api/connector/capability`, with its machine
  token and the same words). Chopin keeps them on the machine (`machines.vm_problem`,
  migration 051). The Machines page shows them in the machine's Sandbox row while it
  is away. A later connection that runs microVMs clears them.
- **Chopin hands work and credentials only to connectors that run microVMs.**
  Connector protocol 8 means "every agent runs in its own NVX microVM", and each of its
  requests says so (`chopin-connector-sandbox: nvx` and the hypervisor) once it has
  checked the machine. A connection, a Planner credential, a GitHub token, an MCP
  token, an AI launch or a machine's database login asked for by an older connector is
  refused with `connector-update-required` and words that say to run `chopin update`,
  whatever it says of its agents; an older connector stops on that without retrying. A
  protocol 8 request that doesn't say its agents run in microVMs is refused with
  `microvm-required`, and a registration that says its machine can't run them keeps
  what it said, as above. Pairing and the routes that hand out nothing still answer
  older connectors, so they can update.
- **Add machine** on the Machines page says what a machine needs (KVM, or the
  Windows Hypervisor Platform, on x86_64) instead of the agent's host install, and
  that a Mac can't run Chopin's work.

A machine that loses what NVX needs while connected (its user leaves the `kvm`
group, WHP is turned off) fails its next launch in NVX itself, which says why in
the run's or Planner's failure. The connector never starts the agent any other way.

## The seam

The connector starts every agent through one seam, `Sandbox.spawn(launch)` in
`apps/connector/src/sandbox.ts`. Its callers hand it a `Launch` and get back a
process whose stdin, stdout and stderr are pipes, so ACP over stdio and the spare
Planner protocol are unchanged:

```ts
type Launch = {
	command: string[]; // the agent, by the name its image has it under
	cwd: string; // where it works: its repository's path in the guest
	env: NodeJS.ProcessEnv; // its whole environment, before the guest's own
	stdin: "pipe" | "ignore";
	own?: string[]; // its token folder and agent state, in the state directory
	agentHome?: string; // its agents' state, written (a launch on Chopin's AI accounts)
	writable?: string[]; // other state-directory folders it writes
	reads?: string[]; // host folders it only reads: a Planner's checkout
	repository?: GuestRepository; // the repository its guest clones and works in
	disk?: string; // the disk its guest's writable root is on (a Planner's)
};
```

`vmSpec(launch, context)` in `apps/connector/src/nvx.ts` is a pure function that
turns a launch into a microVM spec (its layer and user, its shares, its proxy port,
its environment, its command), and every file-system and network property below
is a property of what it returns. `nvxArguments(spec, …)` turns a spec into one
`nvx sandbox run` command line:

```text
nvx sandbox run --hypervisor=<kvm|mshv|whp>
  --layer=distro,<image layer>,<uuid>
  --upper=ram   or   --upper=scratch --scratch=<disk>
  --memory-mib=2048 --hostname=chopin-<hash>
  --workload-user=<uid>:<gid>
  --mount=<guest>,<host>,<ro|rw> [--mount-deny=<path>]...      (each share)
  --net=10.0.0.2/24 --network-profile=portable
  --network-egress=deny --host-loopback=deny --network-proxy=10.0.0.1:<proxy port>
  --environment-file=<0600 file> --cwd=<guest path>
  --entrypoint=/usr/bin/env --arg=-- --arg=<word>...
  --timeout=31536000 --exec-timeout-ms=0
```

`nvx sandbox run` streams stdin to the workload and its stdout and stderr back,
ends the VM when the workload exits, and exits with its status. The environment
goes in a file in the launch's own record folder (`<base>/nvx/launches/<id>/`,
`0700`), never on a command line where another process could read it with `ps`, and
the folder goes when the launch ends. `nvx` prints the OpenVMM command it starts as
its first stdout line; the seam drops that line, because an agent's stdout is its
protocol.

There is no other way to start an agent. `spawnIn(sandbox, launch)` calls
`sandbox.spawn`. Tests of what the connector does around an agent use a stand-in
that starts each launch on the host (`apps/connector/src/testing/host-sandbox.ts`,
and `testing/chopin-on-host.ts` for the CLI); neither is built into `chopin`.

## Images

An agent needs its runtime and its install in the guest: Node and Atomic with
atomic-acp, or GitHub's Copilot CLI, or whatever an ACP agent or Planner command
runs. The host's own installs are never used, and the host needs none: what the
person installs or removes on the host with npm, Bun or anything else changes
nothing in a guest.

An **image** is an EROFS layer the connector builds once per recipe, which its
guests boot as their root (`apps/connector/src/images.ts`). The agent's runtime has
to be in a layer rather than a share: virtio-fs answers every lookup with a host
round trip, so loading Atomic's 34,000 files from a share took 36–46 seconds against
1.6–2.5 seconds from a layer ([Measurements](#measurements)). A recipe is:

- the NVX release's own Ubuntu layer, which it is made from;
- Node.js 24, pinned by version and SHA-256 (`NODE_RELEASE`);
- git, its HTTPS libraries and their dependencies as Ubuntu packages, each pinned by
  archive path and SHA-256 (`guest-packages.ts`); the release's layer has no git;
- the agent's install commands: the built-in agents' npm packages at the versions
  this release pins (`AGENT_PACKAGES`: `@github/copilot` 1.0.114, `@bastani/atomic`
  0.10.2, `@bastani/atomic-acp` 0.0.18), or the commands the owner gives for another
  agent with `--install` and for a Planner command with `--planner-install`;
- an account for the connector's own user and group, and a system git configuration
  with `safe.directory = *` (below).

The image's key is the SHA-256 of all of that. It is built once into
`<base>/images/<key>.erofs` and rebuilt only when the key changes: another NVX
release, Node, package, agent version, install command or user. Images no recipe
names any more are removed as the connector starts. A command chopin has no recipe
for is refused before anything is paired, naming the option to add.

An image is built in a microVM too, so an install script runs no closer to the host
than the agent will. The host downloads Node and the packages and checks their
digests; the build's guest, as the layer's own `nobody`, unpacks the release's layer
with `fsck.erofs --extract` (from erofs-utils packages unpacked in its own memory, so
the host needs no erofs-utils), unpacks Node and git over it, runs the install through
the proxy, and writes the new layer with `mkfs.erofs`. A microVM of the new image is
then started to find the recipe's programs before the image is recorded. A build that
fails leaves no image and says why. The first build of the Copilot CLI's image took
39 seconds on the test machine.

**The workload's user.** On a Linux host OpenVMM does every operation on a share as
the connector's user, and the guest checks permissions against the owner the host
reports. So the guest runs as the connector's own user and group
(`--workload-user`), and the image carries an account for them. Any other user
couldn't enter a private folder it had just made in a share, which git, npm, ssh and
every `mkdtemp` do. Windows reports every shared file as everyone's, so any account
works there. Git in the guest sees shares owned by someone else, so the image's
system configuration trusts every directory; it has to be the system file because
git drops `GIT_CONFIG_*` settings for `receive-pack`.

## Repositories in the guest

An agent never works in a folder shared from the host. It works in a repository of
its own in its guest, which its guest clones as it starts (`PREPARE` in `nvx.ts`):

- **A run** (Build, Run, Retry, investigation, prototype) clones with
  `git clone --shared` from the git directory of the person's checkout or the
  connector's clone of the repository, shared read-only, into its guest's memory
  (`--upper=ram`) at `/work/<name>`, checks out the run's commit detached and makes
  the run's branch (`chopin/implement-…` or `chopin/spike-…`). `--shared` reads the
  objects where they are, through alternates, and copies nothing. The host first makes
  sure that git directory has the run's commit, fetching it into the checkout as before.
- **A Planner** keeps a disk of its own, `<base>/planners/<owner>/<repo>/<document>.disk`,
  a sparse ext4 image its guest's writable root is on (`--upper=scratch`). Its first
  start clones with `git clone --reference … --dissociate` from the checkout's git
  directory, which copies the objects it needs, so the clone outlives the person's
  garbage collection, at the checkout's `HEAD`. Every later start finds it there, with
  whatever the Planner left in it. The Planner also reads the person's checkout,
  shared read-only, uncommitted files included, as `CHOPIN_CHECKOUT`; its own
  repository is `CHOPIN_WORKTREE`.

Nothing an agent writes reaches the person's repository but through GitHub: it pushes
its branch through the proxy with the token Chopin issued for the run, as before. A
guest never writes the person's checkout or its git directory. Every share of the
person's files is read-only, which NVX enforces on the host for every request
whatever the guest does, and a clone's alternates are only ever a read-only path.

Measured on the test machine, a clone in the guest runs `git status` in 32–35 ms and
commits in 72 ms; the same worktree shared from the host took 1.7–11 seconds for
`git status`. The Planner reading the person's checkout over its read-only share is
slower (a `git status` over 80,000 files took 7.4–8.7 seconds, `rg` 5–6 seconds), so
it reads the checkout for what is uncommitted and does its own work in its clone.

What people see change:

- A finished run leaves no worktree on the machine. What it kept, it pushed; its
  branch appears on GitHub and in the person's `git branch` only once they fetch it.
- A Planner's commits are on its disk and on the branches it pushes, never in the
  person's checkout.
- `--keep-runs` keeps finished runs' records and agent state, not worktrees.

### What read a run's worktree on the host, and where it went

Before this change some features opened a run's worktree on the host. Each now works
inside the guest, or reads nothing of it:

| Feature                                                             | Before                                                    | Now                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An investigation's or prototype's screenshots (`upload_image_file`) | The connector's bridge read the file in the host worktree | The run's MCP bridge runs in the guest, on the image's Node (`guest-bridge.ts`, carried by the `chopin` binary and shared as one read-only file), and reads the image in the guest's repository: at most 1 MiB, PNG, JPEG or WebP, never outside the repository |
| Chopin's tools for the run (`read_implementation`, `report_pr`, …)  | A stdio or loopback bridge on the host                    | The same bridge in the guest, to Chopin through the proxy with the run's token                                                                                                                                                                                  |
| Investigation and prototype results                                 | Submitted over MCP                                        | Unchanged: over MCP, as JSON; no files                                                                                                                                                                                                                          |
| A prototype's throwaway branch                                      | Removed from the person's repository when the run ended   | Never in it: the branch is in the guest and goes with it; pushing it is refused as before                                                                                                                                                                       |
| Extra worktrees for concurrent pull requests                        | `<base>/runs/<run>-worktrees/`, removed at the end        | `git worktree add` inside `/work` in the guest, gone with it                                                                                                                                                                                                    |
| Servers an agent left running                                       | Killed by the processes in its worktree                   | End with its microVM                                                                                                                                                                                                                                            |
| Retention (`--keep-runs`)                                           | Kept the newest runs' worktrees                           | Keeps the newest runs' records and agent state; removes an earlier release's worktrees with their runs                                                                                                                                                          |
| Build, Retry and `read_rebuild` reading what a build did            | Chopin reads GitHub                                       | Unchanged: Chopin reads the pull requests on GitHub                                                                                                                                                                                                             |
| Logs                                                                | The agent's stdout and stderr through the connector       | Unchanged, through `nvx`                                                                                                                                                                                                                                        |
| A spare Planner's worktree, detached at the checkout's new `HEAD`   | Updated on the host                                       | A spare whose checkout moved is let go and the document starts cold; the host runs no git in a guest's repository                                                                                                                                               |
| `chopin status` disk use                                            | Kept worktrees                                            | Kept runs' agent state, and Planners' disks                                                                                                                                                                                                                     |

### A Planner's disk

- **Size.** A disk is a sparse 32 GiB ext4 image, made in a microVM of the release's
  own layer (`truncate` and `mkfs.ext4` with lazy initialization), so it takes on the
  host only what its Planner writes. 32 GiB is the most it can hold.
- **Life.** It lasts across the Planner's starts, the machine's restarts and the
  connector's updates. A spare Planner's slot that takes a document is that
  document's from then on, disk included.
- **Removal.** The connector removes a Planner's disk, with its token folder and its
  agents' state:
  - when Chopin says its document is archived or gone (`POST
    /api/connector/planner/kept`, asked as the connector connects and every hour);
  - when no Planner has run on it for 30 days;
  - when the machine is unpaired, or Chopin revokes it, once its launches have
    stopped.

  It never removes a disk a running microVM has: each launch's record names its disk,
  and the sweep checks the records again just before it removes one. A Planner reset in
  Chopin doesn't remove the disk: the next Planner finds its clone as it was left.
- **Unpushed commits** on a disk are the Planner's state. They go with the disk, and
  the connector says so when it removes one ("Commits on it that were never pushed
  went with it").

## Shares

Shares are mounted at the same absolute paths in the guest as on a Linux host, so
the paths a launch's environment names mean the same on both sides. NVX refuses
shares that hold one another; a read-only folder inside another the launch is given
is in that one (a checkout's own `.git`), and anything else is refused, naming both.

| Share                                           | Mode in the guest                     | Who gets it                      |
| ----------------------------------------------- | ------------------------------------- | -------------------------------- |
| The git directory its repository is cloned from | read-only                             | a run, a Planner                 |
| The person's checkout                           | read-only, uncommitted files included | a Planner                        |
| Its token folder (`<slot>.tokens`)              | read-only                             | a launch with tokens             |
| Its agents' state (`<slot>.agent`)              | writable                              | a launch on Chopin's AI accounts |
| The MCP bridge (`/opt/chopin/bridge.mjs`)       | read-only, one file                   | every launch                     |
| What the owner adds with `--sandbox-write`      | writable                              | every launch                     |

Nothing else of the host is in the guest: not the home folder, not the connector's
state directory, not the machine token, not `~/.ssh` or any other credential, not
another launch's tokens, not the owner's own agent logins. So the lists the process
sandbox needed (credential paths to deny, the state directory to read around, the
owner's agent folders to hide) are gone: what isn't shared isn't there. A guest
writes only folders the connector made for it in its state directory, and what the
owner adds. `--sandbox-hide <path>` still works inside a share, as `--mount-deny`.

## Network

A guest's only way out is the connector's allow-list proxy, through NVX's
proxy-only network:

```text
--net=10.0.0.2/24 --network-profile=portable --network-egress=deny
--host-loopback=deny --network-proxy=10.0.0.1:<proxy port>
```

OpenVMM relays the guest's TCP connections to `10.0.0.1:<proxy port>` to the proxy on
host loopback and denies everything else: other ports of the gateway, the host's
other loopback services, the local network, IPv6, UDP and DNS. The guest gets
`HTTPS_PROXY`, `HTTP_PROXY` and `ALL_PROXY` set to `http://10.0.0.1:<port>`,
`NO_PROXY` empty and `NODE_USE_ENV_PROXY=1`; a launch's own proxy settings are
dropped. The proxy decides as before: Chopin's origin, GitHub, the AI relay, the
machine's database login, the package registries, what the owner adds with
`--sandbox-host`, and nothing else.

The AI relay keeps its address on host loopback (`http://127.0.0.1:<port>/<key>`).
The guest's request for it goes to the proxy, which allows the relay's `host:port`
and connects to it on the host.

## Credentials

A guest gets the credentials of its own launch and nothing else:

- for AI providers, the stand-ins Chopin's launch hands out, which only the
  connector's relay can use; the relay adds the launch credential
  (`x-chopin-launch`), which stays in the connector's memory;
- the launch's own Planner credential, MCP token and GitHub token (for one
  repository, short-lived), in its token folder or environment;
- on a machine with a database login for agents' sessions, that login, in its
  agents' state.

Never: the machine token, the owner's GitHub login as `chopin` holds it, an AI
provider key, the relay's launch credentials, another launch's tokens or the owner's
own agent logins. The guest's environment is the launch's (`managedEnvironment` for
a launch on Chopin's AI accounts, the agent's own variables and `--env` otherwise)
and the image's. A run Chopin hands no AI launch (a Chopin without launches) gets no
models of the owner's either: its agent runs with what `--env` gives it. A Planner
backend Chopin hands no AI accounts (an older server) is started with the
connector's environment but its GitHub credentials, as before.

A guest reads what it is shared, though: a Planner's checkout whole and the git
directory a run clones from, `config` included, so a token kept in a remote URL or
a credential file inside `.git` is readable to the agent.

## Planner backends, cold and spare

A cold Planner backend is one launch: its microVM boots on its disk, clones if it
has to, and starts the backend; the microVM ends with it. A spare is a launch too,
started ahead on a disk of its own for the repository's checkout, with its token
folder empty, and handed a document over stdin as before; its slot, disk included,
becomes the document's.

A cold boot to the workload's first output took 0.73–0.80 seconds on a quiet KVM
host and 1.9 seconds on WHP, with a 32 GiB scratch disk costing nothing extra. NVX
snapshots would start a guest faster, but a restore accepts only a fresh scratch
disk, never a Planner's own, and a spare already keeps a backend warm. So this
release takes no snapshots. When it does (for runs, which use no disk), it will
capture only a platform snapshot, before any workload, so no snapshot holds anything
of a launch, and NVX reseeds each restore's entropy and machine ID.

## Ending a launch

The connector owns each launch's `nvx` process. On Linux it runs in a process group
of its own, OpenVMM in it, and the connector records its process, its own process
and its disk in `<base>/nvx/launches/<id>/launch.json`. A launch ends when:

- its work ends (the agent exits, the run finishes or is stopped, its deadline
  passes);
- Chopin revokes the machine, or the owner unpairs it: every launch ends with the
  connector's connection;
- Chopin stops asking for a document's Planner, or archives the document;
- the connector exits.

Ending closes the workload's stdin and signals the process group; anything left is
killed with it, OpenVMM included, so a launch's microVM is gone within the grace
period its caller already had (five seconds for a Planner). A connector that died
without ending its launches finds their records when it next starts its microVMs,
kills those whose connector is gone and removes the records; a launch of a chopin
still running beside it on the same state directory is left alone. Until then such
a VM reaches nothing: its proxy and relay died with the connector, and its tokens
expire.

## Concurrency and resources

Each VM gets 2 GiB of memory and one vCPU (`nvx sandbox run` takes no processor
count), its RAM upper at most half of its memory. An idle guest of 2 GiB costs about
205 MB of the host's memory (330 MB with Atomic loaded) and 0.1% of a core; 24
concurrent 1 GiB VMs ran on an 8-vCPU, 32 GiB Windows host, and 80 on the Linux test
machine. The connector runs one job at a time as before, plus the Planners it is
asked for and one spare per registered checkout's repository.

## What goes away

- MXC, its executors in the `chopin` binary, and the sandbox probe;
- Seatbelt, bubblewrap and ProcessContainer, and their policies: read roots, denied
  credential paths, the state directory read around, Windows read roots, the owner's
  agent folders hidden from a launch on Chopin's AI accounts;
- the git hardening for trees an agent wrote: the host no longer runs git in one;
- linked worktrees of the person's repository for runs and Planners;
- `--require-sandbox` and `--no-sandbox`: there is nothing to require and nothing
  to turn off;
- the agent start checks outside the sandbox: `chopin connect` and
  `chopin service install` check the agent in a microVM of its image;
- the host's agent install and its Node.js version check: the image has its own;
- macOS and Arm64 machines.

`--sandbox-host` stays (the proxy's allow-list). `--sandbox-write` stays, as a
writable share. `--sandbox-hide` stays, inside a share. `--install` and
`--planner-install` are new.

## Windows

What differs on a Windows host:

- **Paths.** Guest paths are POSIX. A host path `C:\Users\me\repo` is shared at
  `/mnt/c/Users/me/repo`, and the connector translates every path a launch's
  environment names.
- **Owners.** NTFS has no POSIX owner; every shared file reads as `0:0`, mode 777.
  The image's account works as it is.
- **No agent works in an NTFS share.** chmod, setting times and hard links fail in a
  share on WHP, so `npm install` in one fails. Repositories are in the guest, so this
  doesn't arise.
- **Hidden `.git`.** Git for Windows marks `.git` hidden, and an entry with the Hidden
  attribute below a share's root can't be read in the guest, though a share's root
  can be. A run shares the git directory itself, which works. A Planner shares the
  checkout and clones from the `.git` in it, which the guest can't read while it is
  hidden, and NVX refuses to share the checkout and its `.git` as two shares. So on
  Windows the connector clears the Hidden attribute of a Planner's checkout's `.git`
  before it starts (`unhide` in `windows-host.ts`); that attribute only says how
  Explorer shows the folder, and nothing in it changes.
- **Disks.** A file a guest grows on NTFS isn't sparse: making a 32 GiB disk that way
  wrote 32 GiB and took 220 seconds. So the connector makes every disk's file sparse
  on the host first (`FSCTL_SET_SPARSE` and `SetEndOfFile`, `sparseFile`), on Linux by
  truncating it, and a guest formats it without discards, which NTFS doesn't take.
  Space a Planner frees inside its disk isn't given back to NTFS, so a disk only grows,
  to its 32 GiB at most, until it is removed.
- **Leftovers.** `nvx sandbox run` keeps its own folder in the system's temporary
  directory (`nvx-sandbox-run-*`, private), which a launch ended by force leaves behind,
  on Linux too; sweeping it is still to do. A launch's environment file stays in its
  `0700` record folder until the launch ends, or until the next connector starts after a
  crash.
- **Ending.** Killing `nvx.exe` leaves `openvmm.exe` running, and so does an `nvx` that
  reaches its own `--timeout` while the guest is busy (`error[still-running]`); and a VM
  killed in the middle of heavy share I/O was seen to wedge, holding its memory until
  Windows restarted. So the connector gives `nvx` a timeout of a year, so its own
  deadlines decide; puts each `nvx.exe` in a job object that kills what is in it when
  closed (`killJob`); stops a launch by ending its stdin and waiting for the workload,
  and so the VM, to end by itself; kills the job only after that grace; and, where a
  process of the job is still running 10 seconds later, says the VM didn't end and
  Windows may need a restart, rather than take it for gone. A `nvx sandbox run` has no
  `nvx sandbox stop`; ending its workload is its graceful stop. A Planner backend has no
  stdin to end, so it gets only the grace and then the job.
- **Service.** The Task Scheduler service runs as the user, who must be allowed to
  use WHP; that needs no administrator.

The Linux/KVM engine is the one that has run end to end. On WHP the same agent image
booted unchanged, shares, restores and stdio were measured, the `chopin` binary ran,
and `windows-host.test.ts` ran on a Windows host (sparse files, unhiding, jobs). A
Windows machine running a Build and a Planner end to end is the next check.

## Shipping NVX

A `chopin` release pins one NVX release (`NVX_RELEASE` in `nvx.ts`): its version and
the SHA-256 of each package (`linux-kvm`, `linux-mshv`, `windows-whp`). NVX publishes
development releases only, several a day, so the pin moves only with a `chopin`
release tested on it. `chopin` downloads its package the first time it needs it
(about 275 MB on Linux, 150 MB on Windows), checks the pin and the package's own
`SHA256SUMS`, unpacks it into `<base>/nvx/<version>/` (`0700`) and removes releases it
no longer pins. `CHOPIN_NVX_ROOT` names an extracted package instead, for a machine
without the network. The `chopin` binary carries the MCP bridge its guests run.
Stripping OpenVMM's debug information brings the Linux package to about 71 MB;
carrying the packages in Chopin's own releases, and having `install.sh` and
`install.ps1` fetch them beside the binary, is the next step.

## Migration

- A machine updates `chopin` (connector protocol 8). Its first connect checks the
  machine, downloads NVX, and builds its agent's image (once; it says how long).
- Chopin's server takes connections and hands credentials to protocol 8 only, once it
  is deployed; older connectors are told to update.
- Settings saved by an earlier `chopin connect` keep working. A saved
  `--require-sandbox` or `--no-sandbox` is dropped. An agent other than the built-in
  ones needs `--install` once.
- Runs and Planner worktrees an earlier release made stay where they are. Retention
  removes old runs' worktrees as before. A Planner worktree is never used again and
  never removed by `chopin`: `chopin status` lists it as an earlier chopin's, and
  its commits are the person's to keep or remove (`git worktree remove`). Each
  Planner starts afresh on a disk.
- `<base>/sandbox/` (MXC's executors) can be removed.

## Invariants

These are what the change keeps, each with the tests that hold it. The real-VM tests
(`apps/connector/src/nvx-vm.test.ts`) run where `CHOPIN_NVX_ROOT` names an NVX package
and the user can use `/dev/kvm`, and skip elsewhere, CI included.

| Invariant                     | Statement                                                                                                                                                     | Tests                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No host agent                 | No agent process (coding agent, Planner backend, agent check, image build) starts outside a microVM: the seam has no other way to start one.                  | `nvx.test.ts` (the command line is `nvx sandbox run` with the agent as its workload); `nvx-vm.test.ts` (a launch runs in its guest; ending it ends OpenVMM); every caller takes a `Sandbox`                                                        |
| Shares exact                  | A microVM's shares are exactly its launch's allowed set, with their modes, and nothing else of the host; it writes nothing of the person's.                   | `nvx.test.ts` ("a run gets … and nothing else", "no share the guest writes is a path into the person's repository", "no share holds another"); `nvx-vm.test.ts` (a write into the person's `.git` fails with a read-only file system)              |
| Alternates read-only          | A guest's clone reads the person's objects only through a read-only path, and a Planner's copies them.                                                        | `nvx.test.ts` (the clone and its source share); `run.test.ts` (a run's clone reads the checkout's objects and adds nothing to the person's repository); `planner.test.ts`; `nvx-vm.test.ts` (a Planner's clone has its own objects)                |
| Egress exact                  | A guest's only network endpoint is the connector's proxy, and the proxy allows only its list.                                                                 | `nvx.test.ts` (proxy-only flags; a launch's own proxy settings dropped); `nvx-vm.test.ts` (no direct connection, no DNS, only allowed hosts through the proxy); `sandbox-proxy.test.ts`                                                            |
| No real credential in a guest | No guest gets the machine token, an AI provider key, the relay's launch credential, the owner's GitHub login or agent logins, or the connector's environment. | `nvx.test.ts` (the environment is the launch's, in a file, never on a command line); `nvx-vm.test.ts` (no secret on any host command line); `launch-handoff.test.ts` (an agent holds only stand-ins)                                               |
| Snapshot clean                | No snapshot holds anything of a launch.                                                                                                                       | Holds trivially: this release takes no snapshots                                                                                                                                                                                                   |
| Teardown                      | A launch that ended, was revoked or unpaired has no microVM left.                                                                                             | `nvx-vm.test.ts` (ending a launch ends OpenVMM and its record; a server the agent left running ends with it); `sandbox.ts` `endOrphans`                                                                                                            |
| Disk in use is kept           | A Planner's disk is never removed while a microVM runs on it; a removed disk takes its tokens and state with it.                                              | `planner-disks.test.ts`                                                                                                                                                                                                                            |
| Refuse unsupported            | A machine that can't run NVX pairs, connects and starts nothing, says why, and Chopin keeps what it said.                                                     | `nvx.test.ts` (which machines can run it); `main.test.ts`, `messages.test.ts` (refused before pairing, nothing sent); `routes.test.ts` (older connectors told to update, `microvm-required`, the capability kept and shown); `machine-contract.ts` |

## Measurements

On a Linux test machine (KVM, AMD, NVX `v0.1.0-dev.c753e7b4c288`), one vCPU, warm
host cache:

| Workload                                           | Over a virtio-fs share    | In the guest's own disk    | On the host |
| -------------------------------------------------- | ------------------------- | -------------------------- | ----------- |
| Load Atomic (34,000 files)                         | 36–46 s (read-only share) | 1.6–2.5 s (image layer)    | 1.2 s       |
| `git status`, 3,555-file worktree                  | 1.7–11 s                  | 32–35 ms (clone in memory) | 21–43 ms    |
| `git status`, a checkout with 80,000 files on disk | 7.4–8.7 s                 |                            | 17 ms       |
| `npm install express`, warm npm cache              | 1.7 s                     | 0.84 s (memory)            | 0.91 s      |
| Cold boot to the first output                      |                           | 0.73–0.80 s (1.9 s on WHP) |             |
| Build of the Copilot CLI's image                   |                           | 39 s, once                 |             |

One failure to know: OpenVMM sometimes failed to start a microVM under heavy host
load with "driver does not support io-uring" in its log (3 of about 25 starts during
one busy period, none in 80 since). The launch fails with that reason and the run or
Planner can be started again; retrying such a start by itself is the next step.
