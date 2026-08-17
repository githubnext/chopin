# Repository channels

Chopin keeps channel metadata in the selected storage adapter and uses
GitHub as the current authorization source. A repository must appear in the
intersection of the authenticated user's access and a personal or organization
GitHub App installation. The installation must include that repository. Merely
being public is not enough to expose its Chopin channels.

GitHub read access may list and open channels. Push or admin access may create a
channel and mutate its plan, chat and decisions. The HTTP API and WebSocket
upgrade both recheck those permissions; open sockets revalidate their
session and repository access periodically.

```text
GET  /api/repositories/:owner/:repository/channels
POST /api/repositories/:owner/:repository/channels
GET  /api/channels/:channelId
POST /api/channels/:channelId/agent/reset
```

Channel IDs are random lowercase UUIDs. The stored repository node ID is the
authority; owner and name are retained to resolve the repository and are never
trusted as substitutes for that ID.

The web client uses ordinary document navigation:

```text
/                                      repository list
/repositories/:owner/:repository      channel list and creation
/channels/:channelId                   chat, plan and decisions workspace
```

Channels persist their canonical MDX, complete Yjs checkpoint,
post-checkpoint update journal, transcript, authoritative open/answered/cancelled
question records and draft CRDTs, comment records, decisions, and question or
comment relationships through `StorageAdapter.collaboration`. Checkpointing
deletes journal updates through the checkpoint sequence; it is a recovery tail,
not permanent document history. A client update is acknowledged only after its
fenced durable commit.

Agent turns use the first invoking editor's GitHub App session and
repository-scoped GitHub tools. The isolation and ownership model is described
in [Copilot agent](hosted-agent.md).
