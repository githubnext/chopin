CREATE TABLE mcp_sessions (
	id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
	user_id text NOT NULL,
	client_name text NOT NULL,
	client_version text NOT NULL,
	created_at timestamptz NOT NULL,
	last_seen_at timestamptz NOT NULL
);
CREATE INDEX mcp_sessions_idle ON mcp_sessions(last_seen_at);
