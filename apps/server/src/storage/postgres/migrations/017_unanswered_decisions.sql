ALTER TABLE channel_state
	ADD COLUMN unanswered_decisions integer NOT NULL DEFAULT 0
		CHECK (unanswered_decisions >= 0);
