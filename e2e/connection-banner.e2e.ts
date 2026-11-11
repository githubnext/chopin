/**
 * The Chat's one connection banner and the machine's own side of it, against a real remote
 * Planner: a reply that kept going or ended while the page was cut off, a machine whose link
 * dropped under a reply (the connection's to tell, never a failure's), and what asking a machine
 * to start the Planner (`chat:wake`) does for a writer, a reader, an archived document and each
 * state the Planner is in. `HARNESS=remote` needs a server of its own, started here against a
 * database of its own.
 */
import { spawn } from "node:child_process";

import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import { CONNECTOR_PROTOCOL } from "../apps/connector/src/version";
import { instruction } from "../packages/protocol/address";
import {
	CONNECTOR_PLANNER_COMMAND_HEADER,
	CONNECTOR_PLATFORM_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "../packages/protocol/connector";
import { finishTurn } from "../apps/server/src/testing/agent-link";
import { allBanners, connectionBanner, failureBanner, RESUMED_WAIT, watchBanners } from "./banner";
import { chatInput, fillChat } from "./chat-input";
import {
	createChannel,
	registerTestDatabase,
	seedChannel,
	seedChildChannel,
	seedLinkedChildChannel,
} from "./database";
import { e2eDatabaseName, e2ePort } from "./ports";
import { RELEASE } from "./release";
import { authenticate, expect, ready, roomPath, test } from "./room";
import { HOST, ROOT } from "./servers";

import type { Browser, Page, WebSocketRoute } from "@playwright/test";
import type { Chat } from "../packages/protocol/index";
import type { AgentClient, AgentHandlers } from "../packages/agent-link/src/client";

const PORT = e2ePort(8799);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_connection_banner");
const HANDLE = "mona";
const KEPT_GOING = "Back. The reply kept going.";
const FINISHED_AWAY = "Back. The reply finished while you were away.";

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

let processes: ReturnType<typeof spawn>[] = [];
/** The database of the server `remoteServer` started last. */
let serverDatabase = "";

// One disposable database and application port, so the tests take turns.
test.describe.configure({ mode: "default" });

async function remoteServer(): Promise<string> {
	let database = await freshDatabase();
	serverDatabase = database;
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
	await seedChannel(PORT, room, "# Banner\nThe score is in draft.\n");
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
 * The page's own socket, which a test cuts and lets come back. After `back(true)` the server's
 * frames are held on the new socket until `release`, so the page is catching up for as long as
 * the test says.
 */
async function losable(page: Page) {
	let away = false;
	let holding = false;
	let held: Array<string | Buffer> = [];
	let sockets: WebSocketRoute[] = [];
	await page.routeWebSocket("**/ws?**", socket => {
		if (away) return void socket.close();
		let server = socket.connectToServer();
		socket.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (holding) held.push(message);
			else socket.send(message);
		});
		sockets.push(socket);
	});
	return {
		lose: async () => {
			away = true;
			await sockets.at(-1)!.close();
		},
		back: async (hold = false) => {
			away = false;
			holding = hold;
			await page.evaluate(() => dispatchEvent(new Event("online")));
		},
		release: () => {
			holding = false;
			for (let message of held.splice(0)) sockets.at(-1)!.send(message);
		},
	};
}

/**
 * A machine whose Planner answers each message in the words `Answer <n>`. `gates[n]` holds its
 * nth turn open until it settles, so a reply is running for as long as a test says. With
 * `working`, its first message also starts a workflow run, the work a link that drops keeps for
 * its client: without it nothing is kept, and a dropped link is only held for a while.
 */
async function machine(
	room: string,
	gates: Array<Promise<void> | undefined> = [],
	working = false,
) {
	let prompts: string[] = [];
	// The sessions Chopin has open on this link, and how many upkeep turns it has run on them.
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
			// Chopin's own upkeep of the document runs through the same Planner; it is not a message.
			if (context.message.prompt.startsWith("[Background job")) {
				upkeep++;
				context.emit({ type: "stream-start", modelId: "scripted" });
				return finishTurn(context);
			}
			prompts.push(context.message.prompt);
			let number = prompts.length;
			if (working && number === 1) {
				let started = Math.floor(Date.now() / 1000) - 300;
				client.reportRuns(context.message.session, {
					active: ["run-1"],
					paused: [],
					cards: [{
						id: "run-1",
						name: "plan-review",
						status: "running",
						started,
						updated: started + 240,
						stages: [{
							id: "run-1:review",
							name: "review-draft",
							status: "running",
							started,
						}],
						waiting: 0,
					}],
				});
			}
			await gates[number - 1];
			let id = `answer-${number}`;
			context.emit({ type: "stream-start", modelId: "scripted" });
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

async function say(page: Page, text: string): Promise<void> {
	let input = chatInput(page);
	await fillChat(input, `@chopin ${text}`);
	await input.press("Enter");
}

/** A turn the Chat shows running: its composer offers Stop. */
function running(page: Page) {
	return chat(page).getByRole("button", { name: "Stop generating" });
}

test("a reply that kept going while the connection was away is told so, and one that ended while it was away is told so, with what was caught up", async ({ page }) => {
	test.setTimeout(150_000);
	let room = await remoteServer();
	let first = Promise.withResolvers<void>();
	let second = Promise.withResolvers<void>();
	await authenticate(page, HANDLE, ORIGIN);
	await page.addInitScript(() => {
		// The widest jitter, so a scheduled retry cannot pass for the online event.
		Math.random = () => 0.999;
	});
	await watchBanners(page);
	let wire = await losable(page);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let planner = await machine(room, [first.promise, second.promise]);
	try {
		await expect(allBanners(page)).toHaveCount(0);

		// A reply is running when the connection is cut, and still running when it comes back.
		await say(page, "keep going");
		await expect(running(page)).toBeVisible();
		expect(planner.prompts).toHaveLength(1);
		await wire.lose();
		await expect(connectionBanner(page)).toHaveAttribute("data-layer", "socket", {
			timeout: 30_000,
		});
		await wire.back();
		await expect(connectionBanner(page)).toHaveAttribute("data-phase", "resumed", {
			timeout: 30_000,
		});
		await expect(connectionBanner(page)).toContainText(KEPT_GOING);
		await expect(allBanners(page)).toHaveCount(1);
		await expect(connectionBanner(page)).toHaveCount(0, RESUMED_WAIT);
		await expect(running(page)).toBeVisible();
		first.resolve();
		await expect(chat(page).getByText("Answer 1", { exact: true })).toBeVisible();
		await expect(running(page)).toHaveCount(0);

		// A reply is running when the connection is cut, and has ended when it comes back.
		await say(page, "finish while I am away");
		await expect(running(page)).toBeVisible();
		await wire.lose();
		await expect(connectionBanner(page)).toHaveAttribute("data-layer", "socket", {
			timeout: 30_000,
		});
		second.resolve();
		await expect.poll(() => planner.prompts.length).toBe(2);
		await page.waitForTimeout(1_000);
		await wire.back();
		await expect(connectionBanner(page)).toHaveAttribute("data-phase", "resumed", {
			timeout: 30_000,
		});
		await expect(connectionBanner(page)).toContainText(FINISHED_AWAY);
		// What it caught up on is the reply that came in meanwhile.
		await expect(connectionBanner(page)).toContainText(/\d+ new messages?/);
		await expect(chat(page).getByText("Answer 2", { exact: true })).toBeVisible();
		await expect(allBanners(page)).toHaveCount(1);
		await expect(allBanners(page)).toHaveCount(0, RESUMED_WAIT);
		await expect(failureBanner(page)).toHaveCount(0);
	} finally {
		first.resolve();
		second.resolve();
		await planner.client.detach();
	}
});

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

const PLANNER_HELD =
	/^@mona's machine stepped away\. Your work is kept until \d{1,2}:\d{2}[^.]*\.$/;
const PLANNER_OFFLINE = "@mona's machine is offline. Your work is kept.";

test("a machine whose link dropped under a reply with no work to keep is held for a while: the connection's one banner says it stepped away, the failed reply waits behind it, and Retry asks again as it was once the machine is back", async ({ page }) => {
	test.setTimeout(150_000);
	let room = await remoteServer();
	let hold = Promise.withResolvers<void>();
	let referred = crypto.randomUUID();
	let title = `Source review ${referred.slice(0, 8)}`;
	await seedChildChannel(PORT, room, referred, title, "# Referenced child\n");
	await authenticate(page, HANDLE, ORIGIN);
	await watchBanners(page);
	let sent: Chat.Send[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Send;
				if (frame.kind === "chat:send") sent.push(frame);
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let link = watchSockets();
	try {
		let planner = await machine(room, [hold.promise]);
		let input = chatInput(page);
		await fillChat(input, `@chopin Compare #${referred.slice(0, 8)}`);
		let documents = chat(page).getByRole("listbox", { name: "Document references" });
		await documents.getByRole("option", { name: title, exact: true }).click();
		await input.press("Enter");
		await expect(running(page)).toBeVisible();
		expect(planner.prompts).toHaveLength(1);
		expect(sent).toHaveLength(1);
		link.sockets[0]!.close(3000, "network failed");
		await planner.client.resumption;

		// Nothing the machine does was kept for it, so it is held through a grace period: that is
		// the Planner layer's one banner, with no button, and the reply's failure waits behind it.
		let banner = connectionBanner(page);
		await expect(banner).toHaveAttribute("data-layer", "planner");
		await expect(banner).toHaveAttribute("data-phase", "dropped");
		await expect(banner).toHaveText(PLANNER_HELD);
		await expect(banner.getByRole("button")).toHaveCount(0);
		await expect(failureBanner(page)).toHaveCount(0);
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(allBanners(page)).toHaveCount(1);
		let failedLine = chat(page).locator("[data-chat-system]").getByText(
			"The machine disconnected during the turn.",
			{ exact: true },
		);
		await expect(failedLine).toHaveCount(1);

		// The machine's client is back: the connection's banner goes, and the failure is told, as it was.
		let back = await machine(room);
		await expect(connectionBanner(page)).toHaveCount(0, { timeout: 30_000 });
		let failure = failureBanner(page);
		await expect(failure).toHaveAttribute("data-kind", "error");
		await expect(failure).toContainText("Couldn't finish the reply.");
		await expect(failure.locator(".composer-notice-line")).toHaveText(
			"The machine disconnected during the turn.",
		);
		await expect(failedLine).toHaveCount(0);
		await expect(allBanners(page)).toHaveCount(1);

		// Retry asks the same turn again, once, with its references, and the machine answers it.
		await failure.getByRole("button", { name: "Retry", exact: true }).click();
		await expect.poll(() => sent.length).toBe(2);
		expect(sent[1]).toMatchObject({ text: instruction(sent[0]!.text), to: sent[0]!.to });
		expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId);
		// The room keeps the words without the summons, so the reference moves with them: it still
		// names the same document, over the same `#title`.
		let summons = sent[0]!.text.length - sent[1]!.text.length;
		expect(sent[0]!.references).toEqual([{
			kind: "document",
			channelId: referred,
			start: sent[0]!.text.indexOf(`#${title}`),
			end: sent[0]!.text.indexOf(`#${title}`) + title.length + 1,
		}]);
		expect(sent[1]!.references).toEqual([{
			kind: "document",
			channelId: referred,
			start: sent[0]!.references![0]!.start - summons,
			end: sent[0]!.references![0]!.end - summons,
		}]);
		expect(sent[1]!.text.slice(sent[1]!.references![0]!.start, sent[1]!.references![0]!.end))
			.toBe(`#${title}`);
		expect(sent[1]!.focus).toBe(sent[0]!.focus);
		await expect(chat(page).getByText("Answer 1", { exact: true })).toBeVisible();
		expect(back.prompts).toHaveLength(1);
		await expect(allBanners(page)).toHaveCount(0);
		await back.client.detach();
	} finally {
		hold.resolve();
		link.restore();
	}
});

test("a machine whose link dropped under a reply with a workflow run is disconnected, not held: the connection's one banner says it is offline, with no failure banner and the notice once", async ({ page }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let hold = Promise.withResolvers<void>();
	await authenticate(page, HANDLE, ORIGIN);
	await watchBanners(page);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let link = watchSockets();
	try {
		let planner = await machine(room, [hold.promise], true);
		await say(page, "work while the link drops");
		await expect(running(page)).toBeVisible();
		expect(planner.prompts).toHaveLength(1);
		link.sockets[0]!.close(3000, "network failed");
		let kept = await planner.client.resumption;
		expect(kept?.sessions.size).toBe(1);

		// Its run was kept for it, with no deadline: the Planner layer's one banner, with no button,
		// and the failed reply's own notice says the connection dropped, quietly, once.
		let banner = connectionBanner(page);
		await expect(banner).toHaveAttribute("data-layer", "planner");
		await expect(banner).toHaveAttribute("data-phase", "dropped");
		await expect(banner).toHaveText(PLANNER_OFFLINE);
		await expect(banner.getByRole("button")).toHaveCount(0);
		await expect(failureBanner(page)).toHaveCount(0);
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(allBanners(page)).toHaveCount(1);
		await expect(
			chat(page).getByText(
				"The machine's connection dropped during this reply. Its workflows and open questions are kept; ask again once it has reconnected.",
				{ exact: true },
			),
		).toHaveCount(1);
	} finally {
		hold.resolve();
		link.restore();
	}
});

/**
 * What the server answers to one Chat request made on a socket of its own, opened as this page
 * would open it: its answer, or how the socket closed or failed to open instead.
 */
async function ask(page: Page, room: string, kind: string) {
	return page.evaluate(async ({ id, kind }) => {
		type Frame = { kind: string; rid?: string; [key: string]: unknown };
		let url = new URL("/ws", location.href);
		url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
		url.searchParams.set("channel", id);
		let socket = new WebSocket(url);
		let opened = await new Promise<boolean>(resolve => {
			socket.addEventListener("open", () => resolve(true), { once: true });
			socket.addEventListener("error", () => resolve(false), { once: true });
		});
		if (!opened) return { refused: true } as { refused: true } | { closed: number } | Frame;
		socket.send(JSON.stringify({ kind: "plan:open", ts: 0, rid: crypto.randomUUID() }));
		let rid = crypto.randomUUID();
		let answer = await new Promise<Frame | { closed: number }>(resolve => {
			let timer = setTimeout(() => resolve({ closed: -1 }), 10_000);
			socket.addEventListener("close", event => {
				clearTimeout(timer);
				resolve({ closed: event.code });
			});
			socket.addEventListener("message", event => {
				if (typeof event.data !== "string") return;
				let frame = JSON.parse(event.data) as Frame;
				if (frame.rid !== rid) return;
				clearTimeout(timer);
				resolve(frame);
			});
			// Once the room has had a moment to take the open.
			setTimeout(() => socket.send(JSON.stringify({ kind, ts: 0, rid })), 1_000);
		});
		socket.close();
		return answer;
	}, { id: room, kind });
}

async function twoPeople(browser: Browser, room: string) {
	let writer = await (await browser.newContext()).newPage();
	await authenticate(writer, HANDLE, ORIGIN);
	await writer.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(writer);
	return writer;
}

test("asking a machine to start the Planner is for a writer of a live document: a reader is refused, a writer is told no machine, attached or held, and an archived document is refused", async ({ browser }) => {
	test.setTimeout(150_000);
	let room = await remoteServer();
	let writer = await twoPeople(browser, room);
	let reader = await (await browser.newContext()).newPage();
	await authenticate(reader, "readonly", ORIGIN);
	await reader.goto(`${ORIGIN}${roomPath(room)}`);
	await expect(chat(reader)).toBeVisible();

	// A reader is told they cannot, and nothing is asked.
	expect(await ask(reader, room, "chat:wake")).toMatchObject({
		kind: "session:error",
		message: expect.stringMatching(/write access/),
	});

	// A writer with no machine connected is told so, by the answer.
	expect(await ask(writer, room, "chat:wake")).toMatchObject({
		kind: "chat:wake",
		asked: false,
		why: "no-machine",
	});

	let link = watchSockets();
	try {
		let planner = await machine(room);
		// With the Planner attached there is nothing to start.
		expect(await ask(writer, room, "chat:wake")).toMatchObject({
			kind: "chat:wake",
			asked: false,
			why: "attached",
		});

		// Its link dropped with nothing kept for it: it is held for its owner, and nothing is asked.
		link.sockets[0]!.close(3000, "network failed");
		await planner.client.resumption;
		expect(await ask(writer, room, "chat:wake")).toMatchObject({
			kind: "chat:wake",
			asked: false,
			why: "held",
		});
		// No state offers a button: only the machine's own client can resume it.
		await expect(connectionBanner(writer)).toHaveAttribute("data-layer", "planner");
		await expect(connectionBanner(writer)).toHaveText(PLANNER_HELD);
		await expect(connectionBanner(writer).getByRole("button")).toHaveCount(0);
	} finally {
		link.restore();
	}

	// An archived document is final: nothing is asked.
	let archived = await writer.context().request.post(`${ORIGIN}/api/channels/${room}/archive`, {
		headers: { origin: ORIGIN },
	});
	expect(archived.ok()).toBe(true);
	expect(await ask(writer, room, "chat:wake")).toEqual({
		kind: "session:error",
		message: "repository write access is required",
		rid: expect.any(String),
		ts: expect.any(Number),
	});
});

test("asking a machine to start the Planner whose link dropped with a workflow run kept is answered disconnected, and offers no button", async ({ browser }) => {
	test.setTimeout(150_000);
	let room = await remoteServer();
	let writer = await twoPeople(browser, room);
	let link = watchSockets();
	try {
		let planner = await machine(room, [], true);
		await say(writer, "start a workflow run");
		await expect(chat(writer).getByText("Answer 1", { exact: true })).toBeVisible();
		// Chopin opens a session of its own for the document's upkeep after a reply, and ends it
		// when that is done. The link held both while it ran, so cut it once only the chat's is left.
		await expect.poll(() => planner.upkeep).toBeGreaterThan(0);
		await expect.poll(() => planner.open.size).toBe(1);
		link.sockets[0]!.close(3000, "network failed");
		expect((await planner.client.resumption)?.sessions.size).toBe(1);
		expect(await ask(writer, room, "chat:wake")).toMatchObject({
			kind: "chat:wake",
			asked: false,
			why: "disconnected",
		});
		await expect(connectionBanner(writer)).toHaveAttribute("data-layer", "planner");
		await expect(connectionBanner(writer)).toHaveText(PLANNER_OFFLINE);
		await expect(connectionBanner(writer).getByRole("button")).toHaveCount(0);
	} finally {
		link.restore();
	}
});

/** `handle` created the document, as if they had made it in Chopin. */
async function createdBy(room: string, handle: string) {
	let database = new SQL(serverDatabase);
	try {
		await database`
			UPDATE channels SET created_by = (SELECT id FROM users WHERE login = ${handle})
			WHERE id = ${room}
		`;
	} finally {
		await database.close();
	}
}

/**
 * Pair a machine for the person signed in on `page` and connect a checkout of octo-org/score as
 * `chopin connect --planner-command` does. Its poll is the connector's own: the Planners it runs,
 * answered with the ones it should run once they differ, or `{ waiting: true }` once Chopin has
 * waited as long as it does for a change.
 */
async function pairedMachine(page: Page, label: string) {
	let back = page.url();
	await page.goto(`${ORIGIN}/auth/github/connector?key`);
	await expect(page).toHaveURL(/\/machines\?server$/);
	let minted = await (await page.request.post(`${ORIGIN}/api/connector/pairing-keys`, {
		data: {},
		headers: { origin: ORIGIN },
	})).json() as { key: string };
	let checkout = { repository: "octo-org/score", commit: "a".repeat(40), label };
	let post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
		fetch(new URL(path, ORIGIN), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL),
				[CONNECTOR_VERSION_HEADER]: RELEASE,
				...extra,
			},
			body: JSON.stringify(body),
		});
	let paired = await (await post("/api/connector/pairings", { ...checkout, key: minted.key }))
		.json() as { token: string };
	let opened = await post("/api/connector/connections", checkout, {
		[CONNECTOR_PLATFORM_HEADER]: "linux x64",
		[CONNECTOR_PLANNER_COMMAND_HEADER]: "1",
		authorization: `Bearer ${paired.token}`,
	});
	expect(opened.status, await opened.clone().text()).toBe(200);
	let { token } = await opened.json() as { token: string };
	await page.goto(back);
	return {
		poll: async (planners: string[]) => {
			let answer = await (await post("/connector/mcp", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "wait_for_work", arguments: { planners } },
			}, { authorization: `Bearer ${token}` })).json() as {
				result: { content: Array<{ text: string }> };
			};
			return JSON.parse(answer.result.content[0]!.text) as unknown;
		},
		disconnect: () =>
			post("/connector/mcp", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "disconnect_workspace", arguments: {} },
			}, { authorization: `Bearer ${token}` }),
	};
}

test("asking a machine to start the Planner reaches the paired machine that serves the document, which is waiting on its Planner poll, and is answered asked", async ({ page }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	await authenticate(page, HANDLE, ORIGIN);
	await createdBy(room, HANDLE);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let studio = await pairedMachine(page, "studio");

	// The machine is asked to run the document's Planner, and so runs it as far as it is told.
	expect(await studio.poll([])).toEqual({
		kind: "planners",
		planners: [{ id: room, url: expect.stringContaining(ORIGIN) }],
	});
	// It does, and nothing has attached yet: its poll has nothing to be told and waits, for as
	// long as Chopin waits for a change, which is far longer than this test does.
	let waited = Date.now();
	let poll = studio.poll([room]).then(answer => ({ answer, at: Date.now() }));
	let settled = false;
	void poll.then(() => void (settled = true));
	await page.waitForTimeout(3_000);
	expect(settled).toBe(false);

	// A writer asks for the Planner: the answer says a machine was asked, and the machine's own
	// waiting poll is woken by it, at once, with the same Planner to run and this document named
	// as one a person asked to have started again now.
	let asked = Date.now();
	let answer = await ask(page, room, "chat:wake");
	expect(answer).toMatchObject({ kind: "chat:wake", asked: true });
	expect(answer).not.toHaveProperty("why");
	let woken = await poll;
	expect(woken.answer).toEqual({
		kind: "planners",
		planners: [{ id: room, url: expect.stringContaining(ORIGIN) }],
		retry: [room],
	});
	expect(woken.at - asked).toBeLessThan(5_000);
	expect(woken.at - waited).toBeLessThan(15_000);
	await studio.disconnect();
});

test("Retry sends the same turn again from the child document it was asked in, with its focus and its references, once the machine is back", async ({ page }) => {
	test.setTimeout(150_000);
	let room = await remoteServer();
	let hold = Promise.withResolvers<void>();
	let referred = crypto.randomUUID();
	let referredTitle = `Source review ${referred.slice(0, 8)}`;
	await seedChildChannel(PORT, room, referred, referredTitle, "# Referenced child\n");
	let child = crypto.randomUUID();
	let childTitle = `Open child ${child.slice(0, 8)}`;
	await seedLinkedChildChannel(PORT, room, child, childTitle, `# ${childTitle}\n\nA finding.\n`);
	await authenticate(page, HANDLE, ORIGIN);
	await watchBanners(page);
	let sent: Chat.Send[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Send;
				if (frame.kind === "chat:send") sent.push(frame);
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let link = watchSockets();
	try {
		let planner = await machine(room, [hold.promise]);
		// The child is open beside the root's Chat, which has no Chat of its own for it.
		await page.getByRole("link", { name: `#${childTitle}`, exact: true }).click();
		let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
		await expect(surface.locator(`[data-workspace-room="${child}"]`)).toBeVisible();
		let input = chatInput(page);
		await fillChat(input, `@chopin Compare #${referred.slice(0, 8)}`);
		let documents = chat(page).getByRole("listbox", { name: "Document references" });
		await documents.getByRole("option", { name: referredTitle, exact: true }).click();
		await input.press("Enter");
		await expect(running(page)).toBeVisible();
		expect(planner.prompts).toHaveLength(1);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.focus).toBe(child);
		expect(sent[0]!.references).toHaveLength(1);
		link.sockets[0]!.close(3000, "network failed");
		await planner.client.resumption;
		let back = await machine(room);
		await expect(connectionBanner(page)).toHaveCount(0, { timeout: 30_000 });
		let failure = failureBanner(page);
		await expect(failure).toHaveAttribute("data-kind", "error");

		// The child is closed before Retry is pressed: the turn is asked again from where it was
		// asked, not from where the page is now.
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await expect(surface).toHaveCount(0);
		await expect(failure).toHaveAttribute("data-kind", "error");
		await failure.getByRole("button", { name: "Retry", exact: true }).click();
		await expect.poll(() => sent.length).toBe(2);
		expect(sent[1]).toMatchObject({ text: instruction(sent[0]!.text), to: sent[0]!.to });
		expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId);
		expect(sent[1]!.focus).toBe(child);
		let summons = sent[0]!.text.length - sent[1]!.text.length;
		let first = sent[0]!.references![0]!;
		expect(first).toEqual({
			kind: "document",
			channelId: referred,
			start: sent[0]!.text.indexOf(`#${referredTitle}`),
			end: sent[0]!.text.indexOf(`#${referredTitle}`) + referredTitle.length + 1,
		});
		expect(sent[1]!.references).toEqual([{
			kind: "document",
			channelId: referred,
			start: first.start - summons,
			end: first.end - summons,
		}]);
		expect(sent[1]!.text.slice(first.start - summons, first.end - summons))
			.toBe(`#${referredTitle}`);
		await expect(chat(page).getByText("Answer 1", { exact: true })).toBeVisible();
		expect(back.prompts).toHaveLength(1);
		expect(sent).toHaveLength(2);
		await expect(allBanners(page)).toHaveCount(0);
		await back.client.detach();
	} finally {
		hold.resolve();
		link.restore();
	}
});
