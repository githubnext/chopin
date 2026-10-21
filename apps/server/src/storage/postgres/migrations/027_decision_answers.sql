CREATE TABLE decision_answers (
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	decision_id text NOT NULL CHECK (char_length(decision_id) BETWEEN 1 AND 128),
	generation integer NOT NULL CHECK (generation >= 1),
	saved_at timestamptz NOT NULL,
	turn_id text CHECK (char_length(turn_id) BETWEEN 1 AND 128),
	delivered_at timestamptz,
	PRIMARY KEY (channel_id, decision_id)
);
CREATE INDEX decision_answers_pending ON decision_answers(channel_id, saved_at)
	WHERE delivered_at IS NULL;
