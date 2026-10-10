CREATE TABLE plan_images (
	sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
	bytes bytea NOT NULL,
	size integer NOT NULL CHECK (size = octet_length(bytes) AND size <= 1048576),
	uploaded_by text NOT NULL REFERENCES users(id),
	created_at timestamptz NOT NULL,
	PRIMARY KEY (channel_id, sha256)
);
CREATE INDEX plan_images_sha256 ON plan_images(sha256, created_at);
