CREATE TABLE planner_credentials (
	digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
	machine_id text NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	expires_at timestamptz NOT NULL
);
CREATE INDEX planner_credentials_machine ON planner_credentials(machine_id, channel_id);
CREATE INDEX planner_credentials_expiry ON planner_credentials(expires_at);
