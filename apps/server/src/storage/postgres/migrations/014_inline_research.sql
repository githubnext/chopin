ALTER TABLE research_workspaces
	DROP CONSTRAINT research_workspaces_origin_check;

ALTER TABLE research_workspaces
	ADD CONSTRAINT research_workspaces_origin_check
		CHECK (origin IN ('inline', 'sidebar', 'planner'));
