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

The server checks the bearer before upgrading and answers a refusal over HTTP,
so nothing is opened:

| Status | Meaning                                                     |
| ------ | ----------------------------------------------------------- |
| 404    | The server does not run `HARNESS=remote` with `AGENT` on    |
| 401    | Missing or malformed bearer, or GitHub rejected the token   |
| 403    | The account fails instance admission, or a foreign `Origin` |
| 503    | GitHub is unavailable or rate limiting; retry later         |
| 500    | Any other admission failure                                 |

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
`url` at most 2048. `attach` succeeds when the bearer's GitHub account has pull
access to the document's repository. After `refused` the server closes the link.

The server checks the account's admission and pull access again before every
`start` and every `turn`, and every 5 minutes while the link is attached. Once
either is lost it sends `refused` with `access-revoked` and closes the link with
4403; the turn that triggered the check fails. A GitHub outage during a periodic
check leaves the link open.

| Refusal code           | Close code | Meaning                                           |
| ---------------------- | ---------- | ------------------------------------------------- |
| `unsupported-version`  | 4426       | The server speaks another `version`               |
| `repository-forbidden` | 4403       | The account cannot read the document's repository |
| `document-unavailable` | 4404       | No document matches, or it is being deleted       |
| `document-archived`    | 4404       | The document is archived                          |
| `access-revoked`       | 4403       | Access was lost after attaching (see below)       |
| `unavailable`          | 1011       | The server could not check the document           |

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
- `detach` closes the link with code 1000.

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
- `finishReason.unified` is one of `stop`, `length`, `content-filter`,
  `tool-calls`, `error`, `other`. `usage` and `totalUsage` are
  `{ "inputTokens": { "total?", "noCache?", "cacheRead?", "cacheWrite?" }, "outputTokens": { "total?", "text?", "reasoning?" } }`
  with non-negative integers.
- `error` fails the turn with that text.

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

| Close code | Sent after                                     | Meaning                                       |
| ---------- | ---------------------------------------------- | --------------------------------------------- |
| 1000       | `detach`                                       | The client detached                           |
| 1008       | `error` with `malformed-message` or `protocol` | Unparseable, invalid, or out-of-order message |
| 1009       | `error` with `message-too-large`               | A frame over 2 MiB                            |
| 1011       | `refused` with `unavailable`                   | The server could not check the document       |
| 4403       | `refused`                                      | `repository-forbidden` or `access-revoked`    |
| 4404       | `refused`                                      | `document-unavailable` or `document-archived` |
| 4426       | `refused`                                      | `unsupported-version`                         |

`protocol` covers a message before `attach` is answered, a second `attach`, and
a repeated `input-request` id the server remembers. When the link closes for
any reason, the server ends a running turn with an error, stops the turn's host
tools still running, withdraws open questions and the Decisions those tools
opened, and forgets the link; reattaching starts new sessions. A server never
replays an interrupted turn.

A client that receives a frame it cannot parse should close with 4400 and reason
`malformed-message`. Node.js's `WebSocket` lets a caller close only with 1000 or
3000 to 4999, so a client cannot answer with 1008. The package client does
this and settles everything still waiting on the link at once.
