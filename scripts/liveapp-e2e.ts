import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import type { Subprocess } from "bun";

let root = fileURLToPath(new URL("..", import.meta.url));
let children: Subprocess[] = [];
let container = `frontend-pilot-${crypto.randomUUID()}`;
let ownsContainer = false;
let integrated = process.argv.includes("--integrated");

async function port() {
	let listener = createServer();
	await new Promise<void>(done => listener.listen(0, "127.0.0.1", done));
	let selected = (listener.address() as { port: number }).port;
	await new Promise<void>(done => listener.close(() => done()));
	return selected;
}

async function run(command: string[], env: Record<string, string> = {}) {
	let process = Bun.spawn(command, {
		cwd: root,
		env: { ...Bun.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	let [stdout, stderr, code] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (code) throw new Error(`${command.join(" ")} failed (${code})\n${stdout}\n${stderr}`);
	return stdout.trim();
}

function start(command: string[], env: Record<string, string>) {
	let child = Bun.spawn(command, {
		cwd: root,
		env: { ...Bun.env, ...env },
		stdout: "inherit",
		stderr: "inherit",
		detached: true,
	});
	children.push(child);
	return child;
}

try {
	let appPort = await port();
	let webPort = await port();
	await run([
		"docker",
		"run",
		"--rm",
		"-d",
		"--name",
		container,
		"-e",
		"POSTGRES_USER=pilot",
		"-e",
		"POSTGRES_PASSWORD=pilot",
		"-e",
		"POSTGRES_DB=pilot",
		"-p",
		"127.0.0.1::5432",
		"postgres:17-alpine",
	]);
	ownsContainer = true;
	let databasePort = Number(
		(await run(["docker", "port", container, "5432/tcp"])).split(":").at(-1),
	);
	let database = `postgresql://pilot:pilot@127.0.0.1:${databasePort}/pilot?sslmode=disable`;
	let deadline = Date.now() + 30_000;
	while (true) {
		try {
			await run(["docker", "exec", container, "pg_isready", "-U", "pilot", "-d", "pilot"]);
			break;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await Bun.sleep(200);
		}
	}
	let origin = `http://127.0.0.1:${appPort}`;
	let env = {
		PORT: String(appPort),
		CHOPIN_DEV_WEB_PORT: String(webPort),
		CHOPIN_DEV_EXE_HOST: "",
		SERVER_HOST: "127.0.0.1",
		APP_ORIGIN: origin,
		DEV_CLIENT: `http://127.0.0.1:${webPort}`,
		DATABASE_URL: database,
		E2E_DATABASE_URL_0: database,
		STORAGE_DRIVER: "postgres",
		AUTH_MODE: "hosted",
		AGENT: "off",
		BACKGROUND_JOBS: "off",
		CONVERSATION_PLAN: "off",
		HARNESS: "copilot-sdk",
		HARNESS_AUTH: "",
		HARNESS_EXTENSIONS: "",
		MODEL: "gpt-6-luna",
		GITHUB_APP_SLUG: "frontend-pilot",
		GITHUB_APP_CLIENT_ID: "e2e",
		GITHUB_APP_CLIENT_SECRET: "e2e",
		GITHUB_ALLOWED_USERS: "",
		GITHUB_ALLOWED_ORGANIZATIONS: "",
		SESSION_ENCRYPTION_KEY: "33".repeat(32),
		DEV_QUESTIONS: "",
		DEV_COMMENTS: "",
		LIVEAPP_PILOT_PROBE: "1",
		LIVEAPP_TEST_ORIGIN: origin,
		LIVEAPP_NO_AI: "1",
		LIVEAPP_TEST_INTEGRATED: integrated ? "1" : "0",
	};
	await run(["bun", "apps/server/src/storage/migrate.ts"], env);
	start([
		integrated ? "node" : "bun",
		"apps/web/node_modules/vite/bin/vite.js",
		"apps/web",
		...(integrated ? ["--mode", "liveapp"] : []),
	], env);
	start(["bun", "--preload", "./e2e/github.ts", "apps/server/src/main.ts"], env);
	deadline = Date.now() + 180_000;
	while (true) {
		try {
			let response = await fetch(origin);
			await response.body?.cancel();
			if (response.ok) break;
		} catch {}
		if (Date.now() >= deadline || children.some(child => child.exitCode !== null)) {
			throw new Error("Frontend pilot servers did not become ready");
		}
		await Bun.sleep(200);
	}
	let test = start([
		"bun",
		"node_modules/@playwright/test/cli.js",
		"test",
		"--config",
		"e2e/liveapp/playwright.config.ts",
		...process.argv.slice(2).filter(arg => arg !== "--integrated"),
	], env);
	let code = await test.exited;
	if (code) process.exitCode = code;
} finally {
	for (let child of children) {
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {}
	}
	await Promise.race([Promise.all(children.map(child => child.exited)), Bun.sleep(3000)]);
	for (let child of children) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {}
	}
	if (ownsContainer) await run(["docker", "rm", "-f", container]);
}
