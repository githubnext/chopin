CREATE TABLE users (
	id text PRIMARY KEY,
	login text NOT NULL,
	avatar_url text NOT NULL,
	created_at timestamptz NOT NULL,
	updated_at timestamptz NOT NULL
);

CREATE TABLE web_sessions (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users(id),
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL
);

CREATE INDEX web_sessions_expiry ON web_sessions (expires_at);

CREATE TABLE channels (
	id text PRIMARY KEY,
	repository_id text NOT NULL,
	repository_owner text NOT NULL,
	repository_name text NOT NULL,
	title text NOT NULL,
	created_by text NOT NULL REFERENCES users(id),
	revision bigint NOT NULL DEFAULT 0,
	next_sequence bigint NOT NULL DEFAULT 1,
	created_at timestamptz NOT NULL,
	updated_at timestamptz NOT NULL
);

CREATE INDEX channels_repository_listing
	ON channels (repository_id, updated_at DESC, id ASC);

CREATE UNIQUE INDEX channels_repository_title_ci
	ON channels (repository_id, lower(title));

CREATE TABLE channel_state (
	channel_id text PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
	sidecar jsonb NOT NULL DEFAULT 'null'::jsonb
);

CREATE TABLE channel_snapshots (
	channel_id text PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
	generation text NOT NULL,
	revision bigint NOT NULL,
	through_sequence bigint NOT NULL,
	epoch text NOT NULL,
	source text NOT NULL,
	source_hash text NOT NULL,
	document bytea NOT NULL,
	sidecar jsonb NOT NULL,
	created_at timestamptz NOT NULL
);

CREATE TABLE channel_operations (
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	operation_id text NOT NULL,
	sequence bigint NOT NULL,
	revision bigint NOT NULL,
	PRIMARY KEY (channel_id, operation_id),
	UNIQUE (channel_id, sequence)
);

CREATE TABLE channel_updates (
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	sequence bigint NOT NULL,
	revision bigint NOT NULL,
	epoch text NOT NULL,
	update bytea NOT NULL,
	PRIMARY KEY (channel_id, sequence)
);

CREATE TABLE channel_events (
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	sequence bigint NOT NULL,
	ordinal integer NOT NULL,
	id text NOT NULL,
	kind text NOT NULL,
	payload jsonb NOT NULL,
	created_at timestamptz NOT NULL,
	PRIMARY KEY (channel_id, sequence, ordinal),
	UNIQUE (channel_id, id)
);

CREATE INDEX channel_events_order ON channel_events (channel_id, sequence, ordinal);

CREATE TABLE agent_state (
	channel_id text PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
	owner_session_id text REFERENCES web_sessions(id) ON DELETE SET NULL,
	generation bigint NOT NULL,
	summary text NOT NULL DEFAULT '',
	transcript_cursor bigint NOT NULL DEFAULT 0,
	status text NOT NULL CHECK (status IN ('ready', 'unavailable')),
	updated_at timestamptz NOT NULL
);

CREATE TABLE storage_leases (
	name text PRIMARY KEY,
	owner text NOT NULL,
	fencing bigint NOT NULL,
	expires_at timestamptz NOT NULL
);
