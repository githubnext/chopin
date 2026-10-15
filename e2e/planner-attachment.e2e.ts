/**
 * The document's Chat says who holds its remote Planner, live, as a client
 * attaches over the real agent connection, detaches into its grace period, and the
 * grace period ends. `HARNESS=remote` needs its own server, so this file starts
 * one against a database of its own, created beside local-auth's.
 */
import { spawn } from "node:child_process";

import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import { createChannel, registerTestDatabase, seedChannel } from "./database";
import { authenticate, content, expect, ready, roomPath, test } from "./room";
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

// The remote-Planner tests share one disposable database and application port.
test.describe.configure({ mode: "default" });

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

	let client = await connectAgent({
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

/** Open a new comment on the document's first paragraph. */
async function draft(page: Page) {
	await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== "running"));
	await content(page).locator("p").first().selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	return page.getByRole("dialog", { name: "New comment" });
}

test("a new comment is sent to Chopin by default only while a Planner is attached", async ({ page }) => {
	test.setTimeout(90_000);
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(PORT, room, "# Remote comments\nThe harp needs new strings.\n");

	await authenticate(page, HANDLE, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	await expect(plannerStatus(page)).toHaveAttribute("data-planner-state", "none");

	let card = await draft(page);
	let box = card.getByRole("checkbox", { name: "Send to Chopin" });
	await expect(box).not.toBeChecked();

	// Ticked anyway, the server refuses it, says how to attach one, and keeps the words.
	await box.check();
	let field = card.getByRole("textbox", { name: "Comment" });
	await field.fill("Can you shorten this?");
	await card.getByRole("button", { name: "Post comment", exact: true }).click();
	await expect(card.getByRole("alert")).toContainText("No Planner is attached to this document.");
	await expect(field).toHaveValue("Can you shorten this?");
	await page.keyboard.press("Escape");
	await expect(card).toHaveCount(0);

	let client = await connectAgent({
		url: ORIGIN,
		token: `ghu_e2e_${HANDLE}_1`,
		document: room,
		handlers: { turn() {} },
	});
	try {
		await expect(plannerStatus(page)).toHaveAttribute("data-planner-state", "attached");
		await expect((await draft(page)).getByRole("checkbox", { name: "Send to Chopin" }))
			.toBeChecked();
	} finally {
		await client.detach();
	}
});

type Probe = { frames: string[]; closed?: { code: number; at: number } };

/** Open a bare socket from the page, so its cookie and origin are the browser's own. */
async function openProbe(page: Page, name: string, path: string): Promise<void> {
	await page.evaluate(async ({ name, url }) => {
		let probe: Probe = { frames: [] };
		((window as unknown as { probes?: Record<string, Probe> }).probes ??= {})[name] = probe;
		let socket = new WebSocket(url);
		socket.addEventListener("message", event => probe.frames.push(String(event.data)));
		socket.addEventListener("close", event => {
			probe.closed = { code: event.code, at: performance.now() };
		});
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("close", () => reject(new Error(`${name} was refused`)), {
				once: true,
			});
		});
	}, { name, url: `ws://${HOST}:${PORT}${path}` });
}

function probe(page: Page, name: string): Promise<Probe> {
	return page.evaluate(
		name => (window as unknown as { probes: Record<string, Probe> }).probes[name]!,
		name,
	);
}

test("signing out closes that login's sockets at once, and the Planner is never announced to them", async ({ browser }) => {
	test.setTimeout(90_000);
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);

	// Another login in the same room, whose socket must outlive the sign-out.
	let other = await browser.newContext();
	let reader = await other.newPage();
	await authenticate(reader, "review-b", ORIGIN);
	await reader.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(reader);
	let status = plannerStatus(reader);
	await expect(status).toHaveAttribute("data-planner-state", "none");

	let leaving = await browser.newContext();
	let page = await leaving.newPage();
	await authenticate(page, "review-a", ORIGIN);
	await page.goto(`${ORIGIN}/api/session`);
	await openProbe(page, "room", `/ws?channel=${room}`);
	await openProbe(page, "sidebar", "/ws/sidebar");
	await expect.poll(async () => (await probe(page, "room")).frames.length).toBeGreaterThan(0);

	let signedOut = await page.evaluate(async () => {
		let at = performance.now();
		let response = await fetch("/auth/logout", { method: "POST" });
		return { status: response.status, at };
	});
	expect(signedOut.status).toBe(204);
	for (let name of ["room", "sidebar"]) {
		await expect.poll(async () => (await probe(page, name)).closed, { timeout: 1_000 })
			.toBeDefined();
		let closed = (await probe(page, name)).closed!;
		expect(closed.code).toBe(4401);
		expect(closed.at - signedOut.at).toBeLessThan(1_000);
	}
	let heard = (await probe(page, "room")).frames.length;

	let client = await connectAgent({
		url: ORIGIN,
		token: "ghu_e2e_review-b_1",
		document: room,
		handlers: { turn() {} },
	});
	await expect(status).toHaveText("Planner: review-b attached");
	expect((await probe(page, "room")).frames.slice(heard)).toEqual([]);
	await client.detach();
	await other.close();
	await leaving.close();
});

/** A bare WebSocket upgrade request as the member, offering `subprotocol` when given. */
function handshake(path: string, subprotocol?: string): Promise<Response> {
	return fetch(`${ORIGIN}${path}`, {
		headers: {
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-version": "13",
			"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			authorization: `Bearer ghu_e2e_${HANDLE}_1`,
			...(subprotocol ? { "sec-websocket-protocol": subprotocol } : {}),
		},
	});
}

test("the agent connection opens only at /api/v1/agent, offering chopin.agent.v1", async () => {
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	for (let offered of [undefined, "chopin.agent.v2, graphql-ws"]) {
		let refused = await handshake("/api/v1/agent", offered);
		expect(refused.status).toBe(426);
		expect(refused.headers.get("sec-websocket-protocol")).toBeNull();
		expect(await refused.json()).toEqual({
			code: "subprotocol-required",
			supported: ["chopin.agent.v1"],
		});
	}
	let accepted = await handshake("/api/v1/agent", "chopin.agent.v2, chopin.agent.v1");
	expect(accepted.status).toBe(101);
	expect(accepted.headers.get("sec-websocket-protocol")).toBe("chopin.agent.v1");
	// The old path is gone: no WebSocket opens there, and the web client is no answer.
	let old = await handshake("/planner-link", "chopin.agent.v1");
	expect(old.status).toBe(404);
	expect(await old.text()).not.toContain("<html");
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
