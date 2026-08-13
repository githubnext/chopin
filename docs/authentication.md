# Authentication

Authentication covers both the HTTP channel product and its WebSocket.
The upgrade requires the session cookie, exact application origin, a stored
channel, and current repository access. The verified GitHub login supplies the
presence and attribution handle.

## GitHub OAuth

Create a GitHub OAuth App with this callback:

```text
<APP_ORIGIN>/auth/github/callback
```

Configure Chopin with:

```text
STORAGE_DRIVER=postgres
DATABASE_URL=postgresql://chopin:chopin@database:5432/chopin
APP_ORIGIN=https://chopin.example
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
SESSION_ENCRYPTION_KEY=<64 hex characters>
```

Generate the encryption key with `openssl rand -hex 32`.

`APP_ORIGIN` must be exactly one HTTP(S) origin: no credentials, path, query,
fragment, or trailing slash. HTTPS is required except for loopback development,
such as `http://127.0.0.1:8787`. OAuth callbacks are built only from this value,
never from incoming Host or forwarded headers.

The OAuth App currently requests `read:user repo`. The `repo` scope is broad,
but it is required to discover private repositories with an OAuth App. Chopin
does not write repository content. The token lists and authorizes repositories,
authenticates the owning user's Copilot session, supplies its read-only
pull-request MCP bearer, and backs repository-bound file, tree, search, and
history tools.

## Session boundary

The browser receives an HttpOnly, SameSite=Lax cookie containing a random
session id and a 256-bit secret. Storage receives only SHA-256 of that secret.
The GitHub access token is encrypted with AES-256-GCM and additional data tying
it to the session and user before the adapter sees it.

Sessions expire absolutely after 30 days. Logout deletes the encrypted record;
it does not revoke the OAuth grant at GitHub. Expired records are deleted by the
server's storage cleanup loop.

OAuth state and the PKCE verifier are held in a separate encrypted, ten-minute
HttpOnly cookie. Callback URLs are derived only from `APP_ORIGIN`, never from an
incoming Host header.

State-changing HTTP routes and WebSocket upgrades require an Origin
header exactly equal to `APP_ORIGIN`. Open sockets periodically recheck
the stored session and repository permission; logout aborts an active agent
owned by that session.

## API

```text
GET  /auth/github
GET  /auth/github/callback
GET  /api/session
GET  /api/repositories?page=1
GET  /api/repositories/:owner/:repository/channels
POST /api/repositories/:owner/:repository/channels
GET  /api/channels/:channelId
POST /api/channels/:channelId/agent/reset
POST /auth/logout
```

API and authentication paths are owned by the server in development and
production.
