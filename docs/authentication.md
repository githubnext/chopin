# Hosted authentication

Hosted authentication is an HTTP boundary in front of the channel product. It
does not yet replace the claimed handle on the prototype `/r/*` WebSocket; that
happens when channels become authenticated resources.

## GitHub OAuth

Create a GitHub OAuth App with this callback:

```text
<APP_ORIGIN>/auth/github/callback
```

Configure Chopin with:

```text
AUTH_DRIVER=github
APP_ORIGIN=https://chopin.example
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
SESSION_ENCRYPTION_KEY=<64 hex characters>
```

Generate the encryption key with `openssl rand -hex 32`. Authentication requires
a durable storage adapter; it cannot run with `STORAGE_DRIVER=legacy`.

The OAuth App currently requests `read:user repo`. The `repo` scope is broad,
but it is required to discover private repositories with an OAuth App. Chopin
does not use it to write repository content.

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

## API

```text
GET  /auth/github
GET  /auth/github/callback
GET  /api/session
GET  /api/repositories?page=1
GET  /api/repositories/:owner/:repository/channels
POST /api/repositories/:owner/:repository/channels
GET  /api/channels/:channelId
POST /auth/logout
```

API and authentication paths are owned by the server in development and
production. Unknown paths return 404 and never fall through to Vite or the SPA.
