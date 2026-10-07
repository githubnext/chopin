# In-app frontend development

LiveApp provides opt-in frontend development. Its floating **Developer**
window edits real source, checks an isolated candidate, and activates compatible
changes in the open application. Manual saves use the same publication path.

## Prepare the package

Use Bun 1.4.2 and Node 24.11 or newer. The integration uses a locally packed library;
the selected library commit and archive SHA-256 are in
[`liveapp.package.json`](../liveapp.package.json). Prepare the library checkout at
that commit with its normal `npm ci` before running this from the application root:

```sh
LIVEAPP_SOURCE=/absolute/path/to/library bun run liveapp:prepare
```

This builds and packs the supplied checkout, creates a content-addressed archive
under `.liveapp-package/`, installs it in `apps/web`, and updates the package
record and Bun lockfile together. It also works before this application's
dependencies have been installed. The archive directory is generated and ignored;
run preparation on a fresh checkout before `bun install --frozen-lockfile`.

Stop integrated development before refreshing the package. Commit the updated
web dependency, lockfile, and package record together when changing versions.

## Start

Configure the ordinary application and PostgreSQL as described in the
[README](../README.md#run-locally), then run:

```sh
bun run dev:liveapp
```

Open **http://127.0.0.1:8787**, using one application tab. Port 5173 is internal
Vite; opening it directly bypasses the application's authentication/API proxy.
The launcher prints the usable application URL after startup.

LiveApp guides first-time model setup. Its settings and credentials live in
`liveapp.config.json` and `.liveapp/pi/`; they are separate from the product
Planner's configuration. To run setup explicitly:

```sh
./apps/web/node_modules/.bin/liveapp setup --project .
```

The Node/Vite process owns frontend publication. The Bun application process
stays alive without source-watch restarts in this mode, retaining its sessions,
writer lease, rooms, and product WebSockets. LiveApp's separate control socket
connects to internal Vite; application traffic uses port 8787.

Accepted AI edits remain uncommitted working-tree source, with private revision
snapshots under `.liveapp/`. Review and commit them normally. Collapse or move
the Developer window to reach application controls underneath it.

`bun run dev` retains native Vite development. Production builds and ordinary
development pages do not load the Developer widget or its runtime.

## Editable scope

The editable roots in [`liveapp.adapter.ts`](../liveapp.adapter.ts) are web
views, editor UI, and shared presentation styles. Source candidates run the
existing workspace typechecks.

Changes to hook/resource initialization, mutable module initialization, startup
wiring, dependencies, or unsupported module constructs require restarting or
revising the proposed change. Server/protocol/storage files are outside this
integration's editable scope. Multiple or suspended LiveApp tabs are not
covered; close old application tabs before publishing.

The existing collaborative editor's undo limitation is outside this integration's
preservation guarantees.

## Verify

```sh
bun run types
bun run ci
bun run build
bun run e2e
```

Comprehensive compiler, import, publication, recovery, and resource-lifecycle
regressions belong to the LiveApp repository and its generic fixtures. Product
behavior is covered by the ordinary `bun run e2e` suite.
