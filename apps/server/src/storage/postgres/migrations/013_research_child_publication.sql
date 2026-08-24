ALTER TABLE research_workspaces
	ADD COLUMN published_channel_id text UNIQUE
		REFERENCES channels(id) ON DELETE RESTRICT;
