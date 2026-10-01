import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { expect } from "@playwright/test";

import { JEV_CONTROL_DIR } from "./jev-control";
import { FIXTURES, HOST, ROOT } from "./servers";

export const RESTART_URL = `http://${HOST}:${FIXTURES}`;

/** A separate app against database 1; the main Playwright server owns database 0. */
export async function startJevProcess(): Promise<ChildProcessWithoutNullStreams> {
	let database = process.env.E2E_DATABASE_URL_1;
	if (!database) throw new Error("restart test requires disposable database 1");
	let child = spawn("bun", [
		"--preload",
		"./e2e/github.ts",
		"--preload",
		"./e2e/jev.ts",
		"apps/server/src/main.ts",
	], {
		cwd: ROOT,
		env: {
			...process.env,
			PORT: String(FIXTURES),
			SERVER_HOST: HOST,
			AGENT: "off",
			CONVERSATION_PLAN: "on",
			JEV_API_KEY: "e2e-jev-only",
			JEV_MODEL: "jev-e2e",
			TYPESAFE_API_KEY: "",
			E2E_JEV_CONTROL_DIR: JEV_CONTROL_DIR,
			BACKGROUND_JOBS: "on",
			WEB_RESEARCH: "on",
			STORAGE_DRIVER: "postgres",
			DATABASE_URL: database,
			APP_ORIGIN: RESTART_URL,
			GITHUB_APP_SLUG: "chopin-e2e",
			GITHUB_APP_CLIENT_ID: "e2e",
			GITHUB_APP_CLIENT_SECRET: "e2e",
			GITHUB_ALLOWED_USERS: "",
			GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
			DEV_QUESTIONS: "",
			DEV_COMMENTS: "",
		},
	});
	let output = "";
	for (let stream of [child.stdout, child.stderr]) {
		stream.on("data", chunk => output = (output + String(chunk)).slice(-4000));
	}
	try {
		await expect.poll(async () => {
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(`restart app exited: ${output}`);
			}
			try {
				return (await fetch(RESTART_URL)).ok;
			} catch {
				return false;
			}
		}, { timeout: 15_000 }).toBe(true);
		return child;
	} catch (error) {
		await stopJevProcess(child);
		throw new Error(`restart app did not become ready: ${output}`, { cause: error });
	}
}

export async function stopJevProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	let exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	child.kill("SIGTERM");
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			exited,
			new Promise<void>((_, reject) => {
				timer = setTimeout(() => reject(new Error("restart app did not stop")), 5_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
