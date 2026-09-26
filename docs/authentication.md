# Authentication and authorization

Authentication covers the browser product, WebSocket, local MCP, repository
tools, and Copilot. A verified GitHub user supplies presence and attribution.
Optional instance admission lists restrict who may use Chopin. Browser routes,
WebSockets, and the hosted agent intersect the user's repository role with the
GitHub App installation. Local MCP instead checks the repository role granted
directly to its caller-supplied bearer token.

## GitHub App

Create one GitHub App for each deployment. Use these registration settings:

```text
Homepage URL: <APP_ORIGIN>
Callback URL: <APP_ORIGIN>/auth/github/callback
Setup URL:    <APP_ORIGIN>/auth/github/setup
```

- Leave **Expire user authorization tokens** enabled.
- Leave **Request user authorization (OAuth) during installation** disabled.
- Leave device flow disabled for a hosted deployment; local device-flow sign-in
  (below) requires enabling it on the App instead.
- Enable **Redirect on update** when a setup URL is configured.
- Disable webhooks.
- Select **Any account** so personal accounts and organizations can install it.
- Prefer **Only select repositories** while installing it.

Repository permissions for the complete product are:

```text
Contents:        Read-only
Pull requests:   Read-only
Checks:          Read-only
Commit statuses: Read-only
Metadata:        Read-only (automatic)
```

Contents backs file, tree, code-search, and commit-history tools. The other
read-only permissions back the hosted GitHub MCP pull-request toolset. Chopin
does not request repository, organization, or account write permission. An
`AGENT=off` deployment only needs Contents and automatic Metadata access unless
organization admission is enabled.

Organization admission additionally requires:

```text
Organization permissions:
Members: Read-only
```

The App must be installed on every allowed organization, and an organization
owner must approve this permission. Existing installations continue with their
old permissions until the owner approves the update.

No App ID, private key, JWT, installation access token, or webhook secret is
used. Chopin acts on behalf of each signed-in user with a GitHub App user access
token so repository-role checks and the user's Copilot entitlement remain
theirs.

Configure Chopin with the App's slug and OAuth client credentials. A minimal
production environment contains:

```text
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://<user>:<password>@<database-host>:5432/<database>
APP_ORIGIN=https://chopin.example
GITHUB_APP_SLUG=chopin-example
GITHUB_APP_CLIENT_ID=...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_ALLOWED_USERS=octocat,hubot
GITHUB_ALLOWED_ORGANIZATIONS=githubnext
SESSION_ENCRYPTION_KEY=<64 hex characters>
```

The client ID is distinct from the numeric App ID. Generate the encryption key
with `openssl rand -hex 32`; it protects the short-lived OAuth attempt cookie,
including state, the PKCE verifier, and an optional browser return path.

`APP_ORIGIN` must be exactly one HTTP(S) origin: no credentials, path, query,
fragment, or trailing slash. HTTPS is required except for loopback development,
such as `http://127.0.0.1:8787`. Callback URLs are built only from this value,
never from incoming Host or forwarded headers.

The complete variable reference and deployment procedures live in
[Self-hosting](self-hosting.md).

## Local device-flow sign-in

`AUTH_MODE=local` replaces the browser authorization-code flow with GitHub's
device flow and persists the resulting credential so a restarted process can
resume the same login. It is a loopback-only mode, not an alternative hosted
deployment: `SERVER_HOST` must be `127.0.0.1`, `::1`, or `localhost`, and
`APP_ORIGIN` must be an exact HTTP(S) loopback origin on the same port. The
Docker image binds `0.0.0.0` and is incompatible with local mode; run from a
source checkout instead.

Device flow authenticates with the App's public client ID only.
`GITHUB_APP_CLIENT_SECRET` is not read in local mode; a value left over from a
hosted `.env` is ignored. Enable device flow on the App used for local mode
(this is the opposite of the hosted guidance above), and keep **Expire user
authorization tokens** enabled so expiring access and refresh tokens are
issued.

The browser flow is:

1. `POST /auth/device` requests a device code from GitHub and returns the
   user-facing code, verification URL, and expiry to the browser. The private
   `device_code` never leaves the server. The response also sets an
   HttpOnly, origin-checked attempt cookie that binds later requests to the
   same browser.
2. The browser shows the code and polls `GET /auth/device` roughly every one
   to two seconds. The server polls GitHub independently, honoring GitHub's
   advertised interval and any `slow_down` increase, so approval from another
   device or browser still completes the attempt.
3. Once GitHub reports the grant, the browser calls
   `POST /auth/device/complete`, which validates the authorized identity and
   admission, then attempts credential persistence.
4. If persistence needs plaintext consent, `complete` (or the next `GET`)
   reports `{status: "consent", path}`, the exact local file path. The browser
   shows the plaintext-storage warning; `POST /auth/device/consent {accept}`
   either finishes sign-in or cancels it. Declining or dismissing this prompt
   discards the pending credential and cancels the attempt without creating a
   session; it does not fall back to an in-memory-only login.
5. `POST /auth/device/cancel` cancels an attempt at any point and discards any
   pending credential.

Device routes do not return `401`, which the browser client treats as an
invalid session and reloads. A missing attempt cookie reports `cancelled`;
state-changing requests with a mismatched Origin return `403`.

**Credential persistence** prefers the operating system's credential store
(macOS Keychain, Windows Credential Manager, or a Linux secret service such as
gnome-keyring, through `Bun.secrets`). That attempt is bounded to five
seconds so an unavailable or locked store cannot hang sign-in; a store call
that is still in flight when the bound expires is left running and its
eventual result is discarded (a late success is deleted, not kept) so it can
never resurrect a declined or superseded attempt.

When the store is missing, inaccessible, disabled, or times out, Chopin keeps
the credential in memory and asks for plaintext consent instead of writing
anything, using this exact warning and choice text:

```text
System vault not available

The recommended secure storage (keychain, keyring, or credential manager) could not be found or accessed. You may need to install or configure one.

Storing the token in the config file saves it as plain text, which is insecure. If you decline, sign-in will be cancelled and no account state will be changed.

Store token in plain text config file?

Yes, store in plain text (insecure)
No, cancel sign-in
```

Accepting writes the credential to a JSON file under the directory named by
`CHOPIN_LOCAL_CREDENTIALS_DIR` (default `$XDG_CONFIG_HOME/chopin`, or
`~/.config/chopin` on Linux, `~/Library/Application Support/Chopin` on macOS,
`%APPDATA%\Chopin` on Windows), with a newly created directory at `0700` and
the credential file at `0600` on Unix, and an atomic write-then-rename so a
crash mid-write cannot leave a partially written file. These permissions
restrict which local account can read the file; they do not encrypt it or
make it equivalent to an OS credential store. Chopin never writes it inside
the repository or process working directory. Consent applies to this login
only: it is not a standing "prefer plaintext" preference for future accounts,
and a later secure-store failure during refresh never falls back to writing
plaintext silently.

**Restoring after a restart** uses a separate long-lived, HttpOnly,
browser-binding cookie set only on successful sign-in. On the next
`/api/session` call, Chopin loads the persisted credential for that binding,
checks the installation, origin, App client ID, and account against the
stored record, revalidates or refreshes the token, rechecks identity and
admission exactly as a fresh sign-in would, and issues a new ordinary session.
Startup still clears every process-local session and Planner ownership, so a
restored login does not reclaim Planner ownership or replay interrupted model
work; the returning browser only skips repeating the device-flow prompt.

**Logout** in local mode deletes the persisted credential from whichever
backend stored it and clears the session and binding cookies. Because
device-issued refresh tokens do not require the client secret, but revoking
the grant on GitHub's side does, local logout cannot revoke the GitHub
authorization itself; the user must remove it from **Settings > Applications**
on GitHub to fully revoke access. A stale or delayed store write after logout
cannot revive the login, because logout also invalidates the browser binding
it depended on.

Each browser has its own binding; configured instance admission lists still
apply to every authorized account. Loopback binding does not make this a mode
for internet-facing or exposed multi-user deployments.

## Instance admission

`GITHUB_ALLOWED_USERS` and `GITHUB_ALLOWED_ORGANIZATIONS` are optional,
comma-separated, case-insensitive GitHub login lists. If both are empty or
unset, every verified GitHub user is admitted. If either has entries, a user is
admitted when their current username is listed or they have active membership
in any listed organization. Explicit usernames therefore also provide a
break-glass path when organization verification is unavailable.

Organization checks use the caller's token with
`GET /user/memberships/orgs/{org}`, which sees private membership when the App
has Members read access. Pending invitations and outside collaborators are not
admitted, nor are billing managers who are not organization members.
Public-membership lookup is not used. Organization admission does not restrict
repository ownership. Browser and hosted authorization retain separate App
installation and repository role checks; local MCP checks the supplied token's
repository role directly.

Admission results are cached by a hash of the access token for 30 seconds.
Browser requests, open-socket authorization, MCP requests, and Planner
permission callbacks recheck the policy. A definitive removal revokes the
process-local browser session and Planner ownership at the next browser or
socket recheck; a Planner permission callback refuses the operation immediately. GitHub outages,
rate limits, malformed responses, blocked Apps, and missing permission fail
closed for new requests but do not revoke an established browser session; they
are reported as a temporary `503` and retried later.

Configuration is read at process startup. Restart after changing either list;
startup already clears every process-local login session. GitHub usernames and
organization names can be renamed, so update the lists when that happens.

## Authorization and installation

Authorization and installation are separate GitHub App operations. A user may
authorize the App without installing it. After sign-in, Chopin lists only the
personal and organization installations that user can access and only the
repositories selected for each installation. The repository picker links to
the App installation page when access has not been installed or needs updating.

The picker loads every repository page in the background and keeps a validated
snapshot for the lifetime of the browser tab. Stale snapshots are revalidated
page by page with GitHub ETags when search begins. The snapshot is scoped to the
GitHub user and cleared on logout, account changes, and the installation setup
callback. Listing responses remain `no-store`; the server forwards conditional
requests but does not retain picker repository data.

Local MCP is an intentional exception to this installation boundary. Its bearer
token is authenticated independently and authorized with a direct repository
lookup. An MCP-created document for a repository outside the App installation is
not available through browser routes, WebSockets, or the hosted agent until
the installation includes that repository. See [Local agent MCP](local-agent-mcp.md).

The authorization-code flow uses state, S256 PKCE, the exact configured
callback, and the App client secret. It does not request OAuth scopes;
permissions come from the App registration and each installation. The setup
callback ignores GitHub's untrusted `installation_id` query parameter, clears
the browser's installation snapshot, and redirects into the product. The next
picker or authorization request re-queries GitHub with the signed-in user's
token.

When a signed-out browser opens a document deep link, the sign-in request sends
the current path, query, and fragment as `return_to`. Chopin accepts only one
validated root-relative product path, stores it inside the encrypted OAuth
attempt cookie, and redirects there after a successful callback. Absolute and
protocol-relative URLs, control characters, backslashes, and API, auth,
WebSocket, or MCP paths fall back to `/`; a callback query cannot override the
stored value. GitHub App installation setup remains separate: its callback still
ignores return paths and redirects to `/?repository_access=changed`.

Organization members may need an owner to approve installation or new
permissions. For an organization using SAML SSO, establish an active SAML
session before authorizing. If organization repositories remain absent, revoke
the App under **Authorized GitHub Apps** and authorize it again while that SAML
session is active.

Webhooks are intentionally disabled for self-hosted deployments. Installation,
repository-selection, and revocation changes are observed through request-time
checks with a cache no longer than the one-minute open-socket recheck interval.

Environment-specific callback and proxy configuration is documented in
[Remote development](exe-dev.md).

## Session boundary

The browser receives an HttpOnly, SameSite=Lax cookie containing a random
session ID and a 256-bit secret. The serving process keeps the secret hash,
GitHub access and refresh tokens, expirations, user, and credential revision in
memory. PostgreSQL receives only the session ID, user ID, expiry, and creation
time so durable Planner ownership can reference an active process session. A
database row or session ID cannot authenticate a request without the in-memory
secret hash.

GitHub App user access tokens expire after eight hours. Chopin refreshes five
minutes early, rotates the one-use refresh token, and atomically replaces the
process-local credential object. Concurrent requests share one refresh. Logout
removes the memory entry before any asynchronous cleanup, so a racing refresh
cannot resurrect a session.

A rejected refresh token or a second API `401` deletes the matching local
session. Network failures, rate limits, malformed responses, and GitHub `5xx`
responses do not delete it. A transient proactive refresh may continue using
the still-valid access token; after access expiry it reports a temporary error
and retains the session for retry.

Sessions expire absolutely after 30 days or whenever the server process stops.
In local mode, the session created after a restart is a new session bound to
the restored device-flow credential, not the same session ID; see
[Local device-flow sign-in](#local-device-flow-sign-in) for the restore path.
After acquiring the database writer lease, every new process clears session
registry rows and Planner ownership before accepting traffic. Documents,
transcripts, reserved Planner context fields, and repository installations
remain durable. Logout deletes the process-local session and registry row but
does not revoke the GitHub App authorization.

OAuth state, the PKCE verifier, and the validated browser return path are held in
a separate encrypted, ten-minute HttpOnly cookie. Browser state-changing routes
and WebSocket upgrades require an Origin header exactly equal to `APP_ORIGIN`.
The bearer-authenticated MCP route accepts a missing Origin, as non-browser
clients normally omit it, but rejects a present mismatched Origin. Open sockets
periodically recheck the process-local session, instance admission, and
installation repository permission. On restart, a returning local browser
restores a new session on `/api/session`; hosted browsers return to sign-in.

When a credential rotates, any Planner SDK session holding the previous token
is aborted and discarded before refresh. A later turn recreates it from the
durable transcript and document. An interrupted turn is not replayed
automatically because it may already have made durable tool changes.

## Browser HTTP API

```text
GET  /auth/github
GET  /auth/github/callback
GET  /auth/github/install
GET  /auth/github/setup
GET  /api/session
GET  /api/github/installations?page=1
GET  /api/github/installations/:installationId/repositories?page=1
GET  /api/repositories/:owner/:repository/channels
POST /api/repositories/:owner/:repository/channels
GET  /api/repositories/:owner/:repository/documents/:slug
GET  /api/channels/:channelId
PATCH /api/channels/:channelId
POST /api/channels/:channelId/agent/reset
POST /auth/logout
```

Local mode (`AUTH_MODE=local`) additionally registers these routes. It disables
the authorization-code flow, so `/auth/github` and `/auth/github/callback`
return `404`; `/auth/github/install` and `/auth/github/setup` keep working:

```text
POST /auth/device
GET  /auth/device
POST /auth/device/complete
POST /auth/device/consent
POST /auth/device/cancel
```

The repository-scoped document endpoint backs readable browser URLs. Existing
UUID routes remain internal API and collaboration entry points.

API and authentication paths are owned by the server in development and
production.

Live collaboration is multiplexed over `/ws`. External coding agents use the
separate Streamable HTTP endpoint at `/mcp`; unlike the browser API, its
caller-supplied bearer is independent of the GitHub App installation and can
perform write-authorized document and implementation lifecycle operations.
