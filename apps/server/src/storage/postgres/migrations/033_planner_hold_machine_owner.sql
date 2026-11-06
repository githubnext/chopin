ALTER TABLE planner_link_holds ALTER COLUMN owner_session_id DROP NOT NULL;
ALTER TABLE planner_link_holds ADD CONSTRAINT planner_link_holds_owner
	CHECK ((owner_session_id IS NULL) = (machine_id IS NOT NULL));
