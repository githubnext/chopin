-- An account's last reported model list on any document: the composer's list from last time on a
-- document whose own Planner has never reported for that account. Additive: an earlier release
-- reads the table as before.
CREATE INDEX planner_catalogs_latest ON planner_catalogs (user_id, reported_at DESC);
