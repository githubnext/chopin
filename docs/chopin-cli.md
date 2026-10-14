# Use your own machine with Chopin

## What it is

The `chopin` CLI connects a machine you control to a Chopin server. Builds,
investigations and Planner work that you start in Chopin then run there, with
your own coding agent in your own checkout.

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

In Chopin, open **Machines**. With no machine paired yet, the setup card is
already open; otherwise choose **Add a machine**. Pick the machine's system and
your coding agent, copy the command, and run it in a checkout on that machine.
On Linux or macOS it looks like this:

```sh
curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh \
  | sh && CHOPIN_URL=https://your-chopin-instance.example \
  CHOPIN_PAIRING_KEY=chopin_k_… \
  ~/.local/bin/chopin connect . \
  --install-service \
  -- copilot --acp --allow-all
```

It installs `chopin`, pairs the machine with a single-use key and installs the
service. The machine appears on the page as it connects. Nothing opens in a
browser, so the same command works over SSH. On Windows the command passes the
key as `--key`.

The key works once, for ten minutes, and only for the account that made it.
**New key** replaces it, and the page makes a new one as the old one expires.
`chopin` sends the key once and never saves it. If your server needs GitHub to
authorize the machine, the page checks with GitHub before it makes the first
key; that returns at once if you have used Chopin before.

The agent must be installed and signed in first. The card shows its install
command under **Show install command**, and [Coding agents](#coding-agents)
lists them all. Automatic rebuilds and prototypes stay off; see
[Connect a checkout](#connect-a-checkout).

To pair with a key yourself, pass it as `--key` or in `CHOPIN_PAIRING_KEY`:

```sh
chopin pair --key chopin_k_…
chopin connect . --key chopin_k_… -- copilot --acp --allow-all
```

Without a key, `chopin connect` pairs through your browser instead, as
[Connect a checkout](#connect-a-checkout) describes.

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

## Connect a checkout

Install your coding agent and sign in to it, as [Coding agents](#coding-agents)
shows. Then, from your project folder, run `chopin connect` with your server in
`CHOPIN_URL` and the agent's ACP command after `--`:

```sh
cd ~/src/score
CHOPIN_URL=https://your-chopin-instance.example chopin connect . -- copilot --acp --allow-all
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
5. Choose **Connect**. The page says **Connected.**

The pairing lasts until you [disconnect the machine](#disconnect). It survives
server restarts, deploys and signing out of the browser.

When the connection is up, you see:

```text
✓ Connected.
  Work you start in any octo-org/score document runs here. Ctrl-C disconnects.
```

Work from any document in that repository now runs in this checkout.

- Any agent that speaks ACP over stdio works. `--allow-all` is Copilot CLI's
  flag for approving its tools.
- The checkout's `origin` must be a github.com repository you can push to.
- Set `CHOPIN_DEBUG=1` to see your agent's own log.
- Ctrl-C stops running work and disconnects. A second Ctrl-C exits at once.

To give your agent and Planner an environment variable, add `--env`, as often
as you need:

```sh
chopin connect . --env SOME_FLAG=1 -- copilot --acp --allow-all
```

`chopin` saves these values in `config.json`, which only you can read. Keep
secrets in your agent's own login instead. You can't set `PATH` or a
`CHOPIN_` variable this way.

### Coding agents

The Machines page offers these agents. **Connect with** is what follows
`chopin connect .`:

| Agent                                                                                               | Install                                                       | Sign in                                                  | Node.js        | Connect with                                              | Tested with Chopin |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- | -------------- | --------------------------------------------------------- | ------------------ |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server) | `npm install -g @github/copilot`                              | `copilot login`                                          | 22 or newer    | `-- copilot --acp --allow-all`                            | Yes                |
| [Atomic](https://github.com/bastani-inc/atomic-acp)                                                 | `npm install -g @bastani/atomic @bastani/atomic-acp`          | `atomic`, sign in with /login, then quit                 | 22.19 or newer | `--env ATOMIC_ACP_HEADLESS=1 -- atomic-acp`               | Yes                |
| [Claude Code](https://github.com/agentclientprotocol/claude-agent-acp)                              | `npm install -g @agentclientprotocol/claude-agent-acp`        | `claude-agent-acp --cli`, sign in with /login, then quit | 22 or newer    | `-- claude-agent-acp`                                     | No                 |
| [OpenAI Codex](https://github.com/agentclientprotocol/codex-acp)                                    | `npm install -g @openai/codex @agentclientprotocol/codex-acp` | `codex login`                                            | 20 or newer    | `--env INITIAL_AGENT_MODE=agent-full-access -- codex-acp` | No                 |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md)            | `npm install -g @google/gemini-cli`                           | `gemini`, sign in, then quit                             | 20 or newer    | `-- gemini --acp --yolo`                                  | No                 |

Install the agent globally, as the table does, not through `npx`, so the
service finds the same program each time. Each **Connect with** approves the agent's tools
without asking, because the service can't answer a permission prompt:
`--allow-all` for Copilot CLI, `--yolo` for Gemini CLI, and
`INITIAL_AGENT_MODE=agent-full-access` for Codex. Atomic doesn't ask, and
`ATOMIC_ACP_HEADLESS=1` ends its questions at once instead of waiting for an
answer.

Claude Code asks for permission in the terminal, so connect it without
`--install-service` and keep `chopin connect` open. To run it as the service,
set `"defaultMode": "bypassPermissions"` under `"permissions"` in
`~/.claude/settings.json` first.

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
last ran, server included, and runs that copy.

The quickest way is one command. It connects, and once it sees
`✓ Connected.` it disconnects and installs the service:

```sh
chopin connect . --install-service -- copilot --acp --allow-all
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

The service can't answer permission prompts, so give your agent its approval
flag, such as `--allow-all`.

A later `chopin connect`, here or in another checkout, doesn't change what the
service runs. To change it, connect again with the new arguments, then install
again:

```sh
chopin connect ~/src/other-project -- copilot --acp --allow-all   # Ctrl-C after ✓ Connected.
chopin service install
```

If the service is running the checkout you connect, `chopin connect` saves your
settings without connecting and prints:

```text
The chopin service is running this checkout. Saved your settings; run chopin service install to use them.
```

Each operating system has its own catch:

- **Linux.** A systemd user service. Install turns on linger so it keeps
  running after you log out. If that needs an administrator, install prints
  the `sudo loginctl enable-linger` command for them. Never run `chopin` itself
  with `sudo`.
- **macOS.** A LaunchAgent, which runs only while you are logged in.
- **Windows.** A Task Scheduler task, which runs only while you are logged on.

## Check on it

```sh
chopin status
```

You see something like this:

```text
chopin 0.0.2 (connector protocol 3)
Server:     https://your-chopin-instance.example (saved by chopin connect)
Machine:    paired as build-box (octocat); Chopin accepts it
Connector:  running for /home/me/src/score (pid 4242, chopin 0.0.2, the service)
Service:    running (systemd, pid 4242)
            definition: /home/me/.config/systemd/user/chopin.service
            runs /home/me/src/score with /home/me/.local/bin/copilot --acp --allow-all, on https://your-chopin-instance.example
Log:        /home/me/.local/state/chopin/connector/chopin.log
Base dir:   /home/me/.local/state/chopin/connector
```

If you have connected something else since you installed the service, status
shows that too, with a reminder to run `chopin service install`.

If the agent or a Planner keeps failing to start, status shows the latest
failure under the connector, with the first line it printed. That line, and
what a Planner prints to chopin's output, has anything that looks like a token,
your `--env` values of 8 characters or more and the Planner's credential
replaced with `[redacted]`:

```text
Connector:  running for /home/me/src/score (pid 4242, chopin 0.0.2, the service)
              Planner for https://your-chopin-instance.example/octo-org/score/plan: failing (exit 127: /usr/bin/env: 'node': No such file or directory), retrying in 22s
```

A Planner that Chopin refused for good, such as one for a deleted document,
shows `stopped:` and the reason instead of `failing`.

`chopin status` asks Chopin whether it still accepts this machine. It never
pairs, connects or changes anything.

## Run a Planner on this machine

If your Chopin server runs `HARNESS=remote` (and not `AUTH_MODE=local`), this
machine can run a document's Planner. Pass the document's URL with `--planner`
and your Planner backend's command with `--planner-command`:

```sh
chopin connect . --planner https://your-chopin-instance.example/octo-org/score/plan \
  --planner-command "my-planner --flag" -- copilot --acp --allow-all
```

`--planner` can repeat. `chopin` runs the command in the checkout for each
document and restarts it when it exits. See
[Planner backend commands](planner-link.md#planner-backend-commands) for what
the backend must do.

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
**Machines** in Chopin's sidebar, which goes to `/connect` on your server, and
choose **Disconnect machine** from the machine's menu under **Your machines**.

A running `chopin connect` then stops. The next `chopin connect` at a terminal
pairs again. To remove the service as well, run `chopin service uninstall`.

## Commands

| Command                                                     | What it does                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `chopin connect [checkout] [--key <key>] -- <agent>`        | Runs work from Chopin with your agent in this checkout. Pairs first if needed.            |
| `chopin connect … --install-service`                        | Connects once, then installs the service with what it ran.                                |
| `chopin pair [--label <name>] [--key <key>]`                | Pairs this machine, or pairs it again. The label defaults to the hostname.                |
| `chopin status [--json]`                                    | Shows the server, pairing, running connectors, the service and what it runs, and the log. |
| `chopin service install [--allow-downgrade] [--skip-check]` | Copies what `chopin connect` last ran and runs it as a background service.                |
| `chopin service status`                                     | Prints `running`, `stopped`, `restart-pending` or `not-installed`.                        |
| `chopin service restart`                                    | Restarts the service with the settings it has, for example after an update.               |
| `chopin service uninstall`                                  | Removes the service. The pairing, settings and past runs stay.                            |
| `chopin update [version] [--allow-downgrade] [--yes]`       | Installs the release your server asks for, or the one you name.                           |
| `chopin unpair`                                             | Revokes this machine in Chopin and deletes its token.                                     |

Every command takes `--base-dir <dir>`, or `CHOPIN_HOME`, to keep its files
somewhere other than the default folder.

## Troubleshooting

Start with `chopin status` and the log it names. For problems in the browser,
see
[Trouble connecting](local-experiments.md#trouble-connecting).

Each message says what to run next. The first line of each:

| Message starts with                                 | Do this                                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `curl or wget is required`                          | Install curl, for example `sudo apt install curl`, then run the command again.                             |
| `could not download`                                | Check your connection and any proxy (`HTTPS_PROXY`), then run the command again.                           |
| `… isn't writable by you`                           | Run `sudo chown -R "$(id -un)" "$HOME/.local"`, then run the command again.                                |
| `… is not on your PATH`                             | Add the line the installer prints to your shell profile. The setup command runs `chopin` by its full path. |
| `… isn't installed`                                 | Install and sign in to the agent with the commands the message lists, then run the command again.          |
| `… needs Node.js … or newer`                        | Install that Node.js (`nvm install 22`, or nodejs.org), reinstall the agent, then run the command again.   |
| `… isn't inside a git checkout`                     | `cd` into your repository's folder, then run the command again.                                            |
| `… isn't a github.com repository`                   | Check `git remote -v`; Chopin connects clones of GitHub repositories.                                      |
| `Can't reach Chopin at …`                           | Check `CHOPIN_URL`, your network and any proxy, then run the command again.                                |
| `Chopin refused the pairing key`                    | Copy a new command from **Machines** → **Add a machine**, then run it.                                     |
| `The account that made the key can't push to …`     | Ask an owner for write access, then run the command again.                                                 |
| `… speaks connector protocol …`                     | Run the `chopin update` command the message names.                                                         |
| `… didn't answer ACP initialize`                    | Sign in to the agent with the command the message names, then run the command again.                       |
| `… asks for permission in the terminal`             | Run the command without `--install-service` and keep the terminal open.                                    |
| `This machine is already paired with …`             | To pair it for another account, run `chopin unpair`, then the command again.                               |
| `This machine is no longer paired with Chopin`      | Run `chopin pair`, then connect again.                                                                     |
| `The service has to keep running after you log out` | Have an administrator run `sudo loginctl enable-linger "$(id -un)"`, then run the command again.           |

**"CHOPIN_URL is …, but chopin connect saved …"** Install uses the server
`chopin connect` saved. Run `chopin connect` again with the server you want in
`CHOPIN_URL`, then `chopin service install`.

**"Run chopin connect once in your checkout first, then chopin service
install."** Run `chopin connect` in your checkout, wait for `✓ Connected.`,
press Ctrl-C, then install again.

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

**"Workspace already locked."** Another `chopin connect`, or the service, is
serving this checkout. Stop it, or if `chopin status` shows nothing running
there, delete the `.lock` file the message names.

For files, versions, the server rules, service internals, starting the Windows
task at boot and status JSON, see the [chopin CLI reference](chopin-cli-reference.md).
