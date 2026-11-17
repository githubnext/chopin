-- What a thread's Planner told the document's Chat Planner was decided, until that Planner reads
-- it; every Decision card a note was sent for, so a card is noted once; the notes the Chat
-- Planner's latest turn for a message was given, for a Retry of it; and the Decision cards each
-- thread's Planner asked, the only cards it may send a note for.
-- Additive: a server that does not know the columns never writes or reads a note.
ALTER TABLE chat_session_state
	ADD COLUMN thread_notes_json jsonb NOT NULL DEFAULT '[]'::jsonb
		CHECK (jsonb_typeof(thread_notes_json) = 'array'),
	ADD COLUMN noted_questions_json jsonb NOT NULL DEFAULT '[]'::jsonb
		CHECK (jsonb_typeof(noted_questions_json) = 'array'),
	ADD COLUMN given_notes_json jsonb
		CHECK (given_notes_json IS NULL OR jsonb_typeof(given_notes_json) = 'object');

ALTER TABLE chat_threads
	ADD COLUMN asked_questions_json jsonb NOT NULL DEFAULT '[]'::jsonb
		CHECK (jsonb_typeof(asked_questions_json) = 'array');
