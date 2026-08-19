# exe.dev development

Chopin has a dedicated supervisor mode for developing inside an exe.dev VM. It
keeps the application, API, OAuth flow, and application WebSocket on one browser
origin while exposing Vite HMR through a private alternate port.

## Proxy setup

Point the VM's primary proxy at the Bun server:

```bash
ssh exe.dev share port <vm-name> 8787
```

The proxy may remain private for personal development. GitHub redirects the
browser, not a webhook, and the browser can complete exe.dev authentication. To
share Chopin with people who do not have VM access, make the primary proxy
public separately.

## GitHub App

The same development GitHub App can support loopback and the VM because GitHub
Apps accept multiple authorization callback URLs. Keep this exact local entry:

```text
http://127.0.0.1:8787/auth/github/callback
```

For a stable VM, add the exact remote callback with wildcard matching disabled:

```text
https://<vm-name>.exe.xyz/auth/github/callback
```

For an App reused across changing VMs, add this callback and enable wildcard
matching only for this entry:

```text
https://exe.xyz/auth/github/callback
```

GitHub then accepts the exact callback Chopin sends for
`https://<vm-name>.exe.xyz`. This wildcard also trusts sibling `*.exe.xyz`
hosts that the project does not control. Prefer an exact callback; if the
wildcard is necessary, use a development-only App installed on selected test
repositories.

GitHub Apps support only one non-wildcard Setup URL. A single App shared by
loopback and changing VMs cannot return automatically to both. Leave the Setup
URL blank and reopen the Chopin URL manually after installation or repository
updates, or point it at the environment used most often and return manually
from the other one. A fixed environment can use one of these:

```text
http://127.0.0.1:8787/auth/github/setup
https://<vm-name>.exe.xyz/auth/github/setup
```

Leave **Request user authorization (OAuth) during installation** disabled.
Permissions and the remaining App settings are documented in
[Authentication](authentication.md).

## Running Chopin

Keep the ordinary local origin in `.env` alongside the shared App credentials:

```dotenv
APP_ORIGIN=http://127.0.0.1:8787
GITHUB_APP_SLUG=<app-slug>
GITHUB_APP_CLIENT_ID=<client-id>
GITHUB_APP_CLIENT_SECRET=<client-secret>
# Optional instance admission:
GITHUB_ALLOWED_ORGANIZATIONS=githubnext
```

Then run:

```bash
bun run dev:exe
```

The supervisor queries exe.dev's documented Reflection integration for the
canonical VM name and overrides `APP_ORIGIN` only in its child processes. It
binds Bun to `0.0.0.0:8787` and announces the exact application URL:

```text
https://<vm-name>.exe.xyz
```

The primary, portless URL carries the application, API, OAuth callbacks, and
application WebSocket. Vite HMR connects separately over the private alternate
URL:

```text
wss://<vm-name>.exe.xyz:5173
```

Local and VM development are alternate modes for one database: Chopin permits
one active writer process per database, and each process accepts only its exact
configured origin.

## Maintainer notes

`CHOPIN_DEV_EXE_HOST` is the supervisor's internal exact-host handoff to Vite.
Do not replace it with a suffix such as `.exe.xyz` or with `allowedHosts: true`;
that would expand Vite's host trust boundary to unrelated VMs. The alternate
HMR port is intentionally private, while the primary proxy controls who can
open the application.
