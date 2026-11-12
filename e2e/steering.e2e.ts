/**
 * Nothing is held for the Planner. A message to Chopin while its turn runs is in the Chat at once
 * and given to that turn, which reads it at its next step; where the turn cannot take it, or the
 * machine is away, the message says "Couldn't send" and nothing was kept. `HARNESS=remote` needs a
 * server of its own, started here against a database of its own, and a machine that is a client of
 * the agent connection.
 */
import { spawn } from "node:child_process";

import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import { finishTurn } from "../apps/server/src/testing/agent-link";
import { chatInput, expectChatValue, fillChat } from "./chat-input";
import { createChannel, registerTestDatabase, seedChannel } from "./database";
import { authenticate, expect, ready, roomPath, test } from "./room";
import { e2eDatabaseName, e2ePort } from "./ports";
import { HOST, ROOT } from "./servers";

import type { Browser, Locator, Page } from "@playwright/test";
import type { AgentClient, AgentHandlers } from "../packages/agent-link/src/client";

const PORT = e2ePort(8798);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_steering");
const HANDLE = "mona";
const CANNOT = "chopin can't take messages while it works on this machine. Stop it to ask now.";

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
	await seedChannel(PORT, room, "# Steering\nThe score is in draft.\n");
	await authenticate(page, HANDLE, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	return room;
}

/** How many rows an earlier release kept for requests that waited: nothing writes them now. */
async function heldRows(): Promise<number> {
	let database = new SQL(databaseUrls().own);
	try {
		let [row] = await database<{ count: number }[]>`
			SELECT count(*)::int AS count FROM planner_deferred_turns
		`;
		return row!.count;
	} finally {
		await database.close();
	}
}

/** A teammate who has the document open too. */
async function teammate(browser: Browser, room: string, handle: string): Promise<Page> {
	let context = await browser.newContext();
	let page = await context.newPage();
	await authenticate(page, handle, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	return page;
}

/** What the Planner says in Chat, as stream parts. */
function speak(context: Parameters<AgentHandlers["turn"]>[0], id: string, text: string): void {
	context.emit({ type: "text-start", id });
	context.emit({ type: "text-delta", id, delta: text });
	context.emit({ type: "text-end", id });
}

/**
 * A machine whose Planner reads the plan, says so, and then waits for what a person gives its turn
 * before its next step, which says what it was given. `prompts` are the turns it was started for,
 * and `steered` what its running turns were given. Without `steers` it offers no way to take a
 * message mid-run. `release` lets a turn that was given nothing end; a Stop ends it as ever.
 */
async function machine(room: string, options: { steers?: boolean } = { steers: true }) {
	let prompts: string[] = [];
	let steered: string[] = [];
	let aborted = 0;
	let arrived = Promise.withResolvers<void>();
	let released = Promise.withResolvers<void>();
	let handlers: AgentHandlers = {
		async turn(context) {
			// Chopin's own upkeep of the document runs through the same Planner; it is not a message.
			if (context.message.prompt.startsWith("[Background job")) {
				context.emit({ type: "stream-start", modelId: "scripted" });
				return finishTurn(context);
			}
			prompts.push(context.message.prompt);
			context.emit({ type: "stream-start", modelId: "scripted" });
			speak(context, "first", "Reading the plan.");
			let stopped = new Promise<void>(resolve =>
				context.signal.addEventListener("abort", () => resolve(), { once: true })
			);
			await Promise.race([arrived.promise, released.promise, stopped]);
			if (context.signal.aborted) {
				aborted++;
				return;
			}
			if (steered.length) speak(context, "next", `Next step, as asked: ${steered.join(" | ")}`);
			finishTurn(context);
			// Ready for the next turn's own steering.
			arrived = Promise.withResolvers<void>();
		},
		...(options.steers
			? {
				steer(message) {
					steered.push(message.prompt);
					arrived.resolve();
				},
			}
			: {}),
	};
	let client: AgentClient = await connectAgent({
		url: ORIGIN,
		token: `ghu_e2e_${HANDLE}_1`,
		document: room,
		handlers,
	});
	return {
		client,
		prompts,
		steered,
		aborted: () => aborted,
		release: () => released.resolve(),
	};
}

function chat(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

/**
 * Everything the Chat shows of one message a person sent to Chopin, which leads with its mention:
 * not the Planner's own lines, which may repeat what it was told, mentions and all.
 */
function message(page: Page, text: string): Locator {
	return chat(page).locator("[data-chat-message-id]")
		.filter({ has: page.locator("[data-chat-mention-lead]") })
		.filter({ hasText: text });
}

/** What the Planner's next step said it was given. The page shows a handle as its person's name. */
function nextStep(page: Page, said: string): Locator {
	return chat(page).getByText(new RegExp(`Next step, as asked: .*${said}`));
}

async function say(page: Page, text: string): Promise<void> {
	let input = chatInput(page);
	await fillChat(input, `@chopin ${text}`);
	await input.press("Enter");
}

const READING = (page: Page) => chat(page).getByText("Reading the plan.", { exact: true });

test("a message sent while Chopin works is in the Chat at once, given to that turn, and read at its next step", async ({ page }) => {
	test.setTimeout(90_000);
	let room = await open(page);
	let planner = await machine(room);
	let input = chatInput(page);
	try {
		await say(page, "outline the plan");
		await expect(READING(page)).toBeVisible();
		await expect(chat(page).getByRole("button", { name: "Stop generating" })).toBeVisible();

		// Typing a second message while the turn runs turns the one button into Send, which steers
		// the running turn as an ordinary message at once and returns the empty draft to Stop.
		await fillChat(input, "@chopin and cover the rollback too");
		let send = chat(page).getByRole("button", { name: "Send message" });
		await expect(send).toBeEnabled();
		await send.click();
		let steering = message(page, "cover the rollback too");
		await expect(steering).toHaveCount(1);
		await expectChatValue(input, "");
		await expect(steering.locator("[data-chat-failed]")).toHaveCount(0);
		await expect(chat(page).locator('[data-chat-state="queued"]')).toHaveCount(0);
		await expect(chat(page).getByText("queued", { exact: true })).toHaveCount(0);

		// The turn that was running reads it at its next step, and says so: no second turn began.
		await expect(nextStep(page, "and cover the rollback too")).toHaveCount(1);
		expect(planner.steered).toEqual([`@${HANDLE}: and cover the rollback too`]);
		expect(planner.prompts).toHaveLength(1);
		await expect(chat(page).getByRole("button", { name: "Stop generating" })).toHaveCount(0);

		// Still there, once, after a reload: it was kept as a message, not as something to run.
		await page.reload();
		await ready(page);
		await expect(message(page, "cover the rollback too")).toHaveCount(1);
		await page.waitForTimeout(500);
		expect(planner.prompts).toHaveLength(1);
		expect(planner.steered).toHaveLength(1);
	} finally {
		await planner.client.detach();
	}
});

test("Stop with an empty draft ends the running turn, and the draft being empty is all it asks", async ({ page }) => {
	test.setTimeout(90_000);
	let room = await open(page);
	let planner = await machine(room);
	let input = chatInput(page);
	try {
		await say(page, "outline the plan");
		await expect(READING(page)).toBeVisible();
		await expectChatValue(input, "");
		let stop = chat(page).getByRole("button", { name: "Stop generating" });
		await expect(stop).toBeVisible();
		await stop.click();
		await expect(chat(page).getByText(/stopped the turn\./)).toBeVisible();
		await expect.poll(planner.aborted).toBe(1);
		await expect(stop).toHaveCount(0);
		// What was said stays; nothing was given to a turn that was stopped, and nothing is left waiting.
		expect(planner.steered).toEqual([]);
		await expect(message(page, "outline the plan")).toHaveCount(1);
		// Chopin takes the next message as a turn of its own.
		await say(page, "try once more");
		await expect.poll(() => planner.prompts.length).toBe(2);
		planner.release();
	} finally {
		await planner.client.detach();
	}
});

test("a message to a machine that is away is refused with the draft kept, nothing is saved, and sending again when the machine is back answers once", async ({ page }) => {
	test.setTimeout(90_000);
	let room = await open(page);
	let input = chatInput(page);

	// No machine is connected to take it: chopin says so in its quiet row, and the typed text stays in
	// the draft so nothing is lost.
	await say(page, "outline the plan");
	let refusal = chat(page).locator("[data-quiet-note]");
	await expect(refusal).toContainText("No machine is connected, so this message wasn't sent.");
	await expect(refusal.getByRole("button", { name: "How to fix" })).toBeVisible();
	await expectChatValue(input, "@chopin outline the plan");
	await expect(message(page, "outline the plan")).toHaveCount(0);
	await expect(chat(page).locator('[data-chat-state="queued"]')).toHaveCount(0);

	// The server kept nothing: after a reload there is no message in Chat and no deferred row.
	expect(await heldRows()).toBe(0);
	await page.reload();
	await ready(page);
	await expect(message(page, "outline the plan")).toHaveCount(0);
	await expectChatValue(input, "@chopin outline the plan");

	// The machine comes back: pressing Enter on the kept draft sends it and answers once.
	let planner = await machine(room);
	try {
		await input.press("Enter");
		await expect(READING(page)).toBeVisible();
		await expect(refusal).toHaveCount(0);
		await expectChatValue(input, "");
		expect(planner.prompts).toHaveLength(1);
		expect(planner.prompts[0]).toContain("outline the plan");
		planner.release();
	} finally {
		await planner.client.detach();
	}
});

test("when a newer draft is already in the composer, a refused earlier message offers Try again and Delete on itself, and Delete takes it away from this browser only", async ({ page }) => {
	test.setTimeout(90_000);
	let hold = true;
	let release: (() => void) | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(raw => {
			if (hold && typeof raw === "string" && raw.includes('"chat:send"')) {
				hold = false;
				release = () => server.send(raw);
				return;
			}
			server.send(raw);
		});
		server.onMessage(raw => route.send(raw));
	});
	await open(page);
	let input = chatInput(page);
	await say(page, "outline the plan");
	await expect.poll(() => release !== undefined).toBe(true);
	await fillChat(input, "another thought");
	release!();

	let sent = message(page, "outline the plan");
	await expect(sent.locator("[data-chat-failed]")).toContainText("Couldn't send.");
	await expectChatValue(input, "another thought");
	// Delete is in the message's menu, from the toolbar a pointer on the message brings up.
	await sent.hover();
	await sent.getByRole("button", { name: "Message actions" }).click();
	await page.getByRole("menu", { name: "Message actions" }).getByRole("menuitem", {
		name: "Delete",
	})
		.click();
	await expect(sent).toHaveCount(0);
	await input.fill("");
	await page.reload();
	await ready(page);
	await expect(sent).toHaveCount(0);
});

test("a machine that takes no message mid-run refuses one sent while it works, keeps the draft, and Stop then Send starts a turn", async ({ page }) => {
	test.setTimeout(90_000);
	let room = await open(page);
	let planner = await machine(room, { steers: false });
	let input = chatInput(page);
	try {
		await say(page, "outline the plan");
		await expect(READING(page)).toBeVisible();
		await say(page, "and cover the rollback too");
		let refusal = chat(page).locator("[data-quiet-note]");
		await expect(refusal).toContainText(CANNOT);
		await expectChatValue(input, "@chopin and cover the rollback too");
		await expect(message(page, "cover the rollback too")).toHaveCount(0);
		expect(planner.steered).toEqual([]);
		expect(planner.prompts).toHaveLength(1);

		// Stop is how to ask now; the turn ends, the button becomes Send, and the kept draft starts a turn.
		await chat(page).getByRole("button", { name: "Stop generating" }).click();
		await expect.poll(planner.aborted).toBe(1);
		await chat(page).getByRole("button", { name: "Send message" }).click();
		await expect.poll(() => planner.prompts.length).toBe(2);
		expect(planner.prompts[1]).toContain("cover the rollback too");
		await expect(refusal).toHaveCount(0);
		await expectChatValue(input, "");
		planner.release();
	} finally {
		await planner.client.detach();
	}
});

test("two people steer one turn: each message is in both Chats at once and the turn reads both, in the order they were sent", async ({ browser, page }) => {
	test.setTimeout(120_000);
	let room = await open(page);
	let planner = await machine(room);
	let other = await teammate(browser, room, "hubot");
	try {
		await say(page, "outline the plan");
		await expect(READING(page)).toBeVisible();
		await expect(READING(other)).toBeVisible();

		await say(other, "keep it short");
		// In both Chats at once, from the teammate, with nothing waiting on either.
		for (let view of [page, other]) {
			await expect(message(view, "keep it short")).toHaveCount(1);
			await expect(message(view, "keep it short").locator("[data-chat-failed]")).toHaveCount(0);
			await expect(chat(view).locator('[data-chat-state="queued"]')).toHaveCount(0);
		}
		await expect(chat(page).getByText("hubot", { exact: true }).first()).toBeVisible();

		await expect(nextStep(page, "keep it short")).toHaveCount(1);
		expect(planner.steered).toEqual(["@hubot: keep it short"]);
		expect(planner.prompts).toHaveLength(1);
		await expect(nextStep(other, "keep it short")).toHaveCount(1);
		await expect(chat(page).getByRole("button", { name: "Stop generating" })).toHaveCount(0);
		await expect(chat(other).getByRole("button", { name: "Stop generating" })).toHaveCount(0);
	} finally {
		await planner.client.detach();
	}
});

test("a reader cannot steer: a message sent for the running turn is refused for want of write access, and reaches nobody", async ({ browser, page }) => {
	test.setTimeout(120_000);
	let room = await open(page);
	let planner = await machine(room);
	let context = await browser.newContext();
	let reader = await context.newPage();
	let refusals: Array<{ kind: string; message?: string }> = [];
	let send: ((frame: Record<string, unknown>) => void) | undefined;
	await reader.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		send = frame => server.send(JSON.stringify(frame));
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string; message?: string };
				if (frame.kind === "session:error") refusals.push(frame);
			}
			route.send(message);
		});
	});
	try {
		await authenticate(reader, "readonly", ORIGIN);
		await reader.goto(`${ORIGIN}${roomPath(room)}`);
		// A reader's document is not editable, so this waits for the Chat and the connection.
		await expect(chat(reader)).toBeVisible();
		await expect.poll(() => send !== undefined).toBe(true);
		await say(page, "outline the plan");
		await expect(READING(page)).toBeVisible();

		// A hand-made frame, as a custom client would send: the composer offers a reader nothing.
		send!({
			kind: "chat:send",
			ts: 0,
			rid: "reader-steer",
			requestId: crypto.randomUUID(),
			to: "planner",
			text: "@chopin say something else",
		});
		await expect.poll(() => refusals.map(frame => frame.message)).toContain(
			"repository write access is required",
		);
		await page.waitForTimeout(500);
		expect(planner.steered).toEqual([]);
		expect(planner.prompts).toHaveLength(1);
		await expect(message(page, "say something else")).toHaveCount(0);
		await expect(message(reader, "say something else")).toHaveCount(0);
		planner.release();
	} finally {
		await planner.client.detach();
		await context.close();
	}
});
