-- A session's one-line summary, kept only for the source it describes.
ALTER TABLE document_versions ADD COLUMN summary text;
ALTER TABLE document_versions ADD COLUMN summary_hash text;
