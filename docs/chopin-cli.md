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
- You can choose only your own machines.
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

Disconnecting a machine clears every choice of it, and clears it as your
default.

Choose your default machine from **Machines** in the sidebar: it opens a menu
listing **Any connected** and each of your machines under **Local** or **Cloud**
with its state, then **Add
machine** and **Manage machines** for the full page. The default is the
machine marked as your favorite on the **Machines** page too (its star, or **Set
as favorite** in its menu). Only one machine is your
default. Chopin uses it first whenever it is connected and free, and otherwise
picks as before; a machine you chose for a
document never moves. Your default is yours alone and applies to every document
left on **Default machine**.

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
your machines.

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
A Planner waiting on a question or on a live or paused workflow run counts as
use, so its questions stay open however long nobody views the document.
A Planner stays on its machine while that machine is connected, even when
another comes online; it moves when the machine disconnects or the creator
changes the document's machine or their default. Chat says
**Planner: starting on studio…** (the machine's name) until it attaches, and
an `@chopin` message sent meanwhile waits for it.

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

| Path                                    | Holds                                               | Removed                                         |
| --------------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `runs/<run id>`                         | A job's worktree, for you to inspect                | Once 15 newer runs have finished                |
| `runs/<run id>-worktrees/`              | Extra worktrees a build adds for more pull requests | When the run ends, uncommitted changes included |
| `planners/<owner>/<repo>/<document id>` | A Planner command's worktree for one document       | Never                                           |
| `repos/<owner>/<repo>`                  | A clone of a repository you named no checkout of    | Never                                           |

`--keep-runs <n>` keeps `n` finished runs instead of 15, and `--keep-runs 0`
keeps them all. `chopin` never removes a run that is going or waiting to start.

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

| Command                                                     | What it does                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `chopin connect [--key <key>] --agent <id>`                 | Runs work from Chopin, in any repository you can push to, with a built-in agent. Pairs first if needed.           |
| `chopin connect … -- <command>`                             | Runs any other ACP agent's command instead.                                                                       |
| `chopin connect … --checkout <path>`                        | Uses your checkout for its repository's work instead of a clone. Repeat it for more; a bare path counts as one.   |
| `chopin connect … --name <label>`                           | Names the machine in Chopin as it pairs. A machine paired already keeps its name; rename it on the Machines page. |
| `chopin connect … --install-service`                        | Connects once, then installs the service with what it ran.                                                        |
| `chopin connect … --keep-runs <n>`                          | Keeps the `n` most recently finished runs (default 15, 0 for all).                                                |
| `chopin pair [--label <name>] [--key <key>]`                | Pairs this machine, or pairs it again. The label defaults to the hostname.                                        |
| `chopin status [--json]`                                    | Shows the server, pairing, the connector, the service and what it runs, your checkouts and clones, and the log.   |
| `chopin service install [--allow-downgrade] [--skip-check]` | Copies what `chopin connect` last ran and runs it as a background service.                                        |
| `chopin service status`                                     | Prints `running`, `stopped`, `restart-pending` or `not-installed`.                                                |
| `chopin service restart`                                    | Restarts the service with the settings it has, for example after an update.                                       |
| `chopin service uninstall`                                  | Removes the service. The pairing, settings and past runs stay.                                                    |
| `chopin update [version] [--allow-downgrade] [--yes]`       | Installs the release your server asks for, or the one you name.                                                   |
| `chopin unpair`                                             | Revokes this machine in Chopin and deletes its token.                                                             |

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
