ALTER TABLE background_jobs
	ADD COLUMN failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0);
