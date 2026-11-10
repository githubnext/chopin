CREATE TABLE planner_model_choices (
	channel_id text PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
	model text,
	thinking_level text,
	user_id text NOT NULL REFERENCES users(id),
	updated_at timestamptz NOT NULL,
	fencing bigint NOT NULL CHECK (fencing >= 1),
	CONSTRAINT planner_model_choices_choice CHECK (model IS NOT NULL OR thinking_level IS NOT NULL)
);
