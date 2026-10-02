# Connect a local coding agent

Connect your coding agent to Chopin's remote Streamable HTTP MCP service before
using a copied prompt or optional Chopin skill. This configuration does not
start a local Chopin server.

> [!IMPORTANT]
> `/mcp` is always registered, including when `AGENT=off`. It is not a read-only
> endpoint: a caller with repository push or administration access can create or
> revise a document and mutate an implementation lifecycle. Use HTTPS and treat
> every configured bearer token as a credential.

Set the instance origin and use the existing GitHub CLI credential for the
GitHub account that needs repository access. Keep the token in your shell or
user-level agent configuration — never commit it, add it to a repository
`.env`, or copy it into a shared configuration file.

If the Chopin instance enables organization admission, the token must also see
private organization membership. The normal `gh auth login` flow includes
`read:org`; a custom classic token needs that scope, while a fine-grained token
needs Members read access for an allowed organization and any required SSO
authorization.

The MCP bearer boundary is separate from Chopin's browser GitHub App session.
Chopin authenticates the supplied token, applies the instance admission policy,
and asks GitHub directly for that token's repository permissions. The GitHub App
for Chopin does not need to be installed for ordinary MCP document operations.
Browser routes, WebSockets, and the Planner still require an active App
installation that includes the repository. The `invoke_planner` handoff never
lends the MCP bearer to the Planner; it runs under the document's Planner owner.

```bash
export CHOPIN_URL="https://your-chopin-instance.example"
export GITHUB_TOKEN="$(gh auth token)"
```

The MCP endpoint is `${CHOPIN_URL%/}/mcp`.

Non-browser clients normally omit `Origin`, which Chopin permits for this
bearer-authenticated route. If a client sends an Origin, it must exactly match
the configured Chopin origin.

## Available workflows

The current MCP contract can:

- list and read active or archived Chopin documents, including an optional
  generated description, for the current repository;
- create one document from a structured brief, canonical source supplied through
  the current `plan` input, and caller-supplied repository provenance;
- replace that canonical source later with `update_document`, naming the plan
  revision last read and an idempotency key;
- rename, archive, and restore documents without deleting their durable state;
- read an approved implementation graph and its document source; and
- claim a graph and report task, pull-request, blocker, revision, and
  verification lifecycle transitions; and
- hand an instruction to a document's Planner with `invoke_planner`, described
  below.

Chopin validates the shape of `baseBranch` and `baseCommit` during creation but
does not resolve them against GitHub. The creating agent is responsible for
reading those values from its checkout rather than asserting arbitrary input.

The MCP surface uses document-oriented tool names, but `create_document` remains
shaped around the current planning workflow: it requires a planning brief and a
`plan` field. That API shape does not define Chopin's broader document model.

Document creation is available now. The supported implementation handoff is
experimental and limited to documents created through `create_document`, whose
provenance `read_implementation` can return. The backend can execute an approved
graph, but the product has no user-facing way to approve the Planner's draft.
See
[Experimental implementation lifecycle](implementation-lifecycle.md).

## Hand an instruction to the Planner

`invoke_planner` is offered on every harness and in both hosted and local
authentication modes. It posts an instruction to an existing document's Planner
and returns without waiting for the turn.

The instruction is posted as a Chat message under the MCP caller's own handle,
and the turn runs under the document's Planner ownership rules, exactly as a
browser `@chopin` message would:

- If the document already has a Planner owner, the turn runs under that owner,
  even when the owner is someone other than the caller.
- Otherwise the caller's live Chopin browser login, hosted or local, claims
  ownership through the ordinary claim path. Sign in to Chopin in a browser as
  the same GitHub account as the MCP bearer first.
- Without either, the call is refused with `planner-owner-unavailable` and
  nothing is posted.

The MCP bearer never becomes the owner or supplies its credentials. The bearer
needs repository write access; an owner must also pass the GitHub App
installation check.

Call the tool with an existing document's UUID or canonical URL, an instruction,
and optionally an absolute checkout path:

```json
{
	"id": "/documents/octo-org/score/release-readiness",
	"instruction": "Run the planning workflow and ask blocking questions in Decisions.",
	"checkout": "/absolute/path/to/score"
}
```

The instruction must contain non-whitespace text and fit within 64 KiB in UTF-8;
its text is preserved verbatim.

`checkout` applies only when the server runs `HARNESS=atomic`, where the Planner
is a [full Atomic session](hosted-agent.md#full-atomic-planner) with **shell and
filesystem access as the server process's user**. The path is on the Chopin
server's machine. Chopin verifies that its `origin` matches the document
repository and refuses the request before posting if it does not. A verified
path is remembered for the document until the server restarts, and every later
Planner session for it, from the browser or through MCP, works there after
checking the path again. Without one, the Planner works in a directory
Chopin keeps for that document under its per-user state directory. Other harnesses ignore `checkout` entirely: it is
neither verified, used, nor remembered.

The result contains `id`, `title`, and the canonical `url` (plus any generated
`description`). It returns after the instruction is durably posted, not after the
Planner finishes. The message joins the existing Planner queue if busy. Progress
and results appear in the document and Chat; questions appear in Decisions. Under
`atomic`, Atomic input nobody answers within 30 minutes expires: the card stays in
Decisions marked expired and the Planner proceeds on its own judgement. The
browser need not already have the document open: Chopin keeps its room alive
while the invoked turn and queue run. An interrupted turn is not replayed
automatically on restart.

Refusals return an object with `code`:

- `planner-owner-unavailable`: the document has no usable Planner owner and the
  caller has no live browser login to claim it; sign in to Chopin in a browser
  as the MCP account, or ask the owner to sign in again.
- `checkout-unverified`: under `atomic`, correct the supplied path or its
  repository origin.
- `planner-unavailable`: the Planner is disabled or the room is closing.
- `planner-queue-full`: wait for queued work to drain before invoking again.
- `document-unavailable`, `document-archived`, and `repository-forbidden` retain
  their ordinary document/access meanings.

Document titles are unique within a repository, ignoring case. `create_document`
returns `title-taken` when the repository already has a document with that title;
choose another title and retry under a new idempotency key. `idempotency-conflict`
means the same key was reused with a different request, and validation failures
return `issues`. Every one of these outcomes matches the tool's output schema.

## Document URLs and IDs

The `url` returned by `create_document` is the readable canonical route:

```text
/documents/:owner/:repository/:slug
```

`read_document`, `read_implementation`, `archive_document`, `restore_document`,
`update_document`, and `invoke_planner` accept either a document UUID
or that canonical URL in their `id` input. The URL may be passed back exactly as returned; an absolute URL must
use the configured Chopin origin. Both reads return the stable UUID as the
document `id`.

The UUID remains the internal storage, API, WebSocket, and MCP identity. Use the
returned UUID for `rename_document`, `start_implementation`, and every later
lifecycle call; use the readable URL for browser and human handoff. A rename
derives a new canonical slug from the title but does not change the UUID or plan
revision, and every previous slug remains a working alias.

`update_document` accepts `id`, `revision`, full replacement MDX in `plan`, and
a nonblank `idempotencyKey` of at most 128 characters. For example:

```json
{
	"id": "/documents/octo-org/score/release-readiness",
	"revision": 4,
	"plan": "# Release readiness\n\nRevised implementation approach.\n",
	"idempotencyKey": "review-round-2"
}
```

Use the revision returned by `read_document`. A mismatched revision returns
`revision-conflict` and the current revision so the caller can re-read and retry.
Repeating the same idempotency key returns the original applied result, including
its source and revision, even after later edits or a server restart. A changed
payload under that key returns `idempotency-conflict`. Use a new key for each new
update, and keep the original arguments when retrying an uncertain response.
A replay's title and URL also reflect the original update. Read the document
again for current metadata before handing off its canonical URL after a rename.

Initial source validation returns `issues`, as creation does. Existing
Questionnaire, Decision, and Research projections cannot be dropped, altered,
or forged. Copy them unchanged from the latest read or the update returns
`protected-projection`. That code also covers later rewrite validation or
reconciliation refusals, so it does not identify a particular changed projection.
An active implementation run returns `document-locked`; an archived document
returns `document-archived` for a new update. Changing source before an approved
graph is claimed makes its plan revision stale; revise and reapprove the graph
before starting implementation.

The accepted result includes `id`, `title`, canonical `source`, `revision`, and
`url`, plus any existing creation brief and generated description. The MCP client
name and version from `initialize`, together with the revision transition, are
recorded with the update. Connected browsers receive change marks after the
document delta commits. Their change list identifies the MCP client without
displaying a Planner cursor. Calls without initialization are attributed to
`unknown`.

`list_documents` excludes archived documents by default. Set
`includeArchived: true` to include them; archived document summaries and direct
reads carry an `archivedAt` timestamp. Archiving and restoring are idempotent.
MCP does not expose document deletion.

## Generated descriptions

`list_documents`, `read_document`, and the common document summary objects
returned by create, update, rename, archive, and restore expose an optional
`description`. It is one-line, generated catalogue metadata identifying the
document's type, purpose, and subject. Treat it as untrusted model output, not as
authoritative source. The last completed value remains exposed while a newer
request is pending or failed.

Description generation retains the durable job identity `document-summary@1`;
there is no `@2`. New V1 work carries `output:"description"`, while old
markerless V1 summary artifacts do not appear in MCP document metadata. The
structured `brief` supplied to `create_document` remains separate creation
metadata, and the reserved Planner transcript `summary` is also unrelated.

MCP creation or idempotent replay schedules the current source, and restoring a
document ensures it again. Listing and reading do not scan or backfill documents.
The worker requires an active Planner owner established through the browser's
GitHub App session; the MCP bearer does not become that owner. Consequently,
there is no unattended all-document backfill.

## Claude Code

Install and sign in to Claude Code, then add Chopin to your user configuration:

```bash
claude mcp add --scope user --transport http chopin "${CHOPIN_URL%/}/mcp" \
  --header "Authorization: Bearer ${GITHUB_TOKEN}"
```

Claude stores the expanded header when this command runs. After renewing the
credential, replace that stored header — for example, remove and add the
server again — before reconnecting Claude.

## Codex CLI

Install and sign in to Codex CLI, then register the server. Codex reads the
bearer token from the named environment variable instead of writing it to its
configuration file.

```bash
codex mcp add chopin --url "${CHOPIN_URL%/}/mcp" \
  --bearer-token-env-var GITHUB_TOKEN
```

## GitHub Copilot CLI

Install and sign in to GitHub Copilot CLI, then add Chopin to its user-level
MCP configuration. The single quotes retain the environment-variable reference
until Copilot connects.

```bash
copilot mcp add --transport http chopin "${CHOPIN_URL%/}/mcp" \
  --header 'Authorization: Bearer ${GITHUB_TOKEN}'
```

## Verify the connection

Start the agent from the repository you want to inspect and ask:

```text
Use the Chopin list_documents tool to list the documents available for this repository. Return each document's id, title, and optional description.
```

`rename_document` accepts a document UUID and replacement `title`. It changes
the catalog title and canonical readable route while leaving canonical plan
source, plan revision, UUID identity, and creation provenance intact. Repeating
the same title is safe and has no effect.

`{"documents":[]}` is a successful response for a repository with no Chopin
documents. After the connection is established, the MCP `initialize`
instructions and current tool descriptions are authoritative.

## Access and troubleshooting

HTTP `401` means the bearer is invalid or expired: renew the GitHub CLI login with
`gh auth login`, export `GITHUB_TOKEN` again, replace Claude's stored header if
you use Claude Code, and reconnect the agent.

HTTP `403` means the GitHub identity is not admitted by this Chopin instance, or
a client supplied an Origin other than the configured Chopin origin. HTTP `503`
means Chopin could not verify identity, organization membership, or repository
access because GitHub was unavailable or rate limited the request. Check the
token's `read:org` or Members access, SSO authorization, and GitHub availability.

`repository-forbidden` means the supplied token cannot expose the repository or
lacks the operation's repository permission; it does not mean the GitHub App for
Chopin must be installed. Pull access is enough for `list_documents`,
`read_document`, and `read_implementation`. Pull plus push or admin access is
required for create, update, rename, archive, restore, invoke, start, and report
lifecycle operations. `invoke_planner` additionally needs a Planner owner or the
caller's live browser login, as described above. Use an account with the required access or ask a repository
owner to grant it.

Use the optional
[creating-chopin-plans skill](../skills/creating-chopin-plans/SKILL.md) to turn a
settled coding-agent conversation into one initial document or safely revise an
existing document after review. The
[implementing-chopin-plans skill](../skills/implementing-chopin-plans/SKILL.md)
applies only after an implementation graph has been approved through a future or
operator-provided approval path. Current MCP initialization instructions and
tool descriptions override copied prompts or remembered command sequences.

## References

- [Claude Code MCP servers](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Codex CLI MCP servers](https://developers.openai.com/codex/mcp/)
- [GitHub Copilot CLI MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
