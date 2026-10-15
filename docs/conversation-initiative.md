# Automatic participation in Chat

Chopin joins ordinary saved conversation without an `@chopin` mention whenever the
Planner is enabled. There is no separate feature flag. A server-side `JEV_API_KEY` is
required at startup for group turn-taking judgments. Participation is independent of
conversation-derived decision and research cards (`CONVERSATION_PLAN`).

One human's saved message normally hands the turn to Chopin. After a short 1.5-second
window that combines rapid messages, Chopin replies without needing Jev to approve the
topic's usefulness. Typing postpones the turn. A brief reply or acknowledgment gets the
same opportunity as a detailed question.

When multiple humans contribute between Chopin's replies, a bounded Jev judgment first
decides whether they have invited Chopin to answer or are exchanging turns with each
other. A direct request such as “Chopin, can you investigate this?” works without `@`.
Direct requests and clear invitations can respond after the short window. Otherwise Chopin
yields and reconsiders after 15 seconds without new messages or typing. That second
judgment normally responds; explicit requests for silence, a closed exchange, or an
explicitly reserved human answer stay quiet. Uncertain initial judgments yield until the
quiet window. Errors and uncertain judgments at that point stay quiet until a new human
message.

The scheduler counts verified contributors since Chopin's latest reply, expiring activity
after two minutes; passive viewers do not count. Two tabs for one person count once and
local demo collaborators count separately. Jev sees conversation history and the current
turn phase, so multiple recent speakers alone do not require waiting. Typing sends only an
activity flag, never an unsent draft. Its lease expires after six seconds without renewal.

Only the latest human message can start an automatic turn. If Chopin has replied since
that message, the opportunity is consumed. Agent text never schedules another turn. The
turn instruction asks for one concise final conversational reply without separate progress
messages, then yields; this is a model instruction, not a hard limit on the number of text
segments a tool-using turn can emit.

The composer's **Chat**/**Chopin** switch (Shift+Tab) addresses a message to the room or
directly to Chopin. Addressing Chopin, like `@chopin`, is an explicit immediate request,
even while someone types. Room messages and natural-language requests use the short
typing-aware judgment window. Already prepared delivery retries preserve their original
destination, text, references and focus.

Automatic participation is always on and cannot be paused. A pause saved by an earlier
release is ignored, and the server refuses `chat:participation` pause requests.

## Configuration

| Setting                              | Default      | Meaning                                                         |
| ------------------------------------ | ------------ | --------------------------------------------------------------- |
| `CONVERSATION_INITIATIVE_SILENCE_MS` | `15000`      | Group silence window, from 1,000 to 60,000 milliseconds.        |
| `CONVERSATION_INITIATIVE_MODEL`      | `jev-1.13.0` | Jev model for turn-taking judgment, independent of `JEV_MODEL`. |
| `JEV_TIMEOUT_MS`                     | `30000`      | Shared timeout for a Jev request.                               |

Group judgments receive the source message, up to ten recent
human/Planner messages, a bounded excerpt of the document, and up to four open decision
questions. The complete encoded context stays below 24,000 characters. Solo replies bypass
this service. Truncation is explicit; an oversized source message in a group conversation
is left to explicit `@chopin` invocation. This sends private conversation and
document context to TypeSafe, separately from the Planner's model provider. Credentials
remain on the server.

## Execution boundaries

Only a newly committed human room message schedules participation. Bursts replace one
pending opportunity; delivery retries retain their original message identity. Agent
messages, document edits, and background results do not schedule another turn. Messages
sent with a child document open cancel pending root work. Only direct requests can start a
turn there, including confident natural-language requests. The server resolves the child
before dispatch and preserves that focus; ordinary child discussion stays quiet. Explicit
`@chopin` requests retain their existing child resolution. An opportunity expires after
five minutes and is never restored after room eviction or process restart.

The source writer must still be present and retain repository write access at dispatch.
The Planner uses the ordinary owner/entitlement checks and existing foreground turn queue.
A first eligible browser contribution can claim Planner ownership, as title maintenance
already can. A remote Planner must already be attached; automatic participation cannot
claim a remote owner. Active turns finish before the opportunity is judged. Implementation
locks and live, waiting, or paused Planner workflows suppress it.

New human messages invalidate scheduled work and stop an automatic turn that is opening or
running. Typing invalidates its judgment or admission until the turn actually starts.
Cancellation never reverses document edits already saved by a turn. Closing the room and
explicit invocation also cancel pending automatic work. An automatic reply appears like any
other Chopin reply, without a separate system notice.

The scheduler lives in `apps/server/src/chat/initiative-schedule.ts`; its runtime adapter
and semantic judgment are adjacent. Other event sources can eventually use the same Chat
instruction lifecycle, but participation deliberately admits only saved human
conversation.

## Development evidence

Deterministic tests cover pacing, typing leases, coalescing, cancellation, and stable
message identity. Browser tests use real sessions, WebSockets, persistence, and the normal
Planner lifecycle with a scripted model boundary. An 18-case synthetic evaluation includes
two solo cases that bypass Jev and 16 live group/paused judgments. The initial run matched
all expected outcomes; a repeat of the final question matched 17 of 18. One brief answer
to Chopin yielded until the group quiet window instead of responding immediately. Direct
requests, human exchanges, quiet-window replies, and explicit silence matched
expectations. This is development evidence, not calibrated accuracy.
