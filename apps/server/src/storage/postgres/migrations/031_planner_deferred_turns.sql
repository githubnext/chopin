CREATE TABLE planner_deferred_turns (
	id text PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 128),
	seq bigint GENERATED ALWAYS AS IDENTITY,
	document_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
	kind text NOT NULL CHECK (kind IN ('composer', 'invoke_planner', 'invoke_system', 'comment', 'draft')),
	handle text NOT NULL,
	user_id text NOT NULL,
	text text NOT NULL,
	references_json jsonb NOT NULL CHECK (jsonb_typeof(references_json) = 'array'),
	delivery jsonb,
	focus_channel_id text,
	focus_title text,
	thread_id text,
	thread_channel_id text,
	plan_revision bigint,
	claimant_session_id text,
	owner_session_id_at_accept text,
	state text NOT NULL CHECK (state IN ('waiting', 'started', 'ended', 'interrupted', 'cancelled')),
	created_at timestamptz NOT NULL,
	fencing bigint NOT NULL CHECK (fencing >= 1),
	resolved_at timestamptz,
	cancel_reason text CHECK (cancel_reason IN ('agent', 'access', 'unavailable')),
	CONSTRAINT planner_deferred_turns_resolved CHECK (
		(state IN ('ended', 'interrupted', 'cancelled')) = (resolved_at IS NOT NULL)
	),
	CONSTRAINT planner_deferred_turns_cancel_reason CHECK (
		cancel_reason IS NULL OR state = 'cancelled'
	),
	UNIQUE (document_id, request_id)
);
CREATE INDEX planner_deferred_turns_queue ON planner_deferred_turns(document_id, created_at, seq)
	WHERE state IN ('waiting', 'started');
CREATE INDEX planner_deferred_turns_open ON planner_deferred_turns(state)
	WHERE state IN ('waiting', 'started');
CREATE UNIQUE INDEX planner_deferred_turns_thread ON planner_deferred_turns(
	document_id, coalesce(thread_channel_id, ''), thread_id
) WHERE kind = 'comment' AND state = 'waiting' AND thread_id IS NOT NULL;
