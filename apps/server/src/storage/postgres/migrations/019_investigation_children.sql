ALTER TABLE experiments
	ADD COLUMN child_channel_id text UNIQUE
		REFERENCES channels(id) ON DELETE RESTRICT;
