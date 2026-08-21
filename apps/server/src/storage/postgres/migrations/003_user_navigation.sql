CREATE TABLE user_projects (
	user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	repository_id text NOT NULL,
	repository_owner text NOT NULL,
	repository_name text NOT NULL,
	position integer NOT NULL CHECK (position >= 0),
	added_at timestamptz NOT NULL,
	PRIMARY KEY (user_id, repository_id),
	UNIQUE (user_id, position)
);

CREATE TABLE user_navigation (
	user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	last_document_id text REFERENCES channels(id) ON DELETE SET NULL,
	updated_at timestamptz NOT NULL
);
