CREATE TABLE chat_attachments (
	id text PRIMARY KEY,
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
	kind text NOT NULL CHECK (kind IN ('image', 'file')),
	mime_type text NOT NULL,
	bytes bytea NOT NULL,
	size integer NOT NULL CHECK (size = octet_length(bytes) AND size > 0),
	uploaded_by text NOT NULL REFERENCES users(id),
	created_at timestamptz NOT NULL,
	entry_id text,
	position integer,
	CONSTRAINT chat_attachments_type CHECK (
		(kind = 'image' AND mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif'))
		OR (kind = 'file' AND mime_type = 'text/plain')
	),
	CONSTRAINT chat_attachments_sent CHECK ((entry_id IS NULL) = (position IS NULL))
);
CREATE INDEX chat_attachments_entry ON chat_attachments(channel_id, entry_id, position)
	WHERE entry_id IS NOT NULL;
CREATE INDEX chat_attachments_unsent ON chat_attachments(channel_id, uploaded_by, created_at)
	WHERE entry_id IS NULL;
