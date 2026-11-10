/**
 * One banner per cause beside the Chat composer, against a real remote Planner: a reply that
 * failed keeps its banner and Retry when the machine drops after it, a message the server refused
 * is told beside a machine that is not connected, and a loss of the room's own connection is the
 * one banner while it lasts. `HARNESS=remote` needs a server of its own, started here against a
 * database of its own.
 */
import { spawn } from "node:child_process";

import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import { instruction } from "../packages/protocol/address";
import { finishTurn } from "../apps/server/src/testing/agent-link";
import { allBanners, connectionBanner, failureBanner, RESUMED_WAIT, watchBanners } from "./banner";
import { chatInput, fillChat } from "./chat-input";
import { createChannel, registerTestDatabase, seedChannel } from "./database";
import { e2eDatabaseName, e2ePort } from "./ports";
import { authenticate, expect, ready, roomPath, test } from "./room";
import { HOST, ROOT } from "./servers";

import type { Page, WebSocketRoute } from "@playwright/test";
import type { Chat } from "../packages/protocol/index";
import type { AgentClient, AgentHandlers } from "../packages/agent-link/src/client";

const PORT = e2ePort(8800);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_connection_slots");
const HANDLE = "mona";
const RATE_LIMITED = "The model service answered 429: too many requests.";
const PLANNER_HELD =
	/^@mona's machine stepped away\. Your work is kept until \d{1,2}:\d{2}[^.]*\.$/;
const NO_MACHINE = "No machine is connected.";

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

let processes: ReturnType<typeof spawn>[] = [];

// One disposable database and application port, so the tests take turns.
test.describe.configure({ mode: "default" });

async function freshDatabase(): Promise<string> {
	let cluster = new URL(
		process.env.E2E_DATABASE_URL_3
			|| "postgresql://chopin:chopin@127.0.0.1:5436/chopin?sslmode=disable",
	);
	let own = new URL(cluster);
	own.pathname = `/${DATABASE}`;
	let admin = new SQL(cluster.href);
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
		await admin.unsafe(`CREATE DATABASE ${DATABASE}`);
	} finally {
		await admin.close();
	}
	return own.href;
}

async function remoteServer(): Promise<string> {
	let database = await freshDatabase();
	let migrated = Bun.spawn(["bun", "apps/server/src/storage/migrate.ts"], {
		cwd: ROOT,
		env: { ...process.env, ...ENV, DATABASE_URL: database },
		stdout: "ignore",
		stderr: "pipe",
	});
	if (await migrated.exited !== 0) {
		throw new Error(
			`migration failed: ${(await new Response(migrated.stderr).text()).slice(-800)}`,
		);
	}
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
			if ((await fetch(`${ORIGIN}/api/health/ready`)).ok) break;
		} catch { /* Not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	await seedChannel(PORT, room, "# Slots\nThe score is in draft.\n");
	return room;
}

test.afterEach(async () => {
	for (let child of processes.splice(0)) {
		if (child.exitCode !== null || child.pid === undefined) continue;
		let exit = new Promise<void>(resolve => child.once("close", () => resolve()));
		process.kill(-child.pid, "SIGTERM");
		await exit;
	}
});

/**
 * The page's own socket: what it sends to the Chat, and a loss the test can cause and end.
 */
async function wire(page: Page) {
	let away = false;
	let sent: Chat.Send[] = [];
	let sockets: WebSocketRoute[] = [];
	await page.routeWebSocket("**/ws?**", socket => {
		if (away) return void socket.close();
		let server = socket.connectToServer();
		socket.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Send;
				if (frame.kind === "chat:send") sent.push(frame);
			}
			server.send(message);
		});
		server.onMessage(message => socket.send(message));
		sockets.push(socket);
	});
	return {
		sent,
		lose: async () => {
			away = true;
			await sockets.at(-1)!.close();
		},
		back: async () => {
			away = false;
			await page.evaluate(() => dispatchEvent(new Event("online")));
		},
	};
}

/**
 * The sockets the package client opens from now on, so a test can cut the machine's link as a
 * network failure does, with no detach. `restore` puts the global back.
 */
function watchSockets() {
	let sockets: WebSocket[] = [];
	let Native = globalThis.WebSocket;
	globalThis.WebSocket = class extends Native {
		constructor(...args: ConstructorParameters<typeof Native>) {
			super(...args);
			sockets.push(this);
		}
	} as typeof WebSocket;
	return { sockets, restore: () => void (globalThis.WebSocket = Native) };
}

/**
 * A machine whose Planner fails its first reply as a rate-limited model would (`failFirst`) and
 * answers every other message in the words `Answer <n>`. Chopin's own upkeep turns are answered
 * and counted apart, and the sessions Chopin has open on the link are kept, so a test can cut the
 * link once none of them is still open.
 */
async function machine(room: string, failFirst = false) {
	let prompts: string[] = [];
	let open = new Set<string>();
	let upkeep = 0;
	let handlers: AgentHandlers = {
		start(message) {
			open.add(message.session);
		},
		destroy(message) {
			open.delete(message.session);
		},
		async turn(context) {
			if (context.message.prompt.startsWith("[Background job")) {
				upkeep++;
				context.emit({ type: "stream-start", modelId: "scripted" });
				return finishTurn(context);
			}
			prompts.push(context.message.prompt);
			let number = prompts.length;
			context.emit({ type: "stream-start", modelId: "scripted" });
			if (failFirst && number === 1) throw new Error(RATE_LIMITED);
			let id = `answer-${number}`;
			context.emit({ type: "text-start", id });
			context.emit({ type: "text-delta", id, delta: `Answer ${number}` });
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
	return {
		client,
		prompts,
		open,
		get upkeep() {
			return upkeep;
		},
	};
}

function chat(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

test("a failed reply keeps its banner and Retry when the machine drops after it, a loss of the room's connection is the one banner while it lasts, and Retry asks again once the machine is back", async ({ page }) => {
	test.setTimeout(150_000);
	let room = await remoteServer();
	await authenticate(page, HANDLE, ORIGIN);
	await watchBanners(page);
	let socket = await wire(page);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let link = watchSockets();
	try {
		let planner = await machine(room, true);
		let input = chatInput(page);
		await fillChat(input, "@chopin Compare the two drafts");
		await input.press("Enter");

		// The reply failed for a cause of its own: its banner, with Retry, and nothing else.
		let failure = failureBanner(page);
		await expect(failure).toHaveAttribute("data-kind", "error");
		await expect(failure).toContainText("Couldn't finish the reply.");
		await expect(failure.locator(".composer-notice-line")).toHaveText(RATE_LIMITED);
		await expect(failure.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
		await expect(connectionBanner(page)).toHaveCount(0);
		await expect(allBanners(page)).toHaveCount(1);
		expect(planner.prompts).toHaveLength(1);
		expect(socket.sent).toHaveLength(1);

		// The machine's link drops afterwards, with nothing to keep: the failed turn's session and
		// Chopin's upkeep session have both ended.
		await expect.poll(() => planner.upkeep).toBeGreaterThanOrEqual(1);
		await expect.poll(() => planner.open.size).toBe(0);
		link.sockets[0]!.close(3000, "network failed");
		await planner.client.resumption;

		// That is another cause: the machine's banner and the failure's, each once, Retry still there.
		let machineBanner = connectionBanner(page);
		await expect(machineBanner).toHaveAttribute("data-layer", "planner");
		await expect(machineBanner).toHaveAttribute("data-phase", "dropped");
		await expect(machineBanner).toHaveText(PLANNER_HELD);
		await expect(failure).toHaveAttribute("data-kind", "error");
		await expect(failure.locator(".composer-notice-line")).toHaveText(RATE_LIMITED);
		await expect(failure.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
		await expect(allBanners(page)).toHaveCount(2);

		// The room's own connection is lost: it is the cause of anything else that cannot be done,
		// so its banner is the only one while it lasts.
		await socket.lose();
		await expect(machineBanner).toHaveAttribute("data-layer", "socket", { timeout: 15_000 });
		await expect(failureBanner(page)).toHaveCount(0);
		await expect(allBanners(page)).toHaveCount(1);

		// It comes back: the socket's banner goes, and the two causes that remain are told again.
		await socket.back();
		await expect(machineBanner).toHaveAttribute("data-layer", "planner", RESUMED_WAIT);
		await expect(machineBanner).toHaveText(PLANNER_HELD);
		await expect(failure.locator(".composer-notice-line")).toHaveText(RATE_LIMITED);
		await expect(failure.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
		await expect(allBanners(page)).toHaveCount(2);

		// The machine's client is back: its banner goes, and Retry asks the same turn again, once.
		let back = await machine(room);
		await expect(connectionBanner(page)).toHaveCount(0, { timeout: 30_000 });
		await expect(allBanners(page)).toHaveCount(1);
		await failure.getByRole("button", { name: "Retry", exact: true }).click();
		await expect.poll(() => socket.sent.length).toBe(2);
		expect(socket.sent[1]).toMatchObject({
			text: instruction(socket.sent[0]!.text),
			to: socket.sent[0]!.to,
		});
		expect(socket.sent[1]!.requestId).not.toBe(socket.sent[0]!.requestId);
		await expect(chat(page).getByText("Answer 1", { exact: true })).toBeVisible();
		expect(back.prompts).toHaveLength(1);
		await expect(allBanners(page)).toHaveCount(0);
		await back.client.detach();
	} finally {
		link.restore();
	}
});

test("a message the server refused is told beside a machine that is not connected, each cause its own banner", async ({ page }) => {
	test.setTimeout(90_000);
	let room = await remoteServer();
	await authenticate(page, HANDLE, ORIGIN);
	await watchBanners(page);
	let socket = await wire(page);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);

	// No machine serves the document: that is the Planner layer's banner.
	let machineBanner = connectionBanner(page);
	await expect(machineBanner).toHaveAttribute("data-layer", "planner");
	await expect(machineBanner).toContainText(NO_MACHINE);
	await expect(allBanners(page)).toHaveCount(1);

	// A message to the people here, over the server's 64 KiB limit, which the server refuses.
	let input = chatInput(page);
	await input.fill("x".repeat(64 * 1024 + 1));
	await input.press("Enter");
	await expect.poll(() => socket.sent.length).toBe(1);
	expect(socket.sent[0]!.to).toBe("room");

	// The refusal is its own cause, told in its own banner beside the machine's.
	let refused = failureBanner(page);
	await expect(refused).toContainText(
		"Message not sent: chat message exceeds the 64 KiB limit",
	);
	await expect(machineBanner).toHaveAttribute("data-layer", "planner");
	await expect(machineBanner).toContainText(NO_MACHINE);
	await expect(allBanners(page)).toHaveCount(2);
});
