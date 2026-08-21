ALTER TABLE channels
	ADD CONSTRAINT channels_repository_identity UNIQUE (repository_id, id);

CREATE TABLE channel_slugs (
	repository_id text NOT NULL,
	slug text NOT NULL,
	channel_id text NOT NULL,
	canonical boolean NOT NULL,
	created_at timestamptz NOT NULL,
	PRIMARY KEY (repository_id, slug),
	FOREIGN KEY (repository_id, channel_id)
		REFERENCES channels(repository_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX channel_slugs_canonical
	ON channel_slugs (channel_id) WHERE canonical;

CREATE INDEX channel_slugs_channel ON channel_slugs (channel_id);
