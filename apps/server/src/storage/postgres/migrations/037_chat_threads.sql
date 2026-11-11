CREATE TABLE chat_threads (
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	root_id text NOT NULL CHECK (char_length(root_id) BETWEEN 1 AND 128),
	root_json jsonb NOT NULL CHECK (jsonb_typeof(root_json) = 'object'),
	forked_at bigint NOT NULL,
	created_by text NOT NULL,
	entries_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(entries_json) = 'array'),
	compactions_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(compactions_json) = 'array'),
	usage_json jsonb,
	fork_state_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fork_state_json) = 'object'),
	updated_at timestamptz NOT NULL,
	fencing bigint NOT NULL CHECK (fencing >= 1),
	PRIMARY KEY (channel_id, root_id)
);
CREATE INDEX chat_threads_channel_order ON chat_threads(channel_id, forked_at, root_id);

CREATE TABLE chat_session_state (
	channel_id text PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
	compactions_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(compactions_json) = 'array'),
	usage_json jsonb,
	atomic_entries_json jsonb,
	atomic_leaf_id text,
	entry_forks_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(entry_forks_json) = 'object'),
	updated_at timestamptz NOT NULL,
	fencing bigint NOT NULL CHECK (fencing >= 1)
);
