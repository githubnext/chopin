ALTER TABLE channels
	ADD COLUMN generated_description text,
	ADD COLUMN generated_description_revision bigint NOT NULL DEFAULT 0,
	ADD COLUMN generated_description_plan_revision bigint,
	ADD COLUMN generated_description_source_hash text,
	ADD COLUMN generated_description_generator_version integer,
	ADD COLUMN generated_description_job_id text,
	ADD COLUMN generated_description_updated_at timestamptz;

ALTER TABLE channels
	ADD CONSTRAINT channels_generated_description_complete CHECK (
		(
			generated_description IS NULL
			AND generated_description_revision = 0
			AND generated_description_plan_revision IS NULL
			AND generated_description_source_hash IS NULL
			AND generated_description_generator_version IS NULL
			AND generated_description_job_id IS NULL
			AND generated_description_updated_at IS NULL
		)
		OR (
			generated_description IS NOT NULL
			AND generated_description <> ''
			AND generated_description_revision > 0
			AND generated_description_plan_revision IS NOT NULL
			AND generated_description_plan_revision >= 0
			AND generated_description_source_hash IS NOT NULL
			AND generated_description_source_hash ~ '^sha256:[a-f0-9]{64}$'
			AND generated_description_generator_version IS NOT NULL
			AND generated_description_generator_version = 1
			AND generated_description_job_id IS NOT NULL
			AND generated_description_job_id <> ''
			AND generated_description_updated_at IS NOT NULL
		)
	);
