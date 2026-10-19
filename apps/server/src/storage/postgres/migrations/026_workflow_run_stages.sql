CREATE TABLE workflow_run_stages (
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	run_id text NOT NULL CHECK (char_length(run_id) BETWEEN 1 AND 128),
	stage_id text NOT NULL CHECK (char_length(stage_id) BETWEEN 1 AND 128),
	position bigint NOT NULL CHECK (position >= 0),
	name text NOT NULL CHECK (char_length(name) <= 4000),
	kind text CHECK (kind = 'tool'),
	status text NOT NULL CHECK (status IN (
		'pending', 'running', 'awaiting_input', 'paused', 'blocked', 'completed', 'failed',
		'skipped', 'stopped'
	)),
	parent_ids jsonb CHECK (
		parent_ids IS NULL
		OR jsonb_typeof(parent_ids) = 'array' AND jsonb_array_length(parent_ids) <= 64
	),
	started bigint CHECK (started >= 0),
	ended bigint CHECK (ended >= 0),
	PRIMARY KEY (channel_id, run_id, stage_id)
);
CREATE INDEX workflow_run_stages_order ON workflow_run_stages(channel_id, run_id, position);
