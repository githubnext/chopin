CREATE TABLE result_followthrough (
	id text PRIMARY KEY CHECK (length(id) = 64),
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	child_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	kind text NOT NULL CHECK (kind IN ('research', 'investigation')),
	source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
	result_key text NOT NULL CHECK (length(result_key) BETWEEN 1 AND 256),
	status text NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
	revision integer NOT NULL CHECK (revision >= 0),
	attempts integer NOT NULL CHECK (attempts >= 0),
	created_at timestamptz NOT NULL,
	updated_at timestamptz NOT NULL,
	reason text CHECK (length(reason) BETWEEN 1 AND 160),
	context jsonb,
	attempt_token text,
	UNIQUE (channel_id, kind, source_id, result_key),
	CHECK (status <> 'running' OR (context IS NOT NULL AND attempt_token IS NOT NULL))
);

CREATE INDEX result_followthrough_pending ON result_followthrough (updated_at, id)
	WHERE status = 'pending';
CREATE INDEX result_followthrough_source ON result_followthrough (channel_id, kind, source_id);
