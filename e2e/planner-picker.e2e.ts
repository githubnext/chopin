/**
 * The machine button left of a document's Build plan starts the document's Planner on the machine
 * chosen under `HARNESS=remote`.
 * `HARNESS=remote` needs its own server, so this file starts one against a database of its own.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import type { AgentHandlers } from "../packages/agent-link/src/client";
import {
	CONNECTOR_PLANNER_COMMAND_HEADER,
	CONNECTOR_PLATFORM_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_SERVICE_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "../packages/protocol/connector";
import { CONNECTOR_PROTOCOL } from "../apps/connector/src/version";
import { chatInput, fillChat } from "./chat-input";
import {
	announced,
	expectHealthy,
	expectNoMachineWords,
	expectPlannerAttached,
	expectSaidOnce,
	heard,
	listenForAnnouncements,
	machineButton,
	NONE,
	strip,
} from "./planner-status";
import { createChannel, registerTestDatabase, seedChannel } from "./database";
import { authenticate, content, expect, ready, roomPath, test } from "./room";
import { e2eDatabaseName, e2ePort } from "./ports";
import { RELEASE } from "./release";
import { HOST, ROOT } from "./servers";

import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";

import type { Browser, Page } from "@playwright/test";

const PORT = e2ePort(8794);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_planner_picker");
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
const PHONE = {
	hasTouch: true,
	isMobile: true,
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
};
/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

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

// One disposable database and application port for the file.
test.describe.configure({ mode: "default" });

/** The database of the server `remoteServer` started last. */
let serverDatabase = "";

async function remoteServer() {
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
	let child = spawn(process.execPath, ["--preload", "./e2e/github.ts", "apps/server/src/main.ts"], {
		cwd: ROOT,
		detached: true,
		env: {
			...process.env,
			...ENV,
			DATABASE_URL: database,
			AGENT: "on",
			HARNESS: "remote",
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
			if ((await fetch(`${ORIGIN}/api/session`)).ok) break;
		} catch { /* Not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	registerTestDatabase(PORT, database);
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
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
 * Pair a machine for the person signed in on `page` with a pairing key and connect a checkout of
 * octo-org/score, as `chopin connect` does; with `planner`, as `--planner-command` does, with
 * `service`, as the background service on a server does, and with `bare`, with no checkout, as a
 * machine that clones what it needs connects.
 */
async function machine(
	page: Page,
	label: string,
	planner: boolean,
	{ service = false, bare = false }: { service?: boolean; bare?: boolean } = {},
) {
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
	let paired = await (await post("/api/connector/pairings", {
		...bare ? { label } : checkout,
		key: minted.key,
	})).json() as { token: string };
	let opened = await post(
		"/api/connector/connections",
		bare ? { label, checkouts: [] } : checkout,
		{
			[CONNECTOR_PLATFORM_HEADER]: "linux x64",
			...(planner ? { [CONNECTOR_PLANNER_COMMAND_HEADER]: "1" } : {}),
			...(service ? { [CONNECTOR_SERVICE_HEADER]: "1" } : {}),
			authorization: `Bearer ${paired.token}`,
		},
	);
	expect(opened.status, await opened.clone().text()).toBe(200);
	let { token } = await opened.json() as { token: string };
	await page.goto(back);
	return {
		/** The Planner backend Chopin asked the connector to start: a credential, then the link. */
		backend: async (document: string, handlers: AgentHandlers = { turn() {} }) => {
			let issued = await post("/api/connector/planner", { document }, {
				authorization: `Bearer ${paired.token}`,
			});
			expect(issued.status, await issued.clone().text()).toBe(200);
			let { token: credential } = await issued.json() as { token: string };
			return connectAgent({
				url: ORIGIN,
				token: credential,
				document,
				handlers,
			});
		},
		/**
		 * The connector's Planner poll, naming the Planners it runs; Chopin answers with the ones
		 * it should run once they differ.
		 */
		poll: async (planners: string[]) => {
			let answer = await (await post("/connector/mcp", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "wait_for_work", arguments: { planners } },
			}, { authorization: `Bearer ${token}` })).json() as {
				result: { content: Array<{ text: string }> };
			};
			return JSON.parse(answer.result.content[0]!.text);
		},
		/** The connector's wait for work: the build Chopin queued on this machine, if any. */
		work: async () => {
			let answer = await (await post("/connector/mcp", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "wait_for_work", arguments: {} },
			}, { authorization: `Bearer ${token}` })).json() as {
				result: { content: Array<{ text: string }> };
			};
			return JSON.parse(answer.result.content[0]!.text);
		},
		/** What the connector tells Chopin when its Planner backend keeps exiting before it attaches. */
		reportFailure: (body: unknown) =>
			post("/api/connector/planner/failure", body, { authorization: `Bearer ${paired.token}` }),
		/** Ctrl-C in chopin connect. */
		disconnect: () =>
			post("/connector/mcp", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "disconnect_workspace", arguments: {} },
			}, { authorization: `Bearer ${token}` }),
	};
}

async function open(
	browser: Browser,
	handle: string,
	room: string,
	options: object,
	{ listen = false }: { listen?: boolean } = {},
) {
	let context = await browser.newContext(options);
	let page = await context.newPage();
	await authenticate(page, handle, ORIGIN);
	// With `listen`, what the page's live region is told is recorded from its first load.
	if (listen) await listenForAnnouncements(page);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	return page;
}

/** Someone who can only read the document, opened once its text is on the page. */
async function openReader(browser: Browser, room: string) {
	let context = await browser.newContext(DESKTOP);
	let page = await context.newPage();
	await authenticate(page, `score-reader-${room.slice(0, 8)}`, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	return page;
}

async function shoot(page: Page, name: string, target?: ReturnType<Page["locator"]>) {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	await new Promise(resolve => setTimeout(resolve, 400));
	await (target ?? page).screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Open the machine button's menu, left of Build plan. */
async function runOn(page: Page) {
	await page.getByRole("button", { name: /^Runs on/ }).click();
	let menu = page.getByRole("menu", { name: "Runs on", exact: true });
	await expect(menu.getByRole("menuitemradio").first()).toBeVisible();
	return menu;
}

test("the machine button starts the document's Planner on the machine chosen", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let page = await open(browser, "mona", room, DESKTOP);
	let studio = await machine(page, "studio", true);
	await machine(page, "desk", false);
	await page.reload();
	await ready(page);

	// One list chooses where the document's work and Planner run: a machine without a Planner
	// command can still be chosen for builds, so it is offered too.
	let menu = await runOn(page);
	// Nobody chose: the row Automatic uses is checked.
	await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveCount(1);
	await expect(menu.getByRole("menuitemradio", { name: /^desk/ })).not.toHaveAttribute(
		"aria-disabled",
		"true",
	);
	await expect(menu.getByRole("menuitemradio", { name: /^studio/ })).not.toHaveAttribute(
		"aria-disabled",
		"true",
	);
	await shoot(page, "planner-machine");

	// Choosing studio asks its connector to start the Planner, which then attaches.
	await menu.getByRole("menuitemradio", { name: /^studio/ }).click();
	await expect(menu).toBeHidden();
	expect(await studio.poll([])).toEqual({
		kind: "planners",
		planners: [{ id: room, url: expect.stringContaining(ORIGIN) }],
	});
	let link = await studio.backend(room);
	menu = await runOn(page);
	await expect(menu.getByRole("menuitemradio", { name: /^studio/ }))
		.toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Escape");

	// studio goes offline: its row stays chosen but can't be chosen again.
	await studio.disconnect();
	await page.reload();
	await ready(page);
	menu = await runOn(page);
	let offline = menu.getByRole("menuitemradio", { name: /^studio/ });
	await expect(offline).toHaveAttribute("aria-disabled", "true");
	await expect(offline).toContainText("Offline");
	await link.detach().catch(() => {});
});

test("on a phone, the machine button's sheet starts the Planner on the machine chosen", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let page = await open(browser, "mona", room, PHONE);
	let studio = await machine(page, "studio", true);
	await machine(page, "desk", false);
	await page.reload();
	await ready(page);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
	await page.locator(".phone-top-bar").getByRole("button", { name: /^Runs on/ }).tap();
	let sheet = page.getByRole("dialog", { name: "Runs on", exact: true });
	await expect(sheet.getByRole("menuitemradio", { name: /^desk/ })).not.toHaveAttribute(
		"aria-disabled",
		"true",
	);
	await shoot(page, "planner-phone-sheet");
	await sheet.getByRole("menuitemradio", { name: /^studio/ }).tap();
	await expect(sheet).toBeHidden();
	expect((await studio.poll([])).planners).toHaveLength(1);
	let link = await studio.backend(room);
	await link.detach();
});

test("a machine that cannot reply leaves its button with no dot and says no machine is connected, never the machine's green", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let page = await open(browser, "mona", room, DESKTOP);
	// desk is connected for the repository but has no Planner command, so nothing can reply.
	await machine(page, "desk", false);
	await page.reload();
	await ready(page);
	let menu = await runOn(page);
	await menu.getByRole("menuitemradio", { name: /^desk/ }).click();
	await expect(menu).toBeHidden();

	// The one banner at the composer tells it, in the Planner's layer; the button is named for the
	// machine alone and carries no state, so the same fact is told in one place.
	let status = machineButton(page);
	await expect(strip(page)).toHaveText(NONE);
	await expect(strip(page)).toHaveAttribute("data-layer", "planner");
	await expect(status).toHaveAccessibleName("Runs on desk");
	await expect(status).not.toHaveAttribute("data-planner");
	// The same bare icon as a button with no machine: no dot, so no green beside the words.
	await expect(status.locator(".machine-glyph-dot")).toHaveCount(0);
	await expect(status.locator("[data-state]")).toHaveCount(0);
	await expect(announced(page)).toHaveText(NONE);
	await shoot(page, "planner-none-button-desktop");

	// Its menu does not say it again, while each machine's own row still tells that machine's state.
	menu = await runOn(page);
	await expect(menu.getByRole("group", { name: "Connection", exact: true })).toHaveCount(0);
	await expect(menu.getByRole("menuitemradio", { name: /^desk/ })).toContainText("Connected");
	await page.keyboard.press("Escape");

	// On a phone the button in the top bar is the same bare icon, and Chat's banner says it.
	let handset = await open(browser, "mona", room, PHONE);
	await handset.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
	let phoneButton = handset.locator(".phone-top-bar").getByRole("button", { name: /^Runs on/ });
	await expect(strip(handset)).toHaveText(NONE);
	await expect(phoneButton).toHaveAccessibleName("Runs on desk");
	await expect(phoneButton.locator(".machine-glyph-dot")).toHaveCount(0);
	await shoot(handset, "planner-none-button-phone");
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

/** Star one of the signed-in person's machines, by name, as their favorite. */
async function favor(page: Page, room: string, label: string) {
	let choice = await (await page.request.get(`${ORIGIN}/api/documents/${room}/machine`)).json() as {
		machines: Array<{ id: string; label: string }>;
	};
	let id = choice.machines.find(machine => machine.label === label)!.id;
	let response = await page.request.post(`${ORIGIN}/api/connector/machines/${id}/favorite`, {
		data: { favorite: true },
		headers: { origin: ORIGIN },
	});
	expect(response.status()).toBe(200);
}

test("a document on Default machine runs its Planner on its creator's favorite machine, and moves it when that one disconnects", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let page = await open(browser, "mona", room, DESKTOP);
	await createdBy(room, "mona");
	let studio = await machine(page, "studio", true);
	await favor(page, room, "studio");
	let desk = await machine(page, "desk", true);
	await page.reload();
	await ready(page);

	// Nobody chose a machine: the favorite is asked to start the Planner, and its button says so.
	// The banner at the composer says so, in the Planner's layer; the button is the machine's alone.
	let status = machineButton(page);
	await expect(strip(page)).toHaveAttribute("data-layer", "planner");
	await expect(strip(page)).toContainText("Connecting to studio");
	await expect(status).toHaveAccessibleName("Runs on studio");
	await expect(status).not.toHaveAttribute("data-planner");
	await shoot(page, "planner-starting-desktop");
	expect(await studio.poll([])).toEqual({
		kind: "planners",
		planners: [{ id: room, url: expect.stringContaining(ORIGIN) }],
	});
	let first = await studio.backend(room);
	// Attached, it is nothing to tell: the button is the machine's alone, with its own dot.
	await expectHealthy(status);
	await expect(status.locator(".machine-glyph-dot")).toHaveAttribute("data-state", "connected");
	await expect(page.locator(".chat-composer").getByRole("button", { name: /^Runs on/ }))
		.toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Runs on/ })).toHaveAccessibleName(
		"Runs on studio",
	);
	await expect((await runOn(page)).getByRole("menuitemradio", { checked: true }))
		.toContainText("studio");
	await page.keyboard.press("Escape");
	await shoot(page, "default-planner-attached", page.locator(".chat-composer"));

	// The favorite disconnects: the Planner moves to the other machine without anyone choosing it.
	await studio.disconnect();
	await expect(strip(page)).toContainText("Connecting to desk");
	await expect(status).toHaveAccessibleName("Runs on desk");
	expect(await desk.poll([])).toEqual({
		kind: "planners",
		planners: [{ id: room, url: expect.stringContaining(ORIGIN) }],
	});
	let second = await desk.backend(room);
	await expectHealthy(status);
	await expect(page.getByRole("button", { name: /^Runs on/ })).toHaveAccessibleName(
		"Runs on desk",
	);
	await expect((await runOn(page)).getByRole("menuitemradio", { checked: true }))
		.toContainText("desk");
	await page.keyboard.press("Escape");
	await first.detach().catch(() => {});
	await second.detach();
});

test("@chopin in a document on Default machine waits for the Planner its machine is starting", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let page = await open(browser, "mona", room, DESKTOP);
	await createdBy(room, "mona");
	let studio = await machine(page, "studio", true);
	await page.reload();
	await ready(page);
	await expect(strip(page)).toContainText("Connecting to studio");
	await expect(machineButton(page)).toHaveAccessibleName("Runs on studio");

	// Sent before the Planner attaches, the message waits for it rather than being refused.
	let input = chatInput(page);
	await fillChat(input, "@chopin outline the plan");
	await input.press("Enter");
	expect((await studio.poll([])).planners).toHaveLength(1);
	let link = await studio.backend(room);
	await expectHealthy(machineButton(page));
	await expect(page.getByText("outline the plan").first()).toBeVisible();
	await expect(page.getByText(/Connect a machine to get a reply|No machine is connected/))
		.toHaveCount(0);
	await link.detach();
});

/** The document's machine state, as the page reads it, with `change` applied while `active.on`. */
async function reading(
	page: Page,
	room: string,
	change: (state: Record<string, unknown>) => Record<string, unknown>,
) {
	let active = { on: true, served: 0 };
	let held: Promise<void> | undefined;
	let url = `${ORIGIN}/api/documents/${room}/machine`;
	await page.route(url, async route => {
		if (route.request().method() !== "GET") return route.fallback();
		let response = await route.fetch();
		let state = await response.json() as Record<string, unknown>;
		active.served++;
		await held;
		await route.fulfill({ response, json: active.on ? change(state) : state });
	});
	return {
		active,
		/** Reads started from now on are answered only when the returned function is called. */
		hold: () => {
			let gate = Promise.withResolvers<void>();
			held = gate.promise;
			return () => {
				held = undefined;
				gate.resolve();
			};
		},
		/** Stops answering, so a read after the server has gone is the page's own. */
		end: () => page.unroute(url),
		/** Asks again, as the page does when it is focused, and waits until that has been drawn. */
		refresh: async () => {
			let before = active.served;
			await page.evaluate(() => window.dispatchEvent(new Event("focus")));
			await expect.poll(() => active.served).toBeGreaterThan(before);
			await page.evaluate(() =>
				new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
			);
		},
	};
}

const SHAPES = [["desktop", DESKTOP], ["phone", PHONE]] as const;

/** Where Chat is: beside the document, or its own tab on a phone. */
async function chatTab(page: Page, phone: boolean) {
	if (!phone) return;
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
}

for (let [shape, options] of SHAPES) {
	test(`the Planner's status names the document's own machine or says nothing, and never another person's machine, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(150_000);
		let room = await remoteServer();
		let owner = await open(browser, "casey", room, DESKTOP);
		await machine(owner, "Build box", true, { service: true });
		await share(owner, "Build box");
		let page = await open(browser, "mona", room, options, { listen: true });
		await createdBy(room, "mona");
		let studio = await machine(page, "studio", true);
		await favor(page, room, "studio");
		await page.reload();
		await ready(page);
		await chatTab(page, shape === "phone");
		let button = machineButton(page);
		await expect(strip(page)).toContainText("Connecting to studio");
		await expect(strip(page)).toHaveAttribute("data-layer", "planner");
		await expect(button).toHaveAccessibleName("Runs on studio");
		expect((await studio.poll([])).planners).toHaveLength(1);

		// As a reconnect reads the machines before its own is back: the list names a teammate's shared
		// machine for the Planner, and the document runs on none yet.
		let list = await (await page.request.get(`${ORIGIN}/api/documents/${room}/machine`))
			.json() as { machines: Array<{ id: string; label: string }> };
		let theirs = list.machines.find(value => value.label === "Build box")!.id;
		let reread = await reading(page, room, state => ({
			...state,
			choice: null,
			automatic: null,
			planner: { state: "starting", login: "casey", machine: theirs },
		}));
		await reread.refresh();
		// Nothing names Build box, and nothing names mona's own login for her own machine: the status
		// waits until the document's own machine is known.
		await expect(button).toHaveAccessibleName("Runs on: no machine connected");
		await expect(announced(page)).toHaveText("");
		await expect(strip(page)).toHaveCount(0);
		expect(await heard(page)).not.toContainEqual(expect.stringContaining("Build box"));
		await shoot(page, `planner-names-no-machine-${shape}`);

		// The list catches up, and the status is the document's own machine's.
		reread.active.on = false;
		await reread.refresh();
		await expect(strip(page)).toContainText("Connecting to studio");
		await expect(button).toHaveAccessibleName("Runs on studio");
		// It was said once, before the gap, and is not said again as the same state returns.
		await expect(announced(page)).toHaveText("");
		expect(await heard(page)).toEqual(["Connecting to studio"]);
		await shoot(page, `planner-names-own-machine-${shape}`);
		await reread.end();
		await (await studio.backend(room)).detach();
	});
}

/**
 * A page whose socket to the document is carried by the test, which can say a Planner state to it as
 * the server does, on top of what the real server says. Installed before the page opens.
 */
async function carried(page: Page) {
	let sockets: Array<
		{ send: (data: string | Buffer) => void; close: (options: object) => Promise<void> }
	> = [];
	let muted = false;
	let away = false;
	let held: Array<string | Buffer> | undefined;
	let hellos = 0;
	let deliver = (socket: { send: (data: string | Buffer) => void }, message: string | Buffer) => {
		if (typeof message === "string" && message.includes('"session:hello"')) hellos++;
		socket.send(message);
	};
	await page.routeWebSocket("**/ws?**", socket => {
		if (away) return void socket.close();
		let upstream = socket.connectToServer();
		socket.onMessage(message => upstream.send(message));
		upstream.onMessage(message => {
			// What the real server says of its Planner never reaches the page while muted, held or not:
			// a new socket's first words are "no machine", then the machine being connected to, and a
			// test that says it all would otherwise be told a word it did not choose on release.
			if (typeof message === "string" && muted && message.includes('"session:planner"')) return;
			if (held) return void held.push(message);
			deliver(socket, message);
		});
		socket.onClose((code, reason) => void upstream.close({ code, reason }));
		upstream.onClose((code, reason) => void socket.close({ code, reason }));
		sockets.push(socket);
	});
	return {
		say: (planner: object) =>
			sockets.at(-1)!.send(JSON.stringify({ kind: "session:planner", ts: 0, planner })),
		/**
		 * The server restarting: the page's socket is closed with 1012, and this waits until the page
		 * has reconnected and been greeted, so that what is said next reaches the new connection.
		 * (`sockets` also holds every earlier load of the page, so its length says nothing.)
		 */
		restart: async () => {
			let before = hellos;
			await sockets.at(-1)!.close({ code: 1012, reason: "server restarting" });
			await expect.poll(() => hellos, { timeout: 15_000 }).toBeGreaterThan(before);
		},
		/** Keeps what the real server says of its Planner from the page, so the test says it all. */
		mute: (on: boolean) => {
			muted = on;
		},
		/** The connection is lost and every reconnect is refused, until `back`. */
		lose: async () => {
			away = true;
			await sockets.at(-1)!.close({});
		},
		/**
		 * Reconnects are answered again; the page is told it is online, as the browser would. With
		 * `hold`, what the server says on the new socket is kept from the page until `release`, so the
		 * page has the socket open and nothing on it, and its catching up lasts as long as the test
		 * looks at it.
		 */
		back: async (hold = false) => {
			away = false;
			if (hold) held = [];
			await page.evaluate(() => dispatchEvent(new Event("online")));
		},
		release: () => {
			let kept = held ?? [];
			held = undefined;
			for (let message of kept) deliver(sockets.at(-1)!, message);
		},
	};
}

for (let [shape, options] of SHAPES) {
	test(`the states a restart passes through are never said, and a machine being connected to is said only once it lasts, then clears on its own, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(120_000);
		let room = await remoteServer();
		let context = await browser.newContext(options);
		let page = await context.newPage();
		await authenticate(page, "mona", ORIGIN);
		await listenForAnnouncements(page);
		let { say } = await carried(page);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await createdBy(room, "mona");
		let studio = await machine(page, "studio", true);
		await page.reload();
		await ready(page);
		await chatTab(page, shape === "phone");
		let button = machineButton(page);
		expect((await studio.poll([])).planners).toHaveLength(1);
		let link = await studio.backend(room);
		await expectHealthy(button);
		await expectPlannerAttached(page);

		// What a deploy says on its way back: no machine, then a machine being connected to, then
		// the Planner, in a little over a second. Nothing of it is said, drawn or heard.
		let names: string[] = [];
		let drawn = 0;
		let watch = setInterval(() => {
			void button.getAttribute("aria-label").then(name => name && names.push(name)).catch(() => {});
			void strip(page).count().then(count => drawn += count).catch(() => {});
		}, 50);
		say({ state: "none" });
		await page.waitForTimeout(400);
		say({ state: "starting", login: "mona" });
		await page.waitForTimeout(500);
		say({ state: "attached", login: "mona" });
		await page.waitForTimeout(700);
		clearInterval(watch);
		expect(names.length).toBeGreaterThan(5);
		expect(names.filter(name => /Connecting|No machine|offline/.test(name))).toEqual([]);
		expect(drawn).toBe(0);
		expect(await heard(page)).toEqual([]);
		await expectPlannerAttached(page);

		// A machine still being connected to after the moment is said, on the banner and not the
		// button, and clears when it has done.
		say({ state: "starting", login: "mona" });
		await page.waitForTimeout(700);
		await expectHealthy(button);
		await expect(strip(page)).toContainText("Connecting to");
		await expect(strip(page)).toHaveAttribute("data-layer", "planner");
		await shoot(page, `planner-connecting-after-grace-${shape}`);
		say({ state: "attached", login: "mona" });
		await expectHealthy(button);
		await expectPlannerAttached(page);
		expect(await heard(page)).toHaveLength(1);
		await link.detach();
	});
}

for (let [shape, options] of SHAPES) {
	test(`through a reconnect the page keeps the last known machine state and says nothing of a restart's passing states, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(120_000);
		let room = await remoteServer();
		let context = await browser.newContext(options);
		let page = await context.newPage();
		await authenticate(page, "mona", ORIGIN);
		await listenForAnnouncements(page);
		let carriage = await carried(page);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await createdBy(room, "mona");
		let studio = await machine(page, "studio", true);
		await page.reload();
		await ready(page);
		await chatTab(page, shape === "phone");
		expect((await studio.poll([])).planners).toHaveLength(1);
		let link = await studio.backend(room);
		let button = machineButton(page);
		await expectHealthy(button);
		await expectPlannerAttached(page);

		// The server restarts: the page's connection is closed as a restart closes it, and it comes
		// back. The new server's first word is that there is no machine, then that one is being
		// connected to, then that the Planner is back, as the first seconds of a deploy go.
		let sample = { names: [] as string[], banners: 0 };
		let watch = setInterval(() => {
			void page.evaluate(() => ({
				name: document.querySelector('[aria-label^="Runs on"]')?.getAttribute("aria-label"),
				banners: document.querySelectorAll("[data-connection-banner]").length,
			})).then(now => {
				if (now.name) sample.names.push(now.name);
				sample.banners += now.banners;
			}).catch(() => {});
		}, 50);
		carriage.mute(true);
		await carriage.restart();
		carriage.say({ state: "none" });
		await page.waitForTimeout(400);
		carriage.say({ state: "starting", login: "mona" });
		await page.waitForTimeout(500);
		carriage.say({ state: "attached", login: "mona" });
		await page.waitForTimeout(700);
		clearInterval(watch);
		// The last known state, a Planner that is attached and so says nothing, stood throughout.
		expect(sample.names.length).toBeGreaterThan(10);
		expect(sample.names.filter(name => /Connecting|No machine|offline/.test(name))).toEqual([]);
		expect(sample.banners).toBe(0);
		expect(await heard(page)).toEqual([]);
		await expectHealthy(button);
		await expectPlannerAttached(page);
		await link.detach();
	});
}

for (let [shape, options] of SHAPES) {
	test(`through a restart that keeps the machine away for seconds, the page keeps its last known machine state and never says no machine is connected, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(120_000);
		let room = await remoteServer();
		let context = await browser.newContext(options);
		let page = await context.newPage();
		await authenticate(page, "mona", ORIGIN);
		await listenForAnnouncements(page);
		let carriage = await carried(page);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await createdBy(room, "mona");
		let studio = await machine(page, "studio", true);
		await page.reload();
		await ready(page);
		await chatTab(page, shape === "phone");
		expect((await studio.poll([])).planners).toHaveLength(1);
		let link = await studio.backend(room);
		let button = machineButton(page);
		await expectHealthy(button);
		await expectPlannerAttached(page);

		// The server restarts, and the machine takes six seconds to come back to the new one, which
		// says there is no machine to everyone who connects until it does.
		carriage.mute(true);
		let sample = { names: [] as string[], said: [] as string[], strips: 0, banners: 0 };
		let watch = setInterval(() => {
			void page.evaluate(() => ({
				name: document.querySelector('[aria-label^="Runs on"]')?.getAttribute("aria-label"),
				said: document.querySelector("[data-connection-status]")?.textContent ?? "",
				strip: document.querySelectorAll(".chat-composer .composer-notice").length,
				banners: document.querySelectorAll("[data-connection-banner]").length,
			})).then(now => {
				if (now.name) sample.names.push(now.name);
				sample.said.push(now.said);
				sample.strips += now.strip;
				sample.banners += now.banners;
			}).catch(() => {});
		}, 50);
		await carriage.restart();
		carriage.say({ state: "none" });
		await page.waitForTimeout(6_000);
		clearInterval(watch);
		// Nothing changed on the page, past the moment a state waits for and long after it.
		expect(sample.names.length).toBeGreaterThan(80);
		expect(sample.names.filter(name => /Connecting|No machine|offline/.test(name))).toEqual([]);
		expect(sample.said.filter(Boolean)).toEqual([]);
		expect(sample.strips).toBe(0);
		expect(sample.banners).toBe(0);
		expect(await heard(page)).toEqual([]);
		await expectHealthy(button);
		await shoot(page, `planner-slow-return-${shape}`);

		// The machine's own word comes: a machine being connected to is said once it lasts, then
		// the Planner is back and the words go.
		carriage.say({ state: "starting", login: "mona" });
		await expect(strip(page)).toContainText("Connecting to");
		await expectHealthy(button);
		carriage.say({ state: "attached", login: "mona" });
		await expectHealthy(button);
		await expectPlannerAttached(page);

		// A machine removed while the page stays connected is still said, on the banner.
		carriage.say({ state: "none" });
		await expect(announced(page)).toHaveText(NONE);
		await expect(strip(page)).toHaveText(NONE);
		await expectHealthy(button);
		await link.detach();
	});
}

for (let [shape, options] of SHAPES) {
	test(`the Planner's status says nothing of a machine while the machine list describes another account's Planner than the socket does, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(150_000);
		let room = await remoteServer();
		let owner = await open(browser, "casey", room, DESKTOP);
		await machine(owner, "Build box", true, { service: true });
		await share(owner, "Build box");
		let context = await browser.newContext(options);
		let page = await context.newPage();
		await authenticate(page, "mona", ORIGIN);
		await listenForAnnouncements(page);
		let carriage = await carried(page);
		carriage.mute(true);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await createdBy(room, "mona");
		await machine(page, "studio", true);
		await favor(page, room, "studio");
		await page.reload();
		await ready(page);
		await chatTab(page, shape === "phone");
		let button = machineButton(page);
		let list = await (await page.request.get(`${ORIGIN}/api/documents/${room}/machine`))
			.json() as { machines: Array<{ id: string; label: string }> };
		let theirs = list.machines.find(value => value.label === "Build box")!.id;

		// The machine list was read before another account's Planner took the document over: it still
		// describes casey's Build box being started, which the document runs on.
		let reread = await reading(page, room, state => ({
			...state,
			choice: theirs,
			planner: { state: "starting", login: "casey", machine: theirs },
		}));
		await reread.refresh();
		await expect(button).toHaveAccessibleName("Runs on Build box");

		// bob's Planner dropped, is being started, and cannot be: Build box is none of bob's, and
		// nothing says it is, past the moment a machine being connected to waits.
		let failure = { attempts: 3, reason: "exit 1", at: new Date().toISOString() };
		for (
			let planner of [
				{ state: "disconnected", login: "bob" },
				{ state: "starting", login: "bob" },
				{ state: "starting", login: "bob", failure },
			]
		) {
			carriage.say(planner);
			await page.waitForTimeout(1_800);
			await expect(button).toHaveAccessibleName("Runs on Build box");
			await expect(announced(page)).toHaveText("");
			await expect(strip(page)).toHaveCount(0);
		}
		expect(await heard(page)).toEqual([]);
		await shoot(page, `planner-stale-list-${shape}`);

		// The list catches up, and the status is the machine of the account the socket names.
		reread.active.on = false;
		await reread.refresh();
		carriage.say({ state: "starting", login: "mona" });
		await expect(strip(page)).toContainText("Connecting to studio");
		await expect(strip(page)).toHaveAttribute("data-layer", "planner");
		await expect(button).toHaveAccessibleName("Runs on studio");
		await reread.end();
	});
}

for (let [shape, options] of SHAPES) {
	test(`the Planner's status names only the machine the document runs on, and says nothing while the machine list still describes another of the person's own machines, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(150_000);
		let room = await remoteServer();
		let context = await browser.newContext(options);
		let page = await context.newPage();
		await authenticate(page, "mona", ORIGIN);
		await listenForAnnouncements(page);
		let carriage = await carried(page);
		carriage.mute(true);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await createdBy(room, "mona");
		await machine(page, "Box A", true);
		await machine(page, "Box B", true);
		let list = await (await page.request.get(`${ORIGIN}/api/documents/${room}/machine`))
			.json() as { machines: Array<{ id: string; label: string }> };
		let id = (label: string) => list.machines.find(value => value.label === label)!.id;
		let chosen = await page.request.post(`${ORIGIN}/api/documents/${room}/machine`, {
			data: { machine: id("Box B") },
			headers: { origin: ORIGIN },
		});
		expect(chosen.status()).toBe(200);
		await page.reload();
		await ready(page);
		await chatTab(page, shape === "phone");
		let button = machineButton(page);
		await expect(button).toHaveAccessibleName("Runs on Box B");

		// The document was set to run on Box B after the machine list was read, and that list still
		// says its Planner is on Box A, the person's own as well.
		let reread = await reading(page, room, state => ({
			...state,
			choice: id("Box B"),
			planner: { state: "starting", login: null, machine: id("Box A") },
		}));
		await reread.refresh();

		// Box A is not the document's machine: past the moment a machine being connected to waits,
		// nothing is named, said, announced or drawn, whichever way the Planner of the person's own
		// account is told to be.
		let failure = { attempts: 3, reason: "exit 1", at: new Date().toISOString() };
		for (
			let planner of [
				{ state: "starting", login: "mona" },
				{ state: "disconnected", login: "mona" },
				{ state: "starting", login: "mona", failure },
			]
		) {
			carriage.say(planner);
			await page.waitForTimeout(1_800);
			await expect(button).toHaveAccessibleName("Runs on Box B");
			await expect(announced(page)).toHaveText("");
			await expect(strip(page)).toHaveCount(0);
		}
		expect(await heard(page)).toEqual([]);
		await shoot(page, `planner-stale-own-machine-${shape}`);

		// The list catches up, and the document's own machine is named.
		reread.active.on = false;
		await reread.refresh();
		carriage.say({ state: "starting", login: "mona" });
		await expect(strip(page)).toContainText("Connecting to Box B");
		await expect(button).toHaveAccessibleName("Runs on Box B");
		carriage.say({ state: "disconnected", login: "mona" });
		await expect(strip(page)).toContainText("Box B is offline. Your work is kept.");
		await expect(button).toHaveAccessibleName("Runs on Box B");
		// The list read for the last word is still on its way: let it be answered before the server goes.
		await page.unrouteAll({ behavior: "wait" });
	});
}

for (let [shape, options] of SHAPES) {
	test(`the Planner's status names no machine from a list read before the socket's word, says nothing until a list read after it has answered, and then names the document's own, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(150_000);
		let room = await remoteServer();
		let context = await browser.newContext(options);
		let page = await context.newPage();
		await authenticate(page, "mona", ORIGIN);
		await listenForAnnouncements(page);
		let carriage = await carried(page);
		carriage.mute(true);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await createdBy(room, "mona");
		await machine(page, "Box B", true);
		await machine(page, "Box C", true);
		let list = await (await page.request.get(`${ORIGIN}/api/documents/${room}/machine`))
			.json() as { machines: Array<{ id: string; label: string }> };
		let choose = async (label: string) => {
			let chosen = await page.request.post(`${ORIGIN}/api/documents/${room}/machine`, {
				data: { machine: list.machines.find(value => value.label === label)!.id },
				headers: { origin: ORIGIN },
			});
			expect(chosen.status()).toBe(200);
		};
		await choose("Box B");
		await page.reload();
		await ready(page);
		await chatTab(page, shape === "phone");
		let button = machineButton(page);
		let reread = await reading(page, room, state => state);
		await expect(button).toHaveAccessibleName("Runs on Box B");

		// A list read after the word says Box B, and Box B is named.
		carriage.say({ state: "starting", login: "mona" });
		await expect(strip(page)).toContainText("Connecting to Box B");
		await expect(button).toHaveAccessibleName("Runs on Box B");

		// The document is then set to run on Box C, and the next read of the list is slow, or never
		// answers. The list the page holds was read before the next word and still agrees with itself
		// on Box B, which the Planner may have left: Box B is not named for that word, and neither is
		// what was said of the word before, which was Box B's. The status says nothing, for as long as
		// the read takes, and nothing is announced.
		let release = reread.hold();
		await choose("Box C");
		carriage.say({ state: "disconnected", login: "mona" });
		await expect(button).toHaveAccessibleName("Runs on Box B");
		await page.waitForTimeout(1_800);
		await expect(button).toHaveAccessibleName("Runs on Box B");
		await expect(button).not.toHaveAttribute("data-planner");
		await expect(strip(page)).toHaveCount(0);
		expect(await heard(page)).toEqual(["Connecting to Box B"]);
		await page.waitForTimeout(3_000);
		await expect(button).toHaveAccessibleName("Runs on Box B");
		await shoot(page, `planner-slow-list-${shape}`);

		// It answers, and the document's own machine is named.
		release();
		await expect(strip(page)).toContainText("Box C is offline. Your work is kept.");
		await expect(button).toHaveAccessibleName("Runs on Box C");
		expect(await heard(page)).toEqual([
			"Connecting to Box B",
			"Box C is offline. Your work is kept.",
		]);
		await page.unrouteAll({ behavior: "wait" });
	});
}

/** What the connection banner says, and the live region with it, while the socket is being retried. */
const RECONNECTING = "Reconnecting. Your changes are kept.";
/** And as it returns with nothing missed on either side. */
const BACK_ONLINE = "Back online. Your changes are synced";
const CATCHING_UP = "Catching up";
/** And as a machine that had dropped is back, with nothing to catch up on. */
const MACHINE_BACK = "The machine is back. Nothing new while it was away.";

/** One reading of what the page says of the machine: the button's name, its state, the strip and the live region. */
type Sample = { at: number; name: string; planner: string; strip: string; said: string };

/** Reads what the page says every 50 ms, in the page, until the returned function is called. */
async function sampling(page: Page): Promise<() => Promise<Sample[]>> {
	await page.evaluate(() => {
		let samples: Sample[] = [];
		let start = performance.now();
		let read = () => {
			let button = document.querySelector('button[aria-label^="Runs on"]');
			samples.push({
				at: Math.round(performance.now() - start),
				name: button?.getAttribute("aria-label") ?? "",
				planner: button?.getAttribute("data-planner") ?? "",
				strip: document.querySelector(".chat-composer [data-connection-banner]")?.textContent ?? "",
				said: document.querySelector("[data-connection-status]")?.textContent ?? "",
			});
		};
		read();
		let timer = setInterval(read, 50);
		(window as unknown as { sampled: { samples: Sample[]; timer: number } }).sampled = {
			samples,
			timer: timer as unknown as number,
		};
	});
	return () =>
		page.evaluate(() => {
			let { samples, timer } = (window as unknown as {
				sampled: { samples: Sample[]; timer: number };
			}).sampled;
			clearInterval(timer);
			return samples;
		});
}

for (let [shape, options] of SHAPES) {
	test(`a state that waits for its grace after the gap draws nothing meanwhile, never what was shown before the gap or a machine the current state no longer supports, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(150_000);
		let room = await remoteServer();
		let context = await browser.newContext(options);
		let page = await context.newPage();
		await authenticate(page, "mona", ORIGIN);
		await listenForAnnouncements(page);
		let carriage = await carried(page);
		carriage.mute(true);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await createdBy(room, "mona");
		await machine(page, "Box B", true);
		await machine(page, "Box C", true);
		let list = await (await page.request.get(`${ORIGIN}/api/documents/${room}/machine`))
			.json() as { machines: Array<{ id: string; label: string }> };
		let choose = async (label: string) => {
			let chosen = await page.request.post(`${ORIGIN}/api/documents/${room}/machine`, {
				data: { machine: list.machines.find(value => value.label === label)!.id },
				headers: { origin: ORIGIN },
			});
			expect(chosen.status()).toBe(200);
		};
		await choose("Box B");
		await page.reload();
		await ready(page);
		await chatTab(page, shape === "phone");
		let button = machineButton(page);
		let reread = await reading(page, room, state => state);
		await expect(button).toHaveAccessibleName("Runs on Box B");

		// Box B drops its Planner, and the button says so.
		carriage.say({ state: "disconnected", login: "mona" });
		await expect(strip(page)).toContainText("Box B is offline. Your work is kept.");
		await expect(button).toHaveAccessibleName("Runs on Box B");

		// The document is then set to run on Box C, and its Planner is starting. The read of the list
		// is slow: until it answers, the status says nothing, not what it said of Box B.
		let release = reread.hold();
		await choose("Box C");
		carriage.say({ state: "starting", login: "mona" });
		await expect(button).toHaveAccessibleName("Runs on Box B");
		await expect(button).not.toHaveAttribute("data-planner");
		await page.waitForTimeout(1_800);
		await expect(button).toHaveAccessibleName("Runs on Box B");
		await expect(strip(page)).toHaveCount(0);

		// It answers, naming Box C. A machine being connected to waits out its grace, and for that
		// time nothing of Box B, which Box C's state no longer supports, is read, in the button's name,
		// on its dot, in the strip or by a screen reader.
		let stop = await sampling(page);
		release();
		await expect(strip(page)).toContainText("Connecting to Box C");
		await page.waitForTimeout(1_000);
		let samples = await stop();
		expect(samples.at(-1)!.at - samples[0]!.at).toBeGreaterThanOrEqual(2_000);
		let named = samples.findIndex(sample => sample.name.includes("Box C"));
		let connecting = samples.findIndex(sample => sample.strip.includes("Connecting"));
		expect(named).toBeGreaterThanOrEqual(0);
		expect(connecting).toBeGreaterThan(named);
		expect(samples.slice(named).filter(sample => JSON.stringify(sample).includes("Box B")))
			.toEqual([]);
		for (let sample of samples.slice(named, connecting)) {
			expect(sample).toMatchObject({ name: "Runs on Box C", planner: "", strip: "", said: "" });
		}
		expect(samples[connecting]!.at - samples[named]!.at).toBeGreaterThanOrEqual(1_200);
		expect(samples.slice(connecting).map(sample => sample.name)).toEqual(
			samples.slice(connecting).map(() => "Runs on Box C"),
		);
		for (let sample of samples.slice(connecting)) {
			expect(sample.strip).toContain("Connecting to Box C");
		}
		expect(await heard(page)).toEqual([
			"Box B is offline. Your work is kept.",
			"Connecting to Box C",
		]);
		await shoot(page, `planner-settled-after-move-${shape}`);
		await page.unrouteAll({ behavior: "wait" });
	});
}

for (let [shape, options] of SHAPES) {
	test(`while the connection banner shows, the live region says only the connection's words, does not say a Planner state again that carried on through the loss, and says a different one once, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(150_000);
		let room = await remoteServer();
		let context = await browser.newContext(options);
		let page = await context.newPage();
		await page.addInitScript(() => {
			Math.random = () => 0.999;
		});
		await authenticate(page, "mona", ORIGIN);
		await listenForAnnouncements(page);
		let carriage = await carried(page);
		carriage.mute(true);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await createdBy(room, "mona");
		await machine(page, "Box B", true);
		await machine(page, "Box C", true);
		let list = await (await page.request.get(`${ORIGIN}/api/documents/${room}/machine`))
			.json() as { machines: Array<{ id: string; label: string }> };
		let choose = async (label: string) => {
			let chosen = await page.request.post(`${ORIGIN}/api/documents/${room}/machine`, {
				data: { machine: list.machines.find(value => value.label === label)!.id },
				headers: { origin: ORIGIN },
			});
			expect(chosen.status()).toBe(200);
		};
		await choose("Box B");
		await page.reload();
		await ready(page);
		await chatTab(page, shape === "phone");
		let button = machineButton(page);
		let notice = page.locator(
			'.chat-composer [data-connection-banner]:not([data-layer="planner"])',
		);
		await expect(button).toHaveAccessibleName("Runs on Box B");

		// The machine drops, and a screen reader is told once.
		carriage.say({ state: "disconnected", login: "mona" });
		await expect(strip(page)).toContainText("Box B is offline. Your work is kept.");
		await expect(strip(page)).toHaveAttribute("data-layer", "planner");
		await expect(button).toHaveAccessibleName("Runs on Box B");
		await expect(announced(page)).toHaveText("Box B is offline. Your work is kept.");
		let said = ["Box B is offline. Your work is kept."];
		expect(await heard(page)).toEqual(said);

		// The page's connection is lost: its banner is the one thing said, in the connection's own
		// words, and the live region carries none of the machine's. The state carried on through the
		// loss, so it is not said after it.
		await carriage.lose();
		await expect(notice).toBeVisible();
		await expect(strip(page)).toHaveCount(1);
		await expectNoMachineWords(page, RECONNECTING);
		await page.waitForTimeout(500);
		expect(await heard(page)).toEqual([...said, RECONNECTING]);
		await shoot(page, `planner-silent-offline-${shape}`);
		await carriage.back(true);
		// The socket is open and nothing is on it yet: the banner says it is catching up, in its own
		// layer, for as long as the test looks, and the live region says it once.
		await expect(notice).toHaveAttribute("data-layer", "sync");
		await expect(notice).toContainText(CATCHING_UP);
		await expect(announced(page)).toHaveText(CATCHING_UP);
		carriage.release();
		await expect(notice).toHaveCount(0);
		await expect(strip(page)).toContainText("Box B is offline. Your work is kept.");
		await expect(button).toHaveAccessibleName("Runs on Box B");
		await page.waitForTimeout(500);
		expect(await heard(page)).toEqual([...said, RECONNECTING, CATCHING_UP, BACK_ONLINE]);
		// The back-online words went with their banner, and the Planner state that carried on is not
		// said in their place.
		await expect(announced(page)).toHaveText("");

		// A state that is not the one it last said is said once.
		carriage.say({ state: "starting", login: "mona" });
		await expect(strip(page)).toContainText("Connecting to Box B");
		await expect(button).toHaveAccessibleName("Runs on Box B");
		await expect(announced(page)).toHaveText("Connecting to Box B");
		await page.waitForTimeout(500);
		expect(await heard(page)).toEqual([
			...said,
			RECONNECTING,
			CATCHING_UP,
			BACK_ONLINE,
			"Connecting to Box B",
		]);
		await page.unrouteAll({ behavior: "wait" });
	});
}

for (let [shape, options] of SHAPES) {
	test(`a state released after the socket dropped, whose grace runs out beside the page's offline notice, is not said there, and is said once when the connection returns, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(150_000);
		let room = await remoteServer();
		let context = await browser.newContext(options);
		let page = await context.newPage();
		await page.addInitScript(() => {
			Math.random = () => 0.999;
		});
		await authenticate(page, "mona", ORIGIN);
		await listenForAnnouncements(page);
		let carriage = await carried(page);
		carriage.mute(true);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await createdBy(room, "mona");
		await machine(page, "Box B", true);
		await machine(page, "Box C", true);
		let list = await (await page.request.get(`${ORIGIN}/api/documents/${room}/machine`))
			.json() as { machines: Array<{ id: string; label: string }> };
		let choose = async (label: string) => {
			let chosen = await page.request.post(`${ORIGIN}/api/documents/${room}/machine`, {
				data: { machine: list.machines.find(value => value.label === label)!.id },
				headers: { origin: ORIGIN },
			});
			expect(chosen.status()).toBe(200);
		};
		await choose("Box B");
		await page.reload();
		await ready(page);
		await chatTab(page, shape === "phone");
		let button = machineButton(page);
		let notice = page.locator(
			'.chat-composer [data-connection-banner]:not([data-layer="planner"])',
		);
		let reread = await reading(page, room, state => state);
		await expect(button).toHaveAccessibleName("Runs on Box B");

		// The document is set to run on Box C and its machine starts there, but the read of the list,
		// started after that word, answers only after the connection has dropped. The state it
		// releases has to last its grace, and does so beside the notice, which is the one thing said.
		let release = reread.hold();
		await choose("Box C");
		carriage.say({ state: "starting", login: "mona" });
		await expect(button).toHaveAccessibleName("Runs on Box B");
		await carriage.lose();
		await expect(notice).toBeVisible();
		let stop = await sampling(page);
		release();
		await page.waitForTimeout(2_500);
		let samples = await stop();
		expect(samples.at(-1)!.at - samples[0]!.at).toBeGreaterThanOrEqual(2_000);
		expect(samples.filter(sample => sample.said && sample.said !== RECONNECTING)).toEqual([]);
		await expectNoMachineWords(page, RECONNECTING);
		expect(await heard(page)).toEqual([RECONNECTING]);

		// The connection returns, and the state is said once, as a state entered then.
		await carriage.back(true);
		await expect(notice).toHaveAttribute("data-layer", "sync");
		await expect(notice).toContainText(CATCHING_UP);
		await expect(announced(page)).toHaveText(CATCHING_UP);
		carriage.release();
		await expect(notice).toHaveCount(0);
		await expect(strip(page)).toContainText("Connecting to Box C");
		await expect(button).toHaveAccessibleName("Runs on Box C");
		await expect(announced(page)).toHaveText("Connecting to Box C");
		await page.waitForTimeout(500);
		expect(await heard(page)).toEqual([
			RECONNECTING,
			CATCHING_UP,
			BACK_ONLINE,
			"Connecting to Box C",
		]);
		await page.unrouteAll({ behavior: "wait" });
	});
}

for (let [shape, options] of SHAPES) {
	test(`a machine that is offline says when it was last seen, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(120_000);
		let room = await remoteServer();
		// The page words a time seen today as the time of day and any other day with its date, in the
		// browser's time zone. An hour before the real clock is yesterday for a run just after local
		// midnight, so the page's clock and zone are fixed and the machine was seen an hour before.
		let context = await browser.newContext({ ...options, timezoneId: "UTC" });
		let page = await context.newPage();
		let now = new Date("2026-06-15T12:00:00Z");
		await page.clock.install({ time: now });
		await authenticate(page, "mona", ORIGIN);
		let { say } = await carried(page);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await createdBy(room, "mona");
		let studio = await machine(page, "studio", true);
		await page.reload();
		await ready(page);
		await chatTab(page, shape === "phone");
		let button = machineButton(page);
		await expect(strip(page)).toContainText("Connecting to studio");
		await expect(button).toHaveAccessibleName("Runs on studio");
		let list = await (await page.request.get(`${ORIGIN}/api/documents/${room}/machine`))
			.json() as { machines: Array<{ id: string; label: string }> };
		let id = list.machines.find(value => value.label === "studio")!.id;

		// The machine is away: the page is told its Planner dropped, and the machine list says when
		// the machine was last seen.
		let reread = await reading(page, room, state => ({
			...state,
			choice: id,
			machines: (state.machines as Array<Record<string, unknown>>).map(value =>
				value.id === id
					? { ...value, connected: false, lastSeenAt: now.getTime() - 3_600_000 }
					: value
			),
			planner: { state: "disconnected", login: "mona", machine: id },
		}));
		say({ state: "disconnected", login: "mona" });
		await reread.refresh();
		await expect(strip(page)).toContainText(
			/studio is offline\. Last seen \d{1,2}:\d{2}\D?[AP]M\./,
		);
		await expect(button).toHaveAccessibleName("Runs on studio");
		// The one live word is said as the state is entered, and not again as its detail arrives.
		await expect(announced(page)).toHaveText(/^studio is offline\./);
		// Chopin cannot reconnect the machine, so the banner offers no Reconnect; this person may
		// choose another machine, so it offers that, and it opens the same list the button does.
		let choose = strip(page).getByRole("button", { name: "Choose machine", exact: true });
		await expect(strip(page).getByRole("button")).toHaveCount(1);
		await expect(choose).toBeVisible();
		await choose.click();
		let chosen = shape === "phone"
			? page.getByRole("dialog", { name: "Runs on", exact: true })
			: page.getByRole("menu", { name: "Runs on", exact: true });
		await expect(chosen.getByRole("menuitemradio", { name: /^studio/ })).toContainText("Offline");
		await shoot(page, `machine-offline-choose-${shape}`);
		// A phone's sheet takes focus once it has risen, as it does when the button opens it.
		if (shape === "phone") await expect(chosen).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(chosen).toBeHidden();
		// The banner tells it, so the machine's menu does not tell it a second time. A desktop's list
		// of machines is the menu named "Runs on"; a phone's is a sheet, a dialog of that name, with
		// the same list, so each is looked at as what it is, and has its machine's own row and no note.
		if (shape === "phone") await button.tap();
		else await button.click();
		let surface = shape === "phone"
			? page.getByRole("dialog", { name: "Runs on", exact: true })
			: page.getByRole("menu", { name: "Runs on", exact: true });
		await expect(surface.getByRole("menuitemradio", { name: /^studio/ })).toContainText("Offline");
		await expect(surface.getByRole("group", { name: "Connection", exact: true })).toHaveCount(0);
		await shoot(page, `machine-offline-last-seen-${shape}`);
		await page.keyboard.press("Escape");
		await expect(surface).toBeHidden();

		// It comes back, and the banner says so, once, and goes.
		reread.active.on = false;
		say({ state: "attached", login: "mona" });
		await expect(button).toHaveAccessibleName(/^Runs on studio$/);
		await expect(announced(page)).toHaveText(MACHINE_BACK);
		await page.unrouteAll({ behavior: "wait" });
		await studio.disconnect();
	});
}

for (let [shape, options] of SHAPES) {
	test(`a person with no machine button reads no machine state above the composer beside the page's offline notice, and reads it again when the connection returns, on a ${shape}`, async ({ browser }) => {
		test.setTimeout(150_000);
		let room = await remoteServer();
		let context = await browser.newContext(options);
		let page = await context.newPage();
		await page.addInitScript(() => {
			Math.random = () => 0.999;
		});
		await authenticate(page, "hubot", ORIGIN);
		let carriage = await carried(page);
		carriage.mute(true);
		await page.goto(`${ORIGIN}${roomPath(room)}`);
		await ready(page);
		await chatTab(page, shape === "phone");
		await expect(machineButton(page)).toHaveCount(0);
		let notice = page.locator(
			'.chat-composer [data-connection-banner]:not([data-layer="planner"])',
		);
		let failure = { attempts: 3, reason: "exit 1", at: new Date().toISOString() };

		// Each state the banner tells a person with no button, lost and recovered: the page cannot
		// hear the machine while it is offline, and its one banner speaks for the connection.
		let states = [
			["connecting", { state: "starting", login: "mona" }, "Connecting to @mona's machine"],
			[
				"failing",
				{ state: "starting", login: "mona", failure },
				"Can't connect to @mona's machine.",
			],
			[
				"away",
				{ state: "disconnected", login: "mona" },
				"@mona's machine is offline. Your work is kept.",
			],
		] as const;
		for (let [name, planner, text] of states) {
			carriage.say(planner);
			await expect(strip(page)).toContainText(text);
			// A machine that is away offers this person, who may not choose one, no button at all.
			if (name === "away") await expect(strip(page).getByRole("button")).toHaveCount(0);

			await carriage.lose();
			await expect(notice).toBeVisible();
			await expect(strip(page)).toHaveCount(1);
			await expect(strip(page)).not.toHaveAttribute("data-layer", "planner");
			await expect(page.locator(".chat-composer").getByText(text)).toHaveCount(0);
			await shoot(page, `no-button-${name}-offline-${shape}`);

			await carriage.back();
			await expect(notice).toHaveCount(0);
			await expect(strip(page)).toContainText(text);
			await expect(strip(page)).toHaveAttribute("data-layer", "planner");
			await shoot(page, `no-button-${name}-online-${shape}`);
		}
		await expectNoHorizontalOverflow(page);
	});
}

/** Why it refused, with no stop at its end: shown as it was reported, not tidied into a sentence. */
const REASON =
	"unsafe-checkout: ~/src/score's own git configuration sets a credential helper, which is not run in";

/** What a connector reports when its backend refused its checkout for the `attempts`th time in a row. */
function refused(document: string, attempts: number) {
	return {
		document,
		failure: { attempts, how: "exit 1", reason: REASON, at: Date.now() },
	};
}

test("a Planner its machine keeps failing to start says why on the banner at the composer, for the machine's owner and for a person with no button alike, and is announced once, until it attaches", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let page = await open(browser, "mona", room, DESKTOP, { listen: true });
	await createdBy(room, "mona");
	let studio = await machine(page, "studio", true);
	await page.reload();
	await ready(page);
	// A teammate who has the document open has no machine of their own, so no button; the composer's
	// top edge is the only place they can read the Planner's state, and it says it, not by name
	// whose machine it is.
	let teammate = await open(browser, "hubot", room, DESKTOP);
	let button = machineButton(page);
	await expect(button).toHaveAccessibleName("Runs on studio");
	await expect(machineButton(teammate)).toHaveCount(0);
	expect((await studio.poll([])).planners).toHaveLength(1);
	// Starting: the banner tells it, to the owner and to the person with no button alike, and the
	// button is left naming only where the document runs. A screen reader is told once, and the
	// banner says nothing of its own aloud.
	await expect(strip(page)).toContainText(/^Connecting to (studio|@mona's machine)$/);
	await expect(button).not.toHaveAttribute("data-planner");
	// The first sentence may still name the owner's login if the machine list had not loaded yet; it
	// is not said again once the machine's name arrives.
	await expect(announced(page)).toHaveText(/^Connecting to (studio|@mona's machine)$/);
	await expect(strip(teammate)).toHaveText("Connecting to @mona's machine");
	await expect(strip(teammate)).not.toHaveAttribute("role");
	await shoot(teammate, "planner-starting-teammate-desktop", teammate.locator(".chat-composer"));

	// One launch that exited is a transient failure: still just starting.
	expect((await studio.reportFailure(refused(room, 1))).status).toBe(200);
	await expect(button).toHaveAccessibleName("Runs on studio");
	await expect(strip(page)).toContainText("Connecting to studio");

	// The second in a row says why, to the machine's owner and to the teammate.
	expect((await studio.reportFailure(refused(room, 2))).status).toBe(200);
	await expect(button).toHaveAccessibleName("Runs on studio");
	await expect(button).not.toHaveAttribute("data-planner");
	await expect(button.locator(".machine-glyph-dot[data-planner]")).toHaveCount(0);
	// The banner tells it once, to both, so the button does not tell it again: the reason is
	// drawn in full and as given, with what has been tried and where to fix it.
	let owned = strip(page);
	await expect(owned).toContainText("Can't connect to studio.");
	await expect(owned.locator(".composer-notice-line")).toHaveText([
		REASON,
		/^Tried 2 times, last at .+\. Still trying\.$/,
	]);
	await expect(owned.getByRole("link", { name: "How to fix" })).toBeVisible();
	let seen = strip(teammate);
	await expect(seen).not.toHaveAttribute("role");
	await expect(seen).toContainText("Can't connect to @mona's machine.");
	await expect(seen.locator(".sr-only")).toHaveCount(0);
	await expect(seen.locator(".composer-notice-line")).toHaveText([
		REASON,
		/^Tried 2 times, last at .+\. Still trying\.$/,
	]);
	await expect(seen.locator(".composer-notice-line").first()).toBeVisible();
	await expect(seen.getByRole("link", { name: "How to fix" })).toBeVisible();
	// Each hears it once, from the one live region, and from no other element.
	await expect(announced(page)).toHaveText("Can't connect to studio.");
	await expectSaidOnce(page, "Can't connect to studio.");
	await expect(announced(teammate)).toHaveText("Can't connect to @mona's machine.");
	await expectSaidOnce(teammate, "Can't connect to @mona's machine.");
	await shoot(page, "planner-failing-desktop");
	await shoot(teammate, "planner-failing-teammate-desktop", teammate.locator(".chat-composer"));

	// The machine button opens onto the machines alone: the story is the banner's, told once.
	await button.click();
	let menu = page.getByRole("menu", { name: "Runs on", exact: true });
	await expect(menu.getByRole("group", { name: "Connection", exact: true })).toHaveCount(0);
	await shoot(page, "planner-failing-menu-desktop");
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
	await expect(button).toBeFocused();

	// More failures update the count and say nothing more aloud; @chopin sent meanwhile is never
	// refused for it: it is in the Chat at once, marked Sent, and waits for the machine.
	await studio.reportFailure(refused(room, 3));
	await expect(owned.locator(".composer-notice-line").last()).toContainText("Tried 3 times");
	await expect(seen.locator(".composer-notice-line").last()).toContainText("Tried 3 times");
	let input = chatInput(teammate);
	await fillChat(input, "@chopin outline the plan");
	await input.press("Enter");
	let outline = teammate.locator("[data-chat-message-id]").filter({ hasText: "outline the plan" });
	await expect(outline).toHaveCount(1);
	await expect(outline.getByRole("img", { name: "Sent" })).toBeVisible();
	await expect(input).toHaveText("");
	await expect(strip(teammate)).not.toHaveAttribute("data-error", "true");

	// It attaches at last, and nothing about the failure is left, quietly: no word, no mark.
	let link = await studio.backend(room);
	await expectHealthy(button);
	await expect(strip(page)).toHaveCount(0);
	await expect(announced(page)).toHaveText("");
	// The warning goes, and the teammate's message, which waited for the machine, is delivered once
	// it is there, with nothing about it said on the composer.
	await expect(teammate.locator(".chat-composer .composer-notice[data-warning]")).toHaveCount(0);
	await expect(strip(teammate)).toHaveCount(0);
	await expect(outline.getByRole("img", { name: "Delivered" })).toBeVisible();
	await expect(outline).toHaveCount(1);
	await expect(page.getByText("Tried 3 times")).toHaveCount(0);
	// A screen reader was told each state once, and not again as the count rose or it cleared.
	let said = await heard(page);
	let connecting = said.filter(text => text.startsWith("Connecting to "));
	expect(connecting).toHaveLength(1);
	expect(said.filter(text => text === "Can't connect to studio.")).toHaveLength(1);
	expect(said.indexOf(connecting[0]!)).toBeLessThan(said.indexOf("Can't connect to studio."));
	expect(said.at(-1)).toBe("Can't connect to studio.");
	await link.detach();
});

test("on a phone, a Planner its machine keeps failing to start says why on its machine button alone, and in full at the composer for a person with no button", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let page = await open(browser, "mona", room, PHONE);
	await createdBy(room, "mona");
	let studio = await machine(page, "studio", true);
	await page.reload();
	await ready(page);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
	// A teammate with no machine, so no button, on a phone as well.
	let teammate = await open(browser, "hubot", room, PHONE);
	await teammate.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
	await expect(machineButton(teammate)).toHaveCount(0);
	expect((await studio.poll([])).planners).toHaveLength(1);
	let button = machineButton(page);
	await expect(button).toHaveAccessibleName("Runs on studio");
	await expect(button).toBeInViewport();
	await expect(strip(page)).toContainText("Connecting to studio");
	await expectInsideViewport(strip(page));
	await shoot(page, "planner-starting-phone");
	await expect(strip(teammate)).toHaveText("Connecting to @mona's machine");
	await expect(() => expectInsideViewport(strip(teammate))).toPass();
	await shoot(teammate, "planner-starting-teammate-phone");

	await studio.reportFailure(refused(room, 2));
	await expect(button).not.toHaveAttribute("data-planner");
	await expect(strip(page)).toContainText("Can't connect to studio.");
	await expectInsideViewport(strip(page));
	await expectNoHorizontalOverflow(page);
	await shoot(page, "planner-failing-phone");

	// Without the button the reason is drawn, as given, and fits the phone.
	await expect(strip(teammate)).toContainText("Can't connect to @mona's machine.");
	await expect(strip(teammate).locator(".composer-notice-line")).toHaveText([
		REASON,
		/^Tried 2 times, last at .+\. Still trying\.$/,
	]);
	await expectInsideViewport(strip(teammate));
	await expectNoHorizontalOverflow(teammate);
	await shoot(teammate, "planner-failing-teammate-phone");

	// The owner's banner tells it in full too, and tapping the button opens its sheet onto the
	// machines alone.
	await expect(strip(page).locator(".composer-notice-line")).toHaveText([
		REASON,
		/^Tried 2 times, last at .+\. Still trying\.$/,
	]);
	await button.tap();
	await expect(page.getByRole("group", { name: "Connection", exact: true })).toHaveCount(0);
	await shoot(page, "planner-failing-sheet-phone");
});

test("a teammate's document with no machine of its own gets its Planner on a machine shared with teammates", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	// mona's machine can run Planners; hubot created the document and has no machine.
	let owner = await open(browser, "mona", room, DESKTOP);
	let studio = await machine(owner, "studio", true);
	let page = await open(browser, "hubot", room, DESKTOP);
	await createdBy(room, "hubot");
	await page.reload();
	await ready(page);
	// hubot has no machine, so no button: the composer's top edge says so, whatever is typed.
	let status = strip(page);
	await expect(status).toHaveText(NONE);

	// mona shares studio from the Machines table; hubot's document asks it at once.
	await owner.goto(`${ORIGIN}/machines`);
	let sharing = owner.getByRole("switch", { name: "Share studio with teammates" });
	await expect(sharing).toHaveAttribute("aria-checked", "false");
	await sharing.click();
	await expect(sharing).toHaveAttribute("aria-checked", "true");
	// Once the machine is listed for hubot he has its button, which then carries the state; the one
	// live region says it either way, once.
	await expect(announced(page)).toHaveText(/^Connecting to /);
	expect(await studio.poll([])).toEqual({
		kind: "planners",
		planners: [{ id: room, url: expect.stringContaining(ORIGIN) }],
	});
	let link = await studio.backend(room);
	await expect(status).toHaveCount(0);
	await shoot(page, "teammate-planner-attached", page.locator(".chat-composer"));

	// hubot's @chopin reaches the Planner on mona's machine.
	let input = chatInput(page);
	await fillChat(input, "@chopin outline the plan");
	await input.press("Enter");
	await expect(page.getByText("outline the plan").first()).toBeVisible();
	await expect(page.getByText(/Connect a machine to get a reply|No machine is connected/))
		.toHaveCount(0);

	// Sharing off: the Planner stops, and hubot's document has none again.
	await sharing.click();
	await expect(sharing).toHaveAttribute("aria-checked", "false");
	await expect(status).toHaveText(/^(No machine is connected|@mona's machine stepped away)/);
	await link.detach().catch(() => {});
});

test("a teammate's Planner finishes its reply after its machine stops being shared, then stops", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let owner = await open(browser, "mona", room, DESKTOP);
	let studio = await machine(owner, "studio", true);
	let page = await open(browser, "hubot", room, DESKTOP);
	await createdBy(room, "hubot");
	await owner.goto(`${ORIGIN}/machines`);
	let sharing = owner.getByRole("switch", { name: "Share studio with teammates" });
	await sharing.click();
	await expect(sharing).toHaveAttribute("aria-checked", "true");
	await page.reload();
	await ready(page);
	let status = strip(page);
	expect((await studio.poll([])).planners).toHaveLength(1);
	let replying = Promise.withResolvers<void>();
	let started = Promise.withResolvers<void>();
	let link = await studio.backend(room, {
		async turn() {
			started.resolve();
			await replying.promise;
		},
	});
	await expect(status).toHaveCount(0);

	// hubot's reply is under way when mona stops sharing studio: it keeps its Planner meanwhile.
	let input = chatInput(page);
	await fillChat(input, "@chopin outline the plan");
	await input.press("Enter");
	await started.promise;
	await sharing.click();
	await expect(sharing).toHaveAttribute("aria-checked", "false");
	await expect(owner.getByText("Finishing 1 teammate document", { exact: true })).toBeVisible({
		timeout: 15_000,
	});
	await expect(sharing).toHaveAccessibleDescription("Finishing 1 teammate document");
	await expect(status).toHaveCount(0);
	await shoot(owner, "machines-finishing");

	// The reply ends: the next sweep stops the Planner, and studio no longer says it is finishing.
	replying.resolve();
	await expect(status).toHaveText(NONE, { timeout: 30_000 });
	await expect(owner.getByText(/^Finishing/)).toHaveCount(0, { timeout: 15_000 });
	await link.detach().catch(() => {});
});

/** A first build's tasks, so Build plan can show without a Planner's draft. */
const GRAPH = {
	versions: [{
		number: 1,
		revision: 1,
		planRevision: 0,
		state: "draft" as const,
		definition: {
			tasks: [{
				id: "connect",
				title: "Connect the local agent",
				context: "An isolated tracer.",
				goal: "Read the approved graph.",
				acceptance: ["The agent can read the graph.", "Its progress appears in Chopin."],
				dependsOn: [],
			}],
		},
	}],
};

/** Where an element starts, from the left of the page. */
async function left(target: ReturnType<Page["locator"]>) {
	return (await target.boundingBox())!.x;
}

/** The Machines page's one table, the person's own machines and the ones teammates share. */
function machinesTable(page: Page) {
	return page.getByRole("table", { name: "Your machines" });
}

/** The sidebar's Machines entry, with its count. */
function machinesEntry(page: Page) {
	return page.getByRole("complementary", { name: "Projects" })
		.getByRole("button", { name: /^Machines/ });
}

/** The document's machine button, left of Build plan. */
function runsOnButton(page: Page) {
	return page.getByRole("button", { name: /^Runs on/ });
}

/** The owner shares one of their machines with teammates from the Machines table, and waits for it. */
async function share(owner: Page, label: string, shared = true) {
	await owner.goto(`${ORIGIN}/machines`);
	let sharing = owner.getByRole("switch", { name: `Share ${label} with teammates` });
	if (await sharing.getAttribute("aria-checked") !== String(shared)) await sharing.click();
	await expect(sharing).toHaveAttribute("aria-checked", String(shared));
}

test("teammates' shared machines are in the one Machines table, read-only, and go when unshared", async ({ browser }) => {
	test.setTimeout(150_000);
	let room = await remoteServer();
	let owner = await open(browser, "casey", room, DESKTOP);
	let box = await machine(owner, "Build box", true, { service: true });
	await machine(owner, "Desk", true);
	let teammate = await open(browser, "drew", room, DESKTOP);
	let reader = await openReader(browser, room);

	// Nothing is shared yet: a teammate's Machines page has no table.
	await teammate.goto(`${ORIGIN}/machines`);
	await expect(teammate.getByRole("heading", { name: "Add your first machine" })).toBeVisible();
	await expect(machinesTable(teammate)).toHaveCount(0);

	// casey shares Build box but not Desk.
	await share(owner, "Build box");
	let table = machinesTable(teammate);
	await expect(table).toBeVisible({ timeout: 15_000 });
	await expect(teammate.getByRole("region", { name: "Shared with you" })).toHaveCount(0);
	let row = table.getByRole("row", { name: /Build box/ });
	await expect(row).toContainText("casey");
	await expect(row).toContainText(`chopin ${RELEASE}`);
	await expect(row).toContainText("Connected");
	await expect(table.getByRole("rowgroup").filter({ hasText: "Cloud" })).toBeVisible();
	await expect(table.getByText("Desk")).toHaveCount(0);
	// The page counts it, as the sidebar does.
	await expect(teammate.getByText("1 machine", { exact: true })).toBeVisible();
	await expect(machinesEntry(teammate)).toContainText("1/1");
	// Read-only: its Shared switch is on and out of reach, and nothing renames, disconnects or sets
	// it up. The star is the teammate's own, to make it their default.
	let sharing = row.getByRole("switch", { name: "Share Build box with teammates" });
	await expect(sharing).toBeChecked();
	await expect(sharing).toBeDisabled();
	await expect(row.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
	await expect(row.getByRole("button", { name: "Favorite Build box" })).toBeEnabled();
	await expect(row.getByRole("link")).toHaveCount(0);
	await shoot(teammate, "machines-table-shared");

	// Chopin refuses the owner-only routes to a teammate, whatever they send.
	let listed = await (await teammate.request.get(`${ORIGIN}/api/connector/machines`)).json() as {
		machines: Array<Record<string, unknown>>;
	};
	expect(listed.machines).toEqual([expect.objectContaining({
		label: "Build box",
		teammate: true,
		owner: expect.objectContaining({ login: "casey" }),
		repositories: ["octo-org/score"],
		connected: true,
		favorite: false,
	})]);
	let id = listed.machines[0]!.id as string;
	for (
		let [action, data] of [["label", { label: "mine" }], ["shared", { shared: false }], [
			"revoke",
			{},
		]] as const
	) {
		let refused = await teammate.request.post(`${ORIGIN}/api/connector/machines/${id}/${action}`, {
			data,
			headers: { origin: ORIGIN },
		});
		expect(refused.status(), action).toBe(404);
	}
	await expect(owner.getByRole("switch", { name: "Share Build box with teammates" }))
		.toHaveAttribute("aria-checked", "true");

	// Someone who can't push to the repository never sees it.
	await reader.goto(`${ORIGIN}/machines`);
	await expect(reader.getByRole("heading", { name: "Add your first machine" })).toBeVisible();
	await expect(machinesTable(reader)).toHaveCount(0);

	// Offline, it stays listed, with when it was last seen.
	await box.disconnect();
	await expect(row).toContainText("Last seen", { timeout: 15_000 });
	await expect(row).not.toContainText("Connected");

	// Its owner stops sharing it: it leaves the teammate's page.
	await share(owner, "Build box", false);
	await expect(machinesTable(teammate)).toHaveCount(0, { timeout: 15_000 });
});

test("on a phone, a teammate's shared machine is a row of the one list, with its owner and version", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let owner = await open(browser, "casey", room, DESKTOP);
	await machine(owner, "Build box", true, { service: true });
	await share(owner, "Build box");
	let page = await open(browser, "drew", room, PHONE);
	await page.goto(`${ORIGIN}/machines`);
	let row = page.getByRole("listitem").filter({ hasText: "Build box" });
	await expect(row).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("region", { name: "Shared with you" })).toHaveCount(0);
	await expect(row).toContainText("casey");
	await expect(row).toContainText(`chopin ${RELEASE}`);
	await expect(row.getByRole("button", { name: "Favorite Build box" })).toBeVisible();
	// Its view offers the star and nothing only its owner changes.
	await row.locator(".machines-row").click();
	let actions = page.getByRole("list", { name: "Actions for Build box" });
	await expect(actions.getByRole("button", { name: "Set as favorite" })).toBeVisible();
	await expect(actions.getByRole("button")).toHaveCount(1);
	await shoot(page, "machines-shared-phone");
});

test("anyone who can edit a document chooses a teammate's shared machine for its Planner; its creator's own choice decides", async ({ browser }) => {
	test.setTimeout(180_000);
	let room = await remoteServer();
	await seedChannel(PORT, room, "# Shared machine\n\nThe Planner runs where it is chosen.\n", {
		graph: GRAPH,
	});
	let owner = await open(browser, "casey", room, DESKTOP);
	let box = await machine(owner, "Build box", true, { service: true });
	await machine(owner, "Desk", true);
	// drew created the document and has a machine of their own; quinn edits it and has none.
	let creator = await open(browser, "drew", room, DESKTOP);
	await createdBy(room, "drew");
	let laptop = await machine(creator, "Laptop", true);
	let editor = await open(browser, "quinn", room, DESKTOP);
	let reader = await openReader(browser, room);

	// Not shared, nothing of casey's is offered; a reader has no machine button at all.
	await editor.reload();
	await ready(editor);
	await expect(runsOnButton(editor)).toHaveCount(0);
	await expect(runsOnButton(reader)).toHaveCount(0);
	expect(
		(await (await reader.request.get(`${ORIGIN}/api/documents/${room}/machine`)).json() as {
			machines: unknown[];
		}).machines,
	).toEqual([]);

	// Shared, Build box is offered to the editor among the Cloud machines, Desk is not, and no
	// group is named for its owner.
	await share(owner, "Build box");
	await editor.reload();
	await ready(editor);
	let menu = await runOn(editor);
	let group = menu.getByRole("group", { name: "Cloud" });
	await expect(group.getByRole("menuitemradio")).toHaveCount(1);
	let item = group.getByRole("menuitemradio", { name: /^Build box/ });
	await expect(item).toContainText("Connected");
	await expect(item).not.toHaveAttribute("aria-disabled", "true");
	await expect(menu.getByText("Desk")).toHaveCount(0);
	await expect(menu.getByRole("group", { name: "Local" })).toHaveCount(0);
	await expect(menu.getByRole("group", { name: /^Shared by/ })).toHaveCount(0);
	await shoot(editor, "shared-machine-menu");

	// quinn chooses it: Build box is asked to run the Planner, and the button says where.
	await item.click();
	await expect(menu).toBeHidden();
	await expect(runsOnButton(editor)).toHaveAccessibleName(/^Runs on Build box/);
	let asked = await box.poll([]);
	expect(asked).toEqual({
		kind: "planners",
		planners: [{ id: room, url: expect.stringContaining(ORIGIN) }],
	});
	// The machine is one quinn can see in their own menu, so Chat names it rather than its owner.
	await expect(machineButton(editor)).toHaveAccessibleName("Runs on Build box");
	await expect(strip(editor)).toContainText("Connecting to Build box");
	// Quinn's builds run there too: Build plan is ready, not greyed out.
	let plan = editor.getByRole("button", { name: "Build plan", exact: true });
	await expect(plan).toBeVisible();
	await expect(plan).not.toHaveAttribute("aria-disabled", "true");
	await shoot(editor, "shared-machine-chosen");

	// drew, who created the document, chooses their own machine: that decides, so Build box stops
	// and quinn's choice goes.
	await (await runOn(creator)).getByRole("menuitemradio", { name: /^Laptop/ }).click();
	await expect(runsOnButton(creator)).toHaveAccessibleName(/^Runs on Laptop/);
	expect(await box.poll([room])).toEqual({
		kind: "planners",
		planners: [],
		stopped: { [room]: expect.stringContaining("drew chose another machine") },
	});
	expect(await laptop.poll([])).toMatchObject({ kind: "planners" });
	await editor.reload();
	await ready(editor);
	await expect(runsOnButton(editor)).toHaveAccessibleName(/^Runs on: no machine connected/);

	// Offline, its row stays but can't be chosen.
	await box.disconnect();
	await editor.reload();
	await ready(editor);
	menu = await runOn(editor);
	let offline = menu.getByRole("group", { name: "Cloud" })
		.getByRole("menuitemradio", { name: /^Build box/ });
	await expect(offline).toHaveAttribute("aria-disabled", "true");
	await expect(offline).toContainText("Offline");
	await editor.keyboard.press("Escape");

	// Its owner stops sharing it: the machine leaves the menu.
	await share(owner, "Build box", false);
	await editor.reload();
	await ready(editor);
	await expect(runsOnButton(editor)).toHaveCount(0);
});

test("a shared machine with no checkouts serves every repository its owner can push to, and builds there", async ({ browser }) => {
	test.setTimeout(180_000);
	let room = await remoteServer();
	await seedChannel(PORT, room, "# Shared machine\n\nIt is built where it is chosen.\n", {
		graph: GRAPH,
	});
	let owner = await open(browser, "casey", room, DESKTOP);
	// Build box clones what it needs, so it connects with no checkout at all.
	let box = await machine(owner, "Build box", true, { service: true, bare: true });
	await share(owner, "Build box");

	// tessa has opened no document: the Machines page still lists it, in its one table among her
	// own, for octo-org/score, which she and casey can both push to, and its owner's name lines up
	// with its column.
	let context = await browser.newContext(DESKTOP);
	let page = await context.newPage();
	await authenticate(page, "tessa", ORIGIN);
	await page.goto(`${ORIGIN}/machines`);
	let table = machinesTable(page);
	await expect(table).toBeVisible({ timeout: 15_000 });
	let row = table.getByRole("row", { name: /Build box/ });
	await expect(row).toContainText("casey");
	await expect(row).toContainText("Connected");
	let versionOffset = await left(row.getByText(`chopin ${RELEASE}`))
		- await left(table.getByRole("columnheader", { name: "Version" }));
	let ownerOffset = await left(row.getByText("casey", { exact: true }))
		- await left(table.getByRole("columnheader", { name: "Owner" }));
	expect(Math.abs(ownerOffset - versionOffset)).toBeLessThan(1.5);
	await shoot(page, "machines-shared-no-checkout");

	// Her document's machine menu offers it among the Cloud machines, and choosing it is a choice
	// like any.
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let menu = await runOn(page);
	let item = menu.getByRole("group", { name: "Cloud" })
		.getByRole("menuitemradio", { name: /^Build box/ });
	await expect(item).toContainText("Connected");
	await item.click();
	await expect(menu).toBeHidden();
	await expect(runsOnButton(page)).toHaveAccessibleName(/^Runs on Build box/);

	// Build plan is ready, and pressing it queues the build on casey's machine, for tessa.
	let plan = page.getByRole("button", { name: "Build plan", exact: true });
	await expect(plan).toBeVisible();
	await expect(plan).not.toHaveAttribute("aria-disabled", "true");
	await shoot(page, "shared-machine-build-plan");
	await plan.click();
	expect(await box.work()).toEqual({ id: expect.any(String), kind: "implementation" });
	let snapshot = await (await page.request.get(`${ORIGIN}/api/channels/${room}/implementation`))
		.json() as {
			build: { id: string; user: string; machineOwner: string; state: string };
			startedBy: string;
			buildMachines: Record<string, { label: string; owner: string }>;
		};
	expect(snapshot).toMatchObject({
		build: { state: "queued", machineOwner: expect.any(String) },
		startedBy: "tessa",
	});
	expect(snapshot.build.user).not.toBe(snapshot.build.machineOwner);
	expect(snapshot.buildMachines[snapshot.build.id]).toMatchObject({
		label: "Build box",
		owner: "casey",
	});
	await shoot(page, "shared-machine-building");
});

test("on a phone, the machine sheet lists a teammate's shared machine plainly among the Cloud machines", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await remoteServer();
	let owner = await open(browser, "casey", room, DESKTOP);
	await machine(owner, "Build box", true, { service: true });
	await share(owner, "Build box");
	let page = await open(browser, "quinn", room, PHONE);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
	await page.locator(".phone-top-bar").getByRole("button", { name: /^Runs on/ }).tap();
	let sheet = page.getByRole("dialog", { name: "Runs on", exact: true });
	let group = sheet.getByRole("group", { name: "Cloud" });
	await expect(group.getByRole("menuitemradio", { name: /^Build box/ })).toContainText("Connected");
	await expect(sheet.getByRole("group", { name: /^Shared by/ })).toHaveCount(0);
	await shoot(page, "shared-machine-phone-sheet");
	await group.getByRole("menuitemradio", { name: /^Build box/ }).tap();
	await expect(sheet).toBeHidden();
	await expect(page.locator(".phone-top-bar").getByRole("button", { name: /^Runs on/ }))
		.toHaveAccessibleName(/^Runs on Build box/);
});

test("the sidebar counts and lists a teammate's shared machine with the person's own, and chooses it as their default", async ({ browser }) => {
	test.setTimeout(180_000);
	let room = await remoteServer();
	let owner = await open(browser, "casey", room, DESKTOP);
	let box = await machine(owner, "Build box", true, { service: true });
	let page = await open(browser, "drew", room, DESKTOP);
	await machine(page, "Laptop", true);
	await page.reload();
	await ready(page);
	let entry = machinesEntry(page);
	let live = { timeout: 15_000 };
	await expect(entry).toHaveAccessibleName("Machines, 1 connected", live);
	await expect(entry).toContainText("1/1");

	// casey shares Build box: it counts with drew's own machine, 2 of 2.
	await share(owner, "Build box");
	await expect(entry).toHaveAccessibleName("Machines, 2 connected", live);
	await expect(entry).toContainText("2/2");
	await shoot(page, "machines-count-shared", entry);

	// The menu lists it beside his own, plainly, under Local and Cloud, with no group of its own.
	await entry.click();
	let menu = page.getByRole("menu");
	let option = (name: string) => menu.getByRole("menuitemradio", { name: new RegExp(`^${name}`) });
	await expect(menu.getByText("Local", { exact: true })).toBeVisible();
	await expect(menu.getByText("Cloud", { exact: true })).toBeVisible();
	await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
	await expect(option("Laptop")).toContainText("Connected");
	await expect(option("Build box")).toContainText("Connected");
	await expect(menu.getByText(/Shared (by|with)/)).toHaveCount(0);
	await expect(option("Any connected")).toHaveAttribute("aria-checked", "true");
	await shoot(page, "machines-menu-shared");

	// Choosing it makes it his default, which Automatic prefers for his documents.
	await option("Build box").click();
	await expect(menu).toBeHidden();
	await entry.click();
	await expect(option("Build box")).toHaveAttribute("aria-checked", "true");
	await expect(option("Any connected")).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");
	let listed = await (await page.request.get(`${ORIGIN}/api/connector/machines`)).json() as {
		machines: Array<{ label: string; favorite: boolean; teammate: boolean }>;
	};
	expect(listed.machines.map(value => [value.label, value.teammate, value.favorite]).sort())
		.toEqual([["Build box", true, true], ["Laptop", false, false]]);

	// The Machines page lists them in one table and counts both, with his default starred.
	await page.goto(`${ORIGIN}/machines`);
	let table = machinesTable(page);
	await expect(page.getByText("2 machines", { exact: true })).toBeVisible();
	await expect(table.getByRole("row", { name: /Laptop/ })).toBeVisible();
	let theirs = table.getByRole("row", { name: /Build box/ });
	await expect(theirs.getByRole("button", { name: "Remove Build box as favorite" }))
		.toHaveAttribute("aria-pressed", "true");
	await expect(theirs.getByRole("switch")).toBeDisabled();
	await expect(table.getByRole("row", { name: /Laptop/ }).getByRole("switch")).toBeEnabled();
	await shoot(page, "machines-table-shared-and-own");
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	await expect(runsOnButton(page)).toHaveAccessibleName(/^Runs on Build box/, live);

	// The document's own menu lists the same machines the same way, Build box the one in use.
	let runs = await runOn(page);
	await expect(runs.getByRole("group", { name: "Local" }).getByRole("menuitemradio"))
		.toHaveCount(1);
	let cloud = runs.getByRole("group", { name: "Cloud" });
	await expect(cloud.getByRole("menuitemradio", { name: /^Build box/ }))
		.toHaveAttribute("aria-checked", "true");
	await expect(runs.getByRole("group", { name: /^Shared by/ })).toHaveCount(0);
	await shoot(page, "machine-button-menu-shared");
	await page.keyboard.press("Escape");

	// Offline, the count says so, and the warning says the default is the one that is.
	await box.disconnect();
	await expect(entry).toHaveAccessibleName(/^Machines, 1 of 2 connected/, live);
	await expect(entry).toHaveAccessibleName(/your default is offline$/);
	await expect(entry).toContainText("1/2");

	// Its owner stops sharing it: the count, the menu and drew's default all let it go.
	await share(owner, "Build box", false);
	await expect(entry).toHaveAccessibleName("Machines, 1 connected", live);
	await expect(entry).toContainText("1/1");
	await entry.click();
	await expect(option("Any connected")).toHaveAttribute("aria-checked", "true");
	await expect(menu.getByRole("menuitemradio", { name: /^Build box/ })).toHaveCount(0);
	await page.keyboard.press("Escape");
	let after = await (await page.request.get(`${ORIGIN}/api/connector/machines`)).json() as {
		machines: Array<{ label: string; favorite: boolean }>;
	};
	expect(after.machines.map(value => [value.label, value.favorite])).toEqual([["Laptop", false]]);
});

test("teammates' shared machines are sorted with the person's own, newest paired first in Local and Cloud, in the Machines menu, the Machines table and the document's menu", async ({ browser }) => {
	test.setTimeout(240_000);
	let room = await remoteServer();
	let owner = await open(browser, "casey", room, DESKTOP);
	let page = await open(browser, "drew", room, DESKTOP);
	// Paired in this order, oldest first: neither person's machines are all older than the other's.
	await machine(page, "Laptop", true);
	await machine(owner, "Studio", true);
	await machine(page, "Desk", true);
	await machine(owner, "Build box", true, { service: true });
	await machine(page, "Rack", true, { service: true });
	await machine(owner, "Edge", true, { service: true });
	for (let label of ["Studio", "Build box", "Edge"]) await share(owner, label);
	let live = { timeout: 15_000 };
	await page.reload();
	await ready(page);
	let entry = machinesEntry(page);
	await expect(entry).toContainText("6/6", live);

	// Local and Cloud each list the newest first, a teammate's among the person's own.
	await entry.click();
	let menu = page.getByRole("menu");
	await expect(menu.getByRole("menuitemradio")).toHaveText(
		[/^Any connected/, /^Desk/, /^Studio/, /^Laptop/, /^Edge/, /^Rack/, /^Build box/],
		live,
	);
	await expect(menu.getByText(/Shared (by|with)/)).toHaveCount(0);
	await shoot(page, "machines-menu-order");
	await page.keyboard.press("Escape");

	await page.goto(`${ORIGIN}/machines`);
	let table = machinesTable(page);
	await expect(page.getByText("6 machines", { exact: true })).toBeVisible();
	await expect(table.getByRole("row")).toHaveText(
		[/^Machine/, /^Local/, /^Desk/, /^Studio/, /^Laptop/, /^Cloud/, /^Edge/, /^Rack/, /^Build box/],
		live,
	);
	await shoot(page, "machines-table-order");

	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	let runs = await runOn(page);
	await expect(runs.getByRole("group", { name: "Local" }).getByRole("menuitemradio")).toHaveText(
		[/^Desk/, /^Studio/, /^Laptop/],
		live,
	);
	await expect(runs.getByRole("group", { name: "Cloud" }).getByRole("menuitemradio")).toHaveText(
		[/^Edge/, /^Rack/, /^Build box/],
		live,
	);
	await shoot(page, "machine-button-menu-order");
});

test("with no machine of their own, a person still opens the Machines menu to a teammate's shared machine, which names its owner only beside a machine of the same name", async ({ browser }) => {
	test.setTimeout(180_000);
	let room = await remoteServer();
	let owner = await open(browser, "casey", room, DESKTOP);
	await machine(owner, "Desk", true);
	await share(owner, "Desk");
	let page = await open(browser, "tessa", room, DESKTOP);
	let entry = machinesEntry(page);
	let live = { timeout: 15_000 };

	// Not a link to the page: the entry opens the menu, with the shared machine in it.
	await expect(entry).toHaveAccessibleName("Machines, 1 connected", live);
	await expect(entry).toContainText("1/1");
	await entry.click();
	let menu = page.getByRole("menu");
	await expect(menu.getByRole("menuitemradio", { name: /^Desk/ })).toContainText("Connected");
	await expect(menu.getByRole("menuitem", { name: "Manage machines" })).toBeVisible();
	await page.keyboard.press("Escape");

	// Her document's machine button is there for the same reason, and its menu lists it plainly.
	let runs = await runOn(page);
	await expect(
		runs.getByRole("group", { name: "Local" }).getByRole("menuitemradio", {
			name: /^Desk/,
		}),
	).toHaveCount(1);
	// The machine rows do not name its owner; the note above them may, as it names a login.
	await expect(runs.getByRole("menuitemradio").getByText("casey")).toHaveCount(0);
	await page.keyboard.press("Escape");

	// A machine of her own with the same name: the teammate's says whose it is, hers does not.
	await machine(page, "Desk", true);
	await page.reload();
	await ready(page);
	await expect(entry).toHaveAccessibleName("Machines, 2 connected", live);
	await entry.click();
	await expect(menu.getByRole("menuitemradio", { name: /^Desk casey/ })).toHaveCount(1);
	await expect(menu.getByRole("menuitemradio", { name: /^Desk Connected/ })).toHaveCount(1);
	await shoot(page, "machines-menu-same-name");
	await page.keyboard.press("Escape");
	runs = await runOn(page);
	await expect(runs.getByRole("menuitemradio", { name: /^Desk casey/ })).toHaveCount(1);
	await expect(runs.getByRole("menuitemradio", { name: /^Desk Connected/ })).toHaveCount(1);
});
