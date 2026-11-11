-- What an image was before the browser sent a smaller copy of it, for the viewer to say so.
-- Additive: a server that does not know these columns reads every row as it always did.
ALTER TABLE chat_attachments
	ADD COLUMN original_size bigint CHECK (original_size > 0),
	ADD COLUMN original_width integer CHECK (original_width > 0),
	ADD COLUMN original_height integer CHECK (original_height > 0);
