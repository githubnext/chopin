CREATE TABLE research_workspaces (
	id text PRIMARY KEY CHECK (id <> ''),
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	title text NOT NULL CHECK (title <> ''),
	proposed_question text NOT NULL CHECK (proposed_question <> ''),
	confirmed_query text CHECK (confirmed_query IS NULL OR confirmed_query <> ''),
	origin text NOT NULL CHECK (origin IN ('sidebar', 'planner')),
	origin_message_id text CHECK (origin_message_id IS NULL OR origin_message_id <> ''),
	created_by text NOT NULL REFERENCES users(id),
	confirmed_by text REFERENCES users(id),
	revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
	next_turn_ordinal bigint NOT NULL DEFAULT 1 CHECK (next_turn_ordinal > 0),
	next_message_sequence bigint NOT NULL DEFAULT 1 CHECK (next_message_sequence > 0),
	idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
	fingerprint text NOT NULL CHECK (fingerprint <> ''),
	created_at timestamptz NOT NULL,
	updated_at timestamptz NOT NULL,
	UNIQUE (channel_id, idempotency_key),
	CHECK ((confirmed_query IS NULL) = (confirmed_by IS NULL)),
	CHECK (updated_at >= created_at)
);

CREATE INDEX research_workspaces_channel_listing
	ON research_workspaces (channel_id, updated_at DESC, id ASC);

CREATE TABLE research_turns (
	id text PRIMARY KEY CHECK (id <> ''),
	workspace_id text NOT NULL REFERENCES research_workspaces(id) ON DELETE CASCADE,
	ordinal bigint NOT NULL CHECK (ordinal > 0),
	kind text NOT NULL CHECK (kind IN ('initial', 'follow-up', 'search-more')),
	request_id text NOT NULL CHECK (request_id <> ''),
	fingerprint text NOT NULL CHECK (fingerprint <> ''),
	question text NOT NULL CHECK (question <> ''),
	requested_by text NOT NULL REFERENCES users(id),
	evidence_job_id text REFERENCES background_jobs(id),
	answer_job_id text REFERENCES background_jobs(id),
	created_at timestamptz NOT NULL,
	updated_at timestamptz NOT NULL,
	UNIQUE (workspace_id, id),
	UNIQUE (workspace_id, ordinal),
	UNIQUE (workspace_id, request_id),
	CHECK (evidence_job_id IS NULL OR evidence_job_id <> answer_job_id),
	CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX research_turns_evidence_job
	ON research_turns (evidence_job_id)
	WHERE evidence_job_id IS NOT NULL;

CREATE UNIQUE INDEX research_turns_answer_job
	ON research_turns (answer_job_id)
	WHERE answer_job_id IS NOT NULL;

CREATE TABLE research_messages (
	id text PRIMARY KEY CHECK (id <> ''),
	workspace_id text NOT NULL REFERENCES research_workspaces(id) ON DELETE CASCADE,
	sequence bigint NOT NULL CHECK (sequence > 0),
	turn_id text,
	author_kind text NOT NULL CHECK (author_kind IN ('member', 'agent', 'system')),
	user_id text REFERENCES users(id),
	user_handle text CHECK (user_handle IS NULL OR user_handle <> ''),
	text text NOT NULL CHECK (text <> ''),
	source_job_id text REFERENCES background_jobs(id),
	created_at timestamptz NOT NULL,
	UNIQUE (workspace_id, sequence),
	FOREIGN KEY (workspace_id, turn_id)
		REFERENCES research_turns(workspace_id, id) ON DELETE CASCADE,
	CHECK (author_kind <> 'member' OR (turn_id IS NOT NULL AND source_job_id IS NULL)),
	CHECK (author_kind <> 'agent' OR (turn_id IS NOT NULL AND source_job_id IS NOT NULL))
);

CREATE INDEX research_messages_workspace_order
	ON research_messages (workspace_id, sequence ASC);

CREATE UNIQUE INDEX research_messages_member_turn
	ON research_messages (workspace_id, turn_id)
	WHERE author_kind = 'member' AND turn_id IS NOT NULL;

CREATE UNIQUE INDEX research_messages_agent_job
	ON research_messages (source_job_id)
	WHERE author_kind = 'agent' AND source_job_id IS NOT NULL;
