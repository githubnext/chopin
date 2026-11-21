-- The last models a document's remote Planner reported, one row per document and the account the
-- Planner ran for, shown to that account as the last known list while no Planner says what it
-- offers now.
CREATE TABLE planner_catalogs (
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	catalog jsonb NOT NULL CHECK (jsonb_typeof(catalog) = 'object'),
	reported_at timestamptz NOT NULL,
	fencing bigint NOT NULL CHECK (fencing >= 1),
	PRIMARY KEY (channel_id, user_id)
);
