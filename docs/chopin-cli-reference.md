# chopin CLI reference

The details behind [Use your own machine with Chopin](chopin-cli.md).

## Which server chopin uses

You set `CHOPIN_URL` once, for `chopin connect`. It saves that server in
`config.json`, and the other commands and the service use the saved one.

| Command                                                          | Server                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `chopin connect`                                                 | `CHOPIN_URL`, else the saved server, else `https://chopin.githubnext.com`. It saves the one it uses. |
| `chopin pair`, `chopin unpair`, `chopin status`, `chopin update` | The same order, but they save nothing.                                                               |
| `chopin service install` and the service                         | The saved server. Install refuses when `CHOPIN_URL` names another one.                               |

`CHOPIN_URL` must be the server's origin alone, such as
`https://your-chopin-instance.example`. Plain HTTP works only on `localhost`,
`127.0.0.1` and `[::1]`.

To move to another server, run `chopin connect` again with the new
`CHOPIN_URL`. If the service is running, run `chopin pair` too when the machine
isn't paired with that server yet, then `chopin service restart`.

## Where chopin keeps its files

`chopin` keeps its state in `~/.local/state/chopin/connector`, or
`$XDG_STATE_HOME/chopin/connector` when that is set. `--base-dir`,
`CHOPIN_HOME` or `CHOPIN_CONNECTOR_STATE_DIR` moves it.

| File or folder | Holds                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `machine.json` | The machine token for each server. Only you can read it (mode `0600`). `chopin` never prints it. |
| `config.json`  | What `chopin connect` last ran, with its server, and the installed service. No secrets.          |
| `chopin.log`   | The service's output.                                                                            |
| `*.lock`       | One lock for each checkout that a connector is serving.                                          |
| `runs/`        | A Git worktree for each job, kept for you to inspect.                                            |

Chopin stores only a hash of the machine token, plus the machine's own GitHub
authorization, encrypted like a browser login.

## Install a particular version

Pass the version to the installer, or set `CHOPIN_VERSION`:

```sh
curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | sh -s -- 0.2.0
```

Before installing, the installer checks the download against the release's
`checksums.txt`. If the [GitHub CLI](https://cli.github.com) is installed, it
also runs `gh attestation verify` to confirm that Chopin's release workflow
built the file. `CHOPIN_VERIFY_ATTESTATION=0` skips that second check.

Running the installer again also updates `chopin`.

To build the binaries from a Chopin checkout instead, run
`bun run --cwd apps/connector build:binaries --host`. They go to
`apps/connector/dist`. See [Releasing the chopin CLI](releasing-cli.md) for how
releases are made.

## Run without installing

Every Chopin server also serves the connector as one script at
`/connector.js`. It needs [Bun](https://bun.sh) 1.4.2. This is the command
Chopin shows when no local agent is connected:

```sh
mkdir -p ~/.chopin \
  && curl -fsSL https://your-chopin-instance.example/connector.js -o ~/.chopin/connector.js \
  && CHOPIN_URL=https://your-chopin-instance.example \
    bun --no-env-file --config=/dev/null \
      ~/.chopin/connector.js connect . -- copilot --acp --allow-all
```

`--no-env-file` and `--config=/dev/null` stop Bun from reading the folder's
`.env` and `bunfig.toml`. That way a checkout can't choose the server or run
code through a `preload`. The installed `chopin` ignores both files on its own.

`chopin update` and `chopin service install` need the installed `chopin`. When
the server needs a newer script, download it again.

## Updates and downgrades

`chopin update` asks the saved server which release it wants. If it can't reach
the server, it installs the newest release instead. `chopin update 0.2.0`
installs that release.

Moving to an older release needs `--allow-downgrade`. Without it,
`chopin update` prints the command with the flag and changes nothing. On a
terminal it asks before replacing itself, and `--yes` skips the question.

On Windows the running `chopin.exe` becomes `chopin.exe.old`, which the next
`chopin` deletes. If an update leaves only `chopin.exe.old`, run the installer
again.

## How the service runs

The service runs the installed `chopin` by its absolute path, as
`chopin connect --base-dir <dir> --service`. When it starts, it reads what
`chopin connect` saved, including the server, and the machine token. No token
or other secret goes into the service definition. There is one service per
user account.

Before writing anything, install finds the agent's absolute path and builds the
PATH the service runs with. That PATH leaves out folders that disappear on
logout or reboot, such as anything under `$XDG_RUNTIME_DIR` or
`/run/user/<uid>`, and fnm's `fnm_multishells`. Install refuses if the agent,
the interpreter on its `#!/usr/bin/env` line, or `git` would not be found. A
relative Planner command is looked up in the checkout.

If a newer `chopin` installed the service, `chopin service install` refuses to
replace it. Run `chopin update` first, or pass `--allow-downgrade`.

| OS      | Service definition                                                          | Behaviour                                                                                                              |
| ------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Linux   | `~/.config/systemd/user/chopin.service` (under `$XDG_CONFIG_HOME` when set) | Restarts after any exit. A stop gives the connector 90 seconds to report its runs stopped.                             |
| macOS   | `~/Library/LaunchAgents/com.github.chopin.plist`                            | Kept alive while you are logged in. Over SSH with nobody logged in at the Mac, it loads at your next login.            |
| Windows | Task `\chopin-<your user name>` in Task Scheduler's root folder             | Starts at logon, restarts a minute after a failure, and has no time limit. PATH entries that contain `%` are left out. |

On Linux, `chopin service uninstall` leaves linger on. Turn it off with
`sudo loginctl disable-linger "$(id -un)"` if nothing else needs it.

systemd can't run a program whose path contains a quote or a backslash, so
install refuses such a path. Copy `chopin` somewhere else, such as
`/usr/local/bin`, and install from that copy.

## Start the Windows task at boot

To start the task at boot whether or not you are logged on, change it to an S4U
task. Run this in PowerShell as administrator, signed in as the same user:

```powershell
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$name = 'chopin-' + $env:USERNAME   # as `chopin service status` shows it
Set-ScheduledTask -TaskName $name -TaskPath '\' `
  -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited) `
  -Trigger (New-ScheduledTaskTrigger -AtStartup)
```

An S4U task can't reach network shares that need your password. Running
`chopin service install` again puts the task back on the logon trigger. If Task
Scheduler then refuses `restart` or `uninstall`, run them as administrator too.

## Status JSON

`chopin status --json` prints one object. Later releases only add keys.

| Key          | Value                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`    | The CLI version, `dev` from source.                                                                                                                                                                                                  |
| `protocol`   | The connector protocol it speaks.                                                                                                                                                                                                    |
| `server`     | `origin`, and `source`: `CHOPIN_URL`, `config` (saved by `chopin connect`) or `default`.                                                                                                                                             |
| `machine`    | `paired`, `label` (or `null`), `check` (`accepted`, `revoked`, `reauthorize`, `update-required`, `unreachable`, `error` or `not-paired`), `accepted` (`true`, `false`, or `null` when unknown), and optionally `login` and `detail`. |
| `connectors` | One entry per checkout lock: `pid`, `checkout`, `running` (`false` for a stale lock), `service`, and optionally `version`, `started` (ISO 8601) and `planners`.                                                                      |
| `service`    | `state` (`running`, `stopped`, `restart-pending`, `not-installed`, or `unknown` with `detail`), `manager`, `definition`, `log`, `notes`, and optionally `pid`, `running` and `installed` versions.                                   |
| `log`        | The service's log file.                                                                                                                                                                                                              |
| `baseDir`    | The state directory the report is for.                                                                                                                                                                                               |
