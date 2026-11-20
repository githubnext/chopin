-- `invoke_planner` calls made under an idempotency key: one row per caller, document and key,
-- claimed with the result it answers before the instruction is posted, and marked invoked once
-- its turn has started.
CREATE TABLE mcp_invocations (
	user_id text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 128),
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 128),
	fingerprint text NOT NULL CHECK (char_length(fingerprint) BETWEEN 1 AND 128),
	entry_id text NOT NULL CHECK (char_length(entry_id) BETWEEN 1 AND 128),
	result jsonb NOT NULL,
	created_at timestamptz NOT NULL,
	expires_at timestamptz NOT NULL,
	invoked_at timestamptz,
	PRIMARY KEY (user_id, channel_id, key)
);
CREATE INDEX mcp_invocations_expiry ON mcp_invocations(expires_at);
CREATE INDEX mcp_invocations_channel ON mcp_invocations(channel_id);
