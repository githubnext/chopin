ALTER TABLE channels
	ADD COLUMN parent_channel_id text REFERENCES channels(id) ON DELETE RESTRICT;

CREATE INDEX channels_parent
	ON channels (parent_channel_id);
