# Connect a local coding agent

Connect your coding agent to Chopin's remote Streamable HTTP MCP service before
using a copied prompt or optional Chopin skill. This configuration does not
start a local Chopin server.

Set the workspace origin and use the existing GitHub CLI credential for the
GitHub account that needs repository access. Keep the token in your shell or
user-level agent configuration — never commit it, add it to a repository
`.env`, or copy it into a shared configuration file.

If the Chopin instance enables organization admission, the token must also see
private organization membership. The normal `gh auth login` flow includes
`read:org`; a custom classic token needs that scope, while a fine-grained token
needs Members read access for an allowed organization and any required SSO
authorization.

```bash
export CHOPIN_URL="https://your-chopin-workspace.example"
export GITHUB_TOKEN="$(gh auth token)"
```

The MCP endpoint is `${CHOPIN_URL%/}/mcp`.

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

`{"documents":[]}` is a successful response for a repository with no Chopin
documents. After the connection is established, the MCP `initialize`
instructions and current tool descriptions are authoritative.

## Access and troubleshooting

HTTP `401` means bearer authentication failed: renew the GitHub CLI login with
`gh auth login`, export `GITHUB_TOKEN` again, replace Claude's stored header if
you use Claude Code, and reconnect the agent.

HTTP `403` means the GitHub identity is not admitted by this Chopin instance.
HTTP `503` means Chopin could not verify admission; check the token's `read:org`
or Members access, SSO authorization, and GitHub availability.

`repository-forbidden` means the identity authenticated but lacks the
operation's repository permission. Pull access is enough for
`list_documents`, `read_document`, and `read_implementation`. Push or admin
access is required for create, start, and report lifecycle operations. Use an
account with the required access or ask a repository owner to grant it.

## References

- [Claude Code MCP servers](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Codex CLI MCP servers](https://developers.openai.com/codex/mcp/)
- [GitHub Copilot CLI MCP servers](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
