ALTER TABLE background_jobs
	ADD COLUMN progress jsonb NOT NULL DEFAULT '[]'::jsonb,
	ADD CONSTRAINT background_jobs_progress_array CHECK (
		jsonb_typeof(progress) = 'array' AND jsonb_array_length(progress) <= 32
	);
