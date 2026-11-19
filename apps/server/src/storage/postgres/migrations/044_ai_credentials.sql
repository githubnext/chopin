CREATE TABLE ai_credentials (
	user_id text NOT NULL REFERENCES users(id),
	provider text NOT NULL CHECK (provider IN ('github-copilot', 'openai', 'anthropic')),
	kind text NOT NULL CHECK (kind IN ('api-key', 'github-sign-in')),
	ciphertext bytea,
	suffix text CHECK (char_length(suffix) BETWEEN 1 AND 4),
	updated_at timestamptz NOT NULL,
	last_used_at timestamptz,
	PRIMARY KEY (user_id, provider),
	CONSTRAINT ai_credentials_secret CHECK (
		(kind = 'api-key' AND ciphertext IS NOT NULL AND octet_length(ciphertext) > 29)
		OR (
			kind = 'github-sign-in' AND ciphertext IS NULL AND suffix IS NULL
			AND provider = 'github-copilot'
		)
	)
);

CREATE TABLE ai_placeholders (
	digest bytea PRIMARY KEY CHECK (octet_length(digest) = 32),
	launch_id text NOT NULL CHECK (char_length(launch_id) BETWEEN 1 AND 128),
	launch_digest bytea NOT NULL CHECK (octet_length(launch_digest) = 32),
	user_id text NOT NULL REFERENCES users(id),
	provider text NOT NULL CHECK (provider IN ('github-copilot', 'openai', 'anthropic')),
	machine_id text REFERENCES machines(id) ON DELETE CASCADE,
	channel_id text REFERENCES channels(id) ON DELETE CASCADE,
	expires_at timestamptz NOT NULL
);
CREATE INDEX ai_placeholders_launch ON ai_placeholders(launch_id);
CREATE INDEX ai_placeholders_launch_digest ON ai_placeholders(launch_digest);
CREATE INDEX ai_placeholders_machine ON ai_placeholders(machine_id) WHERE machine_id IS NOT NULL;
CREATE INDEX ai_placeholders_expiry ON ai_placeholders(expires_at);
