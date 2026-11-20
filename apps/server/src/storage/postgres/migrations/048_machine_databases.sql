CREATE TABLE machine_databases (
	machine_id text PRIMARY KEY REFERENCES machines(id),
	role_name text NOT NULL UNIQUE CHECK (role_name ~ '^m_[a-z0-9]{1,61}$'),
	revision integer NOT NULL CHECK (revision > 0),
	ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 29),
	candidate_revision integer,
	candidate_ciphertext bytea CHECK (octet_length(candidate_ciphertext) > 29),
	state text NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'disabled', 'dropped')),
	failure text CHECK (char_length(failure) BETWEEN 1 AND 300),
	connector_problem text CHECK (char_length(connector_problem) BETWEEN 1 AND 300),
	updated_at timestamptz NOT NULL,
	disabled_at timestamptz,
	dropped_at timestamptz,
	CONSTRAINT machine_databases_candidate CHECK (
		(candidate_revision IS NULL) = (candidate_ciphertext IS NULL)
		AND (candidate_revision IS NULL OR candidate_revision > revision)
	),
	CONSTRAINT machine_databases_failure CHECK ((state = 'failed') = (failure IS NOT NULL)),
	CONSTRAINT machine_databases_disabled CHECK (
		(state IN ('disabled', 'dropped')) = (disabled_at IS NOT NULL)
	),
	CONSTRAINT machine_databases_dropped CHECK ((state = 'dropped') = (dropped_at IS NOT NULL))
);
CREATE INDEX machine_databases_unsettled ON machine_databases(state)
	WHERE state NOT IN ('dropped');
