/**
 * The document's Chat says who holds its remote Planner, live, as a client
 * attaches over the real Planner link, detaches into its grace period, and the
 * grace period ends. `HARNESS=remote` needs its own server, so this file starts
 * one against a database of its own, created beside local-auth's.
 */
import { spawn } from "node:child_process";

import { SQL } from "bun";

import { connectPlannerLink } from "../packages/planner-link/src/client";
import { createChannel, registerTestDatabase } from "./database";
import { authenticate, expect, ready, roomPath, test } from "./room";
import { HARNESS, HOST, ROOT } from "./servers";

import type { Page } from "@playwright/test";

const PORT = 8793;
const ORIGIN = `http://${HOST}:${PORT}`;
const GRACE_MS = 8_000;
const HANDLE = "mona";

/** Local-auth's PostgreSQL service, which this file shares under another database name. */
function databaseUrls() {
	let cluster = new URL(
		process.env.E2E_DATABASE_URL_3
			|| "postgresql://chopin:chopin@127.0.0.1:5436/chopin?sslmode=disable",
	);
	let own = new URL(cluster);
	own.pathname = "/chopin_planner_attachment";
	return { cluster: cluster.href, own: own.href };
}

async function freshDatabase(): Promise<string> {
	let { cluster, own } = databaseUrls();
	let admin = new SQL(cluster);
	try {
		await admin.unsafe("DROP DATABASE IF EXISTS chopin_planner_attachment WITH (FORCE)");
		await admin.unsafe("CREATE DATABASE chopin_planner_attachment");
	} finally {
		await admin.close();
	}
	return own;
}

const ENV = {
	SERVER_HOST: HOST,
	PORT: String(PORT),
	APP_ORIGIN: ORIGIN,
	STORAGE_DRIVER: "postgres",
	GITHUB_APP_SLUG: "chopin-e2e",
	GITHUB_APP_CLIENT_ID: "e2e",
	GITHUB_APP_CLIENT_SECRET: "e2e",
	GITHUB_ALLOWED_USERS: "",
	GITHUB_ALLOWED_ORGANIZATIONS: "githubnext",
	SESSION_ENCRYPTION_KEY: process.env.SESSION_ENCRYPTION_KEY!,
};

async function migrate(database: string): Promise<void> {
	let child = Bun.spawn(["bun", "apps/server/src/storage/migrate.ts"], {
		cwd: ROOT,
		env: { ...process.env, ...ENV, DATABASE_URL: database },
		stdout: "ignore",
		stderr: "pipe",
	});
	if (await child.exited !== 0) {
		throw new Error(`migration failed: ${(await new Response(child.stderr).text()).slice(-800)}`);
	}
}

let processes: ReturnType<typeof spawn>[] = [];

async function remoteServer(database: string) {
	let child = spawn(process.execPath, ["--preload", "./e2e/github.ts", "apps/server/src/main.ts"], {
		cwd: ROOT,
		detached: true,
		env: {
			...process.env,
			...ENV,
			DATABASE_URL: database,
			AGENT: "on",
			HARNESS: "remote",
			PLANNER_ATTACH_GRACE_MS: String(GRACE_MS),
			BACKGROUND_JOBS: "off",
			WEB_RESEARCH: "off",
			CONVERSATION_PLAN: "off",
			DEV_QUESTIONS: "",
			DEV_COMMENTS: "",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let errors = "";
	child.stderr?.on("data", chunk => {
		errors += String(chunk).slice(-2_000);
	});
	processes.push(child);
	for (let index = 0; index < 150; index++) {
		if (child.exitCode !== null) {
			throw new Error(`remote Planner server exited with ${child.exitCode}: ${errors.slice(-800)}`);
		}
		try {
			if ((await fetch(`${ORIGIN}/api/session`)).ok) return;
		} catch { /* Not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error("remote Planner server did not become ready");
}

test.afterEach(async () => {
	for (let child of processes.splice(0)) {
		if (child.exitCode !== null || child.pid === undefined) continue;
		let exit = new Promise<void>(resolve => child.once("close", () => resolve()));
		process.kill(-child.pid, "SIGTERM");
		await exit;
	}
});

function plannerStatus(page: Page) {
	return page.getByRole("status").filter({ hasText: /^Planner:/ });
}

async function shoot(page: Page, name: string): Promise<void> {
	await page.locator(".chat-composer").screenshot({
		path: test.info().outputPath(`${name}.png`),
		animations: "disabled",
	});
}

test("Chat says live who holds the document's remote Planner", async ({ page }) => {
	test.setTimeout(90_000);
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);

	await authenticate(page, HANDLE, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let status = plannerStatus(page);
	await expect(status).toHaveText("Planner: none attached. @chopin needs an attached Planner.");
	await expect(status).toHaveAttribute("data-planner-state", "none");
	await shoot(page, "none");

	let client = await connectPlannerLink({
		url: ORIGIN,
		token: `ghu_e2e_${HANDLE}_1`,
		document: room,
		handlers: { turn() {} },
	});
	await expect(status).toHaveText(`Planner: ${HANDLE} attached`);
	await expect(status).toHaveAttribute("data-planner-state", "attached");
	await shoot(page, "attached");

	let detachedAt = Date.now();
	await client.detach();
	await expect(status).toHaveText(
		new RegExp(`^Planner: ${HANDLE} detached, held until \\d{1,2}:\\d{2}`),
	);
	await expect(status).toHaveAttribute("data-planner-state", "held");
	let until = await status.locator("time").getAttribute("datetime");
	expect(Date.parse(until!)).toBeGreaterThanOrEqual(detachedAt + GRACE_MS - 1_000);
	await shoot(page, "held");

	// The grace period ends with nobody reattaching, and the room hears it without reloading.
	await expect(status).toHaveText("Planner: none attached. @chopin needs an attached Planner.", {
		timeout: GRACE_MS + 5_000,
	});
	await expect(status).toHaveAttribute("data-planner-state", "none");
});

test("Chat says nothing about attachments where the Planner runs on the server", async ({ page }) => {
	let origin = `http://${HOST}:${HARNESS}`;
	let room = crypto.randomUUID();
	await createChannel(HARNESS, room);
	await authenticate(page, HANDLE, origin);
	await page.goto(`${origin}${roomPath(room)}`);
	await ready(page);
	await expect(page.getByRole("combobox", { name: "Message" })).toBeVisible();
	await expect(plannerStatus(page)).toHaveCount(0);
});
