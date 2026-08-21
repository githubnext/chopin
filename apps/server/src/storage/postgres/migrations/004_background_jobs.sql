CREATE TABLE background_job_channels (
	channel_id text PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
	revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE TABLE background_job_targets (
	channel_id text NOT NULL REFERENCES background_job_channels(channel_id) ON DELETE CASCADE,
	target_key text NOT NULL,
	generation bigint NOT NULL CHECK (generation > 0),
	PRIMARY KEY (channel_id, target_key)
);

CREATE TABLE background_jobs (
	id text PRIMARY KEY CHECK (id <> ''),
	channel_id text NOT NULL,
	type text NOT NULL CHECK (type <> ''),
	version integer NOT NULL CHECK (version > 0),
	origin text NOT NULL CHECK (origin IN ('scheduler', 'planner', 'user')),
	target_key text NOT NULL CHECK (target_key <> ''),
	target_generation bigint NOT NULL CHECK (target_generation > 0),
	idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
	fingerprint text NOT NULL CHECK (fingerprint <> ''),
	input jsonb NOT NULL,
	state text NOT NULL CHECK (
		state IN ('pending', 'paused', 'running', 'completed', 'failed', 'cancelled', 'superseded')
	),
	revision bigint NOT NULL CHECK (revision > 0),
	attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
	claim_owner text CHECK (claim_owner IS NULL OR claim_owner <> ''),
	claim_binding jsonb,
	claim_expires_at timestamptz,
	available_at timestamptz NOT NULL,
	reason text,
	created_at timestamptz NOT NULL,
	updated_at timestamptz NOT NULL,
	FOREIGN KEY (channel_id, target_key)
		REFERENCES background_job_targets(channel_id, target_key) ON DELETE CASCADE,
	UNIQUE (channel_id, idempotency_key),
	UNIQUE (channel_id, target_key, target_generation),
	CHECK (
		(state = 'running' AND claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL)
		OR
		(
			state <> 'running'
			AND claim_owner IS NULL
			AND claim_binding IS NULL
			AND claim_expires_at IS NULL
		)
	)
);

CREATE INDEX background_jobs_channel_listing
	ON background_jobs (channel_id, created_at DESC, id ASC);

CREATE INDEX background_jobs_pending_claim
	ON background_jobs (available_at, created_at, id)
	WHERE state = 'pending';

CREATE INDEX background_jobs_expired_claim
	ON background_jobs (claim_expires_at, created_at, id)
	WHERE state = 'running';

CREATE TABLE background_job_artifacts (
	job_id text PRIMARY KEY REFERENCES background_jobs(id) ON DELETE CASCADE,
	revision bigint NOT NULL CHECK (revision > 0),
	value jsonb NOT NULL,
	created_at timestamptz NOT NULL
);
