CREATE TABLE machine_choices (
	channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	user_id text NOT NULL REFERENCES users(id),
	machine_id text NOT NULL REFERENCES machines(id),
	chosen_at timestamptz NOT NULL,
	PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX machine_choices_machine ON machine_choices(machine_id);
