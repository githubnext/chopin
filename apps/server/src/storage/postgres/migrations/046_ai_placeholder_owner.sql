-- What each launch is for (`run:<id>` or `session:<id>`), so the writer lease's holder can end a
-- launch nothing owns any longer, whichever process handed it out. Launches from before are kept
-- until they expire.
ALTER TABLE ai_placeholders
	ADD COLUMN owner text CHECK (owner IS NULL OR char_length(owner) BETWEEN 1 AND 256);
