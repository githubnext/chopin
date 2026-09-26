import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY = "33".repeat(32);
const COMPOSE = ["docker", "compose", "-f", "compose.yaml", "-f", "compose.local.yaml"];
const databases = [
	"postgresql://chopin:chopin@127.0.0.1:5433/chopin?sslmode=disable",
	"postgresql://chopin:chopin@127.0.0.1:5434/chopin?sslmode=disable",
	"postgresql://chopin:chopin@127.0.0.1:5435/chopin?sslmode=disable",
];
// Not `8788 + index`: the harness server is 8792, clear of #157's 8790/8791.
const appOrigins = [8788, 8789, 8792];

async function run(command: string[], env: Record<string, string> = {}): Promise<void> {
	let child = Bun.spawn(command, {
		cwd: ROOT,
		env: { ...process.env, ...env },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	let code = await child.exited;
	if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}`);
}

let supplied = [
	process.env.E2E_DATABASE_URL_0,
	process.env.E2E_DATABASE_URL_1,
	process.env.E2E_DATABASE_URL_2,
];
if (supplied.some(Boolean) && !supplied.every(Boolean)) {
	throw new Error(
		"E2E_DATABASE_URL_0, E2E_DATABASE_URL_1, and E2E_DATABASE_URL_2 must be set together",
	);
}
let managed = !supplied[0];
try {
	if (process.env.E2E_SKIP_BUILD !== "1") await run(["bun", "run", "build"]);
	if (managed) {
		await run([...COMPOSE, "up", "-d", "--wait", "db-e2e", "db-e2e-fixtures", "db-e2e-harness"]);
	}
	for (let [index, url] of databases.entries()) {
		await run(["bun", "apps/server/src/storage/migrate.ts"], {
			DATABASE_URL: supplied[index] || url,
			STORAGE_DRIVER: "postgres",
			APP_ORIGIN: `http://127.0.0.1:${appOrigins[index]}`,
			GITHUB_APP_SLUG: "chopin-e2e",
			GITHUB_APP_CLIENT_ID: "e2e",
			GITHUB_APP_CLIENT_SECRET: "e2e",
			GITHUB_ALLOWED_USERS: "",
			GITHUB_ALLOWED_ORGANIZATIONS: "",
			SESSION_ENCRYPTION_KEY: KEY,
		});
	}
	await run([
		"bun",
		"node_modules/@playwright/test/cli.js",
		"test",
		"--config",
		"e2e/playwright.config.ts",
		...process.argv.slice(2),
	], {
		E2E_DATABASE_URL_0: supplied[0] || databases[0]!,
		E2E_DATABASE_URL_1: supplied[1] || databases[1]!,
		E2E_DATABASE_URL_2: supplied[2] || databases[2]!,
		SESSION_ENCRYPTION_KEY: KEY,
	});
} finally {
	if (managed) {
		await run([...COMPOSE, "rm", "-s", "-f", "db-e2e", "db-e2e-fixtures", "db-e2e-harness"])
			.catch(() => {});
	}
}
