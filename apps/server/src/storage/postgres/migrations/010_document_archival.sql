ALTER TABLE channels
	ADD COLUMN archived_at timestamptz;

CREATE INDEX channels_repository_active_listing
	ON channels (repository_id, updated_at DESC, id ASC)
	WHERE archived_at IS NULL;
