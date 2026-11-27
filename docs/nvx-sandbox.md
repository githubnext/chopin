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
  Fix: sudo usermod -aG kvm $USER, then log out and back in (for the chopin service,
  restart the machine). Or have an administrator add a udev rule, such as
  KERNEL=="kvm", GROUP="kvm", MODE="0660", RUN+="/usr/bin/setfacl -m u:<user>:rw /dev/kvm"
  (logind may drop that ACL)
  ```

  A user who is in the `kvm` group, though the login `chopin` runs in began before
  they joined it (for the service, its systemd user manager, which a logout leaves
  running), is told so, and to log out and back in, or for the service to restart the
  machine (`joinedLater` reads the group database with `id -G`). No fix restarts
  `user@$(id -u)`, which would end every session and service of the user's. A Mac, an Arm machine or one
  without virtualization is told there is nothing to fix there. `chopin status` shows
  the same words in its `Agents` row.
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
  whatever it says of its agents; an older connector stops on that without retrying. The
  words name the release this Chopin recommends, or the first that speaks protocol 8
  (0.0.32, `NVX_RELEASE`) where it recommends an older one, which it would refuse too,
  and plain `chopin update` where it recommends none (`releaseToInstall`). The
  Machines page's fix and `GET /api/connector/version`, which a plain `chopin update`
  asks, name the same release. A
  protocol 8 request that doesn't say its agents run in microVMs is refused with
  `microvm-required`, and a registration that says its machine can't run them keeps
  what it said, as above. Pairing and the routes that hand out nothing still answer
  older connectors, so they can update.
- **Add machine** on the Machines page says what a machine needs (KVM, or the
  Windows Hypervisor Platform, on x86_64) instead of the agent's host install, and
  that a Mac can't run Chopin's work.

A machine that loses what NVX needs while connected (logind takes back the access to
`/dev/kvm` a desktop login gave its user, the user leaves the `kvm` group, WHP is
turned off) fails its next launch in NVX itself. Where OpenVMM's log says it wasn't
allowed to open `/dev/kvm` or `/dev/mshv` (``failed to open file `/dev/kvm`: Permission
denied``), the launch's failure is the machine's words above, with the fix, and the
connector hears it before the launch ends (`VmOptions.unsupported`). It tells Chopin
(`/api/connector/capability`, as at connect), ends its Planners and its connection once
any run has ended, so the Machines page shows why, and starts nothing until the support
check passes again, which it reads every 30 seconds; then it connects again, which
clears what Chopin kept. A spare whose start failed so is not taken for a command that
can't be a spare. The connector never starts the agent any other way.

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
  --entrypoint=/bin/sh --arg=-c --arg=<launcher> --arg=chopin-launch --arg=<word>...
  --timeout=31536000 --exec-timeout-ms=0
```

`nvx sandbox run` streams stdin to the workload and its stdout and stderr back,
ends the VM when the workload exits, and exits with its status. The environment
goes in a file in the launch's own record folder (`<base>/nvx/launches/<id>/`,
`0700`), never on a command line where another process could read it with `ps`, and
the folder goes when the launch ends. `nvx` prints the OpenVMM command it starts as
its first stdout line, and the guest's launcher prints `>> chopin: the workload starts`
before it runs the agent by the name its image has it under (`/usr/bin/env -- <word>...`);
the seam drops both lines, because an agent's stdout is its protocol. The second is how
the connector knows the workload has started (see
[Starting a microVM again](#starting-a-microvm-again)).

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
  0.10.11, `@bastani/atomic-acp` 0.0.18), or the commands the owner gives for another
  agent with `--install` and for a Planner command with `--planner-install`;
- what is in the folder the owner names with `--install-from` for those commands, if
  any: each file's path in it, content and whether it is executable;
- an account for the connector's own user and group, and a system git configuration
  with `safe.directory = *` (below).

The image's key is the SHA-256 of all of that. It is built once into
`<base>/images/<key>.<uuid>.erofs`, a layer of its own name that its record
`<key>.json` names (an image built before this names none, and is `<key>.erofs`), and
rebuilt only when the key changes: another NVX
release, Node, package, agent version, install command, file in the
`--install-from` folder, or user. Which program a launch starts is no part of the
key, so an agent and a Planner command whose installs are the same share one image,
built once and checked for both programs. Images no recipe
names any more are removed as the connector starts. A command chopin has no recipe
for is refused before anything is paired, naming the option to add.

### When images are built

Every image a launch on the machine may need is built before anything starts
(`ensureImages` in `images.ts`): the agent's, and with `--planner-command` the
Planner's, one for both where their installs are the same. That happens as the
microVMs open, which is before:

- `chopin connect` says Connected, or tells Chopin anything of the machine;
- `chopin service install` installs the service, with `--skip-check` too (which leaves
  out only the agent's start);
- the service connects as it starts, as after `chopin update` with a recipe that
  changed. A service building has not connected yet, so Chopin shows the machine as
  away until it has; the connector protocol has no state that says a machine is
  preparing, and none was added.

`chopin connect` says each build on its own line, and why the Planner's is built
then:

```text
… Building atomic-acp's image for its microVMs (a minute or two, once).
… Building the Planner's image (my-planner) for its microVMs (a minute or two, once, so the first document's Planner starts at once).
… Building one image for atomic-acp and the Planner (my-planner), whose installs are the same, for their microVMs (a minute or two, once, so the first document's Planner starts at once).
```

A build that fails, the Planner's included, fails `chopin connect` or
`chopin service install` with the build's own words, before anything is paired,
connected or installed, rather than a document's Planner later. An image found built
is checked again only for a program it wasn't checked for when it was built, as when
an agent's image is found shared by a Planner command added since; that takes one
microVM start, about a second, once.

One build of a key runs at a time. Within a `chopin`, everything that wants an image
while it is being made waits on that one build. Across the `chopin`s on a base dir,
one holds `<base>/images/<key>.lock`, made whole by linking a file it wrote, with its
process in it; another, such as `chopin service install`'s check beside a service
starting on the same base dir, says it waits, waits, and finds the image built. A
lock whose process is gone is taken over, only under `<key>.lock.takeover` and only
while it is still the lock found abandoned, so two `chopin`s that find a dead one's
lock never both build; and a `chopin` lets go of a lock only while it is its own. A
record is written whole (a file renamed over it), and each build's layer has its own
name, so a record never names a layer another build made. The connector that holds
the base dir prunes images as it starts, but never one of a key whose lock another
`chopin` holds; of an image it keeps, it removes the layers its record doesn't name
and builds left unfinished.

Each launch reads its image's record as it starts (`ImageStore.found`). One whose
image is gone since it was made, removed by hand say, waits for it to be made again
(`awaitingImage` in `sandbox.ts`): a burst of launches that want it meanwhile, as the
Planners of the documents one turn creates, all wait on that one build and then
start in what it made; a build that fails ends every one of them with its words, and
the next launch asks for a build again. A launch stopped while it waits starts
nothing, and its stdin waits with it for the workload. A spare Planner's boot is such a
launch: it waits on the same one build and never makes another, and, as every launch
that waited, says its workload started once its microVM has booted, when it gives its
slot of the launch gate back (see [Bursts of new documents](#bursts-of-new-documents)).

An image is built in a microVM too, so an install script runs no closer to the host
than the agent will. The host downloads Node and the packages and checks their
digests; the build's guest, as the layer's own `nobody`, unpacks the release's layer
with `fsck.erofs --extract` (from erofs-utils packages unpacked in its own memory, so
the host needs no erofs-utils), unpacks Node and git over it, runs the install through
the proxy, and writes the new layer with `mkfs.erofs`. A microVM of the new image is
then started to find the recipe's programs before the image is recorded. A build that
fails leaves no image and says why. The first build of the Copilot CLI's image took
39 seconds on the test machine.

The build's guest has no credentials: none of the owner's, and not the machine's.
An install that needs a sign-in, such as a package from a private registry, reads
what the host fetched with it instead. The owner fetches it into a folder and names
the folder with `--install-from`. The connector copies the folder for each build
(files and folders only; a link is refused rather than followed), checks the copy is
what the key was made of, and shares the copy read-only at `/install-from` with the
build's guest alone. No agent's guest gets it: an image holds only what its install
made of it.

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
  host only what its Planner writes. A new sparse file reads as zeros, which
  `mkfs.ext4` is told (`assume_storage_prezeroed=1`); otherwise the guest's kernel
  writes zeros over its inode tables after the first mount, about 512 MiB on the host.
  32 GiB is the most it can hold.
- **Life.** It lasts across the Planner's starts, the machine's restarts and the
  connector's updates. A spare Planner's slot that takes a document is that
  document's from then on, disk included.
- **Removal.** The connector removes a Planner's disk, with its token folder and its
  agents' state:
  - when Chopin says its document is archived or gone (`POST
    /api/connector/planner/kept`, asked as the connector connects, every hour, and
    once a Planner Chopin stopped asking for has exited, as when its document is deleted);
  - when a writer reset the document's Planner in Chopin after the disk was made.
    Chopin keeps when it was last reset (`channels.planner_reset_at`, migration 052)
    and names it with each Planner credential; the connector keeps the reset each disk
    was made after (`<slot>.reset`). A disk from before goes as its Planner next
    starts, or at the next `planner/kept` sweep, which names each disk's reset;
  - when the machine is unpaired, or Chopin revokes it, once its launches have
    stopped.

  It never removes a disk a running microVM has: each launch's record names its disk,
  and the sweep checks the records again just before it removes one.
- **Unpushed commits** on a disk are the Planner's state. They go with the disk, and
  the connector says so when it removes one ("Any commits on it that were never pushed
  went with it").

## Shares

Shares are mounted at the same absolute paths in the guest as on a Linux host, so
the paths a launch's environment names mean the same on both sides. A share is the
host folder where it really is, links in its path followed, and so is the base dir,
which `stateDirectory` resolves as `chopin` starts: on a machine whose `~/.local` is a
link to another disk, the guest has `/fast/home/.local/…`, never `/home/<user>/.local/…`.
Every host path a guest is told of, in its environment (the agents' state directories,
token files, a `--sandbox-write` folder named in `--env`), its command's arguments or
its working directory, is named where its share has it, however the launch named it
(`inGuest` in `vmSpec`), so no value names a host path the guest doesn't have. NVX refuses
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
connector's environment but its GitHub credentials, as before. Whatever the host, no
variable only Windows sets (`APPDATA`, `USERPROFILE`, `PSModulePath` and the like)
reaches a guest, and on a Windows host neither does its `Path` or `SHELL`: they name
nothing a Linux guest has but the host user's profile.

A guest reads what it is shared, though: a Planner's checkout whole and the git
directory a run clones from, `config` included, so a token kept in a remote URL or
a credential file inside `.git` is readable to the agent.

## Planner backends, cold and spare

A cold Planner backend is one launch: its microVM boots on its disk, clones if it
has to, and starts the backend; the microVM ends with it. A spare is a launch too,
started ahead on a disk of its own for the repository's checkout, with its token
folder empty, and handed a document over stdin as before; its slot, disk included,
becomes the document's.

### Which repositories keep a spare

The connector keeps one ready spare (`planner-spare.ts`) for each repository it
recently ran a Planner in, the clones it made in `repos/` included, and for each
registered checkout's:

- **Recently served.** Each Planner that starts in a repository, cold or on a spare,
  marks it served (`<base>/planner-spare.json`, which the next connector reads), and
  a repository keeps its spare for 7 days after (`RECENT_MS`). The first new document
  of a repository the machine never served starts cold, and its spare starts 5 seconds
  later, once that Planner has had the machine to itself.
- **Bounded.** At most 4 spares (`MAX_SPARES`), and no more than take a tenth of the
  machine's memory at about 300 MB each (`spareBound`: one on a 4 GB machine, two on
  8 GB, none under 3 GB). The most recently served repositories have them; a
  registered checkout no Planner ran in comes after them. A spare starts only while
  the machine has 1 GB available beside it; until then `chopin status` says it waits
  for memory, and it tries again each minute.
- **Only where the machine can push.** Before a spare starts, Chopin is asked whether
  it would give the machine a token for the repository (`POST
  /api/connector/github-token` with `purpose: "check"`, which mints none); a refusal
  starts none, and an answer that can't be had starts none until it can. The answer
  holds 10 minutes, and is asked again every 10 minutes while a spare is kept. A spare
  goes, disk and all, as soon as Chopin refuses that check or the GitHub token of any
  of the repository's Planners, and the repository is no longer served; a registered
  checkout's is asked again every 10 minutes and gets its spare back once Chopin says
  the machine can push there.

A new document (one with no disk on the machine yet) is handed its repository's
ready spare, and its replacement starts 5 seconds later, in a slot of its own. A
spare is never handed a second document: once handed, its process is the
document's Planner and its slot the document's for good, and the pool keeps nothing
of it. Many documents asking at once never share one: the first takes it out of the
pool before anything else runs, and the others start cold.

### Bursts of new documents

People open several documents at once, and a Planner's `create_document` can open
many in one turn, all in one repository, all wanting a Planner at once:

- **A burst refills more than one spare.** A new document that finds no spare ready
  within 10 seconds of another of its repository's asking starts a burst
  (`BURST_MS`). Until none has asked for 2 minutes (`QUIET_MS`), the repository
  keeps up to 4 spares, within the same memory bound, every repository's first
  spare before any's second, and their replacements start at once rather than 5
  seconds later. Once it is quiet, it goes back to one and lets the others go.
- **Cold starts run side by side, up to a cap.** A launch gate (`launch-gate.ts`)
  lets half the machine's processors' worth of Planner microVMs boot at once, 2 at
  least and 8 at most. A cold launch takes a slot only once its GitHub token and its
  checkout are there and its disk is made (the disk's own microVM takes a slot while
  it is made), and gives it back once its guest has booted and starts the backend
  (`workload` on the launch). So no slot is held while Chopin or GitHub is waited on.
  A launch that finds every slot held waits, never refused: documents in the order
  they asked, ahead of any spare. A spare also waits while any document's launch is on
  its way, from the moment the connector asks Chopin for its credential until it boots
  or takes a spare, so a burst's cold starts never share the machine with its refill.
  A spare that is already booting keeps its slot, so a burst can wait up to one
  spare's boot. A slot that frees goes on at once.
- **One fetch for the burst.** The cold launches of a cloned repository fetch it
  before they start. Work that arrives while it is fetched takes that fetch, each with
  its own GitHub token, rather than fetching it again in turn.

Measured on KVM with a gate of 3, five new documents of one repository at once: one
attached on the spare in 79 ms, three cold ones in 2.8–2.9 s side by side, and the
fifth in 4.7 s, once a slot freed (`nvx-vm.test.ts`). A document that has run here before starts on its own disk, cold, because its
state is on that disk and a microVM's disk is fixed when it boots.

There is no spare for a repository the machine has not served yet. A spare is bound to
its repository from its start: spare protocol 1 names the checkout and the spare's own
repository in its environment (`CHOPIN_CHECKOUT`, `CHOPIN_WORKTREE`), and its
microVM's shares (the checkout, the git directory its clone is made from) and the clone
on its disk are fixed when it boots. NVX takes no share into a running microVM, so a
spare not yet bound to a repository would need a new protocol and microVMs that take
shares later.

A spare holds nothing of a document until it is handed one. It boots with the
repository's checkout, read-only, an empty token folder, agents' state of its own and a
new disk; the document's Planner credential and Chopin token are written into its token
folder, and its GitHub token after, only at the hand-over, and the document's AI launch
reaches it over the agent connection once it attaches.

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
and the folder `nvx` keeps for the run in `<base>/nvx/launches/<id>/launch.json`. A
launch ends when:

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

### What a launch leaves

`nvx sandbox run` keeps a private folder of its own in the system's temporary
directory (`nvx-sandbox-run-<id>`, in `$TMPDIR` or `%TEMP%`) with OpenVMM's log and
report in it. It removes the folder when its workload ends by itself, but not when it
is ended by force, as the connector ends a launch it stops (a cold Planner when you
press Ctrl-C, for one); `nvx sandbox run` takes no other place for it
(`--state-dir`), and a folder in the state directory would make OpenVMM's control socket
path longer than Linux allows. So the connector reads the folder from the OpenVMM
command line `nvx` prints (`--microvm-report <folder>/outcome.json`, `runFolderOf`),
records it with the launch, and removes it when the launch ends, however it ends. The
records of a connector that died take their folders with them when the next connector
starts.

As `chopin connect` starts, it also removes the folders in its temporary directory
that no microVM uses (`sweepRunFolders`): those of a connector that died before it
recorded them, or of an earlier `chopin`. It looks only at its user's folders, and
keeps one a launch's record names, one younger than a minute (an `nvx` starting), and
one a running process names, as OpenVMM's command line does for its whole run: a
microVM of another chopin on another base dir, or of anything else of the person's
that runs NVX. Where it can't read the processes (`/proc` on Linux, `Win32_Process`
on Windows), it keeps them all.

The connector's own files are in its state directory, not the shared temporary
directory: the copy of the person's git configuration its git commands read
(`<base>/git/<pid>/`, removed as that process exits, and by the next connector once
the process is gone), and the empty folder the agent's start check runs in
(`<base>/nvx/check`).

## Starting a microVM again

Under heavy host load OpenVMM sometimes fails to start a microVM: it can't set up
io_uring for the guest's disk, and its log ends with `driver does not support
io-uring` (3 of about 25 starts during one busy period on the test machine; refusing
`io_uring_setup` with `strace` makes the same failure). `nvx` itself says only
`vmm-failure status 1`.

The connector starts such a launch's microVM again, up to three starts in all, half a
second and then a second and a half after the start that failed (`startVm`). It does
so only for that failure, read in OpenVMM's log, which it opens as soon as `nvx` names
the folder (`nvx` removes it as a failed start ends), and only before the workload has
started, so an agent never sees two starts:

- the guest's launcher prints `>> chopin: the workload starts` on stdout before it runs
  the agent, and until the connector reads that line nothing of the launch's stdin
  reaches the guest and nothing `nvx` prints on stderr reaches the caller;
- a start whose workload started is never tried again, whatever its log says;
- a launch stopped meanwhile is not started again: on Linux the wait is in the new
  start's own process group, which the caller's stop ends, and on Windows a stop goes
  through the launch, which then starts nothing more.

Each start has its own record and folder, and the caller sees one process: the last
start's exit, and its process group as `pid`. A start that fails for good, for this
reason after three tries or for any other at once, says why on stderr with the end of
OpenVMM's log, its last fatal error with its causes:

```text
The microVM didn't start after 3 tries: fatal error: failed to launch vm worker / Caused by: / 0: failed to launch worker / … / 4: driver does not support io-uring (nvx: error[exited]: OpenVMM exited during startup: vmm-failure status 1)
```

That line is what a run's or Planner's failure shows. `chopin connect` says each new
start in its output.

## Concurrency and resources

Each VM gets 2 GiB of memory and one vCPU (`nvx sandbox run` takes no processor
count), its RAM upper at most half of its memory. An idle guest of 2 GiB costs about
205 MB of the host's memory (330 MB with Atomic loaded) and 0.1% of a core; 24
concurrent 1 GiB VMs ran on an 8-vCPU, 32 GiB Windows host, and 80 on the Linux test
machine. The connector runs one job at a time as before, plus the Planners it is
asked for and its spares (see
[Which repositories keep a spare](#which-repositories-keep-a-spare)): at most 4, and no
more than take a tenth of the host's memory. At most half its processors' worth of Planner
microVMs (2 to 8) boot at once; the rest wait their turn (see
[Bursts of new documents](#bursts-of-new-documents)).

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
writable share. `--sandbox-hide` stays, inside a share. `--install`,
`--planner-install` and `--install-from` are new.

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
- **Leftovers.** `nvx sandbox run` keeps its own folder in `%TEMP%`, which a launch
  ended by force leaves, with only `openvmm.log` in it, as on Linux; the connector
  removes it as the launch ends, trying again for a few seconds while OpenVMM still
  holds the log, and the next `chopin connect` removes any left (see
  [What a launch leaves](#what-a-launch-leaves)). OpenVMM's control channel is a named
  pipe there, so the folder's command line names it only in `--microvm-report`. A
  launch's environment file stays in its `0700` record folder until the launch ends, or
  until the next connector starts after a crash.
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
  machine, downloads NVX, and builds its agent's image, and its Planner command's
  where it has one (once; it says how long).
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

| Invariant                      | Statement                                                                                                                                                                                                  | Tests                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No host agent                  | No agent process (coding agent, Planner backend, agent check, image build) starts outside a microVM: the seam has no other way to start one.                                                               | `nvx.test.ts` (the command line is `nvx sandbox run` with the agent as its workload); `nvx-vm.test.ts` (a launch runs in its guest; ending it ends OpenVMM); every caller takes a `Sandbox`                                                                                                                                                                                                                      |
| Shares exact                   | A microVM's shares are exactly its launch's allowed set, with their modes, and nothing else of the host; it writes nothing of the person's.                                                                | `nvx.test.ts` ("a run gets … and nothing else", "no share the guest writes is a path into the person's repository", "no share holds another"); `nvx-vm.test.ts` (a write into the person's `.git` fails with a read-only file system)                                                                                                                                                                            |
| Paths where the guest has them | Every host path in a guest's environment, command or working directory is where its share has it, named through a link or not; the base dir is where it really is.                                         | `nvx.test.ts` ("a base dir reached through a link"); `workspace.test.ts` (the state directory where it really is); `nvx-vm.test.ts` (a launch whose base dir is reached through a link writes its agent state where the host has it; a command by a host path that is gone runs its image's program)                                                                                                             |
| Alternates read-only           | A guest's clone reads the person's objects only through a read-only path, and a Planner's copies them.                                                                                                     | `nvx.test.ts` (the clone and its source share); `run.test.ts` (a run's clone reads the checkout's objects and adds nothing to the person's repository); `planner.test.ts`; `nvx-vm.test.ts` (a Planner's clone has its own objects)                                                                                                                                                                              |
| Egress exact                   | A guest's only network endpoint is the connector's proxy, and the proxy allows only its list.                                                                                                              | `nvx.test.ts` (proxy-only flags; a launch's own proxy settings dropped); `nvx-vm.test.ts` (no direct connection, no DNS, only allowed hosts through the proxy); `sandbox-proxy.test.ts`                                                                                                                                                                                                                          |
| No real credential in a guest  | No guest gets the machine token, an AI provider key, the relay's launch credential, the owner's GitHub login or agent logins, or the connector's environment.                                              | `nvx.test.ts` (the environment is the launch's, in a file, never on a command line); `nvx-vm.test.ts` (no secret on any host command line); `launch-handoff.test.ts` (an agent holds only stand-ins)                                                                                                                                                                                                             |
| Warm spares                    | A spare is kept only for a repository Chopin says the machine can push to, within the cap and memory bound; it holds nothing of a document before its hand-over and is never handed a second one.          | `planner-spare.test.ts` (a clone a Planner ran in keeps a spare, across restarts; refused, none starts and a kept one goes; the cap, memory and most recent first; never handed twice; a disk here starts cold); `nvx-vm.test.ts` (a clone's spare boots with an empty token folder and attaches a new document sooner than a cold start)                                                                        |
| Bursts                         | Many new documents at once each get one Planner and no spare twice; at most the cap of microVMs boot at once, none waits while a slot is free, documents in order and ahead of spares.                     | `launch-gate.test.ts`; `planner-spare.test.ts` (2, 5 and 10 documents at once, three repositories at once, a burst's refill, no slot held while a clone is fetched); `checkouts.test.ts` (one fetch for a burst); `nvx-vm.test.ts` (five documents at once)                                                                                                                                                      |
| Snapshot clean                 | No snapshot holds anything of a launch.                                                                                                                                                                    | Holds trivially: this release takes no snapshots                                                                                                                                                                                                                                                                                                                                                                 |
| Teardown                       | A launch that ended, was revoked or unpaired has no microVM left, and nothing of `nvx`'s in the temporary directory.                                                                                       | `nvx-vm.test.ts` (ending a launch ends OpenVMM, its record and `nvx`'s folder; a server the agent left running ends with it); `sandbox.test.ts` (a launch ended by force leaves no folder; a dead connector's records take theirs; the sweep keeps a live launch's, its own base dir's or another's, and removes a stale one); `sandbox.ts` `endOrphans`, `sweepRunFolders`                                      |
| One start                      | An agent sees one start of its workload: a microVM is started again only after OpenVMM's io_uring failure, and only before its workload started, with nothing of its stdin given to the start that failed. | `sandbox.test.ts` (a fake `nvx` that fails once with that log line and then starts; no new start for another failure or once the workload started; three at most; a stop while waiting starts nothing); `nvx-vm.test.ts` (a start refused io_uring with strace starts again and its workload reads its input once)                                                                                               |
| Disk in use is kept            | A Planner's disk is never removed while a microVM runs on it; a removed disk takes its tokens and state with it.                                                                                           | `planner-disks.test.ts`                                                                                                                                                                                                                                                                                                                                                                                          |
| Refuse unsupported             | A machine that can't run NVX pairs, connects and starts nothing, says why, and Chopin keeps what it said.                                                                                                  | `nvx.test.ts` (which machines can run it); `main.test.ts`, `messages.test.ts` (refused before pairing, nothing sent); `routes.test.ts` (older connectors told to update, never to an older release, `microvm-required`, the capability kept and shown); `machine-contract.ts`                                                                                                                                    |
| Lost at runtime                | A machine whose user can no longer open the hypervisor's device says why with the fix, tells Chopin, leaves, and starts nothing until it can again.                                                        | `sandbox.test.ts` (a start OpenVMM couldn't open `/dev/kvm` for says so and tells whoever started it); `nvx-vm.test.ts` (OpenVMM refused `/dev/kvm` with strace says so, and is not started again); `main.test.ts` (a machine whose user loses `/dev/kvm` tells Chopin, leaves, starts no Planner until it can, then connects again); `nvx.test.ts` (a user who joined the kvm group after chopin's login began) |
| Images before Connected        | When `chopin connect` says Connected or `chopin service install` installs, every image a launch needs exists and holds its programs; a failed build, the Planner's too, fails them in its words.           | `images.test.ts`; `install-service.test.ts` (connect builds the agent's and the Planner's images before Chopin hears of the machine; a failed Planner build fails it, connecting nothing; install builds with `--skip-check` too); `nvx-vm.test.ts` (a real connect builds the shared image before Connected; the Planner then starts with no build)                                                             |
| One build per key              | Requests for one image at once, in one `chopin` or several on a base dir, run one build; the others wait, and start in it or fail with its words.                                                          | `images.test.ts` (two chopins at once run one build; ten asks at once share one build, and a failed one fails all ten with its words; a dead holder's lock is taken over; pruning keeps a held key's build); `sandbox.test.ts` (ten launches at a gone image: one build, ten starts; a failed build ends all ten with its words; a launch stopped while it waits starts nothing)                                 |
| Shared recipe                  | Recipes with the same install have one key, whatever program each starts: one image, checked for every program.                                                                                            | `images.test.ts` (an agent and a Planner with the same install share one image; an image built for the agent alone is checked for the Planner's program, not built again)                                                                                                                                                                                                                                        |
| No stale image                 | A changed recipe (an install, the `--install-from` folder) builds its own image before the next launch of that kind is handed one; the others keep theirs.                                                 | `images.test.ts` (a changed Planner install, or a changed file in the folder, builds again before the image is handed out)                                                                                                                                                                                                                                                                                       |

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

A new document's Planner, from the moment the document was made to its backend attaching,
on a machine with no checkout of the repository (so its clone in `repos/`), a local Chopin
and a backend that attaches as soon as it starts, measured from Chopin's own log on the same
KVM host:

| Connector                                | New document → Planner attached                                  |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Before: no spare for a cloned repository | 2.35–6.2 s cold, median 2.7 s (8 documents)                      |
| Now: the repository's spare              | 56–185 ms, median 74 ms (11 documents, 4 after a restart)        |
| Now: a second new document within 8 s    | Cold, about 2.5 s: its repository's next spare is still starting |

The backend's own start (Atomic loads in 1.6–2.5 s, above) comes on top of a cold start, and a
spare has done it before it is handed the document.

One failure to know: OpenVMM sometimes failed to start a microVM under heavy host
load with "driver does not support io-uring" in its log (3 of about 25 starts during
one busy period, none in 80 since). The connector starts such a microVM again (see
[Starting a microVM again](#starting-a-microvm-again)).
