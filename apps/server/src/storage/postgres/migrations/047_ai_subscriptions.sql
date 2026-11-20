-- ChatGPT and Claude sign-ins: a person's subscription connected with the provider's own sign-in.
-- `ciphertext` holds the tokens the sign-in returned and names the connection; `tokens` holds the
-- pair a refresh returned since, replaced only while it is still the pair the refresh started from.
ALTER TABLE ai_credentials
	DROP CONSTRAINT ai_credentials_provider_check,
	ADD CONSTRAINT ai_credentials_provider_check
		CHECK (provider IN ('github-copilot', 'openai', 'anthropic', 'chatgpt', 'claude')),
	DROP CONSTRAINT ai_credentials_kind_check,
	ADD CONSTRAINT ai_credentials_kind_check
		CHECK (kind IN ('api-key', 'github-sign-in', 'subscription')),
	ADD COLUMN tokens bytea CHECK (tokens IS NULL OR octet_length(tokens) > 29),
	DROP CONSTRAINT ai_credentials_secret,
	ADD CONSTRAINT ai_credentials_secret CHECK (
		(
			kind = 'api-key' AND ciphertext IS NOT NULL AND octet_length(ciphertext) > 29
			AND tokens IS NULL AND provider IN ('github-copilot', 'openai', 'anthropic')
		)
		OR (
			kind = 'github-sign-in' AND ciphertext IS NULL AND suffix IS NULL AND tokens IS NULL
			AND provider = 'github-copilot'
		)
		OR (
			kind = 'subscription' AND ciphertext IS NOT NULL AND octet_length(ciphertext) > 29
			AND suffix IS NULL AND provider IN ('chatgpt', 'claude')
		)
	);

ALTER TABLE ai_placeholders
	DROP CONSTRAINT ai_placeholders_provider_check,
	ADD CONSTRAINT ai_placeholders_provider_check
		CHECK (provider IN ('github-copilot', 'openai', 'anthropic', 'chatgpt', 'claude'));

ALTER TABLE ai_usage
	DROP CONSTRAINT ai_usage_provider_check,
	ADD CONSTRAINT ai_usage_provider_check
		CHECK (provider IN ('github-copilot', 'openai', 'anthropic', 'chatgpt', 'claude'));
