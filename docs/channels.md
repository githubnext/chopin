# Repository channels

Hosted Chopin keeps channel metadata in the selected storage adapter and uses
GitHub as the current authorization source. A repository must appear in the
authenticated user's owner, collaborator or organization-member repository
listing. Merely being public is not enough to expose its Chopin channels.

GitHub read access may list and open channels. Push or admin access may create a
channel and mutate its plan, chat and decisions. The HTTP API and WebSocket
upgrade both recheck those permissions; open hosted sockets revalidate their
session and repository access periodically.

```text
GET  /api/repositories/:owner/:repository/channels
POST /api/repositories/:owner/:repository/channels
GET  /api/channels/:channelId
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

Hosted channels persist their canonical MDX, complete Yjs checkpoint, accepted
update journal, transcript, questionnaire drafts and comment records through
`StorageAdapter.collaboration`. A client update is acknowledged only after its
fenced durable commit. `DATA_DIR` remains solely for `AUTH_DRIVER=off` legacy
rooms.

The prototype agent is deliberately disabled in hosted mode. It has one global
working directory and credential, which cannot safely serve repository-scoped
users. Hosted agent turns resume only after Copilot runs with the channel
owner's OAuth session and repository-scoped GitHub tools.
