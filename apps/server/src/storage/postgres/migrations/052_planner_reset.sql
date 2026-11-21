-- When a writer last reset a document's Planner. A machine removes its Planner's disk made before
-- then, so the Planner starts afresh there too. Additive: a server that does not know the column
-- resets as before, and a machine keeps its disk.
ALTER TABLE channels ADD COLUMN planner_reset_at timestamptz;
