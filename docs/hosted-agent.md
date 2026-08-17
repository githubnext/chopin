# Copilot agent

Channels use the GitHub App user access token of the first editor who invokes the
planner. That login session owns the channel's Copilot usage until it expires,
logs out, or an editor chooses **New planner session**. Ownership is assigned
atomically in the storage adapter and guarded by a generation token.

Reset and logout abort and discard any active SDK session. Permission
callbacks also recheck the owner session, ownership generation and repository
write access before each custom or MCP tool call. The in-memory session is also
bound to the encrypted credential revision, so a rotated token cannot authorize
one check while an older copied token executes the tool.

The shared Copilot runtime runs in SDK `mode: "empty"`. Each SDK session
receives its owner's token at session creation and has no client-level service
token, logged-in-user fallback, checkout, shell, host filesystem, skills,
plugins, config discovery, custom repository instructions, shared embeddings or
cross-session store.

Available capabilities are:

- Chopin's plan, question and relationship tools;
- bounded file, tree, code-search and commit-history tools fixed to the selected
  repository; and
- repository-bound, read-only pull-request MCP calls. Issue and search MCP tools
  are refused because linked objects and free-form qualifiers can cross a
  repository boundary.

The repository REST tools construct owner and repository coordinates on the
server. They bound response sizes, line ranges and result counts, reject path
escape, and post-filter code search by GitHub repository node ID.

Copilot CLI session files are disposable. When the process or room restarts,
Chopin creates a new SDK session and supplies persisted transcript context; the
current plan is read through `read_plan`. No SDK session ID is stored.

GitHub App user access tokens charge the owning user's Copilot subscription.
Chopin cannot prove entitlement at login: a user without Copilot sees the
provider failure on their first planner turn and remains owner until the channel
is reset, they log out, or their login session expires.

The token is copied into the SDK session, custom repository tools, and remote
MCP headers. Before an eight-hour token is refreshed, Chopin aborts and discards
every in-memory agent using its credential revision. A session still active near
expiry is stopped by a timer. The next turn creates a fresh SDK session and
bootstraps it from the durable plan and bounded transcript. An interrupted turn
is visible and is never replayed automatically because it may already have made
durable edits.

The runtime is started lazily. `AGENT=off` keeps the planner hidden and does not
start Copilot CLI.
