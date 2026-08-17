ALTER TABLE agent_state DROP CONSTRAINT agent_state_owner_session_id_fkey;

UPDATE agent_state
SET owner_session_id = NULL, status = 'unavailable', updated_at = now()
WHERE owner_session_id IS NOT NULL;

DROP TABLE web_sessions;

CREATE TABLE web_sessions (
	id text PRIMARY KEY,
	user_id text NOT NULL REFERENCES users(id),
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL
);

CREATE INDEX web_sessions_expiry ON web_sessions (expires_at);

ALTER TABLE agent_state
ADD CONSTRAINT agent_state_owner_session_id_fkey
FOREIGN KEY (owner_session_id) REFERENCES web_sessions(id) ON DELETE SET NULL;
