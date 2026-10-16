CREATE TABLE document_versions (
	id text PRIMARY KEY,
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	author_id text REFERENCES users(id),
	revision integer NOT NULL,
	source text NOT NULL,
	source_hash text NOT NULL,
	started_at timestamptz NOT NULL,
	updated_at timestamptz NOT NULL CHECK (updated_at >= started_at)
);
CREATE INDEX document_versions_channel ON document_versions(channel_id, updated_at DESC, id DESC);
