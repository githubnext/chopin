-- Full width, a document's own layout setting, as Notion's page setting: every reader sees it.
-- Additive: a server that does not know the column reads every document at the readable measure.
ALTER TABLE channels ADD COLUMN full_width boolean NOT NULL DEFAULT false;
