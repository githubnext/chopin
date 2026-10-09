CREATE TABLE experiments (
	id text PRIMARY KEY,
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	revision bigint NOT NULL CHECK (revision >= 0),
	state text NOT NULL CHECK (state IN ('requested', 'queued', 'running', 'publishing', 'completed', 'failed', 'cancelled', 'interrupted')),
	created_at timestamptz NOT NULL,
	payload jsonb NOT NULL
);
CREATE INDEX experiments_channel ON experiments(channel_id, created_at DESC);
CREATE INDEX experiments_active ON experiments(state) WHERE state IN ('queued', 'running', 'publishing');
