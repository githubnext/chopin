# Agent connection

The agent connection is the WebSocket that lets an agent running outside a
Chopin server act as a document's Planner. Chopin uses it when it runs
`HARNESS=remote`: the server keeps the document and its tools, and the client
runs the model.

This page is enough to write a client. It covers the endpoint, the handshake,
every message, the limits, and how a connection ends.
[Hosted agent](hosted-agent.md#remote-planner) says what the server does with
a connection, and [Self-hosting](self-hosting.md#the-remote-planner) how to
deploy it.

`@chopin/agent-link` (`packages/agent-link`) holds the server's schemas. Its
client, `@chopin/agent-link/client`, uses nothing at runtime but this format,
JSON, and the platform `WebSocket`. The remote harness contract suite runs it in
Bun and as a separate Node.js process against a real socket.

## Endpoint and authentication

Open a WebSocket to `wss://<chopin origin>/api/v1/agent` (`ws:` only for a
loopback development server). It shares the application's origin and port with
`/ws` and `/mcp`, behind the same TLS-terminating proxy. The route exists only
when the server runs with `AGENT` on and `HARNESS=remote`. Otherwise every
request to it, upgrade or not, gets HTTP 404 before anything else is checked.

The upgrade request needs two headers:

- `Sec-WebSocket-Protocol` must offer `chopin.agent.v1`, the
  [subprotocol](https://www.rfc-editor.org/rfc/rfc6455#section-1.9) this page
  describes. It may offer others too. The server always answers with
  `chopin.agent.v1`.
- `Authorization: Bearer <GitHub token>`, the same bearer
  [local agent MCP](local-agent-mcp.md) uses.

It may also send `Chopin-Agent-Features`, naming optional [features](#features)
it wants.

```http
GET /api/v1/agent HTTP/1.1
Host: chopin.example
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Protocol: chopin.agent.v1
Authorization: Bearer <token>

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
Sec-WebSocket-Protocol: chopin.agent.v1
```

Bun's and Node.js's built-in `WebSocket` take both as options:
`new WebSocket(url, { protocols: ["chopin.agent.v1"], headers })` (checked on
Node.js 24). Browsers cannot send the bearer. A client should not send an
`Origin` header. If it does, it must be the server's own origin.

The bearer may instead be a paired machine's Planner credential (see
[Planner backend commands](#planner-backend-commands)): `chopin_p_` followed by
43 base64url characters. It attaches only the document it was issued for, and
the account it attaches as is the machine's owner.

The server checks the request before upgrading and refuses over HTTP, so
nothing opens. It checks in this order:

| Status | Meaning                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 404    | The server does not run `HARNESS=remote` with `AGENT` on                                                                       |
| 426    | The request does not offer `chopin.agent.v1`                                                                                   |
| 403    | A foreign `Origin`                                                                                                             |
| 401    | Missing or malformed bearer, GitHub rejected the token, or an unknown or expired Planner credential, or its machine is revoked |
| 403    | The account fails instance admission                                                                                           |
| 503    | GitHub is unavailable or rate limiting; retry later                                                                            |
| 500    | Any other admission failure                                                                                                    |

A 426 has a JSON body naming the subprotocols the server speaks:

```json
{ "code": "subprotocol-required", "supported": ["chopin.agent.v1"] }
```

### Versions

The subprotocol is the version. A breaking change to the messages gets a new
subprotocol, `chopin.agent.v2`, instead of changing `chopin.agent.v1`, and a
server lists every subprotocol it speaks in `supported`. A client offers the
ones it speaks.

The `version` in [`attach`](#handshake) is the same number: `1` for
`chopin.agent.v1`.

### Features

An additive change a client must know the server accepts is an optional
feature instead of a new version. The client names the features it wants,
comma-separated, in the upgrade request's `Chopin-Agent-Features` header:

```http
Chopin-Agent-Features: run-stage-deltas, decision-option-previews
```

The server ignores names it does not know. When the request has the header,
`attached` carries `features`: the requested features this server supports,
possibly none. Without the header `attached` has no `features`, so a client
that validates `attached` strictly and never asks never sees the field. A server
from before features ignores the header and answers without `features`; a
client must then use none of them.

| Feature                    | What it allows                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-stage-deltas`         | [Delta run cards](#run-stage-deltas), with no stage count limit                                                                                                               |
| `decision-option-previews` | An option's [`preview`](#option-previews) as its own visual, and the `upload_plan_image` host tool                                                                            |
| `resumable-sessions`       | [Resuming](#resuming-after-a-dropped-link) the sessions, runs and questions of a link that dropped unexpectedly                                                               |
| `restart-notice`           | A [`restarting`](#server-to-client) message before the server closes the link with 1012, and the [client rule](#when-the-server-is-restarting) that follows it                |
| `capability-catalog`       | A [`capabilities`](#capability-catalog) report of the models, thinking levels and commands the client offers, and a person's choice of model and thinking level in the `turn` |
| `attachments`              | The images and text files a person sent with a message, in the `turn`'s [`attachments`](#images-and-files-in-a-turn)                                                          |

### Pings

The server sends the connection a WebSocket ping control frame (RFC 6455) every
**15 seconds** from the moment it opens. The client must answer each with a
pong. Standard clients do this on their own, including Bun's and Node.js's
built-in `WebSocket` and the `ws` package; pings are control frames, not
messages, and carry no JSON. Any frame from the client, a pong or a message,
shows the connection is alive.

A client that is slow to read leaves the server's frames to it queued. While
anything is queued the server sends no ping, since a ping can be dropped from a
full queue. A queue getting shorter puts off the close by another timeout, but
it does not count as hearing from the client: the kernel's buffers or a proxy in
front of the client can drain it while the client reads nothing. A client that
has stopped reading entirely keeps a queue that never shrinks, and counts as
silent.

A connection the server hears nothing from for **120 seconds** is treated as dropped,
such as one whose network silently went away. However much of its queue drains
meanwhile, a connection that sends nothing at all, not even a pong, for **15
minutes** is dropped too. The server closes it with 1001 and reason
`unresponsive`, without an `error` or `refused` message, and releases it exactly
as any dropped connection (see [Closing](#closing)): a `resumable-sessions` link
keeps its work, and its account keeps the document's Planner, as
[Resuming](#resuming-after-a-dropped-link) and [Ownership](#ownership) describe. The operator sets the
interval, the timeout and the longest silence with `AGENT_CONNECTION_PING_MS`,
`AGENT_CONNECTION_TIMEOUT_MS` and `AGENT_CONNECTION_MAX_SILENCE_MS`.

So a client working through a large backlog must still send something within
the longest silence. A client that answers pings needs nothing more: once it has
read the queue to the end, the server pings it again and its pong counts. The
server may queue up to about **16 MiB** for a client, so the longest silence is
a trade-off:

- A client that reads at about **19 KiB/s** or faster can always drain a full
  16 MiB queue and answer the next ping within the default 15 minutes.
- A client that has stopped reading behind a proxy that keeps accepting bytes is
  released after 15 minutes at the latest, and usually much sooner: once the
  proxy's and the kernel's buffers fill, the queue stops shrinking and the
  120-second timeout applies.
- An operator can lower `AGENT_CONNECTION_MAX_SILENCE_MS` to release such a client
  sooner, at the cost of closing slower readers, or raise it, up to an hour, for
  slower connections.

The server cannot see a frame until it has arrived whole, and a client's pongs
wait behind a frame it is still sending. So every frame must arrive within the
timeout of the last frame heard before it. With the defaults, a 2 MiB frame
needs a sustained client upload of about **17 KiB/s** (2 MiB in 120 seconds),
or about 20 KiB/s if it starts just before a ping is due (2 MiB in the 105
seconds left). A client on a slower uplink is closed as unresponsive while it
uploads its largest frames; raise `AGENT_CONNECTION_TIMEOUT_MS` for it.

## Frames

Every message is one JSON object in one text frame, with a string `type`. A
frame may hold at most **2 MiB** (2,097,152 bytes) of UTF-8. Objects are strict:
a field this page does not list is refused, except inside a
[capability catalog](#capability-catalog), which is read as written. Binary frames are refused.

Shared limits, in characters unless stated:

| Kind  | Fields                                                                                                                                                                                        | Limit      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| id    | `session`, `turn`, `request`, `toolCallId`, part `id`, run and stage `id`, `run`, `workflowRunId`, `workflowStageId`, `rootRunId`, `active` and `paused` entries, `document.id` in `attached` | 1 to 128   |
| name  | tool names, `toolName`, `names` entries, `responseFormat.name`                                                                                                                                | 1 to 128   |
| short | question `header`, `finishReason.raw`                                                                                                                                                         | up to 128  |
| note  | `message`, every `title`, `error`, `responseFormat.description`, question text, option `label` and `description`, `choices` entries, `placeholder`, `initial`, run and stage `name`           | up to 4000 |
| text  | `prompt`, `instructions`, `delta`, `input`, and the model and level fields of the [capability catalog](#capability-catalog): `modelId`, `turn.model`, `turn.thinkingLevel`                    | the frame  |

Other fields state their own limits where they appear.

`?` marks an optional field. `json` is any JSON value.

## Handshake

The client's first message must be `attach`, and it must send nothing else
until the server answers with `attached` or `refused`.

```text
{ "type": "attach", "version": 1, "document": "<document id or URL>", "checkout?": { "origin?": "", "branch?": "", "head?": "" } }
```

- `version` is the protocol version the client speaks; this page is version `1`.
- `document` is a document id or its Chopin URL, at most 2048 characters.
- `checkout` describes the client's working tree: `origin` (up to 2048), `branch`
  (up to 256), `head` (up to 128). It is informational; the server does not
  verify it.

The server answers:

```text
{ "type": "attached", "version": 1, "document": { "id": "", "title": "", "repository": "owner/name", "url?": "" }, "features?": [] }
{ "type": "refused", "code": "<refusal code>", "message": "" }
```

`attached.document.repository` is `owner/name`, at most 257 characters, and
`url` at most 2048. `features`, present only when the client
[asked for features](#features), lists at most 16 names, each an ASCII letter or
digit then up to 127 letters, digits, `.`, `_` or `-`. After `refused` the server closes the connection.

### Ownership

Attaching makes the client the document's Planner and its account the
document's Planner owner. `attach` succeeds when all of these hold:

- The bearer's GitHub account has push or administration access to the
  document's repository. Pull access alone is refused with
  `repository-forbidden`.
- The same account is signed in to Chopin in a browser, on this server, since
  the server last started. Chopin's repository tools run with that sign-in's
  GitHub App token, never with the connection's bearer. Without one, `attach` is
  refused with `sign-in-required`; sign in at the server's origin and attach
  again.
- That sign-in also passes instance admission and has push or administration
  access to the repository.
- No other client holds the document's Planner (see below).

A client attached with a machine's Planner credential passes the same checks
with the machine's own GitHub authorization instead of a browser sign-in, so it
is never refused with `sign-in-required` and signing out of a browser does not
release it. Its credential must name the document it attaches; any other is
refused with `repository-forbidden`.

These are the checks every Planner owner passes. A document has one Planner at a
time. While a client is attached, any other `attach` for that document is
refused with `planner-attached`, and the `message` names the holder's GitHub login:

```text
octocat is connected to this document. A document has one agent connected at a time.
```

One exception serves a client that left a connection that died unnoticed. A client
that notices its network failed before Chopin does reconnects at once, while Chopin
still counts its old link as attached (up to the 120-second timeout in
[Pings](#pings), longer behind a buffering proxy). If both links belong to the same
account and offered `resumable-sessions`, Chopin answers the new `attach` with
`attached` but treats the new link as unconfirmed until its first message. A `resume`
naming a session the old link holds shows the client is the same one returning and
its old connection is gone: Chopin closes the old link as the unexpected drop it is,
keeps its work, and gives it to the new link, which then resumes as usual. Any other
first message, a `resume` naming nothing the old link holds, or another account, gets
`refused` with `planner-attached` after `attached`, and the old link is untouched. That
refusal is a decision, not a reason to retry. A document archived or deleted while the new
link waited for its first message is refused `document-archived`.
A browser-bearer client and a paired machine's backend never take each other's links.

When the connection closes by `detach`, or a socket drops with no
workflow run or open question for the server to keep, its account keeps
the ownership for a grace period, 2 minutes unless the operator sets
`PLANNER_ATTACH_GRACE_MS`. During it the same account can attach again and keeps
the ownership; another account is refused with `planner-attached`, and the
`message` says until when the holder keeps it:

```text
octocat disconnected from this document and keeps it until 2026-10-10T19:42:00.000Z unless they connect again. A document has one agent connected at a time.
```

When the grace period ends the ownership is released and any eligible account
can attach. The grace period is a lease on the ownership of a connection that is
no longer there, not a timeout on active work: it is 2 minutes by default and at
most one hour (`PLANNER_ATTACH_GRACE_MS` accepts 0 to 3600000), and it never runs
while a connection is attached.

A link that offered `resumable-sessions` and dropped unexpectedly while it held a
live or paused workflow run or an open question runs no grace period at all. Its
account keeps the ownership, as the document's **disconnected** Planner, for as long
as its work is kept: until its client [resumes](#resuming-after-a-dropped-link) or something
explicit ends it (see [What still ends it for good](#resuming-after-a-dropped-link)).
Another account is refused with `planner-attached` and a `message` that says the
holder's connection dropped and its work is kept until it reconnects:

```text
octocat is connected to this document, and its connection dropped. Its work is kept until it reconnects. A document has one agent connected at a time.
```

A server restart releases every attachment and ownership at once; reattach after
it. What a disconnected link kept does not survive that: see
[After a server restart](#after-a-server-restart).

The server checks the account's admission and push or administration access
again before every `start` and every `turn`, and every 5 minutes while the connection
is attached. Once either is lost, or the document is archived or deleted, it
sends `refused` with `access-revoked` and closes the connection with 4403; the turn
that triggered the check fails. A GitHub outage during a periodic check leaves
the connection open.

The ownership also ends, without a grace period, when the browser sign-in it
rests on ends or the document's Planner is reset. The server then sends
`refused` and closes an attached connection at once, and any eligible account,
including the same one, can attach again immediately:

| Cause                                                                                                                                                                                                                                                            | Refusal code       | Close code |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------- |
| The owner's browser sign-in signs out or expires                                                                                                                                                                                                                 | `sign-in-required` | 4401       |
| The machine whose credential attached it is disconnected, or GitHub refuses its authorization                                                                                                                                                                    | `access-revoked`   | 4403       |
| Chopin started it on a machine and moved it to another, or stopped it: a new machine choice or favorite, the document unused for 30 minutes (a Planner replying, or waiting on a question or a live or paused run, is using it), or the machine lost push access | `access-revoked`   | 4403       |
| A repository writer resets the document's Planner                                                                                                                                                                                                                | `access-revoked`   | 4403       |
| The stored ownership no longer names this attachment's sign-in                                                                                                                                                                                                   | `access-revoked`   | 4403       |

The same checks before every `start` and `turn`, and the periodic one, also
find an expired sign-in or a released ownership that nothing reported; an
expired sign-in is reported as `sign-in-required` even when the stored
ownership already reads as released. An `@chopin` message or `invoke_planner`
call makes the same check first, so a connection it finds stale is closed this way and
the request is refused as [without an attached Planner](#without-an-attached-planner).
An `attach` that is still in progress when one of these causes lands, including
a reattach within the grace period, is refused with the same code and close code
instead of attaching; a fresh attach whose sign-in ends while the server checks
it is refused with `sign-in-required` (4401). The `message` says what happened:

```text
The Chopin browser sign-in that connected octocat to this document ended, so the connection was released. Sign in to Chopin at https://chopin.example in a browser as octocat, then connect again.
A repository writer reset this document's connection, so octocat is no longer connected. Connect again to resume.
This document's connection was released, so octocat is no longer connected. Connect again to resume.
```

| Refusal code           | Close code | Meaning                                                                |
| ---------------------- | ---------- | ---------------------------------------------------------------------- |
| `unsupported-version`  | 4426       | The server speaks another `version`                                    |
| `repository-forbidden` | 4403       | The account cannot push to or administer the document's repository     |
| `sign-in-required`     | 4401       | The account has no live Chopin browser sign-in, or it ended            |
| `planner-attached`     | 4409       | Another client holds the document's Planner; `message` names its login |
| `document-unavailable` | 4404       | No document matches, or it is being deleted                            |
| `document-archived`    | 4404       | The document is archived                                               |
| `access-revoked`       | 4403       | Access or the Planner ownership was lost after attaching (see above)   |
| `unavailable`          | 1011       | The server could not check the document or the account; `retry` is set |

Every code is a decision about this account or document, final for a client that is
resuming, except `unavailable`: Chopin could not decide, so the refusal carries
`"retry": true`, and such a client keeps what it holds and tries again with the same
`resume` on its own backoff. No retry is promised to succeed. An HTTP 503 at the upgrade
(GitHub unavailable or rate limiting) is the same kind of refusal. A refusal without
`retry`, and an `error`, ends what the client held.

### Without an attached Planner

On a server running `HARNESS=remote`, an `@chopin` message in the browser and
an MCP `invoke_planner` call for a document with no attached client are never refused
for it: they are [saved](hosted-agent.md#saved-requests), appear in
Chat as sent, and start once a client attaches, in hosted mode and under `AUTH_MODE=local`
alike. A
document whose Planner is within its grace period, or disconnected with its work kept
(the message then says the machine is offline, that the work is kept and that it picks
up when the machine is back), counts as
unattached, and so
does one whose attached connection the request finds stale: its owner's browser
sign-in has ended or the stored ownership no longer names it. The request closes
that connection before it is refused.

When a paired machine is starting the document's Planner, the request first
waits up to 30 seconds for it to attach, and is refused only if it has not:

```text
Still connecting to @<login>'s machine. Try again in a moment.
```

Once the machine's backend has exited before attaching more than once in a row,
the refusal says why, from what its connector reported (see
[Hosted agent](hosted-agent.md#remote-planner)), and still only names the login:

```text
Can't connect to @<login>'s machine: <reason> (3 attempts in a row). It keeps trying; try again once that is fixed.
```

If no machine is starting one, the message says how to get one, in plain words:
a machine is needed. Where Chopin runs Planners on paired machines:

```text
Connect a machine to get a reply. Choose one with the machine button, or run `chopin connect` on a machine that can reply.
```

Elsewhere it names the document URL:

```text
Connect a machine to get a reply. Connect an agent client to <document URL> over the agent connection from a session in a checkout of <owner/name>.
```

A document whose Planner is disconnected is refused with the machine named by its
owner's login, never by its own name:

```text
@<login>'s machine is offline, so it can't reply now. Your work is kept and picks up when it's back.
```

[Local agent MCP](local-agent-mcp.md#hand-an-instruction-to-the-planner) shows
how `invoke_planner` returns it. Once a client is attached, both arrive as
`turn`s on its connection.

## Server to client

```text
{ "type": "start", "session": "", "mode": "planner" }
{ "type": "turn", "session": "", "turn": "", "prompt": "", "instructions?": "", "model?": "", "thinkingLevel?": "", "attachments?": [{ "id": "", "name": "", "kind": "image", "mediaType": "", "size": 0, "data": "" }], "tools": [], "responseFormat?": {} }
{ "type": "abort", "session": "", "turn": "" }
{ "type": "host-tool-result", "session": "", "turn": "", "toolCallId": "", "output": json, "isError?": true }
{ "type": "input-result", "request": "", "status": "answered", "value?": json, "message?": "" }
{ "type": "stop", "request": "", "session": "", "run?": "" }
{ "type": "resume", "request": "", "session": "", "run?": "" }
{ "type": "destroy", "session": "" }
{ "type": "restarting", "reconnectWithinMs": 0 }
{ "type": "error", "code": "malformed-message", "message": "" }
```

- `start` opens a Planner session. `mode` is `planner` for a Planner turn
  session or `isolated` for a background job's session, which may offer no
  tools of its own and gets no Decisions. Answer within **10 seconds**. A
  session refused with `start-failed` or not answered in time gets `destroy`,
  and any question asked for it meanwhile is withdrawn and answered
  `cancelled`.
- `turn` runs one turn. `tools` lists at most 256 of Chopin's host tools as
  `{ "name": "", "description?": "", "inputSchema?": {json schema} }`;
  `description` may be 64,000 characters. `instructions` is the Planner's
  system prompt for the turn. `model` is set when the operator configured
  `MODEL`, or, with `capability-catalog`, when a person chose a model from the
  [catalog](#capability-catalog) the client reported, which then replaces it.
  `thinkingLevel` is sent only with `capability-catalog`, and only when a person chose one.
  `attachments` is sent only with `attachments`, and only when the message that began the turn
  carried images or files (see [Images and files in a turn](#images-and-files-in-a-turn)).
  `responseFormat` is `{ "type": "text" }` or
  `{ "type": "json", "schema?": {}, "name?": "", "description?": "" }`; for
  `json`, the turn's text must be that JSON.
- `abort` stops the turn. Answer with `turn-end`; after **10 seconds** the
  server ends the turn anyway. The server sends no `host-tool-result` for the
  turn's calls after `abort`, so settle any call still waiting as failed.
- `host-tool-result` answers a `host-tool-call`. `output` is the tool's result
  as JSON. A failed call has `"isError": true` and `output`
  `{ "error": "<message>" }`; that includes a tool that threw, invalid input, a
  name outside the turn's `tools`, a call for a turn or session that has ended,
  and a result too large for one frame. A call Chopin's permission policy
  refuses has `output` `{ "type": "execution-denied", "reason?": "" }`.
- `input-result` answers an `input-request` (see [Questions](#questions)). With
  `resumable-sessions`, the client acknowledges every `input-result` it receives with
  `input-received` (see below).
- `stop` and `resume` are **Stop Planner** and **Resume Planner**: pause or
  resume every workflow run of the session, or only `run`. Answer with
  `control-result` within **10 seconds**; an answer that comes later is still an
  answer and clears the Stop on the server. A `stop` may arrive again for a run it
  already paused, because the server cannot tell an answer it never received from a
  `stop` the client never heard (see
  [Resuming](#resuming-after-a-dropped-link)). It pauses, so a repeat changes
  nothing; answer it `ok: true`. A client that answers `ok: false`, for a run that
  has since ended, only has the refusal logged for a `stop` sent again.
- `destroy` ends the session; abandon its turn, its waiting host calls, and its
  questions.
- `restarting`, with `restart-notice`, precedes a close with 1012 when the server is
  restarting. `reconnectWithinMs` is how long, in milliseconds, a new process is expected to
  take to take over; see [When the server is restarting](#when-the-server-is-restarting). A
  client that did not offer the feature never receives it.
- `error` precedes a close for a protocol violation (see [Closing](#closing)).

## Client to server

```text
{ "type": "started", "session": "" }
{ "type": "start-failed", "session": "", "message": "" }
{ "type": "tools", "session": "", "turn": "", "names": [] }
{ "type": "part", "session": "", "turn": "", "part": {} }
{ "type": "host-tool-call", "session": "", "turn": "", "toolCallId": "", "toolName": "", "input": "{}" }
{ "type": "turn-end", "session": "", "turn": "", "status": "finished", "message?": "" }
{ "type": "input-request", "request": "", "session": "", "workflowRunId?": "", "workflowStageId?": "", "rootRunId?": "", "block?": { "index": 0, "digest": "sha256:<64 hex>" }, "input": {} }
{ "type": "input-cancel", "request": "" }
{ "type": "runs", "session": "", "active": [], "paused": [], "cards": [] }
{ "type": "control-result", "request": "", "ok": true, "message?": "" }
{ "type": "detach" }
{ "type": "resume", "sessions": [{ "session": "", "requests": [""] }] }
{ "type": "input-received", "request": "" }
{ "type": "capabilities", "catalog": {} }
```

`resume` and `input-received` belong to the `resumable-sessions` feature and are defined in
[Resuming after a dropped link](#resuming-after-a-dropped-link) and below. `capabilities` belongs to
`capability-catalog` and is defined in [Capability catalog](#capability-catalog).

- `started` or `start-failed` answers `start`. Cut `message` here, in
  `turn-end`, `control-result`, and an `error` part to 4000 characters: a longer
  one is a malformed message and closes the connection.
- `tools` declares, before calling any of them, the client's own tools this turn
  may call (at most 256). A name may not repeat a host tool's name. An isolated
  session must declare none.
- `part` streams the turn (see [Stream parts](#stream-parts)).
- `host-tool-call` runs one of the turn's host tools in the server; `input` is
  its arguments as a JSON string. A `toolCallId` may be used once per turn,
  whether by a `host-tool-call` or a `tool-call` part, including after its call
  has finished or was answered with an error result; reusing one fails the turn
  without running the tool again. A name outside the turn's `tools` is answered
  with an error result.
- `turn-end` ends the turn: `finished`, `failed` (with `message` as the error
  shown), or `aborted`. Every turn needs exactly one. A host tool still running
  in the server when the turn ends is stopped, and a Decision it opened is
  withdrawn.
- `input-received`, with `resumable-sessions`, is `{ "type": "input-received", "request": "" }`:
  the client has the `input-result` for `request` and settled its question. Send it on
  receiving every `input-result`, including a repeated one for a question already settled,
  and nothing else is needed for it to be idempotent: a client ignores an `input-result`
  for a request it already settled, but still acknowledges it. Until it arrives, the server
  keeps the result, and the session that waits to deliver it, because a result written into
  a socket that died unnoticed reaches nobody. If the link drops first, the server keeps
  the result for the client's return and sends it again after `resumed` when `resume`
  still names the request; a request `resume` no longer names was settled, so the result is
  let go. Nothing but the acknowledgement releases it: no timer does, and neither does
  anything else the client sends or answers meanwhile, since such a frame can have crossed
  the result on the wire. A client with the feature that never acknowledges breaks it, and
  its session simply stays retained while the link is attached, as any session waiting on
  its client does, and moves to the outbox when the link closes.
  A client without the feature never sends it, and one that sends it anyway is a
  `protocol` violation.
- `input-request` and `input-cancel` ask and withdraw questions. A `request` id
  may not repeat on the connection, even after its question has its `input-result`.
  The server remembers every open id and the last 1,024 ids it received; a
  remembered id sent again is a `protocol` violation that closes the connection. Use
  fresh ids, such as UUIDs.
- `runs` reports the session's workflow runs whenever they change. Report them
  before `turn-end` so the server keeps the session while runs are live. Reports
  only change run cards and Chat notices; they never start a Planner turn. To
  have the Planner act on a run that ended, call `invoke_planner` with
  `as: "system"` and a GitHub token of the account holding the Planner; see
  [Automatic follow-ups](local-agent-mcp.md#automatic-follow-ups).
- `control-result` answers `stop` or `resume`.
- `detach` closes the connection with code 1000. The account keeps the document's
  Planner for the grace period in [Ownership](#ownership). It ends everything the
  link held, even with `resumable-sessions`: only a link that drops without it keeps
  anything.
- `resume`, with `resumable-sessions`, is the first message after `attached`: the
  sessions the client still holds from a dropped link (see
  [Resuming](#resuming-after-a-dropped-link)).

Messages for a session or turn that has ended are ignored, except a
`host-tool-call`, which gets an error result (`The turn has ended.` or
`The session has ended.`).

### Capability catalog

With `capability-catalog`, a client tells Chopin what it offers in one message, so that a
document's composer can let a person choose what the client runs. The catalog is one value that
grows by adding fields; adding a kind of capability later needs no new message and no new feature.
Commands already fit it, as listed below. Chopin reads a catalog as it was written. Nothing says
how a model, a thinking level or a command is spelled or how long its text runs, so Chopin refuses
no string for its spelling or its length (a level may be `extra high` or `低`, an `id` any length,
a `name` or `kind` empty) and never changes one. A field it has no use for is ignored and kept,
never refused, and no count bounds the models or commands a client lists. Only the frame's size
bounds a catalog, and only a value of the wrong type (a number where a string is listed, a
string where an array is) breaks a rule here. An odd entry never closes the link.

The one thing Chopin leaves out is what nobody could be asked for. A model whose `id` is empty is
malformed, because a turn names a model by its `id`: Chopin skips that entry, keeps every other
model and the link, and logs it. An empty string among a model's `thinkingLevels` is dropped from
that model's levels in the same way (a model left with none has no reasoning control), and so is a
`models.default` with an empty `id`, or an empty `thinkingLevel` of the default. An empty model or
level can therefore never be chosen, and a turn never carries one.

```text
{ "type": "capabilities", "catalog": {
    "models?": {
      "available": [{
        "id": "", "name": "",
        "provider?": { "id": "", "name?": "" },
        "description?": "",
        "thinkingLevels?": [""],
        "inputTypes?": [""]
      }],
      "default?": { "id": "", "thinkingLevel?": "" }
    },
    "commands?": [{ "name": "", "description?": "", "kind": "" }]
} }
```

- **When.** Send it right after `attached`, and after the `resume` of a resumable link, which stays
  the first message. Send it again whenever the client's offer changes, for example after the
  person signs in to another provider. Each report replaces the earlier one whole: a field left out
  is no longer offered, and `{ "catalog": {} }` withdraws everything. A client that offered the
  feature and does not report offers no choice, the same as a client from before the feature. Sending
  `capabilities` without having offered the feature is a `protocol` violation, and a catalog whose fields have the
  wrong type (listed below), a `malformed-message` one. The catalog is held with the link, not stored: after a
  server restart a resumed client sends it again.
- **`models.available`** lists the models in the order to show them within a provider, as many as the
  frame holds (Atomic's own list runs past 1,700).
  `id` is the exact string the client wants back as a turn's `model`; Chopin never parses, bounds
  or normalizes it, and skips an entry whose `id` is empty. `name` is what a person reads. `provider` groups models in the picker: `id`
  groups, `name` (default: `id`) labels the group, and a model with no `provider` is listed without a
  group. `description` is one line of text. Chopin shows names and descriptions as text, never as
  Markdown. A model listed twice stays listed twice, in the order given; a choice of its `id` is
  the first entry's.
- **`thinkingLevels`** are the levels of reasoning this model supports, as strings in the order to
  show them. Atomic's are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`; other clients
  may define their own, spelled as they like. Chopin shows
  every level exactly as written, Atomic's own included (`xhigh`, not Extra high), its case
  unchanged, so that `xhigh` and `extra high`, `ß-fast` and `SS-fast`, and `high` and `High` are
  each two levels a person can tell apart, and the turn carries the string they saw. The composer's own first step, which returns the level to the model's own, is called Default, or Model default where the model lists a level of that name, so no level shares its label. A model with none or an empty list has no reasoning control, and the composer
  hides it. An empty string is not a level: it is dropped. Chopin sends back only a level the model
  listed.
- **`inputTypes`** is what the model reads: `text`, and `image` where it reads images, as strings
  the client defines (Atomic's own `input` list is sent as it is). Chopin sends a turn an image only
  when the model the turn names (or the default model, when it names none) lists `image` here, and
  the composer offers a person an image for a Planner message only then. A model with no
  `inputTypes`, an empty list, or no catalog at all reads as text only, so a client from before the
  field is never sent an image. A text file does not depend on it.
- **`models.default`** is what the client runs when a turn names no model or no level. Its `id`
  should be one of `available`; the composer shows that model as the document's current one until
  somebody chooses another. An operator's `MODEL` takes its place when it is set. A default with an
  empty `id` is ignored, and an empty `thinkingLevel` is dropped from it.
- **`commands`** is reserved for the commands a client offers, such as skills,
  prompt templates and workflows: `name`, `description` and `kind`, a string the client defines
  (`skill`, `prompt`, `workflow`). Chopin keeps them with the catalog, as written (order, spelling,
  repeated entries and a missing `description` included), and tells the room's composers what the
  attached client holds in the `commands` of `chat:model`. They are the attached client's alone:
  nothing a client reported is offered once it has left, and another machine's are never sent to
  this document. Send them only when they are real: a client that has none omits the field, and
  its composer then offers Chopin's own commands only. A person's message that runs one reaches
  the client as the `prompt` of an ordinary `turn`: `/name args` for a `skill`, a `prompt` or any
  kind other than `workflow`, as the client reported the name, and a request to start the
  workflow of that name, with the words after it as its input, for a `workflow`. Chopin checks the
  name and kind against the last report when the message is sent and refuses an unknown one.

A person's choice reaches the client in the next turn: `model` is the chosen model's `id`, and
`thinkingLevel` one of that model's levels (or the default model's, when no model was chosen),
each exactly as the client spelled it. Neither is ever empty: an empty model `id` or level is
skipped when the catalog is read (above), so no one can choose it, and a `model` that is absent
means no model was chosen (an operator's empty `MODEL` reads the same way).
Chopin checks both against the last catalog the client reported when it accepts the choice and
again when the turn starts. A model the catalog no longer lists, or a level its model no longer
lists, is not sent: the turn runs with the client's default, and the document's Chat says so. The
catalog name is saved with the choice so that notice can name it even after it disappears. The
browser's `chat:model` state includes an optional `modelName` for that saved name; older choices
without a name use the current catalog's name if known, otherwise the id. Older browsers can ignore
this optional field. A client must still treat an unknown `model` as an error, because its catalog can have changed
since the report. Without a catalog (an older client, or one that reported none) the composer
offers no choice and `thinkingLevel` is never sent. The composer says a chosen model is no longer
available until the document's Chat records that fallback on a turn; it does not repeat the record.

The two fields are independent of the protocol version: nothing here changes an existing message
for a client that did not offer the feature, so the subprotocol stays `chopin.agent.v1`.

### Images and files in a turn

A person can send images and text files with a message to the Planner (see [Files in Chat](hosted-agent.md#files-in-chat)). With `attachments`, the turn that answers it carries them:

```text
"attachments": [{
  "id": "", "name": "", "kind": "image", "mediaType": "", "size": 0, "data": ""
}]
```

- **`kind`** is `image` for a PNG, JPEG, WebP or GIF, and `file` for a text file. Chopin decides it
  from the file's bytes before it keeps one, never from its name. **`mediaType`** is the type it
  was kept under: one of `image/png`, `image/jpeg`, `image/webp` or `image/gif`, or `text/plain`
  for every text file whatever it was called, and never HTML or SVG. **`name`** is the file's name
  as a person sees it (at most 255 characters, with no folder and no control characters); it is a
  label, not a path, and a client must not use it to name a file on disk without cleaning it
  again. **`size`** is the length in bytes, and **`data`** the same bytes as base64.
- **Order and bounds.** The files are in the order the person sent them, at most 20, and
  together at most 1,048,576 bytes before base64, so they always fit inside the frame's
  2 MiB with a prompt and the tools. A deployment's own caps are never higher under
  `HARNESS=remote` (`CHAT_ATTACHMENT_MAX_BYTES` and `CHAT_ATTACHMENT_MAX_TOTAL_BYTES`). `id` is new for
  each turn and says nothing outside it.
- **Images only where the model reads them.** An image is in `attachments` only when the model the
  turn names, or the default model when it names none, lists `image` in its catalog `inputTypes`.
  Text files are always sent. `prompt` is the message's own text as it always was.
- **A client that did not offer the feature.** It is never sent the field, so its `turn` is
  exactly what it was: the message's text files are written into `prompt`, each as
  `<file name="notes.md">`, the file's text, `</file>`, and an image it cannot be given is said in a
  line of words in `prompt` (so the model can tell the person it could not see it), not dropped
  without a word. A client from before the feature, and one that validates `turn` strictly, are
  unaffected.
- **Sensitive data.** The bytes are what a person chose to share with the room; Chopin sends them
  only to the client attached to that document, in the turn that answers the message, and keeps
  no copy in the link. A client should treat them as it treats the prompt.

The field is optional and additive: nothing here changes an existing message for a client that
did not offer the feature, so the subprotocol stays `chopin.agent.v1`.

### Stream parts

`part.part` is one of these AI SDK `HarnessV1StreamPart`s, without metadata
fields:

```text
{ "type": "stream-start", "modelId?": "" }
{ "type": "text-start", "id": "" }
{ "type": "text-delta", "id": "", "delta": "" }
{ "type": "text-end", "id": "" }
{ "type": "reasoning-start", "id": "" }
{ "type": "reasoning-delta", "id": "", "delta": "" }
{ "type": "reasoning-end", "id": "" }
{ "type": "tool-input-start", "id": "", "toolName": "", "providerExecuted?": true, "dynamic?": true, "title?": "" }
{ "type": "tool-input-delta", "id": "", "delta": "" }
{ "type": "tool-input-end", "id": "" }
{ "type": "tool-call", "toolCallId": "", "toolName": "", "input": "{}", "providerExecuted": true, "dynamic?": true }
{ "type": "tool-result", "toolCallId": "", "toolName": "", "result": json, "isError?": true, "preliminary?": true, "dynamic?": true }
{ "type": "finish-step", "finishReason": { "unified": "stop", "raw?": "" }, "usage": {} }
{ "type": "finish", "finishReason": { "unified": "stop", "raw?": "" }, "totalUsage": {} }
{ "type": "error", "error": "" }
```

- `tool-call` and `tool-result` parts are for the client's own declared tools
  only, and `tool-call` must say `"providerExecuted": true`. A `tool-result`
  must follow its own `tool-call`. Anything else fails the turn as a tool
  boundary failure, and a `tool-call` reusing a `toolCallId` fails it as a
  repeated call. Host tools are called with `host-tool-call`; the server
  emits their call and result parts itself.
- `tool-input-start` may name a host tool (its input streams before the
  `host-tool-call`) or a declared own tool.
- A failed own tool's `tool-result` may carry a
  [structured tool error](#structured-tool-errors) as its `result`.
- `finishReason.unified` is one of `stop`, `length`, `content-filter`,
  `tool-calls`, `error`, `other`. `usage` and `totalUsage` are
  `{ "inputTokens": { "total?", "noCache?", "cacheRead?", "cacheWrite?" }, "outputTokens": { "total?", "text?", "reasoning?" } }`
  with non-negative integers.
- `error` fails the turn with that text.

### Structured tool errors

An own tool that fails may say why in a form Chat can show. Send its
`tool-result` with `"isError": true` and, as `result`, this envelope or its
JSON text:

```text
{ "error": { "code": "", "kind?": "", "message": "" } }
```

- `code` is a stable machine identifier, such as
  `no-repository-credential`.
- `kind` is an optional display name, such as `NoRepositoryCredential`.
- `message` is human-readable text of 1 to 4000 characters.

`code` and `kind` are plain identifiers of 1 to 128 characters: an ASCII
letter or digit, then ASCII letters, digits, `.`, `_` or `-`. They cannot hold
spaces, quotes, `:` or `=`.

The envelope has exactly these fields. `@chopin/agent-link` exports it as
`toolErrorSchema` and `ToolError`. It is a convention, not a new wire shape:
`result` remains any JSON, and an envelope that does not match is shown as an
ordinary result. Chopin recognises the envelope only on a failed, final
result; a successful or `preliminary` result that contains `error` is
shown as it is.

Work details then shows the call as **Failed** with `kind`, or `code` when
there is no `kind`, and `message` as plain text instead of the JSON. Chopin
masks credential assignments, including every proxy setting such as
`http_proxy` or `HTTPS_PROXY`, token shapes such as `ghp_…` and Slack `xox…-`
tokens, and URL credentials before it stores or shows them. The URL rule is
deliberately broad, so it masks too much rather than too little. After any
`://`, whatever comes before it, and after a protocol-relative `//` that starts
the text or follows whitespace, a quote, `(`, `<`, `=`, `[`, a comma or a colon
(so not a `//` inside a path), it finds the last at-sign within 8,192
characters and masks everything between them, user name included:
`https://alice:hunter2@host` shows as `https://[redacted]@host`. It reads the
colon, slashes and at-sign in any spelling a URL parser or a later decoding
step would accept: JSON, JavaScript (`\u{40}`, `%u0040`), Python and C
(`\U00000040`, `\x40`, `\100`) escapes behind any run of backslashes,
percent-encoding at any depth (`%40`, `%2540`, …), and HTML entities with or
without their semicolon. As URL parsers do, it reads a backslash as a slash and
lets tabs and line breaks come before each slash, as in
`https:\\alice:hunter2@host`. Only that
window bounds the scan: spaces, quotes, slashes, line breaks and later schemes
do not end it, so a password holding `://` is masked whole, and text that
merely contains a later `@`, even another URL, can be masked too. Only a short
plain user name with no password, such as `git` in `ssh://git@github.com`,
stays visible. It masks `message` as plain text, even when it holds JSON. It
shows `code` and `kind` as written, and does not recognise an envelope whose
`code` or `kind` the masking would change; that envelope is shown as an
ordinary result. The masking is not exhaustive; keep credentials out of the
envelope. Known limits: it does not recognise a fullwidth at-sign (`＠`), a
separator split by zero-width or soft-hyphen characters, which no URL parser
accepts, a tab or line break written as an escape or entity rather than as
the character itself, a Python named escape such as `\N{COMMERCIAL AT}`, or
percent-encoding of an escape's own characters, such as `%25%34%30` for `%40`.

This masking applies only to what Chat stores and shows. It does not change
what crosses the connection: `host-tool-result.output` reaches the client exactly as
the host tool returned it (except the two reading tools; see
[Reading a large document](#reading-a-large-document)), and a failed host call
keeps its `{ "error": "<message>" }` output.

### Reading a large document

`read_plan` and `read_child` host results, and MCP `read_document`'s text, are
text a model can page through, not JSON: a short header (document, `url`,
`revision`, size), the top-level blocks with their lines and digests, then the
document's own lines, verbatim. One result carries at most 16,000 UTF-8 bytes in
all, header and lists included, because a harness may keep only the head and
tail of a result over 20 KiB. They take optional `offset` (a 1-based line),
`limit` (most lines; a result stops sooner when the budget requires, and says
so) and `column` (a 1-based character in line `offset`, to continue a line too
long for one result), and name the exact call that continues in a `next:` header
line. A document over the budget returns an outline and its first part until the
client pages through it; calling each `next:` returns every character exactly
once. See [Reading a large document](hosted-agent.md#reading-a-large-document).

These are the only host results whose `host-tool-result.output` is not the tool's
own return value: the two tools return their structured view, and the server
sends the client the text its model should read, made from the same view. A client
that read the revision from that JSON must read `revision: <n>` from the header.
The `open_decisions` and `ask` results' `current_plan` stays JSON, and leaves out
`source` and `blocks` when the view is over 8,000 bytes, and says so in
`source_omitted`.

## Questions

An `input-request` carries one question call in `input`, and becomes Decisions
in the document. It has no time limit: it waits until members answer it or it
is withdrawn (the client sends `input-cancel`, the session ends, or the
connection closes), and only then gets its `input-result`:

```text
{ "method": "questionnaire", "params": { "questions": [{ "question": "", "header": "", "options": [{ "label": "", "description": "", "preview?": "" }], "multiSelect?": true }] } }
{ "method": "confirm", "title": "", "message": "" }
{ "method": "select", "title": "", "choices": [] }
{ "method": "input", "title": "", "placeholder?": "" }
{ "method": "editor", "title": "", "initial?": "" }
```

A questionnaire has 1 to 16 questions of up to 32 options; `preview` may be
16,000 characters and is an [option's own visual](#option-previews); `select` offers up to 32 choices. The document's own limits
still apply. Text is stored verbatim and shown as Markdown; see
[Card text](#card-text).

`block` names the block of the document the question concerns, by the `index`
and `digest` the Planner's latest `read_plan` or `edit_plan` result gave it. Its
cards go directly after that block and are linked to it. When that block has
changed since, its digest now repeats, or it is itself a decision card, the
cards go at the end of the document, not linked to any passage, as they do
without `block`. A Planner running in Chopin's own process (`HARNESS=atomic`)
names the block the same way, in the options of its host input request.

`input-result` is `{ "type": "input-result", "request": "", "status": "", "value?": json, "message?": "" }`.
`status` and `value` by method:

| `status`    | `questionnaire` `value`                                          | `confirm` | `select`         | `input`, `editor` | `message` |
| ----------- | ---------------------------------------------------------------- | --------- | ---------------- | ----------------- | --------- |
| `answered`  | `{ "answers": [answer for every question], "cancelled": false }` | boolean   | choice or `null` | text              | absent    |
| `expired`   | `{ "answers": [], "cancelled": true }`                           | `false`   | `null`           | `null`            | absent    |
| `cancelled` | `{ "answers": [answered questions only], "cancelled": true }`    | `false`   | `null`           | `null`            | absent    |
| `failed`    | absent                                                           | absent    | absent           | absent            | why       |

- `answered`: members answered every question. `confirm` is `true` only for
  **Yes**. `select` is the chosen string from `choices`, or `null` when a member
  wrote an answer instead. `input` and `editor` are the text a member wrote.
- `expired`: an earlier Chopin closed the question unanswered after a fixed time.
  Chopin no longer sends it: a question waits until a member answers it or it is
  withdrawn, however long that takes. A client may still accept it from an older
  server, where the cards stayed in Decisions marked expired and no partial
  answers were returned.
- `cancelled`: a member cancelled a question, the client sent `input-cancel`,
  the question was withdrawn before it was asked, the session ended, or the connection
  closed. Open cards are withdrawn. When a member cancelled one question of a
  questionnaire after others were answered, `answers` keeps those others; it is
  empty in every other case. The package client settles a question withdrawn
  before it was sent, or one still open when the connection closes, with a local
  `cancelled` result that has a `message` and no `value`. With
  `resumable-sessions`, a question still open when the link drops unexpectedly
  does not end: see [Resuming](#resuming-after-a-dropped-link).
- `failed`: the request could not become Decisions, for example in an isolated
  session or with 16 requests already open on the connection.

A questionnaire `answers` array lists only answered questions, in question
order; an unanswered question has no entry. Each entry is one of:

```text
{ "questionIndex": 0, "question": "", "kind": "option", "answer": "", "preview?": "" }
{ "questionIndex": 0, "question": "", "kind": "multi", "answer": null, "selected": [""] }
{ "questionIndex": 0, "question": "", "kind": "custom", "answer": "" }
{ "questionIndex": 0, "question": "", "kind": "chat", "answer": "" }
```

- `questionIndex` is the question's 0-based position and `question` its
  verbatim text.
- `option`: a single-select question answered with one offered option. `answer`
  is its label; `preview` is that option's `preview`, present only when it had
  one.
- `multi`: a `multiSelect` question answered with offered options. `selected`
  lists their labels; `answer` is `null`.
- `custom`: a member wrote the answer to a single-select question whose options
  have no `preview`. `answer` is the text, or the labels of the options members
  added, joined by a comma and a space.
- `chat`: the same written answer for a `multiSelect` question or one whose
  options have a `preview`.

A workflow-stage question names its `workflowRunId` and, when it differs, the
`rootRunId` of the run that owns it. While the latest `runs` report lists that
root as paused, an answer is held and sent only once the root is no longer
paused, so a paused run stays stopped.

`runs.cards` are run cards as Chat shows them, at most 64. Each `runs` is a
complete report: it lists every card of the session. A full card is:

```text
{ "id": "", "name": "", "status": "running", "started": 0, "updated": 0, "ended?": 0, "stages": [], "earlierStages?": 0, "waiting": 0 }
```

`status` is one of `running`, `waiting`, `paused`, `finished`, `blocked`,
`failed`, `stopped`; times are whole seconds since the epoch; `waiting` counts
open questions. Up to 64 `stages`, the most recent, are
`{ "id": "", "name": "", "parentIds?": [], "kind?": "tool", "status": "", "started?": 0, "ended?": 0 }`
with `status` one of `pending`, `running`, `awaiting_input`, `paused`, `blocked`,
`completed`, `failed`, `skipped`, `stopped`. `earlierStages` counts the stages
the run reached before the listed ones; Chat lists every reported stage when
someone expands the card and says how many it was not sent. Optional
`parentIds` names the parent stages by their IDs in this report (at most 64 IDs,
each 1–128 characters). Send these links for nested work; older reports without
them remain valid on version 1.
Chat renders unfinished descendants of stopped, failed, blocked or skipped stages
as stopped, while preserving finished outcomes. A stopped, failed or blocked run
stops all unfinished stage displays even without parent links. `active` and
`paused` list at most 64 root run IDs. List a launched run in `active` from the
moment the workflow tool admits it, or its root reports running, until its root
run ends: Atomic delivers activity and lifecycle events in no shared order, so
a run can start before its activity does. A `finished` card is finished only
with `ended`, the time its root run ended; without it, Chat shows the run as
still live and posts no finish notice. When the connection closes, the server
shows the reported live runs as stopped, except where a link with
`resumable-sessions` dropped unexpectedly and its session is [kept](#resuming-after-a-dropped-link).

A full card's `stages` replace every stage Chopin stores for the run, unless
it has none (see [Run stage deltas](#run-stage-deltas)). Chopin stores all of a
run's stages, not only those a card lists, and keeps them across reconnects and
restarts until Chat stops showing the run's card, when a later run replaces
ended cards.

### Run stage deltas

With the `run-stage-deltas` [feature](#features), a card may instead be a delta
card, with `stagesDelta` and without `earlierStages`:

```text
{ "id": "", "name": "", "status": "running", "started": 0, "updated": 0, "ended?": 0, "stagesDelta": true, "stages": [], "waiting": 0 }
```

- `stagesDelta` is always `true`. A delta card's other fields replace the
  card's, as a full card's do.
- `stages` holds only the run's new and changed stages, in the stage shape
  above, with no count limit; only the frame's 2 MiB bounds them. Chopin adds
  them by `id` within the run: a known `id` is replaced whole, where it stands,
  so an optional field left out is gone; a new one follows the run's other
  stages, in the order sent. A repeated `id` keeps its last value. Stages a
  delta does not name are kept, and `"stages": []` changes none.
- The run keeps the `earlierStages` of its last full card.
- A delta never removes a stage. To start a run's stages over, send a full card
  with the new first stages, then delta cards.
- A full card with `"stages": []` for a run that already has stages keeps them,
  with or without this feature. Its other fields, such as `status` and the
  times, change the card as usual, and its `earlierStages` is ignored, so a
  client that reattaches can report an ended run whose stages it no longer
  holds without wiping the ones Chopin stores. A full card with any stages
  still replaces them all.
- `parentIds` may name any stage of the same run, sent in this message, an
  earlier one or a later one. Chopin refuses no parent ID; Chat shows a stage
  whose parent it does not know at the top level until the parent arrives, and
  applies the stopped rule above over all of the run's stages.
- A report too large for one frame goes as several `runs` in a row, each a
  complete report with the same `active`, `paused` and cards, splitting the
  stages between them. Make every card of every part after the first a delta
  card (`"stages": []` when nothing is left for it), so no full card replaces
  the run's stages twice. The package client's `reportRuns` does this.
- After each `attach`, send every stage of each run once, then only what
  changes; adding a stage Chopin already stores again changes nothing.

A server that did not list `run-stage-deltas` in `attached.features`, including
every server from before features, refuses a delta card as `malformed-message`
and closes the connection with 1008. Send such a server full cards: the 64 most
recent stages, with `earlierStages` counting the rest.

### Option previews

With the `decision-option-previews` [feature](#features), an option's `preview`
is the option's own visual: Chopin keeps it as a field of its own and shows it,
framed, under the option's label and description on every card surface
(Decisions, the inline card, the phone sheet, answered cards and the decision
page). Members compare the choices by looking at them, so give every option of
a comparison a visual of the same kind.

- `preview` is one string of Markdown, at most 16,000 characters, stored
  verbatim. It may hold a Mermaid fence, a small pipe table, a code sketch, or an
  image: `![alt](/images/<sha256>.<ext>)`, the document's own upload with the
  required alternative text. Anything else, such as a remote or `data:` image,
  shows its alternative text. There is no separate image field and no cap on the
  number of images, but one picture or diagram per option reads best; the option's
  one-line `description` is its caption.
- Pictures are held to the option's column and about a third of a screen, and
  open large from a click on the picture, which never chooses the option. A
  diagram is bounded until the reader expands it. Where space is tight, as in a
  decision with criteria, an image is a small thumbnail and other content is left
  out of the row.
- The option's accessible name stays its label and description; the preview is a
  group of its own named `Preview of <label>`.
- A selected option's answer carries the option's `preview` as before.

The `upload_plan_image` host tool is offered in a turn's `tools` only to a client
that asked for the feature. It stores an image the Planner made in this
document's own images and returns the Markdown to use, in an option's `preview`,
a question's body, or the plan:

```text
input:  { "data": "<standard base64, at most 1 MiB decoded>", "mimeType": "image/png" | "image/jpeg" | "image/webp" | "image/gif", "alt": "" }
output: { "path": "/images/<sha256>.<ext>", "markdown": "![alt](/images/<sha256>.<ext>)" }
```

`alt` is required, one line of at most 200 characters. The same bytes uploaded
twice give the same path. The server never reads a path on the Planner's side:
a remote Planner encodes its own file. A call fails with the usual host tool
error for an image over 1 MiB, an unsupported type, bytes that are not the
declared type, an archived document, or a call outside a live Planner turn. The
image loads only for people who can read this document. A workflow stage has no
turn of its own, so from a stage use the MCP `upload_image` tool with the same
bytes, or pass the Markdown down from a Planner turn.

A server that did not list `decision-option-previews` in `attached.features`
joins `preview` onto the end of the option's `description` and offers no image
tool; a Chopin that renders card text as Markdown still draws a Mermaid fence or
the document's own image there, just not in a frame of its own.

### Card text

A question's text is Markdown, and so is an option's `description`. The first
line of `question` is the card's heading; everything after the first line break
is the body beneath it:

```json
{
	"question": "Confirm the earlier answers\n\n- Storage: PostgreSQL\n- Rollout: a small pilot",
	"header": "Confirm",
	"options": [{ "label": "Confirm all", "description": "" }]
}
```

- The heading takes inline Markdown only: code spans, emphasis and links. A
  line that only looks like a list or heading, such as `1. Ship it?`, stays
  text. Keep it short; it is the card's bold title.
- The body, and an option `description` of more than one line, take the
  Markdown Chat renders: paragraphs, lists, block quotes, code and links. A line
  break is a line break. A one-line description reads as one phrase, like the
  heading.
- A fence named `mermaid` (`` ```mermaid ``) is drawn as a diagram by the same
  renderer, theme and strict security level the document uses, held to a
  bounded height until the reader expands it. Source Mermaid cannot draw is shown
  as code.
- An image shows only when it is this document's own upload: `![alt](/images/<sha256>.<ext>)`,
  the `path` [`upload_image`](local-agent-mcp.md) returned for the same
  document. Alternative text is required. Any other image, remote, `data:` or
  uploaded to another document, shows its alternative text instead.
- Raw HTML is shown as the text it is, never rendered.

Text without a line break is a heading alone, as it always was, so a client
needs no feature check: an older Chopin shows the same text unformatted.

## Closing

| Close code | Sent after                                     | Meaning                                         |
| ---------- | ---------------------------------------------- | ----------------------------------------------- |
| 1000       | `detach`                                       | The client detached                             |
| 1001       | nothing                                        | No pong or message within the [timeout](#pings) |
| 1008       | `error` with `malformed-message` or `protocol` | Unparseable, invalid, or out-of-order message   |
| 1009       | `error` with `message-too-large`               | A frame over 2 MiB                              |
| 1011       | `refused` with `unavailable`                   | The server could not check the document         |
| 1012       | `restarting`, with `restart-notice`            | The server is restarting                        |
| 4401       | `refused`                                      | `sign-in-required`                              |
| 4403       | `refused`                                      | `repository-forbidden` or `access-revoked`      |
| 4404       | `refused`                                      | `document-unavailable` or `document-archived`   |
| 4409       | `refused`                                      | `planner-attached`                              |
| 4426       | `refused`                                      | `unsupported-version`                           |

`protocol` covers a message before `attach` is answered, a second `attach`, and
a repeated `input-request` id the server remembers. When the connection closes for
any reason, the server ends a running turn with an error, stops the turn's host
tools still running, withdraws open questions and the Decisions those tools
opened, and forgets the connection; reattaching starts new sessions, except
where [resuming](#resuming-after-a-dropped-link) keeps them. The account keeps
the document's Planner ownership as described in [Ownership](#ownership): for the
grace period, or with no deadline while a `resumable-sessions` link's work is kept.
A server never replays an interrupted turn.

### Resuming after a dropped link

A network that fails ends a link without a `detach`. A lost connection never ends
a client's work by itself. A client that asks for the `resumable-sessions`
[feature](#features) can come back without losing what it was doing, however long it
is away: nothing times it out, and the grace period in [Ownership](#ownership) does
not apply to it.

- **What drops.** The socket closes with no `detach` and no `refused`, or the
  server closes it as `unresponsive` (see [Pings](#pings)). The turn under way
  still fails with an error and its host tools stop, as on any close.
- **What is kept.** Each started session that has a live or paused run, or a
  question the client asked and nobody has answered, stays as it was: its run
  cards keep the status last reported, not `stopped`, marked `disconnected` for the
  people reading them, its Decisions stay open in the document and can be answered,
  and an answer given meanwhile is held. Other sessions end as they always did.
  Chat says nothing of the connection itself: the machine button, its menu and
  the run cards carry that state, and nothing confirms it came back.
  Nothing waits on the client in the meantime: `@chopin` and `invoke_planner` are
  refused as [without an attached Planner](#without-an-attached-planner), and no
  other account can attach. The document is not let go either: a Default machine's
  idle period, a machine that went quiet, and the owner's GitHub credential being
  renewed end nothing.
- **Nothing but an explicit end.** There is no deadline. The operator's
  `PLANNER_ATTACH_GRACE_MS` leases only a connection that detached, or dropped with
  nothing to keep. A client may be away for minutes or for days; it resumes the same
  session, receives what was answered or cancelled meanwhile, and its runs go on.
- **A question the client withdraws.** Cancelling a question while the link is down
  ends the client's wait at once, with a local `cancelled` result, and the next link
  does not name it, which withdraws the Decision in Chopin before anything else
  happens. A client that sent `input-cancel` on a link that then dropped is
  treated the same way.
- **Stop is held, not lost.** A Stop Planner, or one run's pause, that cannot
  reach the client is held for its return, and Chat says that the workflows will
  pause when the machine reconnects; the run cards keep their last reported status
  until the client reports otherwise. That covers a Stop pressed while the link is
  down and one already sent whose `control-result` had not come when the link
  dropped. A `stop` the client did not answer within 10 seconds while the link was
  still attached is kept too: Chat says Chopin has not confirmed it, never that
  it stopped, and that the workflows will pause when the machine reconnects, and
  says nothing more when the link is found dead (see [Pings](#pings)). Chat says a Stop
  stopped Chopin only when the client confirmed it, that it was asked to when
  its connection is known to be down, and that it was not confirmed otherwise. After `resumed`, before anything else,
  the server sends the client one `stop` for every run (or one per run named),
  however many times it was pressed, and the client answers `control-result` as
  for any `stop`. The client may already have applied the original, whose answer
  was lost, so it can receive a `stop` for runs that are paused; repeating it
  changes nothing. A `stop` the client answered, whether it applied or refused it,
  is not sent again. One it never answered stays owed, and a `resume` the client did
  answer undoes it only for the runs that `resume` covers: a Stop of every run
  stands for the other runs, and a Stop of one run is undone only by a `resume` of
  that run or of every run. A held Stop whose answer is lost because the link dropped once
  more is sent again with the next `resume`. A Resume pressed meanwhile is not
  held: Chat says the workflows could not be resumed, and it can be pressed again
  once the client is back. Stop on a Planner that only waits on a question
  withdraws the question explicitly, and Chat says so; the client learns of it when it
  resumes. That ends what the link kept, and the account holds the document for the
  grace period as a detached one does.
- **How to resume.** The same account attaches again, offering
  `resumable-sessions`, and sends `resume` as its first message after `attached`:
  `{ "type": "resume", "sessions": [{ "session": "", "requests": [""] }] }`, every
  session it still holds with the `input-request` ids it still waits on. The server
  answers `resumed` in the same shape: the sessions it kept and gave back, each with
  the requests it still holds, whether open or answered while the link was down. It
  then sends each answered request's `input-result` the client has not acknowledged,
  and the client acknowledges it with `input-received`. The client sends `runs`
  again for the sessions it got back, as after any `attach`. A session or request the client does not name has
  ended and is withdrawn; one the server does not list has ended there: the client
  settles its questions as cancelled and calls its `destroy` handler for the session.
  A client that sends anything else first, or does not offer the feature, holds
  nothing to resume. A `refused` with `retry` (`unavailable`, see
  [Ownership](#ownership)) does not end the client's questions: Chopin could not decide,
  so the same `resume` is sent again on the client's backoff, which may or may not
  succeed. Any other `refused` (`planner-attached` included, whoever holds the
  document) and any `error` ends them.
- **A client that does not offer the feature.** It behaves as it always did: when its
  link drops, Chopin ends the turn, withdraws the questions the client asked, shows
  its live runs as `stopped` and forgets its sessions. Such a client settles its own
  waiting questions when its socket closes and holds nothing it could resume, so
  keeping them open would promise answers nobody can receive. A client that wants its
  work to survive a drop must offer `resumable-sessions`; the package client does by
  default (`resumable: false` opts out).
- **What a client implements.** Offer `resumable-sessions` in `Chopin-Agent-Features`
  and check that `attached` lists it; acknowledge every `input-result` with
  `input-received`, including one for a request already settled; keep each session and
  its waiting `input-request` ids across a drop; on the next connection send `resume`
  first and handle `resumed`, then the redelivered `input-result`s and `stop`s, then
  `runs`; retry the same `resume` on a `refused` with `retry`, and treat any other
  `refused` or `error` as final.
- **What still ends it for good.** Its own `detach`; any definitive `refused` (every
  one without `retry`) or protocol error; the owner's sign-out or its expiry; a Planner reset; revoking or unpairing
  the machine that attached it; the document's owner choosing another machine for it;
  archiving or deleting the document; a Stop that withdraws its last question; and the
  same account attaching with a client that does not resume, which includes a browser
  sign-in attaching over a paired machine's parked work, since that client cannot
  resume it. All of these withdraw the questions and show the runs as `stopped`, and a
  later `resume` finds nothing. A server restart does not end it: see below. A person
  with write access can always end a disconnected Planner by resetting it.

#### When the server is restarting

A server that is restarting closes every link with 1012. A link that offered
`resumable-sessions` keeps what it held, as for any close it did not choose: 1012 is not
one of the closes that ends the link for good, and, unlike 1001, it says the server will be
back. A client that also offers `restart-notice` is told how soon, with `restarting` just
before the close, and follows this rule:

- On a 1012 close, connect again at once. Do not wait out the backoff: a proxy in front of
  Chopin holds the upgrade until the new process answers.
- Send `resume` as usual. The new process does not refuse it inside the window it announced:
  before it has restored the owner's browser sign-in (see [Ownership](#ownership)) it holds the
  `resume`, keeps the link, and answers when the sign-in is back. It may refuse it with
  `unavailable` and `retry` once the window is over with the sign-in still not back, or when it
  could not decide for another passing reason. Retry the same `resume` every 250 ms until
  `reconnectWithinMs` has passed since the close, then go back to the client's own backoff.
- Any other `refused`, and any `error`, is final, as for a resume at any other time.

A client without the feature sees only the 1012 close and resumes on its own backoff. If
that is longer than the server's hand-over window, the document shows its Planner as
disconnected once the window ends, as it does for any dropped link. The package client
offers the feature with `resumable-sessions` and reports `reconnectWithinMs` on the
`LinkClosed` its `closed` promise settles with; it leaves connecting again to its caller, so
the rule is for the backend to follow. The test client in `apps/server/src/testing/agent-link.ts`
(`resumeAfterRestart`) implements it.

#### After a server restart

The server keeps links, sessions and open requests in memory, and writes what a restart
must carry over to storage: when a link drops with work kept, and for every live link at
its cut, one `planner_link_holds` row per document with each session's waiting request
ids, for each question the decisions it asked and the kind of request it was, the answers the
client has not acknowledged and the Stops it has not heard. The
server tells every link it is going down before it closes any socket, closes each with 1012
(with `restarting`, whose `reconnectWithinMs` is the hold's window, for a client that offered
`restart-notice`), and no link withdraws a question on the way out, so the Decisions the
Planner had asked stay open and answerable in the document.

The next process rebuilds each hold as a suspended one. Until its **hand-over window**
(`HANDOVER_PLANNER_WINDOW_MS`, 10 seconds by default, counted from the release of the lease: the
next process starts it as it rebuilds the hold, after the release) ends, the
document's members see the Planner attached, the run cards Chat stored stay as they were, and
a `@chopin` message, comment note or task draft is saved and started when the client resumes.
A returning client attaches, and sends `resume` as usual:

- **Before the owner's browser sign-in is back,** which a browser's cookie restores, the
  `resume` waits inside the window: nothing is refused, the link stays attached, the document
  shows the machine attached, and the sessions come back the moment the sign-in does. A
  `resume` still without it when the window is over, or sent after it, is refused with
  `unavailable` and `retry`, and the hold stays. A client that offered `restart-notice` retries
  every 250 ms until `reconnectWithinMs` has passed, then on its own backoff; there is no
  deadline for the hold itself. A paired machine's backend has no
  such wait: its login is made again from the machine's own authorization, and the
  credential it was issued is accepted at once, so no HTTP 401 follows a restart.
- **After it,** the sessions the client names come back, as after any dropped link, and
  `resumed` lists the requests the server holds. An answer given while the link was down,
  or sent and never acknowledged, is one: it is delivered once after `resumed`. A question the
  client still waited on is listed in `requests`, and the client keeps waiting on it. The new
  process asks the members of the document the same question again when the document opens: it
  is the Decision the old process created, still open in the document, and its answer goes to
  the client's own request, as an `input-result` with the result the old process would have
  sent, once. An answer given before the client is back waits and is sent after `resumed`; one
  given after goes straight to it. No turn of its own follows, because the question is waited
  on. A question a client resumes without, because it no longer waits on it, is withdrawn, as
  `input-cancel` withdraws it. Each Stop held for the client is sent first. The client's
  `runs` for a resumed session update nothing Chat shows until a Planner turn starts a session
  of its own.
- **An answer its client is never given.** When the client that asked does not come back to
  resume (it attaches with nothing to resume, or resumes without the session), an answer a
  member had given meanwhile cannot reach its request. It reaches the Planner once, as a turn of
  its own that names the question, the option chosen and who chose it, started when the Planner
  is attached (see [Decisions](decisions.md)). A question of a request that was not kept, one
  asked while the old process was stopping or after a crash, is not waited on at all, and its
  answer is handled the same way. Exactly one of the two delivers an answer. What is not
  carried over is a workflow run's pause: an answer to a question a workflow run asked is sent
  when it is given, without the wait that keeps a paused run stopped.
- **A client that sends anything else first,** or resumes with nothing, holds nothing to
  resume: the kept sessions end and the run cards stop.

When the window ends with no `resume`, the hold is disconnected, as a dropped link is
today: the document's members are told, its run cards say the Planner is disconnected, and the
hand-over logs a miss naming the cause, the owner's sign-in or the client not back. It stays
for the client's return and nothing times it out. A hold that was already disconnected when the
cut came keeps its state and gets no window, and one in its grace period is not kept. An
explicit end (sign-out, a reset, revoking the machine, archiving the document) removes
the hold and its row. Under `AUTH_MODE=local`, which is never handed over, holds stay in
memory and a restart ends them as before.

After a crash, only the hold of a link that had already dropped is stored, with no window, so
its client's `resume` finds it disconnected; the live link's work is lost as it always was. A
crash of the process a cut handed over to leaves the same: it rewrote the row without the window
when it rebuilt the hold, so the process after it finds the hold disconnected and keeps the
sessions for the client's `resume`.
Neither the link closing nor the shutdown posts a Chat line: no "disconnected" notice
and no "was stopped after" line, since nobody stopped anything and Chopin merely restarted. An answer given to a Decision nobody
waits on any more reaches the Planner as a turn of its own once a Planner is attached
(see [Decisions](decisions.md)). Nothing is reported as the Planner stopping its work
because of a network drop.

A request is never asked twice: it keeps its `request` id and its card. The package
client implements resuming and asks for the feature by default: pass
`connectAgent({ resumable: false })` for a client that wants everything to end when
its link drops. Its `resumption` settles, when the link closes, with what to pass the
next `connectAgent` as `resume`, or with nothing when the link ended any other way.

A client that receives a frame it cannot parse should close with 4400 and reason
`malformed-message`. Node.js's `WebSocket` lets a caller close only with 1000 or
3000 to 4999, so a client cannot answer with 1008. The package client does
this and settles everything still waiting on the connection at once.

## Planner backend commands

A paired machine can run a document's Planner without a browser sign-in. The
`chopin` CLI starts a Planner backend command for each document it is given and
hands it a credential; the backend attaches over this connection like any client.

```sh
chopin connect --planner https://chopin.example/octo-org/score/plan \
  --planner-command "my-planner --flag" --agent copilot
```

`--planner` may repeat. `--planner-command` is split into words as a POSIX
shell would, without expanding anything: single and double quotes, also inside
a word as in `--label="two words"`, and backslash escapes outside single
quotes; an unmatched quote is refused. `CHOPIN_PLANNER_COMMAND` may hold the
command as a JSON array of words instead. The command runs in the checkout of
the document's repository, in its own process group: the one `--checkout` named,
else a clone in `<base dir>/repos/<owner>/<repo>` that the connector makes once
and fetches again before each launch. In the [sandbox](chopin-cli.md#sandbox) that
checkout is read-only. Its standard output and error go
to the connector's a line at a time, with its credential, your `--env` values
and anything that looks like a token replaced with `[redacted]`; a line too
long to mask is left out, with a note in its place.

### Environment

Each launch gets the connector's environment, your `--env` values, and these:

| Variable                         | Value                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `CHOPIN_URL`                     | The server's origin.                                                                     |
| `CHOPIN_DOCUMENT`                | The document as given to `--planner`, or its URL when Chopin chose this machine.         |
| `CHOPIN_PLANNER_TOKEN`           | This launch's [credential](#credential).                                                 |
| `CHOPIN_PLANNER_TOKEN_FILE`      | A file (mode `0600`) that always holds a current credential, replaced before it expires. |
| `CHOPIN_CHECKOUT`                | The absolute root of the document's repository's checkout or clone.                      |
| `CHOPIN_WORKTREE`                | The command's own worktree path, `<base dir>/planners/<owner>/<repo>/<document id>`.     |
| `CHOPIN_GITHUB_TOKEN`            | The machine owner's token from Chopin's GitHub App, for pushing and draft pull requests. |
| `CHOPIN_GITHUB_TOKEN_EXPIRES_AT` | When that token expires, in ISO 8601.                                                    |
| `CHOPIN_GITHUB_TOKEN_FILE`       | A file (mode `0600`) that always holds the current token.                                |

`CHOPIN_WORKTREE` stays the same across launches. The connector makes its
parent folders but never removes the worktree itself. Whether the backend or the
connector makes it depends on the [sandbox](chopin-cli.md#sandbox):

- **Without a sandbox** (none works on the machine, or `--no-sandbox`), the folder is
  not there on the first launch and the command makes the worktree, for example:

  ```sh
  git -C "$CHOPIN_CHECKOUT" worktree add "$CHOPIN_WORKTREE" -b <branch>
  ```

- **In the sandbox** the worktree already exists on every launch, the first too: the
  connector makes it on the host before the backend starts, as a linked worktree of
  `CHOPIN_CHECKOUT` detached at its `HEAD`, and leaves it as it finds it on later
  launches. The backend must use it, as it must after its first launch anyway:
  `git -C "$CHOPIN_WORKTREE" checkout -b <branch>` starts a branch, and it can commit
  and push from there. `git worktree add` fails in the sandbox, because the sandbox
  lets the backend write that one worktree's git directory and not the list of
  worktrees in the checkout's. **`CHOPIN_CHECKOUT` is read-only**: it is the
  person's own checkout, and the sandbox never lets an agent write its files, its
  submodules, its `.git`, its index or `HEAD`, whether it is a regular checkout or a
  linked worktree of theirs, and no path its owner adds with `--sandbox-write` changes
  that. A backend reads it, and does its work and its edits in
  `CHOPIN_WORKTREE`, from where its changes reach the person as commits and a
  pushed branch. See [Git in the sandbox](chopin-cli.md#git-in-the-sandbox). A
  folder at `CHOPIN_WORKTREE` that holds something and is no worktree is left as it is.

The connector renews the Planner credential in `CHOPIN_PLANNER_TOKEN_FILE` 5 minutes
before it expires, for as long as the backend runs and Chopin still lets the machine run
the document, and tries again if it cannot reach Chopin, keeping the file it has. It
deletes the file when the backend exits, when the document is withdrawn, or when Chopin
refuses the machine for good, such as a revoked pairing. Its content, like the
launch's credential, never reaches the connector's output. A backend that outlives a
link, as a `resumable-sessions` one does, reads it again before reattaching.

The connector renews the GitHub token in the file 25 minutes before it expires,
so read the file before each use. The three `CHOPIN_GITHUB_TOKEN` variables are
absent when Chopin gives no token; see
[Which GitHub account pushes](chopin-cli.md#which-github-account-pushes).

### Credential

The connector asks for a credential just before every launch:

```text
POST /api/connector/planner
Authorization: Bearer <machine token>
{ "document": "<document id or URL>" }

200 { "token": "chopin_p_…", "expiresAt": <milliseconds since the epoch>, "document": { "id": "", "url": "" } }
```

Chopin issues it only when it runs `HARNESS=remote` with `AGENT` on and not
`AUTH_MODE=local`, where machines hold no GitHub authorization of their own
(otherwise 404), the machine is still paired and authorized (otherwise 401
`machine-revoked` or `machine-reauthorize`), and the machine's owner, checked
with the machine's own GitHub authorization, can push to or administer the
document's repository (otherwise 403 `repository-forbidden`; 404 `not-found`
for no such document, 409 `document-archived` for an archived one). The
credential can open connections to that one document for **15 minutes**. A connection it
opened does not depend on it afterwards: the server rechecks the machine as it
rechecks any owner. Chopin keeps only its SHA-256 digest, in `planner_credentials`,
written before the credential is handed out. A process that starts after a restart
therefore accepts an unexpired credential at once, and a backend that reconnects with it
is not refused with 401 while it waits for the machine's connector to renew it. The rows
go when the credential expires, when the document's Planner is stopped on the machine,
when the machine is unpaired or loses its GitHub authorization, and with the document.

Attached this way, the document's Planner owner is a login of the machine's
owner that no browser holds, whose GitHub token is the machine's own; Chopin's
repository tools act with it. That holds for a teammate's document too, when the
machine's owner shares it and someone chose it or made it their favorite (or Default machine gave it): the
Planner runs as the owner. So do the builds and runs that person starts on the
machine, which the connector claims with the same machine token; Chopin records
the person as who asked, and the build's agent is told to name them in each
pull request (see
[Share a machine with teammates](chopin-cli.md#share-a-machine-with-teammates)).

### What the backend must do

- Read `CHOPIN_URL`, `CHOPIN_DOCUMENT` and `CHOPIN_PLANNER_TOKEN` from its
  [environment](#environment). The token is never in its arguments; do not log
  it.
- Keep any worktree of its own at `CHOPIN_WORKTREE`.
- Open `/api/v1/agent` on `CHOPIN_URL` offering the `chopin.agent.v1`
  subprotocol, with `Authorization: Bearer <CHOPIN_PLANNER_TOKEN>`, and `attach`
  to `CHOPIN_DOCUMENT`.
- On HTTP 401 at the upgrade, or when the connection closes for any reason other than
  its own `detach`, a backend that did not offer `resumable-sessions` exits. Until the
  credential's 15 minutes have passed it may instead reattach with it after 1001, 1012 or a
  dropped socket; after that the credential is refused and it must exit. Chopin
  forgets a credential once it has expired.
- A backend that offers `resumable-sessions` does not exit when its link drops
  unexpectedly: it keeps its process, its sessions and its runs, and attaches again
  with `resume`, however long the network or the machine is away. Chopin keeps the
  document's Planner, its run cards and its open Decisions for it, and holds any
  Stop meanwhile. Because the credential it was launched with is good for 15 minutes,
  it reads `CHOPIN_PLANNER_TOKEN_FILE` before each attempt and again whenever the upgrade
  is refused with 401, retrying on its own backoff. The connector replaces the file
  before its credential expires; a machine that slept through that renewal gets the
  new file once the connector's timer next fires, and a backend that meets a refused
  upgrade in between reads it again and retries. When Chopin refuses its `resume` with
  `retry` (it could not check the document or the account, as GitHub failing at that
  moment does), or the upgrade fails with 503, it keeps its sessions and tries again on
  its backoff, and does not exit. It exits when its own `detach` ends
  the link, when Chopin refuses the attach for good (any `refused` without `retry`,
  including `planner-attached`), when the file
  is gone (the machine was revoked, or Chopin no longer asks it to run the document), or
  when it holds nothing to resume. This repository ships no first-party backend: the
  connector provides what a resumable backend needs, the `@chopin/agent-link` package
  client is the reference implementation of the protocol, and a third-party backend that
  follows this contract is what people run.
- Exit on SIGTERM. On Ctrl-C the connector sends it to the backend's process
  group and, 5 seconds later, kills whatever is left in that group, including
  processes the backend started that ignored it. A backend that exits by itself
  has its group stopped the same way before it is started again. On Windows the
  connector ends the backend's process tree with `taskkill /T /F` instead.

The connector starts a backend that exited again, with a fresh credential, after
the reconnect backoff (up to a second at first, doubling to at most five
minutes, and starting over after a backend ran for a minute). When the
credential request is refused because the machine was revoked or must be paired
again, or Chopin refuses the document, the connector stops that document's
backend and says why. A backend refused with `planner-attached` (4409) because
an earlier connection of the same machine still counts as attached is started again
on that backoff until the server notices that connection is gone (up to the
120-second timeout in [Pings](#pings)); a closed connection's grace period does not
block the same machine.

A backend Chopin asked the machine to run (see
[Run a Planner on this machine](chopin-cli.md#run-a-planner-on-this-machine)) is started again only once
Chopin's Planner poll still asks for it. Chopin closes the link of a Planner it
no longer asks for, so the backend can exit before the poll's answer arrives;
the connector then waits for that answer, and stops the backend for good when
the answer leaves its document out. When a document is renamed, the poll's next
answer names it at its new address; the connector shows that address in
`chopin status` and its output, and starts the backend there next time, without
restarting a backend that is running.
