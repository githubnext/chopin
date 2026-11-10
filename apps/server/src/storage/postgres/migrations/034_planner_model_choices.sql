CREATE TABLE planner_model_choices (
	channel_id text PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
	model text CHECK (char_length(model) BETWEEN 1 AND 256),
	thinking_level text CHECK (char_length(thinking_level) BETWEEN 1 AND 128),
	user_id text NOT NULL REFERENCES users(id),
	updated_at timestamptz NOT NULL,
	fencing bigint NOT NULL CHECK (fencing >= 1),
	CONSTRAINT planner_model_choices_choice CHECK (model IS NOT NULL OR thinking_level IS NOT NULL)
);
