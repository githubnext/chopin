import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const KEY = "33".repeat(32);
const databases = [
	"postgresql://chopin:chopin@127.0.0.1:5433/chopin?sslmode=disable",
	"postgresql://chopin:chopin@127.0.0.1:5434/chopin?sslmode=disable",
];

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

let supplied = [process.env.E2E_DATABASE_URL_0, process.env.E2E_DATABASE_URL_1];
if (supplied.some(Boolean) && !supplied.every(Boolean)) {
	throw new Error("E2E_DATABASE_URL_0 and E2E_DATABASE_URL_1 must be set together");
}
let managed = !supplied[0];
try {
	if (process.env.E2E_SKIP_BUILD !== "1") await run(["bun", "run", "build"]);
	if (managed) {
		await run(["docker", "compose", "up", "-d", "--wait", "db-e2e", "db-e2e-fixtures"]);
	}
	for (let [index, url] of databases.entries()) {
		await run(["bun", "apps/server/src/storage/migrate.ts"], {
			DATABASE_URL: supplied[index] || url,
			STORAGE_DRIVER: "postgres",
			APP_ORIGIN: `http://127.0.0.1:${8788 + index}`,
			GITHUB_APP_SLUG: "chopin-e2e",
			GITHUB_APP_CLIENT_ID: "e2e",
			GITHUB_APP_CLIENT_SECRET: "e2e",
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
		SESSION_ENCRYPTION_KEY: KEY,
	});
} finally {
	if (managed) {
		await run(["docker", "compose", "rm", "-s", "-f", "db-e2e", "db-e2e-fixtures"])
			.catch(() => {});
	}
}
