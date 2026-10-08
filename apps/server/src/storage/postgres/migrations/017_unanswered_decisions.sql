CREATE FUNCTION chopin_unanswered_decisions(sidecar jsonb) RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
	document jsonb := sidecar;
BEGIN
	IF jsonb_typeof(document) = 'string' THEN
		BEGIN
			document := (document #>> '{}')::jsonb;
		EXCEPTION WHEN others THEN
			RETURN 0;
		END;
	END IF;
	RETURN (
		SELECT coalesce(sum(
			CASE
				WHEN jsonb_typeof(record -> 'definition' -> 'questions') IS DISTINCT FROM 'array' THEN 0
				WHEN record ->> 'status' = 'reopened'
					THEN jsonb_array_length(record -> 'definition' -> 'questions')
				WHEN record ->> 'status' = 'open' THEN (
					SELECT count(*)
					FROM jsonb_array_elements(record -> 'definition' -> 'questions') AS question
					WHERE jsonb_typeof(record -> 'answers') IS DISTINCT FROM 'object'
						OR NOT (record -> 'answers') ? coalesce(
							CASE WHEN jsonb_typeof(question -> 'id') = 'string' THEN question ->> 'id' END,
							''
						)
				)
				ELSE 0
			END
		), 0)::integer
		FROM jsonb_array_elements(
			CASE
				WHEN jsonb_typeof(document -> 'questions') = 'array' THEN document -> 'questions'
				ELSE '[]'::jsonb
			END
		) AS record
	);
END
$$;

ALTER TABLE channel_state
	ADD COLUMN unanswered_decisions integer NOT NULL
		GENERATED ALWAYS AS (chopin_unanswered_decisions(sidecar)) STORED;
