# Automatic participation in Chat

With `CONVERSATION_INITIATIVE=on`, Chopin can join ordinary saved conversation
without an `@chopin` mention. This experimental setting is off by default and
requires `AGENT=on` and a server-side `JEV_API_KEY`. It is independent of
conversation-derived decision and research cards (`CONVERSATION_PLAN`).

Chopin waits about 1.5 seconds after a solo contribution becomes quiet. When two
or more people have contributed within the last two minutes, or someone else is
typing, it waits about 15 seconds. People merely viewing the document do not
make a conversation a group discussion. Two tabs for the same person count once;
local demo collaborators count separately. Typing sends only an activity flag,
never an unsent draft. Its lease expires after six seconds without renewal.

Silence is an opportunity to consider speaking, not a reason to speak. A bounded
Jev judgment chooses whether to clarify a concept or human choice, investigate a
repository fact, offer a grounded recommendation, or stay quiet. A winning move
must have probability at least 0.75. Acknowledgments, resolved exchanges, requests
to wait, and questions still awaiting a person's answer should stay quiet. Model
errors and timeouts also stay quiet. Judgment is advisory and can miss a useful
opening; `@chopin` always starts an explicit request immediately.

The small **Chopin joins in** control below Chat pauses automatic participation
for everyone in this document. While paused it reads **Chopin is listening**.
The preference is saved before the control changes and survives reconnects and
server restarts. Re-enabling waits for a new saved contribution. It does not
replay earlier conversation. Direct requests continue to work while paused.

## Configuration

| Setting                              | Default      | Meaning                                                           |
| ------------------------------------ | ------------ | ----------------------------------------------------------------- |
| `CONVERSATION_INITIATIVE`            | `off`        | Enable automatic participation when the Planner is enabled.       |
| `CONVERSATION_INITIATIVE_SILENCE_MS` | `15000`      | Group silence window, from 1,000 to 60,000 milliseconds.          |
| `CONVERSATION_INITIATIVE_MODEL`      | `jev-1.13.0` | Jev model for the relevance judgment, independent of `JEV_MODEL`. |
| `JEV_TIMEOUT_MS`                     | `30000`      | Shared timeout for a Jev request.                                 |

The judge receives the source message, up to ten recent human/Planner messages,
a bounded excerpt of the document, and up to four open decision questions. The
complete encoded context stays below 24,000 characters. Truncation is explicit;
an oversized source message is left to direct invocation. This sends private
conversation and document context to TypeSafe, separately from the Planner's
model provider. Credentials remain on the server.

## Execution boundaries

Only a newly committed human room message schedules participation. Bursts
replace one pending opportunity; delivery retries retain their original message
identity. Agent messages, document edits, and background results do not schedule
another turn. Ordinary messages sent with a child document open cancel pending
automatic work and do not schedule a turn against the root document. Explicit
`@chopin` requests still use the open child as their focus. An opportunity expires
after five minutes and is never restored after room eviction or process restart.

The source writer must still be present and retain repository write access at
dispatch. The Planner uses the ordinary owner/entitlement checks and existing
foreground turn queue. A first eligible browser contribution can claim Planner
ownership, as title maintenance already can. A remote Planner must already be
attached; automatic participation cannot claim a remote owner. Active turns
finish before the opportunity is judged. Implementation locks and live, waiting,
or paused Planner workflows suppress it.

New human messages invalidate scheduled work and stop an automatic turn that is
opening or running. Typing invalidates its judgment or admission until the turn
actually starts. Cancellation never reverses document edits already saved by a
turn. Pausing, closing the room, and explicit invocation also cancel pending
automatic work. A visible system notice explains each admitted intervention.

The scheduler lives in `apps/server/src/chat/initiative-schedule.ts`; its runtime
adapter and semantic judgment are adjacent. Other event sources can eventually
use the same Chat instruction lifecycle, but this experiment deliberately admits
only saved human conversation.

## Development evidence

Deterministic tests cover pacing, typing leases, coalescing, cancellation, and
stable message identity. Browser tests use real sessions, WebSockets, persistence,
and the normal Planner lifecycle with a scripted model boundary. A separate
14-case live Jev development evaluation kept all seven quiet cases quiet and
acted on five of seven useful cases, including confusion about the decision
primitive. Two useful examples abstained. These synthetic examples establish a
development baseline, not calibrated accuracy or a guarantee of helpful turns.
