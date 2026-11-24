# Use your own machine with Chopin

## What it is

The `chopin` CLI connects a machine you control to a Chopin server. Builds,
investigations and Planner work that you start in Chopin then run there, with
your own coding agent, for documents in any repository you can push to.

The machine only makes outgoing requests. Chopin never connects in, and the
browser never reads your files.

## Terminal or service?

`chopin connect` runs in the terminal you start it from. The service runs the
same connection in the background, so no terminal has to stay open. The
Machines page sets up the service, and it's the one to use on a remote machine
or a server.

| How it runs      | What happens                                                                                                                                                                    | Use it for                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `chopin connect` | Runs in this terminal and stops when you close it or your SSH session ends.                                                                                                     | Trying it out               |
| The service      | Runs in the background and starts again after a reboot. Closing SSH doesn't stop it. On Linux, logging out doesn't either; on macOS and Windows it runs while you're logged in. | Remote machines and servers |

`chopin service install` runs a copy of what `chopin connect` last ran.
`chopin connect --install-service` does both: it connects once, then installs
the service. [Keep it running](#keep-it-running) has the details for each
operating system.

## Add a machine

In Chopin, open **Machines** and choose **Add machine**. It offers two ways:

- **Local**, a laptop or desktop you work on. You approve it in the browser.
- **Cloud**, a server or VM that stays connected. It uses a single-use key, so
  nobody opens a browser on it.

Either way you copy one command and run it in a terminal on that machine, in
any folder. The installer installs `chopin`, then runs `chopin connect` itself. If the install
fails, it stops with its own message and runs nothing.

The machine needs Linux or Windows on x86_64 with hardware virtualization: the
agent isn't installed or signed in on it, because `chopin` runs it in a microVM of
its own and installs it there (see [Coding agents](#coding-agents) and
[Sandbox](#sandbox)). A Mac or an Arm machine can install `chopin`, but can't run
Chopin's work. Your server may list its own
[setup agents](self-hosting.md#setup-agents) first, each with its own steps.

### Local

Pick the system and your coding agent. On Linux the command looks like this:

```sh
curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | \
  CHOPIN_URL=https://your-chopin-instance.example sh -s -- connect --install-service --agent copilot
```

In PowerShell on Windows:

```powershell
$env:CHOPIN_URL = 'https://your-chopin-instance.example'
& ([scriptblock]::Create((irm https://github.com/githubnext/chopin/releases/latest/download/install.ps1))) connect --install-service --agent copilot
```

It prints a link and a code. Open the link in the browser you're signed in to,
check the code and approve. The machine connects, installs the service and
appears on the page.

### Cloud

**Add machine** → **Cloud** opens **Add a cloud machine**. Name the machine if
you like (without a name Chopin uses its hostname), choose the agent, whether it
stays connected (on by default), and whether Chopin may build and prototype on it automatically (off
unless you turn it on; see [Connect](#connect)). Then
press **Generate install script**. The command carries a single-use key:

```sh
curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | \
  CHOPIN_URL=https://your-chopin-instance.example CHOPIN_PAIRING_KEY=chopin_k_… sh -s -- connect --install-service --agent copilot
```

A name adds `--name <name>` after `connect`. It pairs at once, with no browser,
so it works over SSH and in scripts. The key
never goes on a command line: sh passes it in the environment of the one
installer, and in PowerShell the first line sets it in the session and
install.ps1 removes it once chopin has run. That line assigns the key to
`$token` first, so PSReadLine 2.0.4 and later leave it out of their history
file.

The key works once, for ten minutes, and only for the account that made it.
Chopin makes one only when you press **Generate install script**, and
**Re-generate install script** replaces it. `chopin` sends the key once and
never saves it. If your server needs GitHub to authorize the machine, pressing
Generate checks with GitHub first; that returns at once if you have used Chopin
before. Chopin holds that authorization for 25 minutes at most, for the browser
sign-in that asked for it only. Signing out ends it and the key it made.

To pair with a key yourself, pass it as `--key` or in `CHOPIN_PAIRING_KEY`:

```sh
chopin pair --key chopin_k_…
chopin connect --key chopin_k_… --agent copilot
```

If curl can't download the installer at all, it prints why and sh, given no
script, runs nothing and exits 0.

A plain `chopin connect` you start over SSH can stop when the session ends,
even under `nohup` or `setsid`. Use the service there.

## Install

`chopin` installs on Linux, macOS and Windows, x64 or arm64, but only a Linux or
Windows machine on x86_64 with hardware virtualization runs Chopin's work (see
[Sandbox](#sandbox)).

On Linux or macOS:

```sh
curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | sh
```

On Windows (x64), in PowerShell:

```powershell
irm https://github.com/githubnext/chopin/releases/latest/download/install.ps1 | iex
```

The installer puts `chopin` in `~/.local/bin`, or on Windows in
`%LOCALAPPDATA%\chopin\bin`, which it adds to your user PATH. It needs no
administrator rights and verifies the download first.

If `~/.local/bin` is not on your `PATH`, the installer prints the line to add to
your shell profile. Then check that it works:

```sh
chopin --version
```

## Connect

Install your coding agent and sign in to it, as [Coding agents](#coding-agents)
shows. Then run `chopin connect` with your server in `CHOPIN_URL` and the agent
in `--agent`. Any folder will do:

```sh
CHOPIN_URL=https://your-chopin-instance.example chopin connect --agent copilot
```

Once it connects, `chopin connect` saves the server, so you set `CHOPIN_URL`
only this once. Later commands use the saved server. Without `CHOPIN_URL` or a
saved server, `chopin` uses `https://chopin.githubnext.com`.

The first time, without a pairing key, `chopin connect` pairs this machine with
your Chopin account in a browser:

1. The terminal prints a link and a short code.
2. Open the link and sign in to Chopin.
3. Check that the page shows the same code as your terminal.
4. Leave **Let Chopin build and prototype automatically on this machine**
   unticked unless you want Chopin to start rebuilds and prototypes here by
   itself. **Build** and **Run** work without it.
5. Choose **Add machine**. The page says **Connected.**

The pairing lasts until you [disconnect the machine](#disconnect). It survives
server restarts, deploys and signing out of the browser. So does a build
running on the machine: the connector keeps its agent working while Chopin
restarts, registers the machine again, and its heartbeat carries the build on
(see [Trouble connecting](local-experiments.md#trouble-connecting)).

When the connection is up, you see:

```text
✓ Connected.
  Work you start in documents of any repository you can push to runs here. Ctrl-C disconnects.
  It clones each repository the first time work needs it.
```

One connection serves every repository you can push to on GitHub. Chopin
checks that you can push to a document's repository each time its work starts
here.

- `--agent` takes `copilot` or `atomic`. For any other agent that speaks ACP
  over stdio, give its command after `--` instead, as in
  `chopin connect -- my-agent --acp`.
- Set `CHOPIN_DEBUG=1` to see your agent's own log.
- Ctrl-C stops running work and disconnects. A second Ctrl-C exits at once.

To give your agent and Planner an environment variable, add `--env`, as often
as you need:

```sh
chopin connect --env SOME_FLAG=1 --agent copilot
```

`chopin` saves these values in `config.json`, which only you can read. Keep
secrets in your agent's own login instead. You can't set `PATH` or a
`CHOPIN_` variable this way.

### Your checkouts and clones

Work in a repository runs from a checkout of it. By default `chopin` clones the
repository the first time work needs it, into
`~/.local/state/chopin/connector/repos/<owner>/<repo>`, and fetches it again
before each piece of work. It clones over HTTPS with the GitHub token Chopin
gives the machine. The token reaches Git only through its environment, never a
command line or the clone's own settings.

To use a checkout you already have, with its branches, dependencies and local
settings, name it with `--checkout`, as often as you like:

```sh
chopin connect --checkout ~/src/score --checkout ~/src/site --agent copilot
```

Each must be a clone of a GitHub repository (its `origin` on github.com) with
at least one commit, and only one per repository. A path given on its own, as
in `chopin connect ~/src/score`, counts as one `--checkout`. Work in those
repositories runs from your checkouts; work in any other repository runs from a
clone. `chopin status` lists both.

If your server gives machines no GitHub token (`AUTH_MODE=local`), there is
nothing to clone with, so name a checkout of each repository you work in. Work
in a repository without one fails with
`This machine has no checkout of <owner>/<repo>`, followed by the command to
run.

### Choose a machine for a document

With more than one machine connected, Chopin picks one for you by default: your default machine when it is connected and free, else the
machine that last worked on the document, else the first idle one. Most people
never need more than that. To pin one document to a machine, open the
document's title menu and choose **Machine**. It shows the current choice
(**Default**, or a machine's name) and opens the machine list in place:
**Default machine** (with the machine it uses now), then each of your machines
with its state; offline ones are greyed out. On a phone,
**Machine** in the title's actions sheet opens the same list as a sheet. The
choice is yours alone and holds for that document until you change it:

- **Build plan**, **Build**, **Run** and investigations you start in the
  document go to the machine you chose, behind any work it is already running.
- Rebuilds and prototypes Chopin starts for you follow the same choice, and
  still need the machine's consent to automatic work.
- Where Chopin runs Planners on machines, the document's Planner runs there
  too, and on **Default machine** it runs on the creator's; see
  [Run a Planner on this machine](#run-a-planner-on-this-machine).
- The list also shows machines teammates share, sorted with your own, newest
  paired first, under **Local** or **Cloud**, when they serve the document's
  repository and their owner can push to it. Anyone who can edit the document may choose one, and its Planner,
  your builds and your runs then run there, as its owner; see
  [Share a machine with teammates](#share-a-machine-with-teammates).
- If the machine you chose is offline, **Build plan** is greyed out, as offline
  machines are in the list, and starts nothing. It changes within a few seconds
  of the machine going offline or coming back, as does the Machines count in
  the sidebar, without a reload; a screen reader hears **build-box is offline**
  (your machine's name). Other work fails with those words rather than moving
  to another machine. Start `chopin connect` on it, or choose another one.
- If Chopin can't read your choice (its database is briefly unavailable), work
  fails with **Can't read your machine choice right now. Try again.** It never
  falls back to another machine; once the choice can be read, it applies again.
- Choosing **Default machine** goes back to Chopin's pick.

Disconnecting a machine clears every choice of it, and everyone's default of it.

Choose your default machine from **Machines** in the sidebar: it opens a menu
listing **Any connected** and each machine you can use under **Local** or
**Cloud** with its state, yours and the ones teammates share sorted together,
newest paired first, then **Add machine** and **Manage machines** for the full
page. Beside the machines it
shows how many are connected out of all of them, such as **2/2**. The default is
the machine marked as your favorite on the **Machines** page too (its star, or
**Set as favorite** in its menu). Only one machine is your
default, yours or a teammate's. Chopin uses it first whenever it is connected
and free, and otherwise picks as before; a machine you chose for a
document never moves. Your default is yours alone and applies to every document
left on **Default machine**. A teammate's machine is your default only while its
owner shares it and can push to a repository you can: when they stop sharing it
or disconnect it, it stops being your default.

### Coding agents

The Machines page offers these agents. **Connect with** is what follows
`chopin connect`, and **Runs** is the command and variables it starts:

| Agent                                                                                               | In its microVMs                                        | Connect with      | Runs                               | Tested with Chopin |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------- | ---------------------------------- | ------------------ |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) | `@github/copilot@1.0.114`                              | `--agent copilot` | `copilot --acp --allow-all`        | Yes                |
| [Atomic](https://github.com/bastani-inc/atomic-acp)                                                 | `@bastani/atomic@0.10.7`, `@bastani/atomic-acp@0.0.18` | `--agent atomic`  | `ATOMIC_ACP_HEADLESS=1 atomic-acp` | Yes                |

You don't install the agent on this machine, and it doesn't need Node.js:
`chopin` runs every agent in a microVM of its own, from an image it builds once
with the agent installed at the version this `chopin` pins (see [Sandbox](#sandbox)).
The agent runs on the AI accounts of the person a job is for, which they connect in
Chopin, so it needs no sign-in here either. The service can't answer a permission
prompt, so Copilot CLI runs with `--allow-all` to approve its tools without asking.
Atomic doesn't ask, and `ATOMIC_ACP_HEADLESS=1` ends its questions at once instead
of waiting for an answer.

Arguments after `--` go to the agent. For example,
`chopin connect --agent atomic -- --model openai/gpt-5.5` runs
`atomic-acp -- --model openai/gpt-5.5`, which passes them on to Atomic. An
`--env` you give wins over the agent's own variable of the same name.

For any other agent that speaks ACP over stdio, give its command after `--`
instead of `--agent`, with its approval flag if it has one, and how to install it
in its microVMs with `--install` (repeat it for several commands). The commands run
in the image's build, with Node.js and npm, whose global installs go into the image:

```sh
chopin connect --install 'npm install -g my-agent' -- my-agent --acp
```

A Planner command is installed the same way with `--planner-install`. An agent
`chopin` has no recipe for is refused before anything is paired, naming the option.
`chopin connect` builds the Planner command's image with the agent's as it starts,
before it says Connected, so the first document's Planner starts at once; when
`--install` and `--planner-install` give the same commands, one image holds both
programs. A build that fails stops `chopin connect` with the build's own output.

The build reaches the network only through the [proxy](#sandbox), with no credentials
of yours, and runs whatever install scripts the packages have. To install something
that needs a sign-in, such as a package from a private registry, fetch it on this
machine yourself and name its folder with `--install-from`. The build gets a copy
of that folder, read-only, at `/install-from`; no agent's microVM gets it:

```sh
npm pack @my-org/my-agent@1.2.3 --pack-destination ~/agent-packages
chopin connect --install-from ~/agent-packages \
  --install 'npm install -g /install-from/my-org-my-agent-1.2.3.tgz' -- my-agent --acp
```

What the folder holds is part of the image, so a changed file builds the image
again. Keep the folder: the service reads it each time it starts. It may hold only
files and folders, not links. npm installs into `/opt/chopin/agent`, so a package
installed with `npm install -g` is at `/opt/chopin/agent/lib/node_modules/<name>`
in the agent's microVM, and its programs are on the agent's `PATH`.

## Keep it running

`chopin service install` runs your connection in the background, so it starts
again after a reboot and needs no open terminal. Anything that should outlive
your login session belongs in the service. It copies what `chopin connect`
last ran, server included, and runs that copy. The settings store the full path
of the agent `chopin connect` found, so the service runs that same agent
whatever your `PATH` is when you install it.

The quickest way is one command. It connects, and once it sees
`✓ Connected.` it disconnects and installs the service:

```sh
chopin connect --install-service --agent copilot
```

You can also do it in two steps:

1. Run `chopin connect` once, as above, and press Ctrl-C after `✓ Connected.`
   A connect that stops before then saves nothing.
2. Install the service:

   ```sh
   chopin service install
   ```

Before installing, `chopin` builds any image your settings need that isn't built
yet, the Planner's included, so the service starts at once. Then it starts your
agent once the way the service will, with the service's `PATH` and your `--env`
values, and waits up to 10 seconds for it to answer. If it doesn't, nothing is
installed, and the message shows the first line your agent printed. For an agent
that can't start without a terminal, pass `--skip-check`, which leaves out only that
start.

The service can't answer permission prompts. The built-in agents already
approve their own tools; give any other agent its approval flag.

A later `chopin connect` doesn't change what the service runs. To change it,
run `chopin connect` with the new arguments, then install again:

```sh
chopin connect --checkout ~/src/other-project --agent copilot
chopin service install
```

While the service is running, `chopin connect` doesn't connect a second time.
It saves your settings and prints:

```text
The chopin service is running on this machine. Saved your settings; run chopin service install to use them.
```

Each operating system has its own catch:

- **Linux.** A systemd user service. Install turns on linger so it keeps
  running after you log out. If that needs an administrator, install prints
  the `sudo loginctl enable-linger` command for them. Never run `chopin` itself
  with `sudo`. When `loginctl` can't answer, install and status read
  systemd-logind's own record, `/var/lib/systemd/linger/<user>`, and say so.
- **macOS.** A LaunchAgent, which runs only while you are logged in.
- **Windows.** A Task Scheduler task, which runs only while you are logged on.

## Check on it

**Machines** in Chopin lists your machines with what each connector last said
about itself: its hostname, its chopin release and system, the coding agent it
runs, and whether it is connected (a green dot) or when it was last seen.
Search finds a machine by any of these. **Edit machine name…** in a machine's
menu renames it in Chopin, and `chopin status` shows that name. Only you see
your machines, except one you share with teammates: they see it in the same
table, sorted with their own, read-only: its name, its owner, its chopin release and
whether it is online, with its **Shared** switch on and disabled. A teammate
who can push to a repository you both can sees it there without having opened a
document in it; see
[Share a machine with teammates](#share-a-machine-with-teammates).

On the machine:

```sh
chopin status
```

You see something like this:

```text
chopin 0.0.11 (connector protocol 5)
Server:     https://your-chopin-instance.example (saved by chopin connect)
Machine:    paired as build-box (octocat); Chopin accepts it
Connector:  running (pid 4242, chopin 0.0.11, the service)
Service:    running (systemd, pid 4242)
            definition: /home/me/.config/systemd/user/chopin.service
            runs --agent copilot (/home/me/.local/bin/copilot --acp --allow-all) with checkouts /home/me/src/score, on https://your-chopin-instance.example
Checkouts:  octo-org/score at /home/me/src/score
Clones:     octo-org/site at /home/me/.local/state/chopin/connector/repos/octo-org/site
Runs:       4 finished runs kept (1.2 GB), 1 running
Planners:   /home/me/.local/state/chopin/connector/planners/octo-org/score/5f0c…e21 (octo-org/score, document 5f0c…e21)
Log:        /home/me/.local/state/chopin/connector/chopin.log
Base dir:   /home/me/.local/state/chopin/connector
```

If you have connected something else since you installed the service, status
shows that too, with a reminder to run `chopin service install`.

If the agent or a Planner keeps failing to start, status shows the latest
failure under the connector, with the first line it printed. That line, and
everything a Planner prints to chopin's output on stdout or stderr, has
anything that looks like a token, your `--env` values of 8 characters or more
and the Planner's credential replaced with `[redacted]`. A line too long to
mask is left out, with a note in its place:

```text
Connector:  running (pid 4242, chopin 0.0.11, the service)
              Planner for https://your-chopin-instance.example/octo-org/score/plan: failing (exit 127: /usr/bin/env: 'node': No such file or directory), retrying in 22s
```

A Planner that Chopin refused for good, such as one for a deleted document,
shows `stopped:` and the reason instead of `failing`.

The people in the document can read why too, not only whoever runs the
machine. After each launch of a Planner Chopin asked this machine to run that
exits before staying up, the connector tells Chopin how many launches in a row
have, how the last one ended and the last line it printed to stderr that says
why (a closing "Exiting with code 1" notice does not count), with tokens and
`--env` values masked, your home directory shown as `~` and the line cut at 300
characters. From the second launch in a row, the document's machine button turns
its dot to a warning and its menu says **Can't connect to studio** with the steps
to fix it (see [Can't connect to a machine](#cant-connect-to-a-machine)),
while the connector keeps retrying. Once the Planner attaches, or a launch stays up, it
goes. A Chopin from before this does not know the report; the connector asks it
once and carries on.

A chopin older than 0.0.23 cannot make the report, and a Planner that never attaches
without exiting makes none, so Chopin says what it saw itself. Each launch asks Chopin for a
credential, so from the third launch in a row the machine's **Can't connect** reads
_It started and stopped again before it connected_, with the release the machine runs and
`chopin update` where that release is older than 0.0.23. Two minutes after a machine was asked, with
no Planner attached, it reads _It hasn't answered yet_ or _It started but hasn't connected yet_
and _Waiting since 7:26 PM_, whatever release it runs. Run `chopin update` on that machine and
restart the service (`chopin service restart`): its next failure then comes with the reason
the Planner printed.

A connector started with `--planner-command` says it can run Planners, and
lists each Planner it runs because Chopin asked this machine for it
beside the `--planner` ones (`canRunPlanners` and `chosenPlanners` in
`--json`):

```text
Connector:  running (pid 4242, chopin 0.0.11)
              Can run Planners for documents that choose this machine
              Planner for https://your-chopin-instance.example/octo-org/score/plan (chosen in Chopin)
```

`chopin status` asks Chopin whether it still accepts this machine. It never
pairs, connects or changes anything.

## Run a Planner on this machine

If your Chopin server runs `HARNESS=remote` (and not `AUTH_MODE=local`), this
machine can run a document's Planner. Pass the document's URL with `--planner`
and your Planner backend's command with `--planner-command`:

```sh
chopin connect --planner https://your-chopin-instance.example/octo-org/score/plan \
  --planner-command "my-planner --flag" --agent copilot
```

`--planner` can repeat. `chopin` runs the command for each document in the
checkout of the document's repository, yours or a clone (see
[Your checkouts and clones](#your-checkouts-and-clones)), and restarts it when it
exits. The command connects to Chopin itself,
over the [agent connection](agent-connection.md). See
[Planner backend commands](agent-connection.md#planner-backend-commands) for what
it must do.

With `--planner-command` alone, the machine says it can run Planners without
naming any document:

```sh
chopin connect --planner-command "my-planner --flag" --agent copilot
```

Choose this machine for a document under **Machine** in its title menu, and
Chopin asks it to start that document's Planner, unless another account holds it. The backend
gets its credential as with `--planner`.

A document left on **Default machine** gets its Planner too, on a machine of
the person who created it, picked as for builds: their default machine when it
is connected and can run Planners, else the machine that last worked on the
document, else any of theirs that can. Chopin asks for it while someone has the
document open, and from the moment its creator makes it with **New document**, before
their page has loaded it, and stops it once nobody has used the document for 30 minutes.
A Planner that is replying, or waiting on a question, counts as use, so its work and its
questions are never cut short
however long nobody views the document.
A Planner stays on its machine while that machine is connected, even when
another comes online; it moves when the machine disconnects or the creator
changes the document's machine or their default. Until it attaches, the
machine button's dot is three petrol dots that brighten in turn and its name says **Connecting to
studio** (the machine's name), and an `@chopin` message sent meanwhile waits for
it. Once it has attached the button says nothing more about it.

### Spare Planners

A Planner's microVM takes a few seconds to boot and start its backend. So `chopin
connect` keeps a spare Planner ready for each repository this machine recently ran a
Planner in, the ones it cloned as well as your checkouts', and hands a new document's
Planner to it: the Planner attaches in a fraction of a second instead (see
[Measurements](nvx-sandbox.md#measurements)). Another spare starts a few seconds
later.

- **Which repositories.** One where a Planner started in the last 7 days, and each
  checkout you gave with `--checkout`. The first new document of a repository this
  machine never ran a Planner in starts cold, and its spare follows. A document whose
  Planner ran here before starts on its own disk, as before.
- **How many.** At most 4, and no more than take a tenth of the machine's memory at
  about 300 MB each, so one on a 4 GB machine and two on 8 GB. The repositories used
  most recently come first. One starts only while the machine has about 1 GB free
  beside it.
- **Only where this machine can push.** Before a spare starts, and every 10 minutes
  while it waits, `chopin` asks Chopin whether it would give this machine a token for
  the repository. Once it wouldn't, or refuses one of the repository's Planners its
  GitHub token, the spare stops and its disk goes.
- **Many at once.** When new documents of a repository come faster than its spare is
  replaced, as when a Planner makes several in one turn, the repository keeps up to 4
  spares, within the same memory bound, until none has come for 2 minutes. Documents
  that find no spare start cold side by side, half the machine's processors' worth at
  a time (2 at least, 8 at most), in the order they were asked for, ahead of any new
  spare.
- **Nothing of a document until it gets one.** A spare starts with your checkout,
  read-only, and nothing else of the document's: no credential, an empty token folder
  and a disk of its own. It gets the document's credentials when it is handed the
  document, and is never handed another.

The Planner command has to take spare mode (`CHOPIN_PLANNER_SPARE`, see
`apps/connector/src/planner-spare.ts`); one that doesn't is noticed and started cold.
`chopin status` shows each spare under the connector:

```text
Connector:  running (pid 4242, chopin 0.0.34, the service)
              Spare Planner for octo-org/score: ready (since 3 min ago, my-planner)
              Spare Planner for octo-org/site: waiting for memory (a spare takes about 300 MB, with 1 GB left free beside it; since 1 min ago)
```

`--no-planner-spare`, or `CHOPIN_PLANNER_SPARE=0` in `chopin`'s environment, starts
no spares, and every Planner starts when it is asked for.

### Can't connect to a machine

Chopin asked a machine to run a document's Planner, and the Planner's backend
exited before it stayed up, more than once in a row. Nothing about it is drawn in
Chat. The machine button, left of **Build plan**, has a warning dot, and its menu
opens onto **Can't connect to studio**: one sentence of why, numbered steps (such
as `chopin status` on the machine, in a block with a **Copy** button) and
**Learn more**, which links here. **Show
details** unfolds the last line the backend wrote to stderr that says why, exactly
as reported, and when it was last tried. chopin's avatar carries the same warning
dot. A person who has no machine button, such as a teammate with no machine of
their own, sees it there, and when they ask chopin something it can't take, chopin
says so in a row only they see, with **How to fix** unfolding the same steps under
**Can't connect to @mona's machine**, since only the owner's login is ever named,
never the machine. A screen reader hears **Can't connect to studio** once, as it
appears, from a live region of the page.

Chopin keeps retrying, and the connector backs off between launches, so nothing
needs pressing once the cause is fixed: the next launch attaches, the warning
goes without a word, and the button's dot returns to the machine's own.

To fix it, start from the reason: it is the backend's own last line that says why,
with tokens and your home directory masked. On the machine itself, `chopin status`
shows the same failure under the connector with how the backend ended, such as
`exit 127: /usr/bin/env: 'node': No such file or directory` for a program that is
not on the connector's `PATH`, and the **Log** line it prints names the file with
what the backend wrote. Change what the reason names on that machine (an
environment variable passed with `--env`, a missing program, a checkout), or
choose another machine for the document from the machine button.

#### Share a machine with teammates

Sharing a machine lets teammates run their work on it. It is off unless its
owner turns it on: with **Run teammates' work** as they add the machine
(**Let teammates run their work on this machine** on the pairing card), or later
with the machine's **Shared** switch on the **Machines** page (**Share with
teammates** in its view on a phone). Turning it on is the owner's consent to
three things for a document whose teammate chose the machine, in repositories
the owner can push to:

- its **Planner** runs there, as the owner, with the owner's GitHub
  authorization; on **Default machine** it also does so for a document whose
  creator has no machine of their own that can run Planners;
- **Build plan**, **Build**, **Retry**, **Run** and investigations the teammate
  starts run there, behind any work the machine is already running. The agent
  runs on the owner's machine with the owner's GitHub account, so its pull
  requests are opened by the owner, not the teammate. Chopin records the
  teammate as the person who asked, shows their name on the build, and tells the
  agent to end each pull request body with a note naming who requested it;
- nothing automatic: rebuilds and prototypes Chopin starts by itself still run
  only on the machine of the person whose living document they are, and only
  where that machine's owner ticked automatic work. They never run on a
  teammate's machine, chosen or not.

A build there is claimed and reported only by the machine it was queued on. It
is queued only while the machine is shared, its owner can push to the
repository, and the teammate has chosen it; it is not taken once any of those
stops being true, and ends within a few seconds saying so. A build already
running keeps going until it finishes, like a Planner mid-reply.

- A teammate sees a shared machine, read-only, in the one table on
  **Machines**, sorted with their own, newest paired first, under **Local** or
  **Cloud**: its name, its owner, when it was paired (the order of the list, not
  shown), whether it is online and its chopin release. It serves every repository its
  owner can push to, so a machine with no checkouts counts too. A machine that
  is not shared, or whose owner can't push to a repository, is never listed to
  anyone who works there; nobody but its owner can rename it, change its sharing
  or disconnect it. A teammate may star it, as their default. For a machine
  that serves every repository, the page intersects two lists of what can be pushed to among GitHub App installations:
  the teammate's own, held a minute, and its owner's, listed with the machine's
  own token and held 10 minutes for everyone who looks (a minute after a failure).
  Neither list is cut short, and nothing is asked of GitHub for each repository,
  so the page's refresh every few seconds, and any number of teammates, cost the
  owner's GitHub rate limit a few listings every 10 minutes. A teammate need not
  have opened a document in a repository first. For the repositories a machine
  has checkouts of, each is asked on its own a few at a time and held as the
  owner's check is (below): the teammate's own check, for a repository their
  installations don't list, is made with their own login and kept 10 minutes for a
  pass and a minute for a refusal. It is listed wherever Chopin has machines,
  with or without Planners on machines; under `AUTH_MODE=local`, where machines
  hold no GitHub authorization of their own, only while its owner is signed in.
- A document's **Machine** list offers it the same way, among the **Local** and
  **Cloud** machines, to anyone who can edit the document and push to its
  repository, and online or offline like your own. Choosing it sends your builds
  and runs there, and that document's Planner too where the rules below allow. Chopin checks
  with the machine's own token that its owner can push to the repository before
  it lists or asks it, and again every 10 minutes. If it is offline, **Build
  plan** is greyed out and says so, as for your own; if its owner stopped
  sharing it or can't push any more, a build or run fails saying that, and never
  moves to another machine.
- The document's creator's choice still decides where its Planner runs. Another
  editor's choice of a machine places it only while the creator has chosen no
  machine, and only on a machine that can run it for them now: online, started
  with `--planner-command`, and (for a teammate's) its owner able to push. Then
  it takes the Planner from Default machine's machine: a Planner attached there
  stops, one that was only asked is withdrawn, and only the chosen machine is
  asked. The choice is stored, so it still holds after Chopin restarts, and
  Default machine is not asked for the document while a stored choice places it.
  A choice of a machine that can't run the Planner now (offline, started without
  a Planner command, or its owner can no longer push) is stored and stops
  nothing: the Planner keeps running where it is, a reply under way included.
  The chosen machine takes it once it can run it: at once when no Planner is
  attached on Default machine, otherwise once that one has ended. A machine
  coming online never interrupts an attached Planner. Choosing another machine
  replaces your earlier choice, so a Planner on the machine you chose before
  stops. When the creator chooses their own machine, or Default machine, the
  Planner on an editor's machine stops and the editor's choice that placed it
  goes, even if that machine had not been asked yet. An editor's choice made
  while the creator's own stood is only stored, for their own builds and runs,
  and counts again once the creator chooses no machine. Builds and runs follow
  each person's own choice, whoever created the document. A person whose choice does
  not place it is told so in the machine menu, above the machines: _The document's
  creator chose where its replies come from, so your choice runs your builds and
  runs._ What Chat says of the Planner keeps naming the machine it is on.
- A document left on **Default machine** whose creator has no connected
  machine that can run Planners uses a shared one too. Builds, runs and
  investigations never go to a teammate's machine unless the person chose it for
  the document or made it their default.
- A teammate's machine that is the creator's default is where Default machine
  runs their Planner first, and where Automatic sends their builds, runs and
  investigations first, while it is online, serves the repository and its owner
  can push to it; where it doesn't, they go where they would without it. A
  choice for the document comes before it. A rebuild they press follows their
  default as it is now, so a shared machine they made their default after the
  first build runs it, ahead of the machine that build ran on. Rebuilds and
  prototypes Chopin starts by itself stay on their builder's own machines.
- With several shared machines, each owner's default goes first.
- Once the creator connects a machine of their own, the Planner moves there,
  unless it is already attached on the shared machine; then it stays until it
  stops.
- Turning sharing off takes the machine off teammates' lists and clears their
  choices of it and their default of it, and takes no new teammate work. A build still waiting on it
  ends. A document whose Planner the machine was not running, had not been asked
  to run and was not about to run, and that nobody is using, only loses the
  choice: nothing starts for it on the creator's machine. A teammate's Planner
  that is idle stops at once; one that is replying or has a question open keeps
  going until that work finishes, then stops within 15 seconds. A build or run
  already going finishes. Meanwhile the machine's row on **Machines** says
  **Finishing 1 teammate document**. Each stop prints why:
  `<owner> stopped sharing <machine> with teammates`.

Choosing another machine stops it and prints
`Stopped the Planner for <document>: the document chose another machine.` So do
moving it, disconnecting or revoking the machine, leaving the document unused,
or losing push access to the repository.
Chopin then voids the credentials it gave the machine for that document.

One machine runs the Planners of documents in as many repositories as you
choose it for.

In the **Machine** list, a machine started without `--planner-command` is
greyed out.

## Where things live on this machine

`chopin connect` keeps its files in its base dir,
`~/.local/state/chopin/connector`, never in your checkouts.
[Where chopin keeps its files](chopin-cli-reference.md#where-chopin-keeps-its-files)
lists them all.

| Path                                         | Holds                                                                                                                              | Removed                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `runs/<run id>.json`, `runs/<run id>.agent/` | A job's record, and its agent's state where it ran on Chopin's AI accounts                                                         | Once 15 newer runs have finished                                                                                                  |
| `planners/<owner>/<repo>/<document id>.disk` | A Planner's disk, with its own clone of the repository                                                                             | When Chopin says its document is archived or gone or its Planner was reset, after 30 days unused, or when the machine is unpaired |
| `repos/<owner>/<repo>`                       | A clone of a repository you named no checkout of                                                                                   | Never                                                                                                                             |
| `images/`                                    | The images agents and Planners run from, built once each                                                                           | When the connector that holds the base dir starts and no recipe names one any more                                                |
| `nvx/`                                       | The NVX release this `chopin` pins, and its microVMs' records                                                                      | An NVX release `chopin` no longer pins                                                                                            |
| `git/<process>/`                             | A copy of the settings of your git configuration that `chopin`'s own git commands use (where to fetch from, proxies, line endings) | As that `chopin` exits, or by the next `chopin connect` once it is gone                                                           |
| `agent-store/`                               | This machine's database login for agent sessions, and the adapter                                                                  | Its password with `chopin unpair`                                                                                                 |

A run leaves no worktree: its agent worked in its microVM, and pushed what it kept.
Nor does it leave anything in your temporary directory: NVX's own folder for each
microVM (`nvx-sandbox-run-*`) goes when the microVM ends, even when it was stopped by
force, and `chopin connect` removes any a `chopin` that was killed left, once no
microVM uses it.

`--keep-runs <n>` keeps `n` finished runs instead of 15, and `--keep-runs 0`
keeps them all. `chopin` never removes a run that is going or waiting to start.

## Sandbox

`chopin connect` runs every agent and Planner command that does work in a microVM
of its own: an [NVX](https://github.com/microsoft/nvx) guest, a small Linux virtual
machine under your system's own hypervisor (KVM on Linux, the Windows Hypervisor
Platform on Windows), with its own kernel. A mistaken or hostile instruction in a
document reaches only what that microVM was given. Nothing else of your machine is
in it: not your home, your other checkouts, your credentials or your agents'
logins. The design is [Agents in NVX microVMs](nvx-sandbox.md).

There is no other way an agent runs. A machine that can't run microVMs, a Mac, an
Arm machine, or one whose user can't use the hypervisor, can't be paired or
connected, and `chopin` says why and what fixes it:

```text
This machine can't run Chopin's work: Chopin runs each agent in its own microVM,
which needs Linux or Windows on x86_64 with hardware virtualization. Your user can't
read and write /dev/kvm.
Fix: sudo usermod -aG kvm $USER, then log out and back in (for the chopin service,
restart the machine). Or have an administrator add a udev rule, such as
KERNEL=="kvm", GROUP="kvm", MODE="0660", RUN+="/usr/bin/setfacl -m u:<user>:rw /dev/kvm"
(logind may drop that ACL)
```

`chopin status`, the line `chopin connect` prints once connected, and the
machine's Sandbox row on the Machines page say where its agents run:

```text
Agents:     Each agent in its own microVM (NVX on KVM)
Agents:     Can't run here: <why>
            Fix: <the one command>
```

A machine paired before it could run microVMs tells Chopin why it can't as it
stops, and the Machines page shows it while the machine is away.

A machine that loses what microVMs need while it is connected, as when logind
takes back the access to `/dev/kvm` a desktop login gave your user, finds out at
its next launch. That launch fails with the words above, `chopin` tells Chopin
why, leaves, and starts no agent or Planner until it can run microVMs again. It
checks every 30 seconds, and connects again by itself once it can.

The first `chopin connect` downloads NVX (about 275 MB on Linux, 150 MB on
Windows, checked against the SHA-256 this `chopin` pins) and builds the images
agents run from, once, before it says Connected: the agent's, and with
`--planner-command` the Planner's, or one image for both when their install
commands are the same. Each takes a minute or two and says so on its own line:

```text
… Building one image for atomic-acp and the Planner (my-planner), whose installs are the same, for their microVMs (a minute or two, once, so the first document's Planner starts at once).
✓ Connected.
```

So the first document you open starts its Planner at once. A build that fails stops
`chopin connect` there, with the build's own output. The service builds any image it
lacks as it starts, as after an update that changes what an image holds, before it
connects, so the machine shows as away until it is done. A microVM then starts in
under a second.

### What an agent can and can't do

|             | In its microVM                                                                                                                                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Works in    | A repository of its own in the microVM, cloned as it starts: a run's in the microVM's memory, a Planner's on a disk of its own that lasts between its starts (see [Repositories in its microVM](#repositories-in-its-microvm)). It pushes what it keeps to GitHub.                              |
| Writes      | Its own repository and the rest of the microVM's own file system, its agents' state where it runs on [Chopin's AI accounts](#ai-accounts-through-chopin), and what you add with `--sandbox-write`. Nothing of your checkouts or their git directories, nothing else of your machine.            |
| Reads       | The git directory its repository is cloned from, read-only; for a Planner, your checkout too, uncommitted files included, read-only; its own token folder. Nothing else of your machine: not your home, `~/.ssh`, your other checkouts, the connector's state directory or another run's files. |
| Network     | Only through a proxy on your machine that allows the hosts below and refuses the rest. A direct connection, DNS, IPv6 and your machine's other local services are closed to it.                                                                                                                 |
| Environment | What the run or Planner is given and nothing of the connector's own: its tokens, `--env` values, the proxy's variables, and an allow-list on Chopin's AI accounts (see below). It reaches the microVM in a `0600` file, never on any process's command line.                                    |
| Programs    | Its image's: Node.js 24, git, the agent at the version this `chopin` pins, and the guest's Ubuntu. Nothing you install on your machine changes them.                                                                                                                                            |

Hosts an agent may reach (the full list is `HOST_GROUPS` in
[`apps/connector/src/sandbox-policy.ts`](../apps/connector/src/sandbox-policy.ts)):

- your Chopin server's origin, with its port;
- GitHub: `github.com`, `api.github.com`, `codeload.github.com`, Git LFS, and
  the hosts GitHub serves raw files and release downloads from
  (`objects.githubusercontent.com`, `raw.githubusercontent.com`,
  `release-assets.githubusercontent.com`,
  `github-releases.githubusercontent.com`);
- the model providers: `api.anthropic.com`, `api.openai.com`, `chatgpt.com`,
  `auth.openai.com`, `generativelanguage.googleapis.com`,
  `oauth2.googleapis.com`, `*.githubcopilot.com`,
  `copilot-proxy.githubusercontent.com`, `openrouter.ai` and
  `*.openai.azure.com`;
- certificate revocation checks (DigiCert, Sectigo, GlobalSign, SSL.com,
  IdenTrust, Microsoft and Let's Encrypt OCSP and CRL hosts), which Java, .NET
  and package managers make while they download;
- the package registries and toolchain downloads of every common language,
  since a run builds and tests whatever language it verifies: JavaScript and
  TypeScript (npm, Yarn, pnpm, JSR, Node, Bun, Deno), Python (PyPI, uv,
  conda), Rust (crates.io, rustup, docs.rs), Go (the module proxy and checksum
  database, Go downloads), the JVM (Maven Central, Google's Maven, Gradle,
  Apache downloads, Adoptium, Azul, JetBrains, sbt, Clojars), .NET (the SDK
  and NuGet), Ruby, PHP (Packagist, Composer), Perl (CPAN), Lua (LuaRocks),
  Haskell (Hackage, GHCup), OCaml (opam), Elixir and Erlang (Hex), Swift
  (swift.org, CocoaPods), Dart (pub.dev), Julia, R (CRAN), Zig, C and C++
  (Conan), Bazel and Nix;
- the hosts you add.

Every built-in host is a fixed public service. None is general-purpose storage
that a stranger could write to and read back, such as
`storage.googleapis.com`, a `*.blob.core.windows.net` account, Amazon S3, gists
or a paste site, since those are where an injected instruction would send what
an agent read. A test keeps it that way.
The registries and GitHub still accept a publish or a push from whoever holds
a token, so the list narrows where data can go but doesn't close every path.
If a project needs one of those storage hosts, as Flutter's SDK does
(`storage.googleapis.com`), add it yourself. The groups follow the lists that
GitHub's agentic workflows, Claude Code on the web and Codex maintain.

The first time the proxy refuses a host, the terminal says so and which flag
allows it. Add hosts and writable directories as you connect; they are saved
with the rest of the settings, so run `chopin service install` again to give
them to the service:

```sh
chopin connect --agent atomic \
  --sandbox-host registry.corp.example \
  --sandbox-host '*.corp.example:8443' \
  --sandbox-write ~/.npm
```

A host is `host`, `*.host` (subdomains, not the bare domain) or `host:port`;
without a port an entry allows 80 and 443. The proxy sees names and ports, never
what a tunnel carries. It refuses a built-in name (GitHub, a model provider, a
registry) that resolves to your own machine or its networks, because a public
service has no business there. Your Chopin server's origin and the hosts you add
are your choice, and may be on a private network, as a self-hosted server or a
corporate registry is.

| Option                        | What it does                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `--sandbox-host <host>`       | Allows an agent to reach one more host. Repeat it.                                                                                         |
| `--sandbox-write <dir>`       | Shares one more directory with every agent, writable, such as a package cache or a local remote, but never a checkout. Repeat it.          |
| `--sandbox-hide <path>`       | Hides one file or folder inside what agents are given, even inside a `--sandbox-write` directory, such as a tool's own sign-in. Repeat it. |
| `--install <command>`         | How to install an agent `chopin` has no recipe for in its microVMs' image. Repeat it for several commands.                                 |
| `--planner-install <command>` | The same for the Planner command.                                                                                                          |
| `--install-from <dir>`        | A folder those commands read, copied read-only to `/install-from` in the image's build and in no agent's microVM.                          |

`--require-sandbox` and `--no-sandbox` are gone: there is nothing to require and
nothing to turn off. Settings an earlier `chopin connect` saved with them work, without
them.

### AI accounts through Chopin

The agent of a build, investigation or prototype runs on the AI accounts that the
person it runs for connected in Chopin (see
[AI credentials](hosted-agent.md#ai-credentials)), never on yours. The connector asks
Chopin for the run's launch with the run's credential before the agent starts, and
the agent runs on those accounts with nothing of yours:

- **Stand-ins, not keys.** The agent's environment sets each granted provider's
  key variable (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `COPILOT_GITHUB_TOKEN`, and
  for a ChatGPT or Claude sign-in `CHATGPT_ACCESS_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`)
  to a random stand-in that works only through Chopin, and `OPENAI_BASE_URL` and
  `ANTHROPIC_BASE_URL` to a relay in the connector on `127.0.0.1`, which the
  microVM reaches through the proxy. Without an OpenAI key, a ChatGPT sign-in also takes
  `OPENAI_API_KEY` and `OPENAI_BASE_URL`; without an Anthropic key, a Claude sign-in
  takes `ANTHROPIC_BASE_URL`. Atomic finds a sign-in as its `openai` or `anthropic`
  provider, ahead of a key, which keeps `openai-api` or `anthropic-api`. The relay adds the launch's own credential
  (`x-chopin-launch`) to each request and forwards it to that provider's base URL
  on Chopin and nowhere else; the credential stays in the connector's memory and is
  never in the agent's environment, files or command line. A stand-in copied out of
  the microVM reaches nothing.
- **Each provider's base URL with its key, for any agent.** `CHOPIN_AI_PROVIDERS`
  holds, as JSON, one entry per granted provider, Copilot included, with what an
  agent needs to reach it and nothing else (an example follows the list): `provider`,
  `baseUrl`, `apiKey`, `keyVariable` and, for Copilot, `headers`. Send `apiKey` as the provider takes its key (`Authorization: Bearer`, or
  `x-api-key` for Anthropic) to `baseUrl` with the provider's own paths after it
  (Copilot's `/models` and `/chat/completions`, OpenAI's and ChatGPT's `/v1/…`, and
  Anthropic's and Claude's `/v1/…`; a Claude stand-in goes as `Authorization: Bearer`,
  and Chopin adds the headers and the leading system block a Claude subscription
  needs, as Atomic sends them), with `headers` added. Each `baseUrl` is on the relay; the launch's own credential is
  in none of it. An agent that reads no provider's variables, any agent that is not
  Atomic, reaches every granted provider with its pair alone.
- **Nothing of your environment.** The agent's environment is built from an
  allow-list, not by taking known secrets out, and its microVM has its own `PATH`,
  `HOME` and tools, so a provider key or another service's token in the connector's
  environment never reaches it. Your `--env` values reach it, but for GitHub
  credentials and your agents' own model keys and directories.
- **A state directory of its own.** The agent keeps its state in a folder of the
  run's, `<base dir>/runs/<run>.agent`, shared with its microVM:
  `ATOMIC_CODING_AGENT_DIR`, `ATOMIC_ACP_DIR` (atomic-acp's session map),
  `COPILOT_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` point there. None of your
  agents' configuration, logins or sessions (`~/.atomic`, `~/.copilot`, `~/.claude`
  and the rest, wherever your environment moves them) is in its microVM, so nothing
  of them can be read.
- **Atomic** finds a generated `models.json` there that sends each granted
  provider (and `openai-api` and `anthropic-api`) to its base URL on the relay,
  with `apiKey` naming the provider's key variable, and reads the model catalog
  through Chopin (`ATOMIC_MODEL_CATALOG_URL`).
- **When it ends.** The connector ends the launch when the run ends; Chopin also ends
  it when the run ends there, if that end never arrives. When Chopin ends it first
  (your machine revoked, the document archived, its deadline), the relay hears it from
  Chopin with the launch's own credential once the proxy refuses a request, and the
  connector stops the run, once.

`CHOPIN_AI_PROVIDERS`, for a run granted Copilot and Anthropic:

```json
[
	{
		"provider": "github-copilot",
		"baseUrl": "http://127.0.0.1:43123/…/github-copilot",
		"apiKey": "chopin_ai_…",
		"keyVariable": "COPILOT_GITHUB_TOKEN",
		"headers": { "Copilot-Integration-Id": "vscode-chat" }
	},
	{
		"provider": "anthropic",
		"baseUrl": "http://127.0.0.1:43123/…/anthropic",
		"apiKey": "chopin_ai_…",
		"keyVariable": "ANTHROPIC_API_KEY"
	}
]
```

A run whose person has no AI account Chopin can use never starts its agent: no
Copilot seat and no API key, Chopin says so (`no-ai-account`), and the run ends in its
words, "chopin needs an AI account to run this, so it didn't start. Add one, then start
it again.", or, where GitHub couldn't be asked about their Copilot access, that the
check couldn't finish. Your own sign-ins and keys are never used in its place, on your
machine or a shared one. A run against a Chopin from before AI launches (which answers
404) starts its agent with no models of yours either: none of your setup is in its
microVM, so it has only what `--env` gives it.

A Planner backend gets its sessions' grants over the
[agent connection](agent-connection.md#models-through-chopin). When Chopin says its
Planners' sessions run on people's AI accounts (`"ai": "chopin"` in
`/api/connector/version`, which the connector reads as it starts, and in each Planner
credential's answer), the connector starts the backend, cold or as a spare, the same
way: an allow-listed environment, its agents' state in a folder of its own beside its
disk, and `CHOPIN_AI=chopin`, so its models come only from the grants it is handed. A spare started otherwise is replaced, never handed such a document.
Against a Chopin that says nothing of it, a backend starts as before. Give a backend
what it needs in its own `--planner-command` or in `--env`, not in the connector's
environment, which it then gets only an allow-list of.

### Agent sessions in Chopin's database

Where the Chopin you connect to gives machines a database for their agents' Atomic
sessions, pairing and `chopin connect` set it up with nothing more to do: the
connector asks Chopin for this machine's own login, saves it in `agent-store/` in its
base dir (the password apart, only you can read it), installs a 0.10 release of the
`@bastani/atomic-storage-postgres` adapter there with `npm` (once, and again only to
replace an earlier release; a failed install leaves the one there as it was), and says so:

```
Agents here keep their sessions in this machine's own database at db.example.com:5432.
```

Each agent that runs on Chopin's AI accounts, and each such Planner, then finds in its
own Atomic directory (in its agents' state, `<run>.agent/atomic`) a copy of the adapter, its
`storage-password` (mode `0600`) and a `settings.json` whose `storage` selects the
database by a URL without the password. A Planner started once the machine has no
database login (Chopin stopped giving one, or this connect couldn't set it up) finds
that `storage` and its password taken out again, the rest of its settings kept, and
keeps its sessions in its agents' state. Your own `~/.atomic` is never touched. The
proxy allows the database's host and port, which Atomic's adapter in the microVM
reaches through `HTTPS_PROXY`.

If Chopin can't make the login, or the adapter can't be installed, the connector says
why and connects anyway; the Machines page shows it too, until a connect reports it
set up, even while the machine is away. `chopin pair` on its own, which connects
nothing, tells Chopin at once. Agents keep their sessions
on the machine until a later connect sets it up. When Chopin can't be reached, the
saved login is used. `chopin unpair` removes the saved password, and Chopin turns the
login off. The proxy allows the database's host and port whether the URL
names a host, an IPv4 address or an IPv6 address in brackets (`[2001:db8::1]:5432`).

### Repositories in its microVM

An agent never works in a folder of your machine. As its microVM starts, it clones the
repository into its own file system, and works and commits there:

- **A run** (Build, Run, Retry, an investigation or a prototype) clones with
  `git clone --shared` from the git directory of your checkout of the repository (or
  `chopin`'s own clone of it in `repos/`), which its microVM reads and never writes,
  checks out the run's commit, and makes its branch. `--shared` reads your objects
  where they are and copies none, so a large repository clones in seconds. The clone
  is in the microVM's memory and ends with it: what the agent keeps, it pushes.
- **A Planner** keeps a disk of its own beside its tokens,
  `planners/<owner>/<repo>/<document id>.disk`: a sparse 32 GiB image that takes only
  what it holds. Its first start clones your checkout's repository there, at your
  checkout's `HEAD`, copying the objects it needs so the clone outlives your own
  `git gc`. Every later start finds it as it was left. It reads your checkout too,
  read-only and uncommitted files included (`CHOPIN_CHECKOUT`); its own clone is
  `CHOPIN_WORKTREE`.

What this changes for you:

- **No worktree folder is left after a run.** `runs/` keeps each run's record and its
  agent's state; its work is on GitHub.
- **A run's or Planner's branches appear only once pushed.** They are never in your
  own repository, so `git branch` in your checkout shows them only after a `git fetch`.
- **Nothing an agent writes reaches your checkout or its git directory**, and `chopin`
  runs no git in a tree an agent wrote.
- **A Planner's unpushed commits live on its disk.** The disk goes when Chopin says its
  document is archived or gone (asked as `chopin connect` connects, every hour, and
  once a Planner Chopin stopped asking for has exited, as when its document is deleted),
  when someone resets the document's Planner in Chopin (as it next starts here, or at
  the next hourly check), when no Planner has run on it for 30 days, or when this machine is unpaired or
  revoked, never while a microVM runs on it. Its unpushed commits go with it, and the
  connector says so.
- **Your checkout over the share is slow to walk.** Reading a whole large checkout from
  a microVM is much slower than on your machine, so a Planner reads it for what is
  uncommitted and does its own work in its clone.

A prototype's agent still can't push anything, and in a run the agent pushes with the
token Chopin issued for that one repository (see
[Which GitHub account pushes](#which-github-account-pushes)).

### What each system needs

**Linux** on x86_64, with read and write access to `/dev/kvm` for your user (or
`/dev/mshv` under the Microsoft Hypervisor). Most distributions give it to the `kvm`
group: `sudo usermod -aG kvm $USER`, then log out and back in. The chopin service keeps
running while you're logged out, so it gets the group when the machine restarts; until
then `chopin` says you're in the `kvm` group but it runs in a login that began before
you joined. Don't restart `user@$(id -u).service` for this: that ends every session and
service you have.

An administrator can grant `/dev/kvm` with a udev rule instead:

```text
KERNEL=="kvm", GROUP="kvm", MODE="0660", RUN+="/usr/bin/setfacl -m u:<user>:rw /dev/kvm"
```

logind may drop that ACL, as it drops the one a desktop login gives you without the
group when that login ends, so the group is what lasts. CI runners, which have one
user, use `MODE="0666"`, as
[GitHub documents for its hosted runners](https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/)
and Chopin's own CI does.

On a cloud VM choose a size with nested virtualization. Nothing else needs
installing: `chopin` downloads the NVX release it pins from NVX's own GitHub
release as it first connects, and builds the agent's and the Planner's images with
Node.js and git.

**Windows** on x86_64, with the Windows Hypervisor Platform turned on
(`Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform`, then
restart). Windows hosts are not yet ready for work: what is left is in
[Agents in NVX microVMs](nvx-sandbox.md#windows).

**macOS** and **Arm** machines can't run Chopin's work: NVX boots x86_64 guests
under KVM, MSHV or WHP, none of which they have. `chopin` installs on them, and
says so when it would pair or connect.

### Things to know

- **The first connect** downloads NVX and builds the agent's image, and the Planner's
  with `--planner-command`, which can take a few minutes; later ones start at once. A
  new `chopin` that pins another NVX or agent version builds them again, as the service
  starts and before it connects.
- **Caches.** A microVM starts with none of your package caches. Add
  `--sandbox-write ~/.npm` (or another tool's cache) to share one, writable, with
  every agent.
- **Git over SSH** can't leave the microVM; Chopin's own git commands and the
  agent's use https with the token Chopin issued.
- **A local `file://` remote** or another folder of yours needs `--sandbox-write`.
- **Agents that ignore the proxy** can't reach the network at all. Node's `fetch` is
  set to use it, and git, npm and curl honor it.
- **Memory.** Each microVM takes up to 2 GiB of guest memory, about 200–330 MB of your
  machine's while idle.
- **A busy machine.** Under heavy load OpenVMM sometimes can't start a microVM (its log
  says `driver does not support io-uring`). `chopin` starts it again, up to three times,
  before the agent has started, and says so in its output.
- **The agent checks.** `chopin service install`, and `chopin connect --install-service`
  before the machine is paired, start the agent once in a microVM of its image to send
  ACP `initialize`, so a service is not installed, nor a pairing key spent, on an agent
  that can't start; `--skip-check` leaves them out. The check that tells Chopin the
  agent's name when a connection opens runs the same way.
- **`connector.js`**, the downloaded script, runs agents in microVMs too, and carries
  the bridge its guests run, as the binary does.
- **What a microVM reads of yours** is what it is shared: a Planner's checkout whole, and
  the git directory a run clones from, its `config` included. A token kept in a remote
  URL there, or a credential store file inside `.git`, is readable to the agent; keep
  credentials out of the repository's own files.
- **A `--sandbox-write` folder** is written by agents as your user, setuid and setgid bits
  included, so don't name one other users of the machine can reach.

## Which GitHub account pushes

Chopin's GitHub App does, never your own login. Before each Planner command,
build or investigation starts, the connector asks Chopin for a token of the App
for that one repository. Chopin checks that the person it is for can push there:
whoever started the run, or you for a Planner on your machine. Commits are made
as the App's bot (`<app>[bot]`), and a build's pull request names and credits
the person who asked. A prototype's token only fetches its commit and is gone
before its agent starts. Setting the App up is in
[Chopin's GitHub App identity](github-app-identity.md#set-it-up).

| Variable                                                              | What it is                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GH_CONFIG_DIR`                                                       | A gh configuration of the launch's own, holding the current token. gh never reads yours.  |
| `CHOPIN_GITHUB_TOKEN_FILE`                                            | A file (mode `0600`) holding the current token, renewed before it expires.                |
| `CHOPIN_MCP_TOKEN_FILE`                                               | A file holding a Chopin token for Chopin's own tools at `/mcp`. It is not a GitHub token. |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` and the committer's             | The App's bot. Your Git identity and signing settings are not used.                       |
| `CHOPIN_STARTER_LOGIN`, `CHOPIN_STARTER_NAME`, `CHOPIN_STARTER_EMAIL` | Who the work is for, for "Requested by" and a `Co-authored-by` trailer.                   |

Nothing a launch inherits reaches GitHub another way: `GH_TOKEN`,
`GITHUB_TOKEN`, other `GH_*` variables, `GIT_ASKPASS`, `SSH_AUTH_SOCK`,
`GIT_SSH*` and `GIT_CONFIG_*` are removed from its environment and from your
`--env` values, and Git never uses SSH (`GIT_SSH_COMMAND=false`).

When Chopin refuses a token, nothing starts. The connector says why, naming the
repository, and the run or Planner fails with that reason; see
[Refusals](github-app-identity.md#refusals). `chopin status` asks Chopin, without
a token being made, about each registered checkout's repository:

```text
Checkouts:  octo-org/score at /work/score; Chopin's GitHub App can't write to octo-org/score; it needs Contents and Pull requests write, which an admin of the repository must grant. This machine won't use its own GitHub login, so nothing runs there.
```

`chopin status --json` has the same as `github`: `"ok"`, the refusal's code,
or `"unknown"` when Chopin couldn't be asked.

### Your Git configuration

The connector's Git commands for a repository, and those of the Planner and
agent it starts, use the repository's `https://github.com/` address and Chopin's
token, whatever your Git configuration says. A `url.<base>.insteadOf` or
`pushInsteadOf` rule that sends GitHub to SSH doesn't reach them, a checkout
whose `origin` is an SSH address is fetched and pushed over https, and your
credential helpers are not run. Nothing is written to your global configuration
or the checkout's own.

## Update

```sh
chopin update
```

This installs the release your Chopin server asks for, verified like the
installer's download. A running service that uses this `chopin` restarts on
its own.

## Disconnect

```sh
chopin unpair
```

This revokes the machine in Chopin and deletes its token. You can also open
**Machines** in Chopin's sidebar, which goes to `/machines` on your server, and
choose **Disconnect machine…** from the machine's **…** menu (on a phone, tap
the machine).

A running `chopin connect` then stops. The next `chopin connect` at a terminal
pairs again. To remove the service as well, run `chopin service uninstall`.

## Commands

| Command                                                     | What it does                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `chopin connect [--key <key>] --agent <id>`                 | Runs work from Chopin, in any repository you can push to, with a built-in agent. Pairs first if needed.                      |
| `chopin connect … -- <command>`                             | Runs any other ACP agent's command instead.                                                                                  |
| `chopin connect … --checkout <path>`                        | Uses your checkout for its repository's work instead of a clone. Repeat it for more; a bare path counts as one.              |
| `chopin connect … --name <label>`                           | Names the machine in Chopin as it pairs. A machine paired already keeps its name; rename it on the Machines page.            |
| `chopin connect … --install-service`                        | Connects once, then installs the service with what it ran.                                                                   |
| `chopin connect … --keep-runs <n>`                          | Keeps the `n` most recently finished runs (default 15, 0 for all).                                                           |
| `chopin connect … --no-planner-spare`                       | Keeps no [spare Planners](#spare-planners): each Planner starts when it is asked for.                                        |
| `chopin connect … --install <command>`                      | How to install an agent `chopin` has no recipe for in its [microVMs](#sandbox)' image. Repeat it.                            |
| `chopin connect … --planner-install <command>`              | The same for the Planner command.                                                                                            |
| `chopin connect … --install-from <dir>`                     | A folder those commands read in the image's build, at `/install-from`, such as packages fetched with your sign-in.           |
| `chopin connect … --sandbox-host <host>`                    | Lets agents reach one more host through the proxy. Repeat it.                                                                |
| `chopin connect … --sandbox-write <dir>`                    | Shares one more directory, writable, with every agent's microVM. Repeat it.                                                  |
| `chopin connect … --sandbox-hide <path>`                    | Hides one file or folder inside what agents are given. Repeat it.                                                            |
| `chopin pair [--label <name>] [--key <key>]`                | Pairs this machine, or pairs it again. The label defaults to the hostname.                                                   |
| `chopin status [--json]`                                    | Shows the server, pairing, the connector, the service and what it runs, the sandbox, your checkouts and clones, and the log. |
| `chopin service install [--allow-downgrade] [--skip-check]` | Copies what `chopin connect` last ran and runs it as a background service.                                                   |
| `chopin service status`                                     | Prints `running`, `stopped`, `restart-pending` or `not-installed`.                                                           |
| `chopin service restart`                                    | Restarts the service with the settings it has, for example after an update.                                                  |
| `chopin service uninstall`                                  | Removes the service. The pairing, settings and past runs stay.                                                               |
| `chopin update [version] [--allow-downgrade] [--yes]`       | Installs the release your server asks for, or the one you name.                                                              |
| `chopin unpair`                                             | Revokes this machine in Chopin and deletes its token.                                                                        |

Every command takes `--base-dir <dir>`, or `CHOPIN_HOME`, to keep its files
somewhere other than the default folder. A link in its path, such as a `~/.local`
that is a link to another disk, is followed: `chopin` uses the folder where it
really is.

## Troubleshooting

Start with `chopin status` and the log it names. For problems in the browser,
see
[Trouble connecting](local-experiments.md#trouble-connecting).

Each message says what to run next. The first line of each:

| Message starts with                                 | Do this                                                                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl or wget is required`                          | Install curl, for example `sudo apt install curl`, then run the command again.                                                                                                                                                                    |
| `could not download`                                | Check your connection and any proxy (`HTTPS_PROXY`), then run the command again.                                                                                                                                                                  |
| `… isn't writable by you`                           | Run `sudo chown -R "$(id -un)" "$HOME/.local"`, then run the command again.                                                                                                                                                                       |
| `… is not on your PATH`                             | Add the line the installer prints to your shell profile. The setup command runs `chopin` by its full path.                                                                                                                                        |
| `This machine can't run Chopin's work`              | Do what its `Fix:` line says, such as joining the `kvm` group, then run the command again. A Mac or an Arm machine can't be one of Chopin's machines; use a Linux or Windows x86_64 machine.                                                      |
| `chopin runs … in a microVM of its own`             | Add `--install '<the command that installs it>'` (or `--planner-install` for a Planner command), then run the command again.                                                                                                                      |
| `… isn't inside a git checkout`                     | Give `--checkout` the folder of a clone from GitHub, or leave it out and `chopin` clones each repository as work needs it.                                                                                                                        |
| `… isn't a github.com repository`                   | Check `git remote -v`; Chopin connects clones of GitHub repositories.                                                                                                                                                                             |
| `Can't reach Chopin at …`                           | Check `CHOPIN_URL`, your network and any proxy, then run the command again.                                                                                                                                                                       |
| `Chopin refused the pairing key`                    | Generate a new script from **Machines** → **Add machine** → **Cloud**, then run it.                                                                                                                                                               |
| `… pairing key isn't allowed to use this Chopin`    | Ask whoever runs Chopin to let your GitHub account or organization in, then generate a new script.                                                                                                                                                |
| `You can't push to … on GitHub`                     | Chopin won't run that repository's work on this machine. Ask an owner for write access, or drop that `--checkout`.                                                                                                                                |
| `This machine has no checkout of …`                 | Your server gives machines no GitHub token to clone with. Run `chopin connect --checkout <path>` with a clone of that repository, then start the work again.                                                                                      |
| `… speaks connector protocol …`                     | Run the `chopin update` command the message names.                                                                                                                                                                                                |
| `… didn't answer ACP initialize`                    | The agent didn't start in its microVM. Check its `--install` commands, or what the message shows it printed, then run the command again.                                                                                                          |
| `The microVM didn't start`                          | OpenVMM couldn't start the agent's microVM; the rest of the message is the end of OpenVMM's log. Fix what it names, such as the Windows Hypervisor Platform, then start the work again. `after 3 tries` means the machine was too busy each time. |
| `Couldn't build …`                                  | The image's install commands failed in its build; the lines after are the end of its output. Fix the `--install` or `--planner-install` commands, or the `--install-from` folder, then run the command again.                                     |
| `… has no …`                                        | The install commands didn't put that program on the image's `PATH`. Check that `--install` (or `--planner-install` for a Planner command) installs it, then run the command again.                                                                |
| `… asks for permission in the terminal`             | Run the command without `--install-service` and keep the terminal open.                                                                                                                                                                           |
| `This machine is already paired with …`             | To pair it for another account, run `chopin unpair`, then the command again.                                                                                                                                                                      |
| `This machine is no longer paired with Chopin`      | Run `chopin pair`, then connect again.                                                                                                                                                                                                            |
| `The service has to keep running after you log out` | Have an administrator run `sudo loginctl enable-linger "$(id -un)"`, then run the command again.                                                                                                                                                  |

**"CHOPIN_URL is …, but chopin connect saved …"** Install uses the server
`chopin connect` saved. Run `chopin connect` again with the server you want in
`CHOPIN_URL`, then `chopin service install`.

**"Run chopin connect once first, then chopin service install."** Run
`chopin connect`, wait for `✓ Connected.`, press Ctrl-C, then install again.

**"This machine is not paired with …"** The service can't pair. Run
`chopin pair` at a terminal, then the command the message names.

**"This machine is no longer paired with Chopin."** or **"GitHub no longer
accepts this machine's authorization."** Someone disconnected the machine, or
GitHub retired its authorization. Run `chopin pair`, then connect again.

**"… didn't answer ACP initialize when started as the service would start
it."** The agent didn't start in a microVM of its image. The message shows how it
ended and the first line it printed. Fix that, often its `--install` commands,
then install again. If the agent can't start without a terminal, pass
`--skip-check`.

**"chopin can't reach your systemd user manager."** Run the command in a login
session as the user who owns the service, not through `su` or `sudo -u`.

**"… is already locked by a running connector"** Another `chopin connect`, or
the service, is already connected with this base dir, and one connection serves
every repository. The second `chopin connect` stops before it builds or removes any
image. Stop the other one, or if `chopin status` shows nothing running, delete the
`.lock` file the message names.

For files, versions, the server rules, service internals, starting the Windows
task at boot and status JSON, see the [chopin CLI reference](chopin-cli-reference.md).
