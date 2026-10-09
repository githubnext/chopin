ALTER TABLE web_sessions
	ADD COLUMN secret_hash bytea,
	ADD COLUMN credential_ciphertext bytea,
	ADD COLUMN credential_revision bigint,
	ADD CONSTRAINT web_sessions_credentials CHECK (
		(secret_hash IS NULL AND credential_ciphertext IS NULL AND credential_revision IS NULL)
		OR (
			secret_hash IS NOT NULL AND octet_length(secret_hash) = 32
			AND credential_ciphertext IS NOT NULL AND octet_length(credential_ciphertext) > 29
			AND credential_revision IS NOT NULL AND credential_revision > 0
		)
	);
