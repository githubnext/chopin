# Authentication

Authentication covers the HTTP product, WebSocket admission, repository tools,
and Copilot. A verified GitHub user supplies presence and attribution. The
GitHub App installation limits which repositories Chopin can see, and the
user's own repository role limits what they can do inside Chopin.

## GitHub App

Create one GitHub App for each deployment. Use these registration settings:

```text
Homepage URL: <APP_ORIGIN>
Callback URL: <APP_ORIGIN>/auth/github/callback
Setup URL:    <APP_ORIGIN>/auth/github/setup
```

- Leave **Expire user authorization tokens** enabled.
- Leave **Request user authorization (OAuth) during installation** disabled.
- Leave device flow disabled.
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
`AGENT=off` deployment only needs Contents and automatic Metadata access.

No App id, private key, JWT, installation access token, or webhook secret is
used. Chopin acts on behalf of each signed-in user with a GitHub App user access
token so repository-role checks and the user's Copilot entitlement remain
theirs.

This is a clean cutover from the former OAuth App integration. No browser
verifier or GitHub credential is part of the PostgreSQL schema; replace the
environment variables, sign in again, and revoke the old OAuth App after
validating the new App.

Configure Chopin with the App's slug and OAuth client credentials:

```text
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://chopin:chopin@database:5432/chopin
APP_ORIGIN=https://chopin.example
GITHUB_APP_SLUG=chopin-example
GITHUB_APP_CLIENT_ID=...
GITHUB_APP_CLIENT_SECRET=...
SESSION_ENCRYPTION_KEY=<64 hex characters>
```

The client id is distinct from the numeric App id. Generate the encryption key
with `openssl rand -hex 32`; it protects only the OAuth state and PKCE cookie.

`APP_ORIGIN` must be exactly one HTTP(S) origin: no credentials, path, query,
fragment, or trailing slash. HTTPS is required except for loopback development,
such as `http://127.0.0.1:8787`. Callback URLs are built only from this value,
never from incoming Host or forwarded headers.

## Authorization and installation

Authorization and installation are separate GitHub App operations. A user may
authorize the App without installing it. After sign-in, Chopin lists only the
personal and organization installations that user can access and only the
repositories selected for each installation. The repository picker links to
the App installation page when access has not been installed or needs updating.

The authorization-code flow uses state, S256 PKCE, the exact configured callback,
and the App client secret. It does not request OAuth scopes; permissions come
from the App registration and each installation. The setup callback ignores
GitHub's untrusted `installation_id` query parameter and re-queries GitHub with
the signed-in user's token.

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
session id and a 256-bit secret. The serving process keeps the secret hash,
GitHub access and refresh tokens, expirations, user, and credential revision in
memory. PostgreSQL receives only the session id, user id, expiry, and creation
time so durable Planner ownership can reference an active process session. A
database row or session id cannot authenticate a request without the in-memory
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
After acquiring the database writer lease, every new process clears session
registry rows and Planner ownership before accepting traffic. Plans,
transcripts, summaries, and repository installations remain durable. Logout
deletes the process-local session and registry row but does not revoke the
GitHub App authorization.

OAuth state and the PKCE verifier are held in a separate encrypted, ten-minute
HttpOnly cookie. State-changing HTTP routes and WebSocket upgrades require an
Origin header exactly equal to `APP_ORIGIN`. Open sockets periodically recheck
the process-local session and installation repository permission. A browser
whose socket reconnects after a restart is returned to sign-in.

When a credential rotates, any Planner SDK session holding the previous token
is aborted and discarded before refresh. A later turn recreates it from the
durable transcript and plan. An interrupted turn is not replayed automatically
because it may already have made durable tool changes.

## API

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
GET  /api/channels/:channelId
POST /api/channels/:channelId/agent/reset
POST /auth/logout
```

API and authentication paths are owned by the server in development and
production.
