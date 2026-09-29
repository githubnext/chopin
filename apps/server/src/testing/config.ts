import { load } from "../config";

export const REQUIRED = {
	STORAGE_DRIVER: "postgres",
	DATABASE_URL: "postgresql://chopin:secret@database.test/chopin",
	APP_ORIGIN: "https://chopin.example",
	GITHUB_APP_SLUG: "chopin-test",
	GITHUB_APP_CLIENT_ID: "client-id",
	GITHUB_APP_CLIENT_SECRET: "client-secret",
	SESSION_ENCRYPTION_KEY: "11".repeat(32),
};

/** Local-mode overrides for a loopback instance. */
export const LOCAL = {
	AUTH_MODE: "local",
	APP_ORIGIN: "http://localhost:8790",
	PORT: "8790",
};

/** Load configuration from exactly these variables, restoring the environment afterwards. */
export function configured(overrides: Record<string, string | undefined> = {}) {
	let env: Record<string, string | undefined> = {
		...REQUIRED,
		AGENT: undefined,
		BACKGROUND_JOBS: undefined,
		WEB_RESEARCH: undefined,
		CONVERSATION_PLAN: undefined,
		JEV_API_KEY: undefined,
		JEV_MODEL: undefined,
		JEV_TIMEOUT_MS: undefined,
		TYPESAFE_API_KEY: undefined,
		HARNESS: undefined,
		HARNESS_AUTH: undefined,
		AUTH_MODE: undefined,
		SERVER_HOST: undefined,
		PORT: undefined,
		MODEL: undefined,
		CHOPIN_LOCAL_CREDENTIALS_DIR: undefined,
		GITHUB_ALLOWED_USERS: undefined,
		GITHUB_ALLOWED_ORGANIZATIONS: undefined,
		...overrides,
	};
	let previous = { ...process.env };
	for (let [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return load();
	} finally {
		for (let key of Object.keys(env)) delete process.env[key];
		Object.assign(process.env, previous);
	}
}
