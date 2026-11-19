CREATE TABLE ai_usage (
	id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
	launch_id text NOT NULL CHECK (char_length(launch_id) BETWEEN 1 AND 128),
	user_id text NOT NULL REFERENCES users(id),
	provider text NOT NULL CHECK (provider IN ('github-copilot', 'openai', 'anthropic')),
	model text CHECK (char_length(model) BETWEEN 1 AND 200),
	outcome text NOT NULL CHECK (outcome IN ('pending', 'ok', 'error', 'unsent', 'unknown')),
	status integer CHECK (status BETWEEN 100 AND 599),
	error text CHECK (char_length(error) BETWEEN 1 AND 64),
	input_tokens bigint CHECK (input_tokens >= 0),
	output_tokens bigint CHECK (output_tokens >= 0),
	cache_read_tokens bigint CHECK (cache_read_tokens >= 0),
	cache_write_tokens bigint CHECK (cache_write_tokens >= 0),
	started_at timestamptz NOT NULL,
	completed_at timestamptz,
	lease_name text NOT NULL,
	fencing bigint NOT NULL CHECK (fencing >= 1),
	CONSTRAINT ai_usage_completed CHECK ((outcome = 'pending') = (completed_at IS NULL))
);
CREATE INDEX ai_usage_person ON ai_usage(user_id, started_at);
CREATE INDEX ai_usage_launch ON ai_usage(launch_id);
CREATE INDEX ai_usage_started ON ai_usage(started_at);
CREATE INDEX ai_usage_pending ON ai_usage(lease_name, fencing) WHERE outcome = 'pending';
