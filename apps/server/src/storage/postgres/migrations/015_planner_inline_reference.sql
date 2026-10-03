ALTER TABLE research_workspaces
	ADD COLUMN inline_reference text
		CHECK (inline_reference IS NULL OR inline_reference IN ('pending', 'placed'));

CREATE INDEX research_workspaces_inline_recovery
	ON research_workspaces (id)
	WHERE inline_reference IS NOT NULL;
