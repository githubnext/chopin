# Planner link

The Planner link is the wire contract between a Chopin server running
`HARNESS=remote` and the client that runs its Planner's model, usually a
member's own Atomic session. This page is complete enough to implement a client
from: it states the endpoint, authentication, version handshake, every message,
its limits, and how the link ends. [Hosted agent](hosted-agent.md#remote-planner)
describes what the server does with it, and
[Self-hosting](self-hosting.md#the-remote-planner) how to deploy it.

`@chopin/planner-link` (`packages/planner-link`) holds the server's schemas.
Its client, `@chopin/planner-link/client`, uses nothing at runtime but this
format, JSON, and the platform `WebSocket`; the remote harness contract suite
runs it in Bun and as a separate Node.js process against a real socket.

## Endpoint and authentication

Open a WebSocket to `wss://<chopin origin>/planner-link` (`ws:` only for a
loopback development server). It shares the application's origin and port with
`/ws` and `/mcp`, behind the same TLS-terminating proxy. The route exists only
when the server runs with `AGENT` on and `HARNESS=remote`; otherwise every
request to it, upgrade or not, gets HTTP 404 before the bearer is checked.

The upgrade request must carry `Authorization: Bearer <GitHub token>`, the same
bearer [local agent MCP](local-agent-mcp.md) uses. Bun's and Node.js's built-in
`WebSocket` accept it as a `headers` option (`new WebSocket(url, { headers })`;
checked on Node.js 24); browsers cannot send it. A client should not send an
`Origin` header; if it does, it must be the server's own origin.

The bearer may instead be a paired machine's Planner credential (see
[Planner backend commands](#planner-backend-commands)): `chopin_p_` followed by
43 base64url characters. It attaches only the document it was issued for, and
the account it attaches as is the machine's owner.

The server checks the bearer before upgrading and answers a refusal over HTTP,
so nothing is opened:

| Status | Meaning                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| 404    | The server does not run `HARNESS=remote` with `AGENT` on                                                                       |
| 401    | Missing or malformed bearer, GitHub rejected the token, or an unknown or expired Planner credential, or its machine is revoked |
| 403    | The account fails instance admission, or a foreign `Origin`                                                                    |
| 503    | GitHub is unavailable or rate limiting; retry later                                                                            |
| 500    | Any other admission failure                                                                                                    |

### Pings

The server sends the link a WebSocket ping control frame (RFC 6455) every
**15 seconds** from the moment it opens. The client must answer each with a
pong. Standard clients do this on their own, including Bun's and Node.js's
built-in `WebSocket` and the `ws` package; pings are control frames, not
messages, and carry no JSON. Any frame from the client, a pong or a message,
shows the link is alive.

A client that is slow to read leaves the server's frames to it queued. While
anything is queued the server sends no ping, since a ping can be dropped from a
full queue. A queue getting shorter puts off the close by another timeout, but
it does not count as hearing from the client: the kernel's buffers or a proxy in
front of the client can drain it while the client reads nothing. A client that
has stopped reading entirely keeps a queue that never shrinks, and counts as
silent.

A link the server hears nothing from for **120 seconds** is treated as dropped,
such as one whose network silently went away. However much of its queue drains
meanwhile, a link that sends nothing at all, not even a pong, for **15
minutes** is dropped too. The server closes it with 1001 and reason
`unresponsive`, without an `error` or `refused` message, and releases it exactly
as any dropped link (see [Closing](#closing)): its account keeps the document's
Planner for the grace period in [Ownership](#ownership). The operator sets the
interval, the timeout and the longest silence with `PLANNER_LINK_PING_MS`,
`PLANNER_LINK_TIMEOUT_MS` and `PLANNER_LINK_MAX_SILENCE_MS`.

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
- An operator can lower `PLANNER_LINK_MAX_SILENCE_MS` to release such a client
  sooner, at the cost of closing slower readers, or raise it, up to an hour, for
  slower links.

The server cannot see a frame until it has arrived whole, and a client's pongs
wait behind a frame it is still sending. So every frame must arrive within the
timeout of the last frame heard before it. With the defaults, a 2 MiB frame
needs a sustained client upload of about **17 KiB/s** (2 MiB in 120 seconds),
or about 20 KiB/s if it starts just before a ping is due (2 MiB in the 105
seconds left). A client on a slower uplink is closed as unresponsive while it
uploads its largest frames; raise `PLANNER_LINK_TIMEOUT_MS` for it.

## Frames

Every message is one JSON object in one text frame, with a string `type`. A
frame may hold at most **2 MiB** (2,097,152 bytes) of UTF-8. Objects are strict:
a field this page does not list is refused. Binary frames are refused.

Shared limits, in characters unless stated:

| Kind  | Fields                                                                                                                                                                                            | Limit      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| id    | `session`, `turn`, `request`, `toolCallId`, part `id`, run and stage `id`, `run`, `workflowRunId`, `workflowStageId`, `rootRunId`, `active` and `paused` entries, `document.id` in `attached`     | 1 to 128   |
| name  | tool names, `toolName`, `names` entries, `modelId`, `responseFormat.name`                                                                                                                         | 1 to 128   |
| short | question `header`, `finishReason.raw`                                                                                                                                                             | up to 128  |
| note  | `message`, every `title`, `error`, `turn.model`, `responseFormat.description`, question text, option `label` and `description`, `choices` entries, `placeholder`, `initial`, run and stage `name` | up to 4000 |
| text  | `prompt`, `instructions`, `delta`, `input`                                                                                                                                                        | the frame  |

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
{ "type": "attached", "version": 1, "document": { "id": "", "title": "", "repository": "owner/name", "url?": "" } }
{ "type": "refused", "code": "<refusal code>", "message": "" }
```

`attached.document.repository` is `owner/name`, at most 257 characters, and
`url` at most 2048. After `refused` the server closes the link.

### Ownership

Attaching makes the client the document's Planner and its account the
document's Planner owner. `attach` succeeds when all of these hold:

- The bearer's GitHub account has push or administration access to the
  document's repository. Pull access alone is refused with
  `repository-forbidden`.
- The same account is signed in to Chopin in a browser, on this server, since
  the server last started. Chopin's repository tools run with that sign-in's
  GitHub App token, never with the link's bearer. Without one, `attach` is
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
refused with `planner-attached`, including one from the same account, and the
`message` names the holder's GitHub login:

```text
octocat is attached as this document's Planner. A document has one Planner at a time.
```

When the link closes, whether by `detach` or a dropped socket, its account keeps
the ownership for a grace period, 2 minutes unless the operator sets
`PLANNER_ATTACH_GRACE_MS`. During it the same account can attach again and keeps
the ownership; another account is refused with `planner-attached`, and the
`message` says until when the holder keeps it:

```text
octocat detached from this document's Planner and holds it until 2026-10-10T19:42:00.000Z unless they reattach. A document has one Planner at a time.
```

When the grace period ends the ownership is released and any eligible account
can attach. A server restart releases every attachment and ownership at once;
reattach after it.

The server checks the account's admission and push or administration access
again before every `start` and every `turn`, and every 5 minutes while the link
is attached. Once either is lost, or the document is archived or deleted, it
sends `refused` with `access-revoked` and closes the link with 4403; the turn
that triggered the check fails. A GitHub outage during a periodic check leaves
the link open.

The ownership also ends, without a grace period, when the browser sign-in it
rests on ends or the document's Planner is reset. The server then sends
`refused` and closes an attached link at once, and any eligible account,
including the same one, can attach again immediately:

| Cause                                                                                         | Refusal code       | Close code |
| --------------------------------------------------------------------------------------------- | ------------------ | ---------- |
| The owner's browser sign-in signs out or expires                                              | `sign-in-required` | 4401       |
| The machine whose credential attached it is disconnected, or GitHub refuses its authorization | `access-revoked`   | 4403       |
| A repository writer resets the document's Planner                                             | `access-revoked`   | 4403       |
| The stored ownership no longer names this attachment's sign-in                                | `access-revoked`   | 4403       |

The same checks before every `start` and `turn`, and the periodic one, also
find an expired sign-in or a released ownership that nothing reported; an
expired sign-in is reported as `sign-in-required` even when the stored
ownership already reads as released. An `@chopin` message or `invoke_planner`
call makes the same check first, so a link it finds stale is closed this way and
the request is refused as [without an attached Planner](#without-an-attached-planner).
An `attach` that is still in progress when one of these causes lands, including
a reattach within the grace period, is refused with the same code and close code
instead of attaching; a fresh attach whose sign-in ends while the server checks
it is refused with `sign-in-required` (4401). The `message` says what happened:

```text
The Chopin browser sign-in that made octocat this document's Planner ended, so the Planner was released. Sign in to Chopin at https://chopin.example in a browser as octocat, then attach again.
A repository writer reset this document's Planner, so octocat is no longer attached. Attach again to resume.
This document's Planner ownership was released, so octocat is no longer attached. Attach again to resume.
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
| `unavailable`          | 1011       | The server could not check the document                                |

### Without an attached Planner

On a server running `HARNESS=remote`, an `@chopin` message in the browser and
an MCP `invoke_planner` call for a document with no attached client are refused
with the code `planner-not-attached`, and nothing is posted or queued. A
document whose Planner is within its grace period counts as unattached, and so
does one whose attached link the request finds stale: its owner's browser
sign-in has ended or the stored ownership no longer names it. The request closes
that link before it is refused. The refusal's message names the document URL:

```text
No Planner is attached to this document. To attach one, connect a Planner client to <document URL> over the Planner link from a session in a checkout of <owner/name>; that session becomes this document's Planner.
```

[Local agent MCP](local-agent-mcp.md#hand-an-instruction-to-the-planner) shows
how `invoke_planner` returns it. Once a client is attached, both arrive as
`turn`s on its link.

## Server to client

```text
{ "type": "start", "session": "", "mode": "planner" }
{ "type": "turn", "session": "", "turn": "", "prompt": "", "instructions?": "", "model?": "", "tools": [], "responseFormat?": {} }
{ "type": "abort", "session": "", "turn": "" }
{ "type": "host-tool-result", "session": "", "turn": "", "toolCallId": "", "output": json, "isError?": true }
{ "type": "input-result", "request": "", "status": "answered", "value?": json, "message?": "" }
{ "type": "stop", "request": "", "session": "", "run?": "" }
{ "type": "resume", "request": "", "session": "", "run?": "" }
{ "type": "destroy", "session": "" }
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
  system prompt for the turn. `model` is set only when the operator configured
  `MODEL`. `responseFormat` is `{ "type": "text" }` or
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
- `input-result` answers an `input-request` (see [Questions](#questions)).
- `stop` and `resume` are **Stop Planner** and **Resume Planner**: pause or
  resume every workflow run of the session, or only `run`. Answer with
  `control-result` within **10 seconds**.
- `destroy` ends the session; abandon its turn, its waiting host calls, and its
  questions.
- `error` precedes a close for a protocol violation (see [Closing](#closing)).

## Client to server

```text
{ "type": "started", "session": "" }
{ "type": "start-failed", "session": "", "message": "" }
{ "type": "tools", "session": "", "turn": "", "names": [] }
{ "type": "part", "session": "", "turn": "", "part": {} }
{ "type": "host-tool-call", "session": "", "turn": "", "toolCallId": "", "toolName": "", "input": "{}" }
{ "type": "turn-end", "session": "", "turn": "", "status": "finished", "message?": "" }
{ "type": "input-request", "request": "", "session": "", "workflowRunId?": "", "workflowStageId?": "", "rootRunId?": "", "input": {} }
{ "type": "input-cancel", "request": "" }
{ "type": "runs", "session": "", "active": [], "paused": [], "cards": [] }
{ "type": "control-result", "request": "", "ok": true, "message?": "" }
{ "type": "detach" }
```

- `started` or `start-failed` answers `start`. Cut `message` here, in
  `turn-end`, `control-result`, and an `error` part to 4000 characters: a longer
  one is a malformed message and closes the link.
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
- `input-request` and `input-cancel` ask and withdraw questions. A `request` id
  may not repeat on the link, even after its question has its `input-result`.
  The server remembers every open id and the last 1,024 ids it received; a
  remembered id sent again is a `protocol` violation that closes the link. Use
  fresh ids, such as UUIDs.
- `runs` reports the session's workflow runs whenever they change. Report them
  before `turn-end` so the server keeps the session while runs are live. Reports
  only change run cards and Chat notices; they never start a Planner turn.
- `control-result` answers `stop` or `resume`.
- `detach` closes the link with code 1000. The account keeps the document's
  Planner for the grace period in [Ownership](#ownership).

Messages for a session or turn that has ended are ignored, except a
`host-tool-call`, which gets an error result (`The turn has ended.` or
`The session has ended.`).

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

The envelope has exactly these fields. `@chopin/planner-link` exports it as
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
what crosses the link: `host-tool-result.output` reaches the client exactly as
the host tool returned it, and a failed host call keeps its
`{ "error": "<message>" }` output.

## Questions

An `input-request` carries one Atomic `HostInput` call in `input`, and becomes
Decisions in the document:

```text
{ "method": "questionnaire", "params": { "questions": [{ "question": "", "header": "", "options": [{ "label": "", "description": "", "preview?": "" }], "multiSelect?": true }] } }
{ "method": "confirm", "title": "", "message": "" }
{ "method": "select", "title": "", "choices": [] }
{ "method": "input", "title": "", "placeholder?": "" }
{ "method": "editor", "title": "", "initial?": "" }
```

A questionnaire has 1 to 16 questions of up to 32 options; `preview` may be
16,000 characters; `select` offers up to 32 choices. The document's own limits
still apply. Text is shown verbatim.

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
- `expired`: nobody answered within 30 minutes. The cards stay in Decisions
  marked expired and no partial answers are returned.
- `cancelled`: a member cancelled a question, the client sent `input-cancel`,
  the question was withdrawn before it was asked, the session ended, or the link
  closed. Open cards are withdrawn. When a member cancelled one question of a
  questionnaire after others were answered, `answers` keeps those others; it is
  empty in every other case. The package client settles a question withdrawn
  before it was sent, or one still open when the link closes, with a local
  `cancelled` result that has a `message` and no `value`.
- `failed`: the request could not become Decisions, for example in an isolated
  session or with 16 requests already open on the link.

A questionnaire `answers` array lists only answered questions, in question
order; an unanswered question has no entry. Each entry is Atomic's
`QuestionAnswer`:

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

`runs.cards` are run cards as Chat shows them, at most 64:

```text
{ "id": "", "name": "", "status": "running", "started": 0, "updated": 0, "ended?": 0, "stages": [], "earlierStages?": 0, "waiting": 0 }
```

`status` is one of `running`, `waiting`, `paused`, `finished`, `blocked`,
`failed`, `stopped`; times are whole seconds since the epoch; `waiting` counts
open questions. Up to 64 `stages` are
`{ "id": "", "name": "", "kind?": "tool", "status": "", "started?": 0, "ended?": 0 }`
with `status` one of `pending`, `running`, `awaiting_input`, `paused`, `blocked`,
`completed`, `failed`, `skipped`. `active` and `paused` list at most 64 root run
ids. When the link closes, the server shows the reported live runs as stopped.

## Closing

| Close code | Sent after                                     | Meaning                                         |
| ---------- | ---------------------------------------------- | ----------------------------------------------- |
| 1000       | `detach`                                       | The client detached                             |
| 1001       | nothing                                        | No pong or message within the [timeout](#pings) |
| 1008       | `error` with `malformed-message` or `protocol` | Unparseable, invalid, or out-of-order message   |
| 1009       | `error` with `message-too-large`               | A frame over 2 MiB                              |
| 1011       | `refused` with `unavailable`                   | The server could not check the document         |
| 4401       | `refused`                                      | `sign-in-required`                              |
| 4403       | `refused`                                      | `repository-forbidden` or `access-revoked`      |
| 4404       | `refused`                                      | `document-unavailable` or `document-archived`   |
| 4409       | `refused`                                      | `planner-attached`                              |
| 4426       | `refused`                                      | `unsupported-version`                           |

`protocol` covers a message before `attach` is answered, a second `attach`, and
a repeated `input-request` id the server remembers. When the link closes for
any reason, the server ends a running turn with an error, stops the turn's host
tools still running, withdraws open questions and the Decisions those tools
opened, and forgets the link; reattaching starts new sessions. The account keeps
the document's Planner ownership for the grace period described in
[Ownership](#ownership). A server never replays an interrupted turn.

A client that receives a frame it cannot parse should close with 4400 and reason
`malformed-message`. Node.js's `WebSocket` lets a caller close only with 1000 or
3000 to 4999, so a client cannot answer with 1008. The package client does
this and settles everything still waiting on the link at once.

## Planner backend commands

A paired machine can run a document's Planner without a browser sign-in. The
`chopin` CLI starts a Planner backend command for each document it is given and
hands it a credential; the backend attaches over this link like any client.

```sh
chopin connect . --planner https://chopin.example/octo-org/score/plan \
  --planner-command "my-planner --flag" -- copilot --acp
```

`--planner` may repeat. `--planner-command` is split into words as a POSIX
shell would, without expanding anything: single and double quotes, also inside
a word as in `--label="two words"`, and backslash escapes outside single
quotes; an unmatched quote is refused. `CHOPIN_PLANNER_COMMAND` may hold the
command as a JSON array of words instead. The command runs in the checkout
`connect` serves, in its own process group, with its standard output and error
going to the connector's.

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
credential can open links to that one document for **15 minutes**. A link it
opened does not depend on it afterwards: the server rechecks the machine as it
rechecks any owner. Chopin keeps only its hash, in memory, so a server restart
forgets it as it releases every attachment.

Attached this way, the document's Planner owner is a login of the machine's
owner that no browser holds, whose GitHub token is the machine's own; Chopin's
repository tools act with it.

### What the backend must do

- Read `CHOPIN_URL` (the server's origin), `CHOPIN_DOCUMENT` (the document as
  given to `--planner`) and `CHOPIN_PLANNER_TOKEN` from its environment. The
  token is never in its arguments; do not log it.
- Open `/planner-link` on `CHOPIN_URL` with
  `Authorization: Bearer <CHOPIN_PLANNER_TOKEN>`, and `attach` to
  `CHOPIN_DOCUMENT`.
- On HTTP 401 at the upgrade, or when the link closes for any reason other than
  its own `detach`, exit. Within the credential's 15 minutes a backend may
  instead reattach once after 1001 or a dropped socket; after that the
  credential is refused and it must exit.
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
an earlier link of the same machine still counts as attached is started again
on that backoff until the server notices that link is gone (up to the
120-second timeout in [Pings](#pings)); a closed link's grace period does not
block the same machine.
