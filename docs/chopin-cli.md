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

The agent must be installed and signed in first. The page shows its install
command under **Show install command**, and [Coding agents](#coding-agents)
lists them all. Your server may list its own
[setup agents](self-hosting.md#setup-agents) first, each with its own steps.

### Local

Pick the system and your coding agent. On Linux or macOS the command looks like
this:

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

On Linux or macOS (x64 or arm64):

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

| Agent                                                                                               | Install                                              | Sign in                                  | Node.js        | Connect with      | Runs                               | Tested with Chopin |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- | -------------- | ----------------- | ---------------------------------- | ------------------ |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) | `npm install -g @github/copilot`                     | `copilot login`                          | 22 or newer    | `--agent copilot` | `copilot --acp --allow-all`        | Yes                |
| [Atomic](https://github.com/bastani-inc/atomic-acp)                                                 | `npm install -g @bastani/atomic @bastani/atomic-acp` | `atomic`, sign in with /login, then quit | 22.19 or newer | `--agent atomic`  | `ATOMIC_ACP_HEADLESS=1 atomic-acp` | Yes                |

Install the agent globally, as the table does, not through `npx`, so the
service finds the same program each time. The service can't answer a
permission prompt, so Copilot CLI runs with `--allow-all` to approve its tools
without asking. Atomic doesn't ask, and `ATOMIC_ACP_HEADLESS=1` ends its
questions at once instead of waiting for an answer.

Atomic requires `atomic-acp` 0.0.3 or newer. Earlier adapters ignore the run's
MCP servers, so an agent can chat but cannot read an investigation or build plan.
Upgrade with `npm install -g @bastani/atomic-acp@latest`, then restart the connector
with `chopin service restart`.

Arguments after `--` go to the agent. For example,
`chopin connect --agent atomic -- --model openai/gpt-5.5` runs
`atomic-acp -- --model openai/gpt-5.5`, which passes them on to Atomic. An
`--env` you give wins over the agent's own variable of the same name.

For any other agent that speaks ACP over stdio, give its command after `--`
instead of `--agent`, with its approval flag if it has one:

```sh
chopin connect -- my-agent --acp
```

In PowerShell, quote a package name that starts with `@`, for example
`npm install -g '@github/copilot'`. PowerShell would read the bare name as a
variable.

If you installed your agent with a version manager such as fnm, your shell may
find it in a folder that only lasts as long as the shell. `chopin connect`
then saves the stable path behind it and prints a line saying so. If there is
no stable path, it warns that `chopin service install` will refuse it.

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

Before installing, `chopin` starts your agent once the way the service will,
with the service's `PATH` and your `--env` values, and waits up to 10 seconds
for it to answer. If it doesn't, nothing is installed, and the message shows
the first line your agent printed. For an agent that can't start without a
terminal, pass `--skip-check`.

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
  with `sudo`.
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
its dot to a warning and its menu says **Can't connect to studio**
with a **How to fix** link (see [Can't connect to a machine](#cant-connect-to-a-machine)),
while the connector keeps retrying. Once the Planner attaches, or a launch stays up, it
goes. A Chopin from before this does not know the report; the connector asks it
once and carries on.

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
document open, and stops it once nobody has used the document for 30 minutes.
A Planner that is replying, or waiting on a question or on a live or paused
workflow run, counts as use, so its work and its questions are never cut short
however long nobody views the document.
A Planner stays on its machine while that machine is connected, even when
another comes online; it moves when the machine disconnects or the creator
changes the document's machine or their default. Until it attaches, the
machine button's dot is a thin spinner and its name says **Connecting to
studio** (the machine's name), and an `@chopin` message sent meanwhile waits for
it. Once it has attached the button says nothing more about it.

### Can't connect to a machine

Chopin asked a machine to run a document's Planner, and the Planner's backend
exited before it stayed up, more than once in a row. The machine button, left of
**Build plan**, has a warning dot, and its menu opens onto **Can't connect to
studio**, the last line the backend wrote to stderr that says why, and how often
and when it was tried, such as _Tried 3 times, last at 6:29 PM. Still trying._,
with a **How to fix** link to this section. A person who has no machine button,
such as a teammate with no machine of their own, reads what the menu would say
on the composer's top edge instead, whatever is being typed: the reason exactly
as the machine reported it, and how often and when it was tried, under **Can't
connect to @mona's machine**, since only the owner's login is ever named, never
the machine. A screen reader hears **Can't connect to studio** once, as it
appears, from a live region of the page that does not depend on either.

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
  each person's own choice, whoever created the document.
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
  that is idle, or waits only on a paused run, stops
  at once; one that is replying, has a question open, or has a live run keeps
  going until that work finishes, then stops within 15 seconds. A build or run
  already going finishes. Meanwhile the machine's row on **Machines** says
  **Finishing 1 teammate document**. Each stop prints why:
  `<owner> stopped sharing <machine> with teammates`. A paused run stays on the
  machine and resumes if its owner shares it again.

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

| Path                                    | Holds                                            | Removed                                         |
| --------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| `runs/<run id>`                         | A job's worktree, for you to inspect             | Once 15 newer runs have finished                |
| `runs/<run id>-worktrees/`              | Extra worktrees an unsandboxed build adds        | When the run ends, uncommitted changes included |
| `planners/<owner>/<repo>/<document id>` | A Planner command's worktree for one document    | Never                                           |
| `repos/<owner>/<repo>`                  | A clone of a repository you named no checkout of | Never                                           |

`--keep-runs <n>` keeps `n` finished runs instead of 15, and `--keep-runs 0`
keeps them all. `chopin` never removes a run that is going or waiting to start.

## Sandbox

`chopin connect` starts every agent and Planner command that runs work inside your
operating system's own process sandbox, as Codex and Claude Code do for theirs, so a
mistaken or hostile instruction in a document can't reach past the run's worktree.
Two start checks, which send the agent nothing, are the exception (see
[Things to know](#things-to-know)). The sandbox is
[MXC](https://github.com/microsoft/mxc) on every system: Seatbelt on macOS, bubblewrap
on Linux and ProcessContainer on Windows. It needs no virtual machine, image or daemon,
and your credentials and environment reach the agent as before.

`chopin status`, and the line `chopin connect` prints once connected, say which
you have, and so does the machine's row on the Machines page:

```text
Sandbox:    Sandboxed (Linux bubblewrap)
Sandbox:    Not sandboxed: <why>. Runs go on without it.
            Fix: <the one command>
```

The words are `Sandboxed (macOS Seatbelt)`, `Sandboxed (Linux bubblewrap)` or
`Sandboxed (Windows ProcessContainer)`. Without a sandbox, runs go on
unsandboxed and the machine says so. Choose `--require-sandbox` to refuse them
instead.

### What an agent can and can't do

|             | In the sandbox                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writes      | Only the worktree the connector made for it (a run's, or a Planner's own; never your checkout), the repository's git directory in the few places commits and refs go and that worktree's entry (see [Git in the sandbox](#git-in-the-sandbox)), the agent's own state (`~/.atomic`, `~/.copilot` or `~/.pdd-kit` for the built-in agents), a private temporary directory, and what you add with `--sandbox-write`. Nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Reads       | The rest of the disk on Linux and macOS, except `~/.ssh`, `~/.aws`, `~/.azure`, `~/.kube`, `~/.docker`, `~/.gnupg`, `~/.config/gh`, `~/.config/gcloud`, `.netrc`, `.git-credentials` and browser profiles, which read as empty or unreadable, and the connector's state directory (`--base-dir`), of which it sees only its own worktree and the folder of its own tokens. The machine token and every other run's and Planner's files, tokens included, are out of its sight, those made after it started too; so is the state directory when a working directory holds it, as a home does. **On Windows a ProcessContainer reads only what it is given, so it is not the rest of the disk:** your profile folder (the same names are unreadable), the directories on `PATH` and those that `PYTHONHOME`, `GOROOT`, `GOPATH`, `CARGO_HOME`, `RUSTUP_HOME`, `JAVA_HOME`, `DOTNET_ROOT`, `NODE_PATH`, `VIRTUAL_ENV`, `CONDA_PREFIX` and the other tool variables in MXC's own baseline name, the programs installed per user in `%LOCALAPPDATA%\Programs`, its working directory and its worktree, the repository's git directory whole (its configuration, hooks, objects and every worktree's entry, since a worktree's `.git` leads into it), and what Windows lets every container read (`C:\Windows`, `C:\Program Files`). A folder on another drive, in another user's profile or anywhere else, a checkout among them, is not readable, but for the checkout a Planner runs in, and for a run's checkout's git directory, which is read without that checkout's files. |
| Network     | Only through a proxy on your machine that allows the hosts below and refuses the rest. A direct connection fails, IPv6 is blocked, and the proxy resolves names.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Environment | Everything it has today, including `GH_TOKEN` and `--env` values. `TMPDIR` points at the private directory, `PATH` names each directory by its real path, and `NODE_USE_ENV_PROXY=1` makes Node's own `fetch` use the proxy; the proxy variables come from MXC.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Hosts an agent may reach (the full list is `HOST_GROUPS` in
[`apps/connector/src/sandbox-policy.ts`](../apps/connector/src/sandbox-policy.ts)):

- your Chopin server's origin, with its port;
- GitHub: `github.com`, `api.github.com`, `codeload.github.com`, Git LFS, and
  the hosts GitHub serves raw files and release downloads from
  (`objects.githubusercontent.com`, `raw.githubusercontent.com`,
  `release-assets.githubusercontent.com`,
  `github-releases.githubusercontent.com`), where provers such as Verus, Z3,
  cvc5, F\* and elan ship their releases;
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
- the formal-methods toolchains beyond those registries: Lean
  (`lean-lang.org` and `*.lean-lang.org` for elan, releases and Reservoir;
  Mathlib's build cache at `mathlib4.lean-cache.cloud` and
  `lakecache.blob.core.windows.net`; the Lean docs), and the docs and
  installers of Verus, F\*, Pulse and KaRaMeL (`aka.ms`, `fstar-lang.org`),
  LemmaScript, Rocq and Isabelle;
- research: `pldb.kirancodes.me`, a read-only search of programming-languages
  papers that pdd-kit's agents use, and arXiv;
- the hosts you add.

Every built-in host is a fixed public service. None is general-purpose storage
that a stranger could write to and read back, such as
`storage.googleapis.com`, a `*.blob.core.windows.net` account other than
Mathlib's cache, Amazon S3, gists or a paste site, since those are where an
injected instruction would send what an agent read. A test keeps it that way.
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

| Option                  | What it does                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--require-sandbox`     | Refuses a run when this machine has no sandbox, naming why. Off by default.                                                             |
| `--no-sandbox`          | Never sandboxes. `chopin status` says it is off.                                                                                        |
| `--sandbox-host <host>` | Allows an agent to reach one more host. Repeat it.                                                                                      |
| `--sandbox-write <dir>` | Allows an agent to write one more directory, such as a package cache or a local remote, but never your checkout (see below). Repeat it. |

### Git in the sandbox

Git runs programs its configuration names: a hooks directory (`core.hooksPath`),
a file-system monitor (`core.fsmonitor`), filters, an ssh command, credential
helpers and, for a remote that is a command (`ext::`), the command. The next
`git` command on your machine reads that configuration from the repository's git
directory and runs them as you, outside the sandbox: Chopin's own `git worktree
add` for the next run, or your `git status` in your checkout. And git finds that
directory through files, a worktree's `.git`, a `commondir` and the `.git` in each
submodule's folder, that name another directory, so your `git status` and `git
diff` open each submodule through the `.git` file in its folder and run what the
directory it names says. An agent that could write any of them would escape the
sandbox, and a sandbox can hold back only a path that already exists, so it can't
forbid the making of a `commondir`, or of a `.git` in a submodule's empty folder,
by name. So the rule is simple: **a sandboxed agent never writes your checkout**,
and nothing you add with `--sandbox-write` changes that (see below). Then there are
two more layers, and each is an allow-list.

**Your checkout is read-only, whole.** A Planner runs in your checkout, the one you
named with `--checkout` or a clone Chopin made in `repos/`, and reads it: its
files, its submodules, its `.git`, its index and `HEAD` are never writable by a
sandboxed agent, whether it is a regular checkout or a linked worktree of yours.
A Planner writes in its own worktree, which the connector makes for it on the host
(`CHOPIN_WORKTREE`, see [Environment](agent-connection.md#environment)), and its
changes reach you as commits and a branch pushed from there, never by editing your
files in place. A run's agent works in the worktree the connector made for that
run. So nothing a sandboxed agent writes is in a tree your own git reads, except
what it writes in your repository's git directory, next.

**What an agent may write in the repository's git directory.** Everything is
read-only, and a read-only directory can't be renamed, removed or made again, with
these written inside it, and only by a launch that has a worktree of its own:

- `objects`, `refs`, `logs` and `lfs`, where commits, branches, tags, fetched
  objects and LFS objects go;
- for a run, an investigation or a prototype, which run in a linked worktree of
  your checkout that the connector made for that run, that worktree's own entry in
  `worktrees/`, where its `HEAD`, index, merge and fetch state and the lock files
  beside them are, with the three files in it that name configuration, `commondir`,
  `gitdir` and `config.worktree`, and the folders `hooks`, `info` and `modules`
  (which the repository's git directory holds read-only too), read-only inside it;
  and the `.git` file in the worktree, which says where its entry is, read-only too;
- for a Planner, its own worktree's entry, written exactly as a run's is, and the
  same four directories: the connector makes the Planner's worktree before it
  starts, and which entry is the launch's own is the connector's record of what it
  made for it, never what a folder is called or what is in it. Your checkout's own
  entry, where it is a linked worktree of yours, is read-only, with the `.git`
  file in it.

So the repository's `config`, `hooks`, `info`, `HEAD`, `index` and `packed-refs`,
its submodules' git directories, `worktrees` itself and every worktree's entry but
the one the connector made for that launch, your own checkout's included, are
read-only, and so is any file git adds to its top level later. A `commondir`, a new
worktree entry and a `.git` made again are all refused, and so are a `rebase-merge`,
`rebase-apply` or `sequencer` folder, a `HEAD`, an `index` or a reflog in your
entry, which is where your own `git rebase --continue` would find an `exec` line
to run. An agent can't name a program for git to run in any place git looks in
your checkout or those git directories, nor send git to a directory where it has.
`objects`, `refs`, `logs` and `lfs` are data: git runs nothing from them, but an
agent that writes them can add commits and create or move branches of your
repository.

Every path above is a real path, taken by the connector once, when it first sees
the checkout or makes the worktree. A checkout whose `.git` is a symbolic link, as
some tools leave one, is recorded by the directory the link leads to, and so is a
`.git` file that leads through one; nothing is named through the link, which a
sandbox could not mount over.

**Git on your machine, run by Chopin.** Every `git` command the connector runs
(`git worktree add` for a run, its fetches, its clean-up, a Planner's worktree)
is told where the repository is instead of looking for it: the git directory, its
common directory and the working tree, as the connector recorded them the first
time it saw the checkout or made the worktree, before any agent worked in it.
Nothing it reads then can send it somewhere else, and there is no moment between
a check and the command at which something could change. It also:

- reads a copy of your git configuration that the connector made once, with
  your system and global files set aside (`GIT_CONFIG_NOSYSTEM`,
  `GIT_CONFIG_GLOBAL`): your `url.*` rewrites, `http.*` and `ssh.*` settings,
  `safe.directory`, line-ending and symlink settings and your filters, which a Git
  LFS checkout needs; not your credential helpers, aliases, hooks, editor or user;
- sets aside what a repository's configuration says for the programs git
  runs: `core.hooksPath`, `core.fsmonitor`, `core.sshCommand` (your own ssh
  command is kept, in `GIT_SSH_COMMAND`), `core.attributesFile` and remotes that are
  commands (`protocol.ext.allow=never`);
- runs no credential helper: every helper any configuration names, a repository's
  and yours, is reset (`credential.helper=` empty) and none is named again. A fetch
  that needs a login gets the machine's GitHub token from the connector, which
  hands it over in the command's environment, as it does for the fetch of a run's
  commit (a prototype's too) and for a clone. A prototype's agent never gets that
  token: it is gone before the agent starts;
- refuses the local transport (`protocol.file.allow=never`), whatever the checkout's
  `origin` is. Set `GIT_ALLOW_PROTOCOL` in the connector's environment if you fetch
  through a mirror on disk.

**What this does and doesn't guarantee.** Your checkout's files, its submodules,
its configuration, hooks and `info`, every file in it that says where git is (a
`.git`, a `commondir`), its index and its `HEAD` are never writable by a sandboxed
agent, and a path you add with `--sandbox-write` is no exception: one that is your
checkout or inside it (a submodule's folder, `.git/hooks`) or inside its git directory
is not granted, and one that holds your checkout is granted with the checkout and its
git directory held read-only, whether the agent is a Planner in the checkout or a run in
a worktree of it. What an agent does write in your git directory is `objects`, `refs`, `logs`
and `lfs`, and its own worktree's entry in `worktrees/`; the rest of that
directory, your other worktrees' entries included, it can't write. The connector's
git does not look where an agent could have pointed it. Your own `git` in your
checkout, while a Planner runs or after, is therefore not covered by the second
layer and doesn't need it: no sandboxed agent wrote anything it reads there, except
those data directories and the launch's own entry, in which no name is a pointer,
configuration, hook or program for it (see the last paragraph of this section).

It does not make the worktree an agent works in safe to run git in: that tree is
the agent's. Its files, what it makes in its own worktree's git entry (`HEAD`, the
index, an unfinished rebase's `exec` lines: do not `git rebase --continue` in a
worktree an agent left in the middle of one), a repository it makes in a folder of
its own (`git init`) and a submodule it adds there with a `.git` of its own are
what the agent wrote, so treat them as you would a clone of a stranger's
repository when you run git inside them. The connector's git does not open them
(`status`, `diff`, a fetch and the removal of a run's worktree run nothing the
agent named, tested), but yours would. A repository's own configuration is still
read by the connector's git, so a filter or a proxy it carries applies to the
connector's commands as it does to anyone's: it is the sandbox's policy that stops
an agent writing one. Windows and macOS have the same policy and the same tests;
they were not run on a real PC or Mac.

What this changes for an agent. Each of these fails with `Read-only file system`
or `could not write config file`:

- **Writing anything in a Planner's checkout**: a file or a folder, a submodule's
  `.git` or any file under a submodule, `git add`, `git commit`, `git checkout` and
  `git switch`. The checkout is yours and read-only whole, whether it is a regular
  one, a linked worktree of yours (even with its `.git` a symbolic link) or a clone
  Chopin made. Reading it works, `git status`, `git log` and `git diff`
  included. The Planner's own worktree takes every one of these, and so does a run's.
  A Planner edits documents through Chopin's tools, not your files: a Planner
  backend that edited `CHOPIN_CHECKOUT` in place must edit `CHOPIN_WORKTREE` and
  commit and push a branch instead.
- **`git fetch` in a Planner's checkout** writes `FETCH_HEAD` there and fails; `git
  fetch --no-write-fetch-head` works. In a worktree it works, as it keeps
  `FETCH_HEAD` in the worktree's own entry.
- **`git worktree add`, `git worktree remove` and `git worktree move`**: they
  write `worktrees/`. A build is told to make each concurrent pull request from its
  own branch, one after another, instead of adding worktrees.
- **`git config` without `-c`, `git remote add`, `git submodule init` and `git lfs
  install --local`** write the configuration. Give git one setting for one command
  with `git -c <name>=<value> <command>`, and push to a URL instead of a new remote.
- **Upstream branches are not recorded.** `git push -u` (or `--set-upstream`),
  `git branch -u` and `git checkout -b <branch> origin/<branch>` write which remote
  branch a branch tracks into the configuration. The push, the branch and the checkout
  still happen, and git still exits 0, but it prints `error: could not write config
  file` and the branch has no upstream. `gh pr create` pushes with `--set-upstream`,
  so it prints the same line. `git push origin HEAD:<branch>` says what it means and
  prints nothing.
- **Deleting a ref fails.** Git takes a lock at the top of the git directory to
  rewrite `packed-refs`, so `git branch -D`, `git tag -d` and `git gc` fail with
  `Unable to create '.git/packed-refs.lock'`. `git rebase`, `git stash` and `git push
  origin :<branch>` do their work and print the same line. Commits, branches,
  fetches (`--prune` included), checkouts, `git push` and `git merge` in a worktree
  work.
- **Git inside a submodule** can't write the submodule's git directory, and `git
  submodule update --init` can't record the submodule or fill its folder, which a
  run's worktree has empty.
- **Git LFS** writes `.git/lfs` only where it exists already: the sandbox can't make
  it in the git directory's top level.

The same runs where there is no sandbox, or with `--no-sandbox`, are not covered by
any of this. For them the connector's git is hardened as above, the agent writes the
git directory, and it is as it was before the sandbox: a worktree an agent made
organizes edits and is not a sandbox.

When a run or Planner starts, the connector makes an empty `config.worktree` and empty
`hooks`, `info` and `modules` folders in the launch's own worktree entry where there are
none, because a sandbox can hold back only a path that exists. Git ignores
`config.worktree` unless `extensions.worktreeConfig` is on, and reads no hook or
configuration from the other three in an entry.

**A new name at the top of the launch's own worktree entry can't be refused.** Git
takes the lock of its `HEAD` and its index by creating a file beside each and renaming
it over them, and a sandbox can't grant that for those names and refuse it for every
other: with the entry read-only and `HEAD`, the index and the logs granted as paths,
`git add` and `git commit` fail with `Unable to create '…/index.lock': Read-only file
system` (measured, real bubblewrap). So that directory stays writable, and an agent can
make any file or folder in it: a `future-pointer`, a `rebase-merge/`, a `locked`, a file
named like a hook. What that comes to:

- Your checkout and the rest of your git directory stay read-only. What git reads in
  the entry as a pointer or as configuration (`commondir`, `gitdir`, `config.worktree`)
  and what your git directory holds read-only (`hooks`, `info`, `modules`) is held, so
  no name made there is a pointer, configuration, hook or program for your own git in
  your checkout. It reads the entry only to list, prune and remove the worktree (a
  `locked` file there keeps `git worktree prune` and `remove` from touching it unless
  forced twice, which the connector's clean-up does), to see which branch it has checked
  out or is rebasing (so a planted `HEAD` or `rebase-merge/head-name` can make your git
  refuse to check out or delete that branch, though nothing runs), and, for `git gc`,
  its `HEAD` and index.
- The connector's git, hardened as above and told where the repository is, runs
  nothing because of such a name. Tested, with these names planted, an unfinished
  rebase with an `exec` line and executables named like hooks among them: `status`,
  `fetch`, adding the next run's worktree, a run's end, a prototype's removal and
  retention's removal of the worktree ran nothing, while `git rebase --continue`,
  which the connector never runs, ran the `exec` line.
- Git run inside the worktree itself reads the rest as it reads the worktree, an
  unfinished rebase's `exec` lines among it: that tree is the agent's, as said above.

### What each system needs

**macOS** needs macOS 15 or later on Apple silicon, and nothing installed.
MXC's Seatbelt backend isn't built for Intel Macs, which run unsandboxed.

**Windows** needs Windows 11 24H2 or later (build 26100), x64 or Arm. MXC's
ProcessContainer can't filter by name, so the proxy is its only way out. Reaching
a proxy that has no package identity needs MXC's `ingress` and host loopback
allowed, which is the weakest of the three setups. A ProcessContainer reads only
what it is given, so the read set follows MXC's own baseline for one (see the table
above) and is smaller than Linux's and macOS's "rest of the disk": your profile, the
tool directories its environment names, per-user programs, the launch's own
working directory and worktree, and the repository's git directory, whole, even where
the checkout it belongs to is on another drive and is not itself readable. Where an agent needs another folder to read, there is no
read-only option; `--sandbox-write` grants it to write as well. MXC's baseline also
grants the system drive's root where PowerShell 7 is on `PATH`; the connector leaves
that out, because granted around the state directory it would grant every folder on
the drive.

**Linux** needs bubblewrap and, for the proxy, `slirp4netns`, util-linux's
`unshare` and `nsenter`, `ip` (iproute2), `iptables` with its `-restore`
programs and the `nf_conntrack` kernel module, which Docker and most firewalls
load, and user namespaces. `socat` and `ripgrep` aren't needed. `chopin
status` names each one that is missing, with the package manager's command for
it (apt, dnf, pacman or apk).

On **Ubuntu 24.04 and later** AppArmor also restricts unprivileged user
namespaces (`kernel.apparmor_restrict_unprivileged_userns=1`), which bubblewrap
and `unshare` need. `chopin status` then gives one command that installs what
is missing and permits those two programs, and nothing else:

```sh
sudo sh -c 'apt-get install -y slirp4netns && printf "%s\n" "abi <abi/4.0>," "include <tunables/global>" "profile chopin-mxc-bwrap /usr/bin/bwrap flags=(unconfined) { userns, }" "profile chopin-mxc-unshare /usr/bin/unshare flags=(unconfined) { userns, }" > /etc/apparmor.d/chopin-mxc && apparmor_parser -r /etc/apparmor.d/chopin-mxc'
```

It leaves out `apt-get` where nothing is missing, and names the paths of your
own `bwrap` and `unshare`. The file is the same kind Ubuntu ships for podman
and lxc: a profile for one program that grants it `userns`. It is narrower than
the alternative, `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`,
which lifts the restriction for every program on the machine. It still lets
anyone who can run those two programs make a user namespace, which is what
bubblewrap is for. To undo it, `sudo apparmor_parser -R
/etc/apparmor.d/chopin-mxc && sudo rm /etc/apparmor.d/chopin-mxc`.

The sandbox was run for real on Linux (Ubuntu 24.04, x64) only. macOS and
Windows have the same policy, tests and executors, and were not run on a real Mac
or Windows PC. On Windows a ProcessContainer refuses a directory it wasn't given,
the parents of the state directory included, so a tool that looks for a file in
each parent of its working directory may meet an error where Linux and macOS show
nothing.

### Things to know

- **The state directory is not denied; it is left out.** Seatbelt lets a denial win
  over a grant inside it, so no one rule could hide the directory from an agent and
  still give it its own worktree. The sandbox reads each directory from `/` down to
  the state directory instead and grants everything in it but the way there,
  then grants the agent only its own worktree and token folder inside it. So what is
  made in the state directory after an agent starts, which is every later run and
  Planner, is never in its sight. The same goes for the working directory: a Planner
  whose checkout holds the state directory (your home, or a dotfiles checkout) reads it
  around the state directory like everything else, and a directory you add with
  `--sandbox-write` that holds it is written around it too. A working directory inside
  the state directory is read only where it is a clone Chopin made in `repos/`. The price is that a file or folder made directly
  in one of those directories (your home, say) after a Planner backend started isn't
  visible to it until it starts again. On Linux those directories are built in the
  sandbox's memory, so a write directly in one succeeds and is gone when the agent
  exits; nothing reaches the disk.
- **A Planner's worktree** is made by the connector, on your machine and with git
  hardened as above and no filter run (not yours, a repository's or Git LFS's: every
  filter is given no command, so a `.gitattributes` that selects one changes nothing),
  at `CHOPIN_WORKTREE`: a linked worktree of the checkout, detached at its `HEAD`,
  which the backend finds there and works in. Its files are as git stores them, so
  an LFS file is its pointer until the backend's own git, in its sandbox, converts it.
  A run's worktree is still made with your filters, which a Git LFS checkout needs. The sandbox
  lets the backend write that worktree and its own git entry and nothing beside it,
  which is why the backend can't make it with `git worktree add` itself. The checkout
  the backend runs in is yours: it reads it and writes nothing of it.
- **Files in `/tmp` are not visible.** Each sandbox has a private `/tmp`; keep
  checkouts and agents elsewhere.
- **Other agents' state.** Built-in agents' state directories are writable; for
  another ACP agent add its directories with `--sandbox-write`.
- **Caches.** `npm install` and similar write caches under your home, which an
  agent may not; add `--sandbox-write ~/.npm` (or point the tool's cache at the
  worktree) if you want them.
- **Git over SSH** can't leave the sandbox. Chopin's own git commands use
  https; so does the agent's, with your token.
- **A local `file://` remote** or any path outside the worktree needs
  `--sandbox-write`.
- **Agents that ignore the proxy** can't reach the network at all. Node's `fetch`
  is set to use it, and Bun and curl honor it themselves.
- **A sandboxed agent gets the stdio bridge** for Chopin's tools, not the
  loopback HTTP one, because it can't reach your machine's loopback.
- **On Linux, MXC gives the environment to bubblewrap as arguments**, so other
  accounts on a shared machine can read it with `ps`. On such a machine mount
  `/proc` with `hidepid=2`.
- **Two start checks are not sandboxed.** `chopin service install`, and `chopin connect
  --install-service` before the machine is paired, start your agent once with your
  environment to send ACP `initialize` and wait up to 10 seconds, so a service is not
  installed, nor a pairing key spent, on an agent that can't start. They are not runs:
  nothing from Chopin, no document, prompt or instruction, reaches the agent, and they
  start it plainly, `--require-sandbox` included. `--skip-check` leaves them out. Every
  start after that, the check that tells Chopin the agent's name when a connection opens
  included, goes through the sandbox. That check runs in your registered checkout, or,
  where there is none, in an empty folder of its own in the system's temporary
  directory, removed when the connector exits, and not in your home.
- **Telemetry.** MXC's is opt-in under its 1.0.0 contract. chopin never opts in.
- **`connector.js`**, the downloaded script, carries no executor and runs
  unsandboxed; the `chopin` binary carries MXC's and writes it to
  `<base dir>/sandbox/` on first use.

## Which GitHub account pushes

Builds and Planner commands push branches and open draft pull requests as you,
with your token from Chopin's GitHub App. Investigations get the token too;
prototypes never do.

| What runs                          | Gets your token as                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| A build's or investigation's agent | `GH_TOKEN` and `GITHUB_TOKEN`. Git uses it for github.com.                               |
| A Planner command                  | `CHOPIN_GITHUB_TOKEN`; see [the Planner's environment](agent-connection.md#environment). |

The machine uses your own `gh` and Git login instead when:

- the server runs `AUTH_MODE=local`;
- you can't push to the repository; or
- the App can only read the repository. The connector and `chopin status` then
  say so:

```text
The GitHub App can't push to octo-org/score (it needs Contents and Pull requests write), so this machine uses its own GitHub login for it.
```

### Your Git configuration

Where Chopin gives the machine a token, the connector's Git commands for that
repository, and those of the Planner and agent it starts, use the repository's
`https://github.com/` address and the token, whatever your own Git
configuration says. A `url.<base>.insteadOf` or `pushInsteadOf` rule that sends
GitHub to SSH, which a background service has no agent or key for, doesn't
reach them, and a checkout whose `origin` is an SSH address is fetched and
pushed over https. The rest of your configuration (identity, signing, other
rules and repositories) applies as it is, and nothing is written to your global
configuration or the checkout's own.

If a Git command still reaches GitHub over SSH and fails, the error names the
rule that rewrites the address.

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
| `chopin connect … --require-sandbox`                        | Refuses runs on a machine with no [sandbox](#sandbox), instead of running them unsandboxed.                                  |
| `chopin connect … --no-sandbox`                             | Never sandboxes agents and Planner commands.                                                                                 |
| `chopin connect … --sandbox-host <host>`                    | Lets agents reach one more host through the sandbox. Repeat it.                                                              |
| `chopin connect … --sandbox-write <dir>`                    | Lets agents write one more directory inside the sandbox. Repeat it.                                                          |
| `chopin pair [--label <name>] [--key <key>]`                | Pairs this machine, or pairs it again. The label defaults to the hostname.                                                   |
| `chopin status [--json]`                                    | Shows the server, pairing, the connector, the service and what it runs, the sandbox, your checkouts and clones, and the log. |
| `chopin service install [--allow-downgrade] [--skip-check]` | Copies what `chopin connect` last ran and runs it as a background service.                                                   |
| `chopin service status`                                     | Prints `running`, `stopped`, `restart-pending` or `not-installed`.                                                           |
| `chopin service restart`                                    | Restarts the service with the settings it has, for example after an update.                                                  |
| `chopin service uninstall`                                  | Removes the service. The pairing, settings and past runs stay.                                                               |
| `chopin update [version] [--allow-downgrade] [--yes]`       | Installs the release your server asks for, or the one you name.                                                              |
| `chopin unpair`                                             | Revokes this machine in Chopin and deletes its token.                                                                        |

Every command takes `--base-dir <dir>`, or `CHOPIN_HOME`, to keep its files
somewhere other than the default folder.

## Troubleshooting

Start with `chopin status` and the log it names. For problems in the browser,
see
[Trouble connecting](local-experiments.md#trouble-connecting).

Each message says what to run next. The first line of each:

| Message starts with                                 | Do this                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `curl or wget is required`                          | Install curl, for example `sudo apt install curl`, then run the command again.                                                                                                                                                                                                                                                   |
| `could not download`                                | Check your connection and any proxy (`HTTPS_PROXY`), then run the command again.                                                                                                                                                                                                                                                 |
| `… isn't writable by you`                           | Run `sudo chown -R "$(id -un)" "$HOME/.local"`, then run the command again.                                                                                                                                                                                                                                                      |
| `… is not on your PATH`                             | Add the line the installer prints to your shell profile. The setup command runs `chopin` by its full path.                                                                                                                                                                                                                       |
| `npm error code EACCES`                             | npm can't write its global folder. Don't use `sudo`: run `npm config set prefix ~/.npm-global`, add `export PATH="$HOME/.npm-global/bin:$PATH"` to your shell profile, open a new terminal and install again. Or install Node.js with a version manager such as [nvm](https://github.com/nvm-sh/nvm), whose npm needs no `sudo`. |
| `… isn't installed`                                 | Install and sign in to the agent with the commands the message lists, then run the command again.                                                                                                                                                                                                                                |
| `… needs Node.js … or newer`                        | Install that Node.js (`nvm install 22`, or nodejs.org), reinstall the agent, then run the command again.                                                                                                                                                                                                                         |
| `… isn't inside a git checkout`                     | Give `--checkout` the folder of a clone from GitHub, or leave it out and `chopin` clones each repository as work needs it.                                                                                                                                                                                                       |
| `… isn't a github.com repository`                   | Check `git remote -v`; Chopin connects clones of GitHub repositories.                                                                                                                                                                                                                                                            |
| `Can't reach Chopin at …`                           | Check `CHOPIN_URL`, your network and any proxy, then run the command again.                                                                                                                                                                                                                                                      |
| `Chopin refused the pairing key`                    | Generate a new script from **Machines** → **Add machine** → **Cloud**, then run it.                                                                                                                                                                                                                                              |
| `… pairing key isn't allowed to use this Chopin`    | Ask whoever runs Chopin to let your GitHub account or organization in, then generate a new script.                                                                                                                                                                                                                               |
| `You can't push to … on GitHub`                     | Chopin won't run that repository's work on this machine. Ask an owner for write access, or drop that `--checkout`.                                                                                                                                                                                                               |
| `This machine has no checkout of …`                 | Your server gives machines no GitHub token to clone with. Run `chopin connect --checkout <path>` with a clone of that repository, then start the work again.                                                                                                                                                                     |
| `… speaks connector protocol …`                     | Run the `chopin update` command the message names.                                                                                                                                                                                                                                                                               |
| `… didn't answer ACP initialize`                    | Sign in to the agent with the command the message names, then run the command again.                                                                                                                                                                                                                                             |
| `… asks for permission in the terminal`             | Run the command without `--install-service` and keep the terminal open.                                                                                                                                                                                                                                                          |
| `This machine is already paired with …`             | To pair it for another account, run `chopin unpair`, then the command again.                                                                                                                                                                                                                                                     |
| `This machine is no longer paired with Chopin`      | Run `chopin pair`, then connect again.                                                                                                                                                                                                                                                                                           |
| `The service has to keep running after you log out` | Have an administrator run `sudo loginctl enable-linger "$(id -un)"`, then run the command again.                                                                                                                                                                                                                                 |

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

**"The service would not find … under the PATH it runs with."** Your agent,
your Planner, the interpreter a script names on its `#!` line, or `git` is only
on this shell's PATH, often through a version manager. Install it somewhere
stable, or connect again with its absolute path.

**"… lies in a directory that lasts only as long as this login or shell."**
Install that program somewhere stable, or link it into a folder on the
service's PATH, which the message prints.

**"… has Windows line endings in its first line; convert it with dos2unix."**
The system would read the interpreter's name with a carriage return on the end.
Run `dos2unix` on the script the message names, then install again.

**"…'s #! line must name an absolute path or use /usr/bin/env."** A `#!` line
such as `#!node` finds nothing when the service runs the script. Change it to
`#!/usr/bin/env node` or the interpreter's absolute path.

**"… runs through more than 5 #! interpreters"** or **"…'s #! interpreters
loop"**. Point the script's `#!` line at the program that finally runs it.

**"… didn't answer ACP initialize when started as the service would start
it."** The message shows how the agent ended and the first line it printed.
Fix that, often by signing in to the agent, then install again. If the agent
can't start without a terminal, pass `--skip-check`.

**"chopin can't reach your systemd user manager."** Run the command in a login
session as the user who owns the service, not through `su` or `sudo -u`.

**"… is already locked by a running connector"** Another `chopin connect`, or
the service, is already connected with this base dir, and one connection serves
every repository. Stop it, or if `chopin status` shows nothing running, delete
the `.lock` file the message names.

For files, versions, the server rules, service internals, starting the Windows
task at boot and status JSON, see the [chopin CLI reference](chopin-cli-reference.md).
