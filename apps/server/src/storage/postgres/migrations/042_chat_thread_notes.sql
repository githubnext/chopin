-- What a thread's Planner told the document's Chat Planner was decided, until that Planner reads
-- it, and every Decision card a note was sent for, so a card is noted once.
-- Additive: a server that does not know the columns never writes or reads a note.
ALTER TABLE chat_session_state
	ADD COLUMN thread_notes_json jsonb NOT NULL DEFAULT '[]'::jsonb
		CHECK (jsonb_typeof(thread_notes_json) = 'array'),
	ADD COLUMN noted_questions_json jsonb NOT NULL DEFAULT '[]'::jsonb
		CHECK (jsonb_typeof(noted_questions_json) = 'array');
