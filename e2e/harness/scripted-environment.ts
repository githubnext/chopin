import { join } from "node:path";

export const SCRIPTED_HARNESS = "e2e-prompt-scripted";

/** Explicit caller selection; these checks do not prove database or network isolation. */
export function requireScriptedServer(env: Record<string, string | undefined>, root: string): void {
	let expected = {
		E2E_CONVERSATION_PLAN: "1",
		SERVER_HOST: "127.0.0.1",
		PORT: "8788",
		APP_ORIGIN: "http://127.0.0.1:8788",
		AGENT: "on",
		CONVERSATION_PLAN: "on",
		HARNESS: SCRIPTED_HARNESS,
		HARNESS_AUTH: "direct",
		JEV_API_KEY: "e2e-jev-only",
		JEV_MODEL: "jev-e2e",
		TYPESAFE_API_KEY: "",
		E2E_PLANNER_JOBS_DIR: join(root, "e2e", "test-results", "planner-jobs"),
		E2E_JEV_CONTROL_DIR: join(root, "e2e", "test-results", "jev-control"),
		STORAGE_DRIVER: "postgres",
	};
	for (let [name, value] of Object.entries(expected)) {
		if (env[name] !== value) throw new Error(`Scripted Planner requires explicit ${name}`);
	}
	if (!/^[a-fA-F0-9]{64}$/.test(env.SESSION_ENCRYPTION_KEY ?? "")) {
		throw new Error("Scripted Planner requires a 64-hex SESSION_ENCRYPTION_KEY");
	}
	let database: URL;
	try {
		database = new URL(env.DATABASE_URL ?? "");
	} catch {
		throw new Error("Scripted Planner requires a supplied local PostgreSQL DATABASE_URL");
	}
	if (
		!["postgres:", "postgresql:"].includes(database.protocol)
		|| !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)
		|| database.pathname.length <= 1
		|| ["host", "hostaddr", "service"].some(name => database.searchParams.has(name))
	) {
		throw new Error("Scripted Planner requires a supplied local PostgreSQL DATABASE_URL");
	}
}
