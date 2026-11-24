-- The top-level document whose Planner created a document, so that Planner can list and instruct the
-- documents it created. Additive: an earlier release ignores the column. Deleting the creating
-- document unlinks the documents it created rather than deleting them.
ALTER TABLE channels
	ADD COLUMN created_from text REFERENCES channels (id) ON DELETE SET NULL;
CREATE INDEX channels_created_from ON channels (created_from, created_at, id)
	WHERE created_from IS NOT NULL;
