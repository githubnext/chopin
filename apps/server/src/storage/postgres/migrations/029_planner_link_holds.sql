CREATE TABLE planner_link_holds (
	channel_id text PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
	user_id text NOT NULL REFERENCES users(id),
	login text NOT NULL CHECK (char_length(login) BETWEEN 1 AND 255),
	owner_session_id text NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
	generation bigint NOT NULL CHECK (generation >= 0),
	machine_id text REFERENCES machines(id) ON DELETE CASCADE,
	machine_label text CHECK (char_length(machine_label) BETWEEN 1 AND 100),
	sessions jsonb NOT NULL CHECK (jsonb_typeof(sessions) = 'array'),
	suspended_at timestamptz NOT NULL,
	handover_until timestamptz,
	fencing bigint NOT NULL CHECK (fencing >= 1),
	CONSTRAINT planner_link_holds_machine CHECK ((machine_id IS NULL) = (machine_label IS NULL))
);
CREATE INDEX planner_link_holds_owner ON planner_link_holds(owner_session_id);
