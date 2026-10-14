CREATE TABLE machine_favorites (
	user_id text PRIMARY KEY REFERENCES users(id),
	machine_id text NOT NULL REFERENCES machines(id),
	chosen_at timestamptz NOT NULL
);
CREATE INDEX machine_favorites_machine ON machine_favorites(machine_id);
