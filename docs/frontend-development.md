# In-app frontend development

This branch includes an opt-in LiveApp frontend pilot. Its floating **Developer**
window edits real source, checks an isolated candidate, and activates compatible
changes in the open application. Manual saves use the same publication path.

## Prepare the package

Use Bun 1.4.2 and Node 24.11 or newer. The pilot uses a locally packed library;
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

## Supported pilot changes

The editable roots in [`liveapp.adapter.ts`](../liveapp.adapter.ts) are web
views, editor UI, and shared presentation styles. Source candidates run the
existing workspace typechecks. The pilot exercises:

- New Tailwind utilities and changed status/presentation helpers.
- JSX changes in the existing resource-owning workspace module.
- A complete Pi source-edit/check/publish turn.
- Pending and mounted lazy dialogs, retained input, and updated UI callbacks.
- A new editor UI component and repeated subsequent changes.
- Remote edits over an independently authenticated product socket during
  preparation, with persistence through the normal PostgreSQL commit path.
- Invalid source, a throwing UI leaf, incompatible initialization, and a manual
  save overtaking a checked AI candidate.

The tests observe original React/DOM roots, editor/Yjs/provider/binding objects,
stores, registration and listener counts, selection, drafts, sessions, epochs,
writer leases, and process/socket continuity. Observational probes never restore
state or keep resources alive.

Changes to hook/resource initialization, mutable module initialization, startup
wiring, dependencies, or unsupported module constructs require restarting or
revising the proposed change. Server/protocol/storage files are outside this
frontend pilot's editable scope. Multiple or suspended LiveApp tabs are not
covered; close old application tabs before publishing.

The unmodified collaborative editor failed the initial undo check. Undo behavior
was intentionally left as-is and is **not** a preservation claim of this pilot.

## Verify

```sh
bun test e2e/liveapp/baseline.test.ts
bun run test:liveapp:baseline
bun run test:liveapp
bun run types
bun run ci
bun run build
```

Both browser commands create a disposable PostgreSQL service and use the real
application/authentication paths with the existing external GitHub fixture.
Integrated tests copy source into `e2e/.scratch/`, perform a frozen offline Bun
installation, and use the actual Pi SDK against a local streaming fixture. Source
changes stay in that copy. The runner owns and cleans up its processes, database,
and source copy; failure traces and publication diagnostics remain in
`e2e/test-results/`. Docker and the installed Chromium browser are required.

The integrated suite intentionally runs one eligible browser tab at a time and
takes several minutes because it checks many complete source publications.
Run individual files by appending, for example, `modes.e2e.ts` to either browser
command. The ordinary `bun run e2e` suite remains independently runnable.

## Validation record

The pilot began at application commit `c493bce5`. Only the original entry's
optional Developer loading/mounting changes application source; the editor,
providers, stores, registrations, and socket owners retain their baseline code.
The first full graph contained 233 application modules and 44 external imports.

Validated on 2026-10-06 with Bun 1.4.2, Vite 7.3.1, React 19.2.4, MDXEditor 4.1.0,
Lexical 0.48.0, and Yjs 13.6.31. The package identity is recorded separately in
`liveapp.package.json`. Validation includes the four integrated pilot tests,
plain-mode checks, all 41 existing editing/toolbar/collaboration/navigation tests,
workspace typechecks, repository checks, and the production build/bundle budget.
