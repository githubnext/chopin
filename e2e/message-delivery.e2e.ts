/**
 * A message to the document's machine is never refused because the machine is away. It is in the
 * Chat the moment it is sent, the composer is empty, and one quiet mark says how far it has got:
 * a clock while only this browser has it, one tick once the server has it, two once the machine
 * took it. `HARNESS=remote` needs a server of its own, started here against a database of its own.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import { finishTurn } from "../apps/server/src/testing/agent-link";
import { chatInput, expectChatValue, fillChat } from "./chat-input";
import { createChannel, registerTestDatabase, seedChannel } from "./database";
import { authenticate, expect, ready, roomPath, test } from "./room";
import { e2eDatabaseName, e2ePort } from "./ports";
import { HOST, ROOT } from "./servers";

import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import type { AgentClient, AgentHandlers } from "../packages/agent-link/src/client";

const PORT = e2ePort(8798);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_message_delivery");
const HANDLE = "mona";
const PHONE = {
	hasTouch: true,
	isMobile: true,
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
};

/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

async function snap(target: Page | Locator, name: string): Promise<void> {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	await target.screenshot({ path: `${SHOTS}/${name}.png`, animations: "disabled" });
}

function databaseUrls() {
	let cluster = new URL(
		process.env.E2E_DATABASE_URL_3
			|| "postgresql://chopin:chopin@127.0.0.1:5436/chopin?sslmode=disable",
	);
	let own = new URL(cluster);
	own.pathname = `/${DATABASE}`;
	return { cluster: cluster.href, own: own.href };
}

async function freshDatabase(): Promise<string> {
	let { cluster, own } = databaseUrls();
	let admin = new SQL(cluster);
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
		await admin.unsafe(`CREATE DATABASE ${DATABASE}`);
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
	JEV_API_KEY: "e2e-jev-only",
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

// One disposable database and application port, so the tests take turns.
test.describe.configure({ mode: "default" });

async function remoteServer(database: string) {
	// The reply check of the real server asks a model; the fake one answers it, as in the other servers.
	let child = spawn(process.execPath, [
		"--preload",
		"./e2e/github.ts",
		"--preload",
		"./e2e/jev.ts",
		"apps/server/src/main.ts",
	], {
		cwd: ROOT,
		detached: true,
		env: {
			...process.env,
			...ENV,
			DATABASE_URL: database,
			AGENT: "on",
			HARNESS: "remote",
			DECISIONS_MODEL: "typesafe/jev-latest",
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
			if ((await fetch(`${ORIGIN}/api/health/ready`)).ok) return;
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

/** A document on a fresh server, opened by `HANDLE`, with no machine yet. */
async function open(page: Page): Promise<string> {
	let database = await freshDatabase();
	await migrate(database);
	await remoteServer(database);
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(PORT, room, "# Delivery\nThe score is in draft.\n");
	await authenticate(page, HANDLE, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	return room;
}

/**
 * A machine whose Planner answers every message once, in the words `Answer <n>`, and keeps what it
 * was asked in `prompts`. Given `hold`, its first turn does not end until that settles, so the rest
 * wait behind it.
 */
async function machine(room: string, hold?: Promise<void>) {
	let prompts: string[] = [];
	let handlers: AgentHandlers = {
		async turn(context) {
			// Chopin's own upkeep of the document runs through the same Planner; it is not a message.
			if (context.message.prompt.startsWith("[Background job")) {
				context.emit({ type: "stream-start", modelId: "scripted" });
				return finishTurn(context);
			}
			prompts.push(context.message.prompt);
			if (prompts.length === 1) await hold;
			let id = `answer-${prompts.length}`;
			context.emit({ type: "stream-start", modelId: "scripted" });
			context.emit({ type: "text-start", id });
			context.emit({ type: "text-delta", id, delta: `Answer ${prompts.length}` });
			context.emit({ type: "text-end", id });
			finishTurn(context);
		},
	};
	let client: AgentClient = await connectAgent({
		url: ORIGIN,
		token: `ghu_e2e_${HANDLE}_1`,
		document: room,
		handlers,
	});
	return { client, prompts };
}

function chat(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

/** Everything the Chat shows of one message the person sent. */
function message(page: Page, text: string): Locator {
	return chat(page).locator("[data-chat-message-id]").filter({ hasText: text });
}

function answers(page: Page): Locator {
	return chat(page).getByText(/^Answer \d+$/);
}

async function say(page: Page, text: string): Promise<void> {
	let input = chatInput(page);
	await fillChat(input, `@chopin ${text}`);
	await input.press("Enter");
}

/** A refusal or a strip about the send is never what says a message did not go. */
async function expectNoSendError(page: Page): Promise<void> {
	await expect(page.locator(".chat-composer .composer-notice[data-error]")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Send message" })).not.toHaveAttribute(
		"aria-busy",
		"true",
	);
}

/** The page's own socket, which a test can cut and let come back. */
function route(page: Page) {
	let sockets: WebSocketRoute[] = [];
	let state = {
		offline: false,
		loseAcknowledgement: false,
		/** How the server answers the next deletes it is asked, without having been asked. */
		refuseDeletes: [] as Array<{ code?: string }>,
		/** How many deletes reached the wire. */
		deletes: 0,
		/** How the server answers the next sends it is asked, without having been asked. */
		refuseSends: [] as Array<{ code?: string; message: string }>,
		/** The request ids of the sends that reached the wire, refused ones included. */
		sends: [] as string[],
	};
	let ready = page.routeWebSocket("**/ws?**", socket => {
		if (state.offline) return socket.close();
		let server = socket.connectToServer();
		socket.onMessage(message => {
			let frame = typeof message === "string"
				? JSON.parse(message) as { kind: string; rid?: string }
				: undefined;
			if (frame?.kind === "chat:send") {
				state.sends.push((frame as { requestId?: string }).requestId ?? "");
				let refusal = state.refuseSends.shift();
				if (refusal) {
					socket.send(JSON.stringify({
						kind: "session:error",
						ts: 0,
						rid: frame.rid,
						message: refusal.message,
						...(refusal.code ? { code: refusal.code } : {}),
					}));
					return;
				}
			}
			if (frame?.kind === "chat:delete") {
				state.deletes++;
				let refusal = state.refuseDeletes.shift();
				if (refusal) {
					socket.send(JSON.stringify({
						kind: "session:error",
						ts: 0,
						rid: frame.rid,
						message: "could not delete message",
						...(refusal.code ? { code: refusal.code } : {}),
					}));
					return;
				}
			}
			server.send(message);
		});
		server.onMessage(message => {
			// The server took the message, and the answer goes with the connection.
			if (
				state.loseAcknowledgement && typeof message === "string"
				&& (JSON.parse(message) as { kind: string }).kind === "chat:send"
			) {
				state.loseAcknowledgement = false;
				state.offline = true;
				server.close();
				socket.close();
				return;
			}
			socket.send(message);
		});
		sockets.push(socket);
	});
	return { sockets, state, ready };
}

test("a message to a machine that is away is in the Chat at once, marked Sent, and delivered once, with one reply, when the machine is back", async ({ page }) => {
	test.setTimeout(90_000);
	let room = await open(page);
	let input = chatInput(page);

	await say(page, "outline the plan");
	let sent = message(page, "outline the plan");
	// At once, as the person's own, with the composer empty and nothing said above it.
	await expect(sent).toHaveCount(1);
	await expect(sent.getByRole("img", { name: "Sent" })).toBeVisible();
	await expectChatValue(input, "");
	await expectNoSendError(page);
	await snap(chat(page), "delivery-sent-desktop");

	// After a reload it is still there, once, and still Sent.
	await page.reload();
	await ready(page);
	await expect(sent).toHaveCount(1);
	await expect(sent.getByRole("img", { name: "Sent" })).toBeVisible();

	let planner = await machine(room);
	try {
		await expect(sent.getByRole("img", { name: "Delivered" })).toBeVisible();
		await expect(answers(page)).toHaveCount(1);
		await expect(answers(page)).toHaveText("Answer 1");
		await expect(sent).toHaveCount(1);
		await expect(sent.getByRole("img", { name: "Sent" })).toHaveCount(0);
		expect(planner.prompts.filter(prompt => prompt.includes("outline the plan"))).toHaveLength(1);
		await expectNoSendError(page);
		await snap(chat(page), "delivery-delivered-desktop");
		// No more turns follow: it was delivered once.
		await page.waitForTimeout(500);
		expect(planner.prompts).toHaveLength(1);
	} finally {
		await planner.client.detach();
	}
});

test("what was sent while the page was offline waits to send, then is Sent once and in order, and the machine takes it in that order", async ({ page }) => {
	test.setTimeout(90_000);
	let wire = route(page);
	await wire.ready;
	let room = await open(page);
	let input = chatInput(page);

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await say(page, "first thing");
	await say(page, "second thing");
	let first = message(page, "first thing");
	let second = message(page, "second thing");
	await expect(first).toHaveCount(1);
	await expect(second).toHaveCount(1);
	await expect(first.getByRole("img", { name: "Waiting to send" })).toBeVisible();
	await expect(second.getByRole("img", { name: "Waiting to send" })).toBeVisible();
	await expectChatValue(input, "");
	await snap(chat(page), "delivery-waiting-desktop");

	wire.state.offline = false;
	await expect(first.getByRole("img", { name: "Sent" })).toBeVisible({ timeout: 30_000 });
	await expect(second.getByRole("img", { name: "Sent" })).toBeVisible();
	await expect(first).toHaveCount(1);
	await expect(second).toHaveCount(1);
	await expect(chat(page).locator("[data-chat-message-id]")).toHaveText([
		/first thing/,
		/second thing/,
	]);

	let planner = await machine(room);
	try {
		await expect(first.getByRole("img", { name: "Delivered" })).toBeVisible();
		await expect(second.getByRole("img", { name: "Delivered" })).toBeVisible();
		await expect(answers(page)).toHaveCount(2);
		expect(planner.prompts).toHaveLength(2);
		expect(planner.prompts[0]).toContain("first thing");
		expect(planner.prompts[1]).toContain("second thing");
		expect(planner.prompts[0]).not.toContain("second thing");
	} finally {
		await planner.client.detach();
	}
});

test("a message not yet delivered is deleted from its own menu, for everyone, and is never sent; one the machine took has no menu", async ({ browser, page }) => {
	test.setTimeout(90_000);
	let room = await open(page);
	let teammate = await browser.newContext();
	try {
		let other = await teammate.newPage();
		await authenticate(other, "hubot", ORIGIN);
		await other.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(other);

		await say(page, "keep this one");
		await say(page, "drop this one");
		let drop = message(page, "drop this one");
		await expect(drop.getByRole("img", { name: "Sent" })).toBeVisible();
		await expect(message(other, "drop this one")).toHaveCount(1);
		// A teammate sees the message, and neither its mark nor its menu.
		await expect(message(other, "drop this one").getByRole("img")).toHaveCount(0);
		await expect(message(other, "drop this one").getByRole("button", { name: "Message actions" }))
			.toHaveCount(0);

		await drop.hover();
		await drop.getByRole("button", { name: "Message actions" }).click();
		let menu = page.getByRole("menu", { name: "Message actions" });
		await snap(page, "delivery-menu-desktop");
		await menu.getByRole("menuitem", { name: "Delete" }).click();
		await expect(drop).toHaveCount(0);
		await expect(message(other, "drop this one")).toHaveCount(0);
		await expect(message(page, "keep this one")).toHaveCount(1);

		let planner = await machine(room);
		try {
			let kept = message(page, "keep this one");
			await expect(kept.getByRole("img", { name: "Delivered" })).toBeVisible();
			await expect(answers(page)).toHaveCount(1);
			expect(planner.prompts).toHaveLength(1);
			expect(planner.prompts.join("\n")).not.toContain("drop this one");
			await kept.hover();
			await expect(kept.getByRole("button", { name: "Message actions" })).toHaveCount(0);
			await page.reload();
			await ready(page);
			await expect(message(page, "drop this one")).toHaveCount(0);
		} finally {
			await planner.client.detach();
		}
	} finally {
		await teammate.close();
	}
});

test("a message the page deletes while it is offline never reaches the server", async ({ page }) => {
	test.setTimeout(90_000);
	let wire = route(page);
	await wire.ready;
	let room = await open(page);

	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await say(page, "changed my mind");
	await say(page, "this one stays");
	let gone = message(page, "changed my mind");
	await expect(gone.getByRole("img", { name: "Waiting to send" })).toBeVisible();
	await gone.hover();
	await gone.getByRole("button", { name: "Message actions" }).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await expect(gone).toHaveCount(0);

	wire.state.offline = false;
	let stays = message(page, "this one stays");
	await expect(stays.getByRole("img", { name: "Sent" })).toBeVisible({ timeout: 30_000 });
	let planner = await machine(room);
	try {
		await expect(stays.getByRole("img", { name: "Delivered" })).toBeVisible();
		await expect(answers(page)).toHaveCount(1);
		expect(planner.prompts).toHaveLength(1);
		expect(planner.prompts.join("\n")).not.toContain("changed my mind");
	} finally {
		await planner.client.detach();
	}
});

test("a message the server turns down for a passing reason is never marked Couldn't send: it waits to send, goes out again by itself with the same request id, and is delivered once", async ({ page }) => {
	test.setTimeout(120_000);
	let wire = route(page);
	await wire.ready;
	let room = await open(page);

	// Storage is busy for the first two tries: the message is fine, and only the moment is wrong.
	wire.state.refuseSends.push(
		{ code: "temporarily-unavailable", message: "could not save message" },
		{ code: "temporarily-unavailable", message: "authorization is temporarily unavailable" },
	);
	await say(page, "outline the plan");
	let sent = message(page, "outline the plan");
	await expect(sent).toHaveCount(1);
	await expect(sent.getByRole("img", { name: "Waiting to send" })).toBeVisible();
	await expect.poll(() => wire.state.sends.length).toBe(1);
	await expect(sent.getByText("Couldn't send.")).toHaveCount(0);
	await expectNoSendError(page);
	await expectChatValue(chatInput(page), "");

	// Tried again after a moment, and again, then the server takes it: Sent, never failed.
	await expect(sent.getByRole("img", { name: "Sent" })).toBeVisible({ timeout: 30_000 });
	expect(wire.state.sends).toHaveLength(3);
	expect(new Set(wire.state.sends).size).toBe(1);
	await expect(sent.getByText("Couldn't send.")).toHaveCount(0);
	await expectNoSendError(page);

	let planner = await machine(room);
	try {
		await expect(sent.getByRole("img", { name: "Delivered" })).toBeVisible();
		await expect(answers(page)).toHaveCount(1);
		await page.waitForTimeout(1_000);
		expect(planner.prompts.filter(prompt => prompt.includes("outline the plan"))).toHaveLength(1);
		expect(planner.prompts).toHaveLength(1);
		await expect(sent).toHaveCount(1);
	} finally {
		await planner.client.detach();
	}
});

test("a message the server turns down for good says Couldn't send on itself, never above the composer, and is tried again or deleted from there", async ({ page }) => {
	test.setTimeout(120_000);
	await open(page);

	// Over the size the server takes: it can never be delivered as it was sent.
	await fillChat(chatInput(page), `@chopin ${"x".repeat(66_000)}`);
	await chatInput(page).press("Enter");
	let failed = chat(page).locator("[data-chat-message-id]").filter({ hasText: "xxxxxxxx" });
	await expect(failed.getByText("Couldn't send.")).toBeVisible();
	await expect(failed).toContainText("exceeds the 64 KiB limit");
	await expect(failed.getByRole("img")).toHaveCount(0);
	await expect(failed.getByRole("button", { name: "Try again" })).toBeVisible();
	await expect(page.locator(".chat-composer .composer-notice[data-error]")).toHaveCount(0);
	await expectChatValue(chatInput(page), "");
	await snap(chat(page), "delivery-failed-desktop");

	// Tried again, it is refused again and says so again, in the same place.
	await failed.getByRole("button", { name: "Try again" }).click();
	await expect(failed.getByText("Couldn't send.")).toBeVisible();
	await expect(page.locator(".chat-composer .composer-notice[data-error]")).toHaveCount(0);

	// Deleted, it goes, and nothing about it is left.
	await failed.getByRole("button", { name: "Delete" }).click();
	await expect(failed).toHaveCount(0);
	await expect(chat(page).locator("[data-chat-message-id]")).toHaveCount(0);
});

test("a message's Couldn't send gives way to the connection banner while it shows, and is back with the connection", async ({ page }) => {
	test.setTimeout(120_000);
	let wire = route(page);
	await wire.ready;
	await open(page);

	await fillChat(chatInput(page), `@chopin ${"x".repeat(66_000)}`);
	await chatInput(page).press("Enter");
	let failed = chat(page).locator("[data-chat-message-id]").filter({ hasText: "xxxxxxxx" });
	await expect(failed.getByText("Couldn't send.")).toBeVisible();

	// Nothing but the banner speaks of a send while the connection is down: the message stays,
	// without its line, and the person's work is not touched.
	wire.state.offline = true;
	await wire.sockets.at(-1)!.close();
	await expect(page.locator('[data-connection-banner][data-layer="socket"]')).toBeVisible();
	await expect(failed).toHaveCount(1);
	await expect(failed.getByText("Couldn't send.")).toHaveCount(0);
	await expect(failed.getByRole("button", { name: "Try again" })).toHaveCount(0);
	await expect(page.locator("body")).not.toContainText("exceeds the 64 KiB limit");

	// Back with the connection, the same line, as it was.
	wire.state.offline = false;
	await page.evaluate(() => dispatchEvent(new Event("online")));
	// The room's own connection is told no more. This server has no machine attached, so the
	// Planner's own banner ("No machine is connected.") correctly stays, and does not hide the
	// message's line: a missing machine is not why a send was turned down.
	await expect(page.locator('[data-connection-banner]:not([data-layer="planner"])')).toHaveCount(
		0,
		{ timeout: 15_000 },
	);
	await expect(failed.getByText("Couldn't send.")).toBeVisible();
	await expect(failed).toContainText("exceeds the 64 KiB limit");
	await expect(failed.getByRole("button", { name: "Try again" })).toBeVisible();
	await expect(page.locator(".chat-composer .composer-notice[data-error]")).toHaveCount(0);
});

test("a message sent while twenty wait behind a busy machine is never marked Couldn't send: it waits to send, goes out by itself once there is room, and is delivered once, last", async ({ page }) => {
	test.setTimeout(180_000);
	let room = await open(page);
	let busy = Promise.withResolvers<void>();
	let planner = await machine(room, busy.promise);
	try {
		await say(page, "running now");
		await expect(message(page, "running now").getByRole("img", { name: "Delivered" }))
			.toBeVisible();
		// The machine is busy with it, so the next twenty wait, which is all the queue holds.
		for (let number = 1; number <= 20; number++) await say(page, `queued ${number}`);
		await expect(message(page, "queued 20").getByRole("img", { name: "Sent" })).toBeVisible();

		await say(page, "one more");
		let more = message(page, "one more");
		await expect(more).toHaveCount(1);
		await expect(more.getByRole("img", { name: "Waiting to send" })).toBeVisible();
		await page.waitForTimeout(1_000);
		await expect(more.getByText("Couldn't send.")).toHaveCount(0);
		await expect(more.getByRole("img", { name: "Waiting to send" })).toBeVisible();
		await expect(page.locator(".chat-composer .composer-notice[data-error]")).toHaveCount(0);
		await expectChatValue(chatInput(page), "");
		await snap(chat(page), "delivery-waiting-full-desktop");

		// The machine finishes and takes the next, which makes room; the browser sends it again.
		busy.resolve();
		await expect(more.getByRole("img", { name: "Delivered" })).toBeVisible({ timeout: 90_000 });
		await expect(more).toHaveCount(1);
		await expect(answers(page)).toHaveCount(22, { timeout: 90_000 });
		expect(planner.prompts).toHaveLength(22);
		expect(planner.prompts[0]).toContain("running now");
		expect(planner.prompts[1]).toContain("queued 1");
		expect(planner.prompts[20]).toContain("queued 20");
		expect(planner.prompts[21]).toContain("one more");
		expect(planner.prompts.filter(prompt => prompt.includes("one more"))).toHaveLength(1);
		await expect(page.locator(".chat-composer .composer-notice[data-error]")).toHaveCount(0);
	} finally {
		busy.resolve();
		await planner.client.detach();
	}
});

test("a message the server took before its answer was lost can still be deleted while the page is offline: the server is told once it is back, and the machine never gets it", async ({ page }) => {
	test.setTimeout(90_000);
	let wire = route(page);
	await wire.ready;
	let room = await open(page);

	wire.state.loseAcknowledgement = true;
	await say(page, "took it then changed my mind");
	await say(page, "this one stays");
	let gone = message(page, "took it then changed my mind");
	await expect(gone.getByRole("img", { name: "Waiting to send" })).toBeVisible();
	// It was put on the wire, and the server may already have it: it can still be taken back.
	await gone.hover();
	await gone.getByRole("button", { name: "Message actions" }).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await expect(gone).toHaveCount(0);

	wire.state.offline = false;
	let stays = message(page, "this one stays");
	await expect(stays.getByRole("img", { name: "Sent" })).toBeVisible({ timeout: 30_000 });
	await expect(gone).toHaveCount(0);
	let planner = await machine(room);
	try {
		await expect(stays.getByRole("img", { name: "Delivered" })).toBeVisible();
		await expect(answers(page)).toHaveCount(1);
		expect(planner.prompts).toHaveLength(1);
		expect(planner.prompts.join("\n")).not.toContain("changed my mind");
		// Nor does it come back with a reload.
		await page.reload();
		await ready(page);
		await expect(message(page, "took it then changed my mind")).toHaveCount(0);
	} finally {
		await planner.client.detach();
	}
});

test("a message taken back while the page is offline stays taken back across a reload, and is never delivered: the server is told once the page is back", async ({ browser, page }) => {
	test.setTimeout(120_000);
	let wire = route(page);
	await wire.ready;
	let room = await open(page);

	// One the server holds, one it took before its answer was lost, one that never left the page.
	await say(page, "held by the server");
	let held = message(page, "held by the server");
	await expect(held.getByRole("img", { name: "Sent" })).toBeVisible();
	wire.state.loseAcknowledgement = true;
	await say(page, "took it, answer lost");
	await say(page, "never left the page");
	let lost = message(page, "took it, answer lost");
	let local = message(page, "never left the page");
	await expect(lost.getByRole("img", { name: "Waiting to send" })).toBeVisible();
	await expect(local.getByRole("img", { name: "Waiting to send" })).toBeVisible();
	for (let [one, text] of [[held, "held by the server"], [lost, "took it, answer lost"]] as const) {
		await one.hover();
		await one.getByRole("button", { name: "Message actions" }).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await expect(message(page, text)).toHaveCount(0);
	}

	// The page is reloaded while it is still offline: what it was told to take back is kept.
	await page.reload();
	await expect(message(page, "never left the page").getByRole("img", { name: "Waiting to send" }))
		.toBeVisible();
	await expect.poll(() =>
		page.evaluate(() =>
			Object.entries(sessionStorage).filter(([key]) => key.startsWith("chopin:retractions:"))
				.map(([, value]) => (JSON.parse(value) as string[]).length)
		)
	).toEqual([2]);

	wire.state.offline = false;
	let stays = message(page, "never left the page");
	await expect(stays.getByRole("img", { name: "Sent" })).toBeVisible({ timeout: 30_000 });
	await expect(message(page, "held by the server")).toHaveCount(0);
	await expect(message(page, "took it, answer lost")).toHaveCount(0);
	// Told once the page is back, so there is nothing left to tell.
	await expect.poll(() =>
		page.evaluate(() =>
			Object.keys(sessionStorage).filter(key => key.startsWith("chopin:retractions:")).length
		)
	).toBe(0);

	let planner = await machine(room);
	let teammate = await browser.newContext();
	try {
		await expect(stays.getByRole("img", { name: "Delivered" })).toBeVisible();
		await expect(answers(page)).toHaveCount(1);
		expect(planner.prompts).toHaveLength(1);
		expect(planner.prompts[0]).toContain("never left the page");
		expect(planner.prompts.join("\n")).not.toContain("held by the server");
		expect(planner.prompts.join("\n")).not.toContain("answer lost");
		// Gone for everyone, and not back with a reload.
		let other = await teammate.newPage();
		await authenticate(other, HANDLE, ORIGIN);
		await other.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(other);
		await expect(message(other, "never left the page")).toHaveCount(1);
		await expect(message(other, "held by the server")).toHaveCount(0);
		await expect(message(other, "took it, answer lost")).toHaveCount(0);
		await page.reload();
		await ready(page);
		await expect(message(page, "held by the server")).toHaveCount(0);
		await expect(message(page, "took it, answer lost")).toHaveCount(0);
	} finally {
		await teammate.close();
		await planner.client.detach();
	}
});

test("a message the server took before its answer was lost, deleted after a reload while the page is still offline, is never delivered: the server is told once the page is back", async ({ browser, page }) => {
	test.setTimeout(120_000);
	let wire = route(page);
	await wire.ready;
	let room = await open(page);

	wire.state.loseAcknowledgement = true;
	await say(page, "took it, answer lost");
	let lost = message(page, "took it, answer lost");
	await expect(lost.getByRole("img", { name: "Waiting to send" })).toBeVisible();
	await expect.poll(() => wire.state.offline).toBe(true);

	// The page is reloaded while it is offline, and only then does the person take it back.
	await page.reload();
	let again = message(page, "took it, answer lost");
	await expect(again.getByRole("img", { name: "Waiting to send" })).toBeVisible();
	await again.hover();
	await again.getByRole("button", { name: "Message actions" }).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await expect(again).toHaveCount(0);
	// What it was told to take back is kept, and is not lost with the outbox it came from.
	await expect.poll(() =>
		page.evaluate(() =>
			Object.entries(sessionStorage).filter(([key]) => key.startsWith("chopin:retractions:"))
				.map(([, value]) => (JSON.parse(value) as string[]).length)
		)
	).toEqual([1]);

	wire.state.offline = false;
	await say(page, "this one stays");
	let stays = message(page, "this one stays");
	await expect(stays.getByRole("img", { name: "Sent" })).toBeVisible({ timeout: 30_000 });
	await expect(message(page, "took it, answer lost")).toHaveCount(0);
	await expect.poll(() =>
		page.evaluate(() =>
			Object.keys(sessionStorage).filter(key => key.startsWith("chopin:retractions:")).length
		)
	).toBe(0);

	let planner = await machine(room);
	let teammate = await browser.newContext();
	try {
		await expect(stays.getByRole("img", { name: "Delivered" })).toBeVisible();
		await expect(answers(page)).toHaveCount(1);
		await page.waitForTimeout(1_000);
		expect(planner.prompts).toHaveLength(1);
		expect(planner.prompts[0]).toContain("this one stays");
		expect(planner.prompts.join("\n")).not.toContain("answer lost");
		await expect(message(page, "took it, answer lost")).toHaveCount(0);
		let other = await teammate.newPage();
		await authenticate(other, HANDLE, ORIGIN);
		await other.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(other);
		await expect(message(other, "this one stays")).toHaveCount(1);
		await expect(message(other, "took it, answer lost")).toHaveCount(0);
	} finally {
		await teammate.close();
		await planner.client.detach();
	}
});

test("a delete the server refuses for a passing reason is asked again and the message stays hidden and is never delivered; its last word, that the machine has it, shows the message again with its mark", async ({ browser, page }) => {
	test.setTimeout(120_000);
	let wire = route(page);
	await wire.ready;
	let room = await open(page);
	let teammate = await browser.newContext();

	await say(page, "taken back in the end");
	await say(page, "the machine has this one");
	await say(page, "this one stays");
	let back = message(page, "taken back in the end");
	let taken = message(page, "the machine has this one");
	await expect(message(page, "this one stays").getByRole("img", { name: "Sent" })).toBeVisible();
	let other = await teammate.newPage();
	await authenticate(other, HANDLE, ORIGIN);
	await other.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(other);
	await expect(message(other, "taken back in the end")).toHaveCount(1);

	// The first delete is refused for a reason that passes; the second goes through.
	wire.state.refuseDeletes.push({});
	await back.hover();
	await back.getByRole("button", { name: "Message actions" }).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await expect.poll(() => wire.state.deletes).toBe(1);
	// Hidden at once and kept hidden, and the server still has it: it is only asked again.
	await expect(back).toHaveCount(0);
	await page.waitForTimeout(1_000);
	await expect(back).toHaveCount(0);
	await expect(message(other, "taken back in the end")).toHaveCount(1);
	await expect.poll(() => wire.state.deletes, { timeout: 30_000 }).toBe(2);
	await expect(message(other, "taken back in the end")).toHaveCount(0);
	await expect(back).toHaveCount(0);
	await expect.poll(() =>
		page.evaluate(() =>
			Object.keys(sessionStorage).filter(key => key.startsWith("chopin:retractions:")).length
		)
	).toBe(0);

	// The server's last word: it cannot be taken back, so it is shown again as it is and not asked again.
	wire.state.refuseDeletes.push({ code: "message-not-deletable" });
	await taken.hover();
	await taken.getByRole("button", { name: "Message actions" }).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await expect.poll(() => wire.state.deletes).toBe(3);
	await expect(taken).toHaveCount(1);
	await expect(taken.getByRole("img", { name: "Sent" })).toBeVisible();
	await page.waitForTimeout(6_500);
	expect(wire.state.deletes).toBe(3);
	await expect.poll(() =>
		page.evaluate(() =>
			Object.keys(sessionStorage).filter(key => key.startsWith("chopin:retractions:")).length
		)
	).toBe(0);

	let planner = await machine(room);
	try {
		await expect(taken.getByRole("img", { name: "Delivered" })).toBeVisible();
		await expect(answers(page)).toHaveCount(2);
		await page.waitForTimeout(1_000);
		expect(planner.prompts).toHaveLength(2);
		expect(planner.prompts.join("\n")).not.toContain("taken back in the end");
		expect(planner.prompts[0]).toContain("the machine has this one");
		expect(planner.prompts[1]).toContain("this one stays");
	} finally {
		await teammate.close();
		await planner.client.detach();
	}
});

test("on a phone the marks and the menu fit beside a message and open inside the screen", async ({ browser }) => {
	test.setTimeout(90_000);
	let context = await browser.newContext(PHONE);
	try {
		let page = await context.newPage();
		await open(page);
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).click();
		await expect.poll(async () => (await chat(page).boundingBox())?.x).toBe(0);
		await say(
			page,
			"a long message that wraps onto a second line so the mark and the menu have to sit beside text",
		);
		let sent = message(page, "a long message");
		await expect(sent.getByRole("img", { name: "Sent" })).toBeVisible();
		let box = await sent.boundingBox();
		let mark = await sent.getByRole("img", { name: "Sent" }).boundingBox();
		expect(mark!.x + mark!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
		await sent.getByRole("button", { name: "Message actions" }).click();
		let menu = await page.getByRole("menu", { name: "Message actions" }).boundingBox();
		let viewport = page.viewportSize()!;
		expect(menu!.x).toBeGreaterThanOrEqual(0);
		expect(menu!.x + menu!.width).toBeLessThanOrEqual(viewport.width);
		expect(menu!.y + menu!.height).toBeLessThanOrEqual(viewport.height);
		await snap(page, "delivery-menu-phone");
	} finally {
		await context.close();
	}
});
