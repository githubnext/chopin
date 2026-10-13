# Use your own machine with Chopin

## What it is

The `chopin` CLI connects a machine you control to a Chopin server. Builds,
investigations and Planner work that you start in Chopin then run there, with
your own coding agent in your own checkout.

The machine only makes outgoing requests. Chopin never connects in, and the
browser never reads your files.

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

Sign in to your coding agent as you normally would. Then, from your project
folder, run `chopin connect` with your server in `CHOPIN_URL` and the agent's
ACP command after `--`:

```sh
cd ~/src/score
CHOPIN_URL=https://your-chopin-instance.example chopin connect . -- copilot --acp --allow-all
```

`chopin connect` saves the server, so you set `CHOPIN_URL` only this once. Later
commands, and the background service, use the saved server. Without
`CHOPIN_URL` or a saved server, `chopin` uses `https://chopin.githubnext.com`.

The first time, `chopin connect` pairs this machine with your Chopin account:

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

## Keep it running

`chopin service install` runs your connection in the background, so it starts
again after a reboot and needs no open terminal. It takes no arguments and runs
what `chopin connect` last ran, with the server it saved.

1. Run `chopin connect` once, as above, and press Ctrl-C after `✓ Connected.`
2. Install the service:

   ```sh
   chopin service install
   ```

The service can't answer permission prompts, so give your agent its approval
flag, such as `--allow-all`.

To change what the service runs, run `chopin connect` again with new arguments,
then restart the service:

```sh
chopin connect ~/src/other-project -- copilot --acp --allow-all
chopin service restart
```

If the service is already running that checkout, `chopin connect` only saves
your settings and prints
`The chopin service is running this checkout. Saved your settings; run chopin service restart to use them.`

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
Log:        /home/me/.local/state/chopin/connector/chopin.log
Base dir:   /home/me/.local/state/chopin/connector
```

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

This revokes the machine in Chopin and deletes its token. You can also choose
**Disconnect machine** under **Your machines** at `/connect` on your server.

A running `chopin connect` then stops. The next `chopin connect` at a terminal
pairs again. To remove the service as well, run `chopin service uninstall`.

## Commands

| Command                                               | What it does                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `chopin connect [checkout] -- <agent>`                | Runs work from Chopin with your agent in this checkout. Pairs first if needed. |
| `chopin pair [--label <name>]`                        | Pairs this machine, or pairs it again. The label defaults to the hostname.     |
| `chopin status [--json]`                              | Shows the server, pairing, running connectors, service and log.                |
| `chopin service install [--allow-downgrade]`          | Runs what `chopin connect` last ran as a background service.                   |
| `chopin service status`                               | Prints `running`, `stopped`, `restart-pending` or `not-installed`.             |
| `chopin service restart`                              | Restarts the service with your latest settings, or after an update.            |
| `chopin service uninstall`                            | Removes the service. The pairing, settings and past runs stay.                 |
| `chopin update [version] [--allow-downgrade] [--yes]` | Installs the release your server asks for, or the one you name.                |
| `chopin unpair`                                       | Revokes this machine in Chopin and deletes its token.                          |

Every command takes `--base-dir <dir>`, or `CHOPIN_HOME`, to keep its files
somewhere other than the default folder.

## Troubleshooting

Start with `chopin status` and the log it names. For problems in the browser,
see
[Trouble connecting](local-experiments.md#trouble-connecting).

**"CHOPIN_URL is …, but chopin connect saved …"** Install uses the server
`chopin connect` saved. Run `chopin connect` again with the server you want in
`CHOPIN_URL`, then `chopin service install`.

**"Run chopin connect once in your checkout first (it saves what the service
runs), then chopin service install."** Run `chopin connect` in your checkout,
wait for `✓ Connected.`, press Ctrl-C, then install again.

**"This machine is not paired with …"** The service can't pair. Run
`chopin pair` at a terminal, then the command the message names.

**"This machine is no longer paired with Chopin."** or **"GitHub no longer
accepts this machine's authorization."** Someone disconnected the machine, or
GitHub retired its authorization. Run `chopin pair`, then connect again.

**"The service would not find … under the PATH it runs with."** Your agent, its
interpreter or `git` is only on this shell's PATH, often through a version
manager. Install it somewhere stable, or connect again with the agent's
absolute path after `--`.

**"chopin can't reach your systemd user manager."** Run the command in a login
session as the user who owns the service, not through `su` or `sudo -u`.

**"Workspace already locked."** Another `chopin connect`, or the service, is
serving this checkout. Stop it, or if `chopin status` shows nothing running
there, delete the `.lock` file the message names.

For files, versions, the server rules, service internals, starting the Windows
task at boot and status JSON, see the [chopin CLI reference](chopin-cli-reference.md).
