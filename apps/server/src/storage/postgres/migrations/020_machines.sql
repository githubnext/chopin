CREATE TABLE machines (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users(id),
	label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 100),
	repositories jsonb NOT NULL CHECK (jsonb_typeof(repositories) = 'array'),
	auto_run boolean NOT NULL,
	token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
	credential_ciphertext bytea,
	credential_revision bigint,
	created_at timestamptz NOT NULL,
	last_seen_at timestamptz NOT NULL,
	reauthorize_at timestamptz,
	revoked_at timestamptz,
	CONSTRAINT machines_credentials CHECK (
		(credential_ciphertext IS NULL AND credential_revision IS NULL)
		OR (
			credential_ciphertext IS NOT NULL AND octet_length(credential_ciphertext) > 29
			AND credential_revision IS NOT NULL AND credential_revision > 0
		)
	),
	CONSTRAINT machines_revoked_without_credentials CHECK (
		revoked_at IS NULL OR credential_ciphertext IS NULL
	)
);
CREATE INDEX machines_owner ON machines(user_id, created_at DESC) WHERE revoked_at IS NULL;
