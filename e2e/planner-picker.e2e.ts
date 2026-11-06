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
	expectSaidOnce,
	heard,
	listenForAnnouncements,
	machineButton,
	NONE,
	strip,
} from "./planner-status";
import { createChannel, registerTestDatabase, seedChannel } from "./database";
import { authenticate, content, expect, ready, roomPath, test } from "./room";
import { RELEASE } from "./release";
import { HOST, ROOT } from "./servers";

import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";

import type { Browser, Page } from "@playwright/test";

const PORT = 8794;
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = "chopin_planner_picker";
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

	let status = machineButton(page);
	await expect(status).toHaveAccessibleName("Runs on desk. No machine is connected.");
	await expect(status).toHaveAttribute("data-planner", "none");
	// The same bare icon as a button with no machine: no dot, so no green beside the words.
	await expect(status.locator(".machine-glyph-dot")).toHaveCount(0);
	await expect(status.locator("[data-state]")).toHaveCount(0);
	await expect(announced(page)).toHaveText(NONE);
	await shoot(page, "planner-none-button-desktop");

	// Its menu says so at the top, while each machine's own row still tells that machine's state.
	menu = await runOn(page);
	await expect(menu.getByRole("group", { name: "Connection", exact: true })).toHaveText(NONE);
	await expect(menu.getByRole("menuitemradio", { name: /^desk/ })).toContainText("Connected");
	await page.keyboard.press("Escape");

	// On a phone the button in the top bar is the same bare icon.
	let handset = await open(browser, "mona", room, PHONE);
	await handset.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
	let phoneButton = handset.locator(".phone-top-bar").getByRole("button", { name: /^Runs on/ });
	await expect(phoneButton).toHaveAccessibleName("Runs on desk. No machine is connected.");
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
	let status = machineButton(page);
	await expect(status).toHaveAccessibleName("Runs on studio. Connecting to studio");
	await expect(status).toHaveAttribute("data-planner", "starting");
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
	await expect(status).toHaveAccessibleName("Runs on desk. Connecting to desk");
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
	await expect(machineButton(page)).toHaveAccessibleName(
		"Runs on studio. Connecting to studio",
	);

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

test("a Planner its machine keeps failing to start says why on its machine button, warns at the composer, tells a person with no button everything there, and is announced once, until it attaches", async ({ browser }) => {
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
	await expect(button).toHaveAccessibleName("Runs on studio. Connecting to studio");
	await expect(machineButton(teammate)).toHaveCount(0);
	expect((await studio.poll([])).planners).toHaveLength(1);
	// Starting, with the button: it carries the state, the composer is left alone, and a screen
	// reader is told once. Without it: the strip says so, whatever is being typed, and says nothing
	// of its own aloud.
	await expect(strip(page)).toHaveCount(0);
	// The first sentence may still name the owner's login if the machine list had not loaded yet; it
	// is not said again once the machine's name arrives.
	await expect(announced(page)).toHaveText(/^Connecting to (studio|@mona's machine)$/);
	await expect(strip(teammate)).toHaveText("Connecting to @mona's machine");
	await expect(strip(teammate)).not.toHaveAttribute("role");
	await shoot(teammate, "planner-starting-teammate-desktop", teammate.locator(".chat-composer"));

	// One launch that exited is a transient failure: still just starting.
	expect((await studio.reportFailure(refused(room, 1))).status).toBe(200);
	await expect(button).toHaveAccessibleName("Runs on studio. Connecting to studio");
	await expect(strip(page)).toHaveCount(0);

	// The second in a row says why, to the machine's owner and to the teammate.
	expect((await studio.reportFailure(refused(room, 2))).status).toBe(200);
	await expect(button).toHaveAccessibleName("Runs on studio. Can't connect to studio.");
	await expect(button).toHaveAttribute("data-planner", "failing");
	await expect(button.locator(".machine-glyph-dot")).toHaveAttribute("data-planner", "failing");
	await expect(button).toHaveAccessibleDescription(/unsafe-checkout: ~\/src\/score/);
	await expect(button).toHaveAccessibleDescription(/Tried 2 times, last at .+\. Still trying\./);
	// The composer's top edge warns, for anyone: the words and where to fix it. With the button the
	// reason is for a screen reader there, and in full on the button's menu.
	let warning = strip(page);
	await expect(warning).toHaveText(/^Can't connect to studio\./);
	await expect(warning).not.toHaveAttribute("role");
	await expect(warning.getByRole("link", { name: "How to fix" })).toHaveAttribute(
		"href",
		/docs\/chopin-cli\.md#cant-connect-to-a-machine$/,
	);
	await expect(warning.locator(".sr-only .composer-notice-line")).toHaveText([
		REASON,
		/^Tried 2 times, last at .+\. Still trying\.$/,
	]);
	// Without it the reason is drawn, in full and as given, with what has been tried.
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

	// The machine button opens onto the whole story, above the machines, with the same link.
	await button.click();
	let menu = page.getByRole("menu", { name: "Runs on", exact: true });
	let note = menu.getByRole("group", { name: "Connection", exact: true });
	await expect(note).toContainText("Can't connect to studio");
	await expect(note).toContainText("unsafe-checkout: ~/src/score");
	await expect(note).toContainText("Tried 2 times, last at");
	await expect(note).toContainText("Still trying.");
	await expect(note.getByRole("menuitem", { name: "How to fix" })).toBeVisible();
	await shoot(page, "planner-failing-menu-desktop");
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
	await expect(button).toBeFocused();

	// More failures update the count and say nothing more aloud; @chopin sent meanwhile is told
	// why, in the machine's own words, not to try in a moment.
	await studio.reportFailure(refused(room, 3));
	await expect(button).toHaveAccessibleDescription(/Tried 3 times/);
	await expect(seen.locator(".composer-notice-line").last()).toContainText("Tried 3 times");
	let input = chatInput(teammate);
	await fillChat(input, "@chopin outline the plan");
	await input.press("Enter");
	await expect(teammate.getByText(/Can't connect to @mona's machine: unsafe-checkout/))
		.toBeVisible({ timeout: 45_000 });

	// It attaches at last, and nothing about the failure is left, quietly: no word, no mark.
	let link = await studio.backend(room);
	await expectHealthy(button);
	await expect(strip(page)).toHaveCount(0);
	await expect(announced(page)).toHaveText("");
	// The teammate's refused @chopin message keeps its own error notice; the warning is what goes.
	await expect(teammate.locator(".chat-composer .composer-notice[data-warning]")).toHaveCount(0);
	await expect(strip(teammate)).toHaveAttribute("data-error", "true");
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

test("on a phone, a Planner its machine keeps failing to start says why at the composer and on the machine button, and in full for a person with no button", async ({ browser }) => {
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
	await expect(button).toHaveAccessibleName("Runs on studio. Connecting to studio");
	await expect(button).toBeInViewport();
	await expect(strip(page)).toHaveCount(0);
	await shoot(page, "planner-starting-phone");
	await expect(strip(teammate)).toHaveText("Connecting to @mona's machine");
	await expect(() => expectInsideViewport(strip(teammate))).toPass();
	await shoot(teammate, "planner-starting-teammate-phone");

	await studio.reportFailure(refused(room, 2));
	await expect(button).toHaveAttribute("data-planner", "failing");
	await expect(strip(page)).toContainText("Can't connect to studio.");
	await expect(strip(page)).toBeInViewport();
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

	// Tapping the button opens its sheet, which tells the whole story above the machines.
	await button.tap();
	let note = page.getByRole("group", { name: "Connection", exact: true });
	await expect(note).toContainText("unsafe-checkout: ~/src/score");
	await expect(note).toBeInViewport();
	await expect(note.getByRole("menuitem", { name: "How to fix" })).toBeVisible();
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
	await expect(machineButton(editor)).toHaveAccessibleName(
		"Runs on Build box. Connecting to Build box",
	);
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
