# Connect a local coding agent

Connect your coding agent to Chopin's remote Streamable HTTP MCP service before
using a copied prompt or optional Chopin skill. This configuration does not
start a local Chopin server.

> [!IMPORTANT]
> `/mcp` is always registered, including when `AGENT=off`. It is not a read-only
> endpoint: a caller with repository push or administration access can create a
> document and mutate an implementation lifecycle. Use HTTPS and treat every
> configured bearer token as a credential.

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
for Chopin does not need to be installed on a repository for MCP access. Browser
routes, WebSockets, and the hosted agent still require an active App
installation that includes the repository.

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

- list and read Chopin documents for the current repository;
- create one document from a structured brief, canonical source supplied through
  the current `plan` input, and caller-supplied repository provenance;
- read an approved implementation graph and its document source; and
- claim a graph and report task, pull-request, blocker, revision, and
  verification lifecycle transitions.

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
Use the Chopin list_documents tool to list the documents available for this repository. Return each document's id and title.
```

`rename_document` accepts a document `id` and replacement `title`. It changes
the catalog title only, leaving canonical plan source, plan revision, and
creation provenance intact. Repeating the same title is safe and has no effect.

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
Chopin must be installed. Pull access is enough for
`list_documents`, `read_document`, and `read_implementation`. Push or admin
access is required for create, rename, start, and report lifecycle operations.
Use an account with the required access or ask a repository owner to grant it.

Use the optional
[creating-chopin-plans skill](../skills/creating-chopin-plans/SKILL.md) to turn a
settled coding-agent conversation into one initial document. The
[implementing-chopin-plans skill](../skills/implementing-chopin-plans/SKILL.md)
applies only after an implementation graph has been approved through a future or
operator-provided approval path. Current MCP initialization instructions and
tool descriptions override copied prompts or remembered command sequences.

## References

- [Claude Code MCP servers](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Codex CLI MCP servers](https://developers.openai.com/codex/mcp/)
- [GitHub Copilot CLI MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
