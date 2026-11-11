/**
 * The Chat composer's model and reasoning control, under `HARNESS=remote`: the models come from
 * the client attached to the document, so this file starts a server of its own against a database
 * of its own and attaches a scripted client over the real agent connection.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { SQL } from "bun";

import { connectAgent } from "../packages/agent-link/src/client";
import { finishTurn } from "../apps/server/src/testing/agent-link";
import { connectionBanner } from "./banner";
import { chatInput, fillChat } from "./chat-input";
import { createChannel, registerTestDatabase } from "./database";
import { NONE, strip } from "./planner-status";
import { e2eDatabaseName, e2ePort } from "./ports";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { authenticate, content, expect, ready, roomPath, test } from "./room";
import { HOST, ROOT } from "./servers";

import type { Browser, Locator, Page, WebSocketRoute } from "@playwright/test";
import type { CapabilityCatalog } from "../packages/agent-link/src/protocol";

const PORT = e2ePort(8799);
const ORIGIN = `http://${HOST}:${PORT}`;
const DATABASE = e2eDatabaseName("chopin_model_picker");
const HANDLE = "mona";
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = {
	hasTouch: true,
	isMobile: true,
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
};
/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

const LARGE = {
	id: "acme/large",
	name: "Large",
	provider: { id: "acme", name: "Acme" },
	description: "Slower and more careful.",
	thinkingLevels: ["off", "low", "high", "xhigh"],
};
const SMALL = {
	id: "acme/small",
	name: "Small",
	provider: { id: "acme", name: "Acme" },
	description: "Fast for short questions.",
};
const DEEP = {
	id: "beta/deep",
	name: "Deep",
	provider: { id: "beta", name: "Beta" },
	description: "Reads the whole repository first.",
	thinkingLevels: ["low", "medium", "high"],
};
const CATALOG: CapabilityCatalog = {
	models: { available: [LARGE, SMALL, DEEP], default: { id: "acme/small" } },
};
/** What the banner says of a machine that went after it had answered a turn: its work is kept. */
const HELD = /^@mona's machine stepped away\. Your work is kept until \d{1,2}:\d{2}[^.]*\.$/;
const WITHOUT_LARGE: CapabilityCatalog = {
	models: { available: [SMALL, DEEP], default: { id: "acme/small" } },
};

function databaseUrls() {
	let cluster = new URL(
		process.env.E2E_DATABASE_URL_3
			|| "postgresql://chopin:chopin@127.0.0.1:5436/chopin?sslmode=disable",
	);
	let own = new URL(cluster);
	own.pathname = `/${DATABASE}`;
	return { cluster: cluster.href, own: own.href };
}

/**
 * Makes the server's read of the documents' stored model choices fail, or work again, by renaming
 * their table in this file's own database.
 */
async function choicesReadable(readable: boolean) {
	let db = new SQL(databaseUrls().own);
	try {
		await db.unsafe(
			readable
				? "ALTER TABLE planner_model_choices_hidden RENAME TO planner_model_choices"
				: "ALTER TABLE planner_model_choices RENAME TO planner_model_choices_hidden",
		);
	} finally {
		await db.close();
	}
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

let server: ReturnType<typeof spawn> | undefined;

// One server and database for the file; each test makes a document of its own.
test.describe.configure({ mode: "default" });

test.beforeAll(async () => {
	let { cluster, own } = databaseUrls();
	let admin = new SQL(cluster);
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
		await admin.unsafe(`CREATE DATABASE ${DATABASE}`);
	} finally {
		await admin.close();
	}
	let migrated = Bun.spawn(["bun", "apps/server/src/storage/migrate.ts"], {
		cwd: ROOT,
		env: { ...process.env, ...ENV, DATABASE_URL: own },
		stdout: "ignore",
		stderr: "pipe",
	});
	if (await migrated.exited !== 0) {
		throw new Error(
			`migration failed: ${(await new Response(migrated.stderr).text()).slice(-800)}`,
		);
	}
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
			DATABASE_URL: own,
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
	server = child;
	for (let index = 0; index < 150; index++) {
		if (child.exitCode !== null) {
			throw new Error(`model picker server exited with ${child.exitCode}: ${errors.slice(-800)}`);
		}
		try {
			if ((await fetch(`${ORIGIN}/api/session`)).ok) break;
		} catch { /* Not bound yet. */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	registerTestDatabase(PORT, own);
});

test.afterAll(async () => {
	let child = server;
	server = undefined;
	if (!child || child.exitCode !== null || child.pid === undefined) return;
	let exit = new Promise<void>(resolve => child.once("close", () => resolve()));
	process.kill(-child.pid, "SIGTERM");
	await exit;
});

/** What the attached scripted client was asked to run, turn by turn. */
type Asked = { model?: string; thinkingLevel?: string; prompt: string };

/** The turn that answered `text`: a background job's turn for the same document comes between. */
function turnFor(asked: Asked[], text: string): Asked {
	let found = asked.findLast(turn =>
		turn.prompt.includes(text) && !turn.prompt.startsWith("[Background")
	);
	if (!found) throw new Error(`no turn answered ${text}`);
	return found;
}

/**
 * Makes the next link this process opens drop the first `capabilities` frame it sends, so the
 * client asks for the catalog and never reports one. The link is made synchronously by
 * `connectAgent`, so the global is put back before anything else can open a socket.
 */
function dropFirstReport(): () => void {
	let Original = globalThis.WebSocket;
	let dropped = false;
	globalThis.WebSocket = class extends Original {
		override send(data: Parameters<WebSocket["send"]>[0]) {
			if (!dropped && typeof data === "string" && JSON.parse(data).type === "capabilities") {
				dropped = true;
				return;
			}
			super.send(data);
		}
	} as typeof WebSocket;
	return () => {
		globalThis.WebSocket = Original;
	};
}

/**
 * `silent` is a client that offers `capability-catalog` and never reports its models, until its
 * own `client.report`, as a client that is slow or has none ready.
 */
async function attachClient(
	room: string,
	capabilities?: CapabilityCatalog,
	options: { silent?: boolean } = {},
) {
	let asked: Asked[] = [];
	let restore = options.silent ? dropFirstReport() : undefined;
	let connecting = connectAgent({
		url: ORIGIN,
		token: `ghu_e2e_${HANDLE}_1`,
		document: room,
		resumable: false,
		...(capabilities ? { capabilities } : {}),
		handlers: {
			async turn(context) {
				asked.push({
					prompt: context.message.prompt,
					...(context.message.model ? { model: context.message.model } : {}),
					...(context.message.thinkingLevel
						? { thinkingLevel: context.message.thinkingLevel }
						: {}),
				});
				context.emit({ type: "stream-start", modelId: "scripted" });
				context.emit({ type: "text-start", id: "reply" });
				context.emit({ type: "text-delta", id: "reply", delta: "Done." });
				context.emit({ type: "text-end", id: "reply" });
				finishTurn(context);
			},
		},
	});
	restore?.();
	let client = await connecting;
	return { client, asked };
}

/** What the pages threw, so a control that crashes is told as a crash and not as a missing element. */
let thrown: string[] = [];
test.afterEach(() => {
	let errors = thrown.splice(0);
	expect(errors).toEqual([]);
});

async function open(browser: Browser, handle: string, room: string, options: object) {
	let context = await browser.newContext(options);
	let page = await context.newPage();
	page.on("pageerror", error => thrown.push(error.message));
	await authenticate(page, handle, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	return page;
}

/**
 * A page whose room socket the test can cut and give back, as a network that fails and returns
 * does: while it is cut, every socket the page opens is closed at once.
 */
async function openCuttable(browser: Browser, handle: string, room: string, options: object) {
	let context = await browser.newContext(options);
	let page = await context.newPage();
	page.on("pageerror", error => thrown.push(error.message));
	let away = false;
	let sockets: WebSocketRoute[] = [];
	await page.routeWebSocket("**/ws?**", socket => {
		if (away) return void socket.close();
		let upstream = socket.connectToServer();
		socket.onMessage(message => upstream.send(message));
		upstream.onMessage(message => socket.send(message));
		sockets.push(socket);
	});
	await authenticate(page, handle, ORIGIN);
	await page.goto(`${ORIGIN}${roomPath(room)}`);
	await ready(page);
	return {
		page,
		cut: async () => {
			away = true;
			await sockets.at(-1)!.close();
		},
		restore: async () => {
			away = false;
			await page.evaluate(() => dispatchEvent(new Event("online")));
		},
	};
}

async function newRoom() {
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	return room;
}

function chat(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

/**
 * The composer's own notice about the model, a notice and not a banner: `strip` finds the
 * connection banner that can be drawn above it, and the two are different causes.
 */
function notice(page: Page) {
	return page.locator(".chat-composer .composer-notice:not([data-banner])");
}

/** The pill in the composer's toolbar: named for the model that will run and its level. */
function trigger(page: Page) {
	return chat(page).getByRole("button", { name: /^Model: / });
}

function popover(page: Page) {
	return page.getByRole("dialog", { name: "Model and reasoning", exact: true });
}

function search(page: Page) {
	return popover(page).getByRole("combobox", { name: "Search models", exact: true });
}

function option(page: Page, name: string) {
	return popover(page).getByRole("option", { name: new RegExp(`^${name}\\b`) });
}

/** The element's check, which only the chosen model's row draws. */
function checked(page: Page, name: string) {
	return option(page, name).locator("span.absolute");
}

function levels(page: Page) {
	return popover(page).getByRole("radiogroup", { name: "Thinking", exact: true });
}

function level(page: Page, name: string) {
	return levels(page).getByRole("radio", { name, exact: true });
}

/**
 * Waits for the popover's entrance, which scales it in from `--dropdown-pre-scale`, to end. A read
 * of its geometry before that sees the drawn box a few percent short (a 36px row as 34.92px).
 */
async function settled(menu: Locator) {
	await menu.evaluate(element =>
		Promise.all(element.getAnimations().map(animation => animation.finished))
	);
}

async function openPicker(page: Page) {
	await trigger(page).click();
	await expect(popover(page)).toBeVisible();
	await expect(search(page)).toBeFocused();
}

/** The pill's name: the first thing in it, which gives way to an ellipsis. */
function name(model: Locator) {
	return model.locator("span").first();
}

/** Say `text` to Chopin and wait until it has been answered. */
async function ask(page: Page, text: string, answers: number) {
	let input = chatInput(chat(page));
	await fillChat(input, `@chopin ${text}`);
	await input.press("Enter");
	await expect(chat(page).getByText("Done.")).toHaveCount(answers, { timeout: 20_000 });
}

async function shoot(page: Page | Locator, name: string) {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	await new Promise(resolve => setTimeout(resolve, 400));
	await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function expectAccessible(page: Page) {
	let result = await new AxeBuilder({ page }).include('[data-slot="model-selector-content"]')
		.analyze();
	expect(result.violations.map(violation => `${violation.id}: ${violation.help}`)).toEqual([]);
}

test("offers a choice only while the attached client reports models", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	// Nobody is attached: there is no catalog, so nothing is offered that nobody could honor.
	await expect(chatInput(chat(page))).toBeVisible();
	await expect(strip(page)).toHaveText(NONE);
	await expect(trigger(page)).toHaveCount(0);

	// A client from before the catalog reports nothing, so the composer hides the control.
	let older = await attachClient(room);
	await expect(strip(page)).toHaveCount(0);
	await expect(trigger(page)).toHaveCount(0);
	await older.client.detach();

	let { client } = await attachClient(room, CATALOG);
	await expect(trigger(page)).toHaveAccessibleName("Model: Small");
	await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
	await expect(trigger(page)).toContainText("Small");

	// The client withdraws its models, then offers them again: the control follows it live.
	client.report({});
	await expect(trigger(page)).toHaveCount(0);
	client.report(CATALOG);
	await expect(trigger(page)).toHaveAccessibleName("Model: Small");
	client.report({ commands: [{ name: "notes", kind: "skill" }] });
	await expect(trigger(page)).toHaveCount(0);
	client.report(CATALOG);
	await expect(trigger(page)).toBeVisible();

	// Somebody who can only read the document is offered no choice.
	let readerContext = await browser.newContext(DESKTOP);
	let reader = await readerContext.newPage();
	await authenticate(reader, `score-reader-${room.slice(0, 8)}`, ORIGIN);
	await reader.goto(`${ORIGIN}${roomPath(room)}`);
	await expect(content(reader)).toHaveAttribute("contenteditable", "false");
	await expect(trigger(reader)).toHaveCount(0);
	await client.detach();
	await expect(trigger(page)).toHaveCount(0);
});

test("lists models by provider, filters them, and chooses with the mouse, reasoning following the model", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let { client, asked } = await attachClient(room, CATALOG);
	await expect(trigger(page)).toBeVisible();
	await shoot(chat(page), "model-picker-closed-desktop");

	await openPicker(page);
	await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
	let list = popover(page).getByRole("listbox");
	await expect(list.getByRole("group", { name: "Acme" }).getByRole("option")).toHaveCount(2);
	await expect(list.getByRole("group", { name: "Beta" }).getByRole("option")).toHaveCount(1);
	await expect(list.getByRole("option")).toHaveText([
		/^Large\s*Slower and more careful\.$/,
		/^Small\s*Default\. Fast for short questions\.$/,
		/^Deep\s*Reads the whole repository first\.$/,
	]);
	// The model that will run has the element's check; no other does.
	await expect(checked(page, "Small")).toHaveCount(1);
	await expect(checked(page, "Large")).toHaveCount(0);
	// Small has no reasoning levels, so the control is not drawn.
	await expect(levels(page)).toHaveCount(0);
	await shoot(page, "model-picker-open-desktop");
	await expectAccessible(page);

	// Search narrows the list by name, id, provider or description, and says when nothing is left.
	await search(page).fill("careful");
	await expect(list.getByRole("option")).toHaveCount(1);
	await search(page).fill("beta");
	await expect(list.getByRole("option")).toHaveText([/^Deep/]);
	await search(page).fill("zzz");
	await expect(list.getByRole("option")).toHaveCount(0);
	await expect(popover(page).getByText("No matching models.", { exact: true })).toBeVisible();
	await search(page).fill("");

	// Choosing closes the popover, returns to the trigger and names the model.
	await option(page, "Large").click();
	await expect(popover(page)).toHaveCount(0);
	await expect(trigger(page)).toHaveAccessibleName("Model: Large");
	await expect(trigger(page)).toBeFocused();

	// A model with levels offers them, after the model's own. A level is a setting: it stays open.
	await openPicker(page);
	await expect(levels(page).getByRole("radio")).toHaveText([
		"Default",
		"off",
		"low",
		"high",
		"xhigh",
	]);
	await expect(level(page, "Default")).toHaveAttribute("aria-checked", "true");
	await level(page, "high").click();
	await expect(level(page, "high")).toHaveAttribute("aria-checked", "true");
	await expect(popover(page)).toBeVisible();
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await expect(trigger(page)).toContainText("high");
	await shoot(page, "model-picker-reasoning-desktop");
	// Escape closes it from the level just chosen, and the trigger has the focus again.
	await expect(level(page, "high")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(popover(page)).toHaveCount(0);
	await expect(trigger(page)).toBeFocused();
	await openPicker(page);

	// Another model that offers the level keeps it; one that does not drops it, and hides the control.
	await option(page, "Deep").click();
	await expect(trigger(page)).toHaveAccessibleName("Model: Deep, reasoning high");
	await openPicker(page);
	await expect(levels(page).getByRole("radio")).toHaveText(["Default", "low", "medium", "high"]);
	await option(page, "Small").click();
	await expect(trigger(page)).toHaveAccessibleName("Model: Small");
	await openPicker(page);
	await expect(levels(page)).toHaveCount(0);
	await page.keyboard.press("Escape");

	// The next turn, and only it, carries the choice the room holds: Small, chosen by name though it
	// is the client's default, so the document keeps it if the client's default changes.
	await ask(page, "first", 1);
	expect(turnFor(asked, "first").model).toBe("acme/small");
	expect(turnFor(asked, "first").thinkingLevel).toBeUndefined();
	await openPicker(page);
	await option(page, "Large").click();
	await openPicker(page);
	await level(page, "low").click();
	await page.keyboard.press("Escape");
	await ask(page, "second", 2);
	expect(turnFor(asked, "second")).toMatchObject({ model: "acme/large", thinkingLevel: "low" });
	await client.detach();
});

test("opens, searches, moves and chooses from the keyboard", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let { client } = await attachClient(room, CATALOG);
	await expect(trigger(page)).toBeVisible();

	// Enter opens it with the search field focused and the model that will run highlighted.
	await trigger(page).focus();
	await trigger(page).press("Enter");
	await expect(search(page)).toBeFocused();
	let active = async () =>
		(await popover(page).locator('[cmdk-item][data-selected="true"]').first().innerText())
			.split("\n")[0]!;
	await expect.poll(active).toBe("Small");

	// The arrow keys move the highlighted row, and stop at either end; the field keeps the focus.
	await search(page).press("ArrowDown");
	await expect.poll(active).toBe("Deep");
	await search(page).press("ArrowDown");
	await expect.poll(active).toBe("Deep");
	await search(page).press("ArrowUp");
	await expect.poll(active).toBe("Small");
	await expect(search(page)).toBeFocused();

	// Typing filters, Enter chooses the active row, closes, and focus returns to the trigger.
	await search(page).fill("deep");
	await search(page).press("Enter");
	await expect(popover(page)).toHaveCount(0);
	await expect(trigger(page)).toBeFocused();
	await expect(trigger(page)).toHaveAccessibleName("Model: Deep");

	// Escape closes without choosing, and returns to the trigger.
	await trigger(page).press("Space");
	await expect(search(page)).toBeFocused();
	await search(page).fill("large");
	await search(page).press("Escape");
	await expect(popover(page)).toHaveCount(0);
	await expect(trigger(page)).toBeFocused();
	await expect(trigger(page)).toHaveAccessibleName("Model: Deep");

	// Tab from the search field reaches the checked level, the arrow keys choose the next, and
	// Tab out of the popover closes it.
	await trigger(page).press("Enter");
	await expect(level(page, "Default")).toHaveAttribute("aria-checked", "true");
	await search(page).press("Tab");
	await expect(level(page, "Default")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(level(page, "low")).toHaveAttribute("aria-checked", "true");
	await expect(level(page, "low")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(level(page, "medium")).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowLeft");
	await expect(level(page, "Default")).toHaveAttribute("aria-checked", "true");
	await expect(trigger(page)).toHaveAccessibleName("Model: Deep");
	await page.keyboard.press("ArrowRight");
	await expect(trigger(page)).toHaveAccessibleName("Model: Deep, reasoning low");
	await page.keyboard.press("Tab");
	await expect(popover(page)).toHaveCount(0);

	// A pointer outside the popover closes it and leaves the draft's focus alone.
	await trigger(page).click();
	await expect(popover(page)).toBeVisible();
	// A corner of the draft that the popover does not cover: it opens level with the pill, which the
	// row's other controls (the + and the microphone among them) push along the box, so it may cover
	// the far corner and leave the near one.
	let draft = chatInput(chat(page));
	let corner = (await draft.boundingBox())!;
	let covered = (await popover(page).boundingBox())!;
	let near = covered.x > corner.x + 12;
	await draft.click({ position: { x: near ? 6 : corner.width - 6, y: 6 } });
	await expect(popover(page)).toHaveCount(0);
	await expect(draft).toBeFocused();
	await client.detach();
});

test("leaves the popover from the level an arrow key chose, even when Tab follows at once", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	// A busy page runs animation frames late. Here they come a second late, so whatever waits for
	// the next frame has not happened when the next key arrives.
	await page.addInitScript(() => {
		let frame = window.requestAnimationFrame.bind(window);
		window.requestAnimationFrame = callback =>
			frame(() => setTimeout(() => callback(performance.now()), 1_000));
	});
	await page.reload();
	await ready(page);
	let { client } = await attachClient(room, CATALOG);
	await trigger(page).press("Enter");
	await search(page).fill("deep");
	await search(page).press("Enter");
	await expect(trigger(page)).toHaveAccessibleName("Model: Deep");
	await trigger(page).press("Enter");
	await expect(search(page)).toBeFocused();
	await search(page).press("Tab");
	await expect(level(page, "Default")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(trigger(page)).toHaveAccessibleName("Model: Deep, reasoning low");
	await page.keyboard.press("Tab");
	await expect(popover(page)).toHaveCount(0);
	await client.detach();
});

test("lists a catalog that repeats a model or a level as the client reported it", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	// Valid on the wire, so kept as written: a model listed three times, a level listed twice and one
	// named `default`, a provider whose id has a space and another whose id is what no provider is called.
	let { client, asked } = await attachClient(room, {
		models: {
			available: [
				{
					id: "echo/one",
					name: "Echo one",
					provider: { id: "the echo lab", name: "Echo Lab" },
					thinkingLevels: ["high", "off", "high", "default"],
				},
				{ id: "none/two", name: "Two", provider: { id: "none", name: "None" } },
				{ id: "echo/one", name: "Echo again", provider: { id: "the echo lab", name: "Echo Lab" } },
				{ id: "echo/one", name: "Echo third" },
			],
			default: { id: "echo/one" },
		},
	});
	await expect(trigger(page)).toHaveAccessibleName("Model: Echo one");
	await openPicker(page);

	// Every entry is listed in the order given, and only the first of an id is the model that runs.
	let rows = popover(page).getByRole("option");
	await expect(rows).toHaveCount(4);
	await expect(rows).toHaveText([
		/^Echo one\s*Default\.$/,
		/^Echo again\s*Default\.$/,
		/^Two$/,
		/^Echo third\s*Default\.$/,
	]);
	await expect(popover(page).getByRole("option").locator("span.absolute")).toHaveCount(1);
	await expect(rows.first().locator("span.absolute")).toHaveCount(1);
	// Each group is named by its own heading, whatever its provider's id is made of.
	await expect(popover(page).getByRole("group", { name: "Echo Lab" })).toHaveCount(1);
	await expect(popover(page).getByRole("group", { name: "None" })).toHaveCount(1);
	await expect(popover(page).getByRole("group", { name: "Other" })).toHaveCount(1);

	// The model's own level, then every level as listed; only the first of a repeated level is the
	// one chosen. A level named `default` would be taken for the first step, which is called Model
	// default instead.
	let radios = levels(page).getByRole("radio");
	await expect(radios).toHaveText(["Model default", "high", "off", "high", "default"]);
	await expect(levels(page).locator('[aria-checked="true"]')).toHaveText(["Model default"]);
	await radios.nth(3).click();
	await expect(trigger(page)).toHaveAccessibleName("Model: Echo one, reasoning high");
	await expect(levels(page).locator('[aria-checked="true"]')).toHaveCount(1);
	await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
	// A level named `default` is a level the client asked for, not the model's own.
	await radios.nth(4).click();
	await expect(trigger(page)).toHaveAccessibleName("Model: Echo one, reasoning default");
	await expect(levels(page).locator('[aria-checked="true"]')).toHaveCount(1);
	await expect(radios.nth(4)).toHaveAttribute("aria-checked", "true");
	await expectAccessible(page);
	await page.keyboard.press("Escape");
	await ask(page, "default level", 1);
	expect(turnFor(asked, "default level")).toMatchObject({ thinkingLevel: "default" });
	await client.detach();
});

test("shows each level exactly as reported, so levels that read alike stay two, and sends exactly the one chosen", async ({ browser }) => {
	test.setTimeout(180_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	// Distinct strings a client may list side by side: Atomic's `xhigh` and a spelling in words, a
	// word and its capitalised copy, and a letter whose capital is two letters.
	let reported = ["xhigh", "extra high", "high", "High", "\u00df-fast", "SS-fast"];
	let { client, asked } = await attachClient(room, {
		models: {
			available: [{ id: "acme/odd", name: "Odd", thinkingLevels: reported }],
			default: { id: "acme/odd" },
		},
	});
	await expect(trigger(page)).toHaveAccessibleName("Model: Odd");
	await openPicker(page);

	// Every level is offered as written, in the order given, and no two are read or named alike.
	let radios = levels(page).getByRole("radio");
	await expect(radios).toHaveText(["Default", ...reported]);
	for (let [position, label] of reported.entries()) {
		await expect(radios.nth(position + 1)).toHaveAccessibleName(label);
	}
	expect(new Set(reported).size).toBe(reported.length);
	await expectAccessible(page);
	await shoot(page, "model-picker-levels-alike-desktop");
	await page.keyboard.press("Escape");

	// Each pick is the string that was listed: the trigger says it, one radio is checked, and the
	// next turn carries it.
	for (let [position, level] of reported.entries()) {
		await openPicker(page);
		await radios.nth(position + 1).click();
		await expect(trigger(page)).toHaveAccessibleName(`Model: Odd, reasoning ${level}`);
		await expect(levels(page).locator('[aria-checked="true"]')).toHaveCount(1);
		await expect(radios.nth(position + 1)).toHaveAttribute("aria-checked", "true");
		await page.keyboard.press("Escape");
		let word = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"][position]!;
		await ask(page, `level ${word}`, position + 1);
		// No model was chosen, so the client's own runs, at exactly the level that was.
		expect(turnFor(asked, `level ${word}`).thinkingLevel).toBe(level);
		expect(turnFor(asked, `level ${word}`).model).toBeUndefined();
	}

	// The last of them, `SS-fast`, is the one still chosen after a reload; `ß-fast` is not.
	await page.reload();
	await ready(page);
	await expect(trigger(page)).toHaveAccessibleName("Model: Odd, reasoning SS-fast");
	await openPicker(page);
	await expect(radios.nth(6)).toHaveAttribute("aria-checked", "true");
	await expect(radios.nth(5)).toHaveAttribute("aria-checked", "false");
	await client.detach();
});

test("tells a level named Default from the model's own default, by sight and by name, and sends each exactly", async ({ browser }) => {
	test.setTimeout(180_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let { client, asked } = await attachClient(room, {
		models: {
			available: [
				{ id: "acme/plain", name: "Plain", thinkingLevels: ["low", "high"] },
				{
					id: "acme/odd",
					name: "Odd",
					thinkingLevels: ["Default", "default", "high", "High"],
				},
			],
			default: { id: "acme/plain" },
		},
	});
	await expect(trigger(page)).toHaveAccessibleName("Model: Plain");
	await openPicker(page);
	// A model with no level that reads like it keeps the name the first step always had.
	await expect(levels(page).getByRole("radio")).toHaveText(["Default", "low", "high"]);
	await option(page, "Odd").click();
	await openPicker(page);

	// Odd lists levels named Default and default, and high beside High. The reset is called Model
	// default so that no radio shares its name; every level is the string the client reported.
	let radios = levels(page).getByRole("radio");
	await expect(radios).toHaveText(["Model default", "Default", "default", "high", "High"]);
	for (let name of ["Model default", "Default", "default", "high", "High"]) {
		await expect(level(page, name)).toHaveCount(1);
	}
	await expect(level(page, "Model default")).toHaveAttribute("aria-checked", "true");
	await expectAccessible(page);
	await shoot(page, "model-picker-level-named-default-desktop");
	await page.keyboard.press("Escape");

	// Each choice asks for exactly what its radio says: the reset for no level, each other for its string.
	let picks: Array<[string, string | undefined, string]> = [
		["Default", "Default", "Model: Odd, reasoning Default"],
		["Model default", undefined, "Model: Odd"],
		["default", "default", "Model: Odd, reasoning default"],
		["High", "High", "Model: Odd, reasoning High"],
		["high", "high", "Model: Odd, reasoning high"],
		["Model default", undefined, "Model: Odd"],
	];
	for (let [position, [radio, sent, named]] of picks.entries()) {
		await openPicker(page);
		await level(page, radio).click();
		await expect(trigger(page)).toHaveAccessibleName(named);
		await expect(levels(page).locator('[aria-checked="true"]')).toHaveCount(1);
		await expect(level(page, radio)).toHaveAttribute("aria-checked", "true");
		await page.keyboard.press("Escape");
		let word = ["one", "two", "three", "four", "five", "six"][position]!;
		await ask(page, `pick ${word}`, position + 1);
		let turn = turnFor(asked, `pick ${word}`);
		expect(turn.model).toBe("acme/odd");
		expect(turn.thinkingLevel).toBe(sent);
	}
	await client.detach();
});

test("lists and runs a catalog of any spelling as the client wrote it, skipping a model with no id, and keeps the client attached", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	// Nothing says how a client spells a model or a level, or how long either is.
	let long = `lab/${"l".repeat(300)}`;
	let { client, asked } = await attachClient(room, {
		models: {
			available: [
				{
					id: long,
					name: "Long",
					provider: { id: "lab", name: "Lab" },
					description: "d".repeat(4_001),
					thinkingLevels: ["", "extra high", "\u4f4e", "constructor"],
				},
				// A model with no id cannot be named in a turn: it is skipped and nothing else is.
				{ id: "", name: "Blank", provider: { id: "lab" }, thinkingLevels: ["low"] },
				{ id: "lab/plain", name: "", provider: { id: "lab" }, description: "", thinkingLevels: [] },
			],
			default: { id: "lab/plain" },
		},
	});
	// An empty name reads as the id, and an empty list of levels as no reasoning control.
	await expect(trigger(page)).toHaveAccessibleName("Model: lab/plain");
	await openPicker(page);
	await expect(popover(page).getByRole("option")).toHaveText([
		/^Long\s*d+$/,
		/^lab\/plain\s*Default\.$/,
	]);
	await expect(popover(page).getByRole("option", { name: /Blank/ })).toHaveCount(0);
	await expect(levels(page)).toHaveCount(0);
	await option(page, "Long").click();
	await openPicker(page);
	// An empty level is not one: it is not listed between Default and the others.
	// Each level is as the client wrote it.
	await expect(levels(page).getByRole("radio")).toHaveText([
		"Default",
		"extra high",
		"\u4f4e",
		"constructor",
	]);
	await level(page, "constructor").click();
	await expect(trigger(page)).toHaveAccessibleName("Model: Long, reasoning constructor");
	await level(page, "extra high").click();
	await expect(trigger(page)).toHaveAccessibleName("Model: Long, reasoning extra high");
	await page.keyboard.press("Escape");
	await ask(page, "as spelled", 1);
	expect(turnFor(asked, "as spelled")).toMatchObject({ model: long, thinkingLevel: "extra high" });
	await client.detach();
});

test("lists every model of a catalog as large as two gateways' together, and searches it", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	// 403 and 307 models: what Atomic offers a person with keys for OpenRouter and the Vercel gateway.
	let { client, asked } = await attachClient(room, {
		models: {
			available: Array.from({ length: 710 }, (_, index) => ({
				id: `${index < 403 ? "openrouter" : "gateway"}/model-${index}`,
				name: `Model ${index}`,
				provider: index < 403
					? { id: "openrouter", name: "OpenRouter" }
					: { id: "gateway", name: "AI Gateway" },
			})),
			default: { id: "openrouter/model-0" },
		},
	});
	await expect(trigger(page)).toHaveAccessibleName("Model: Model 0");
	await openPicker(page);
	await expect(popover(page).getByRole("option")).toHaveCount(710);
	await expect(popover(page).locator("[cmdk-group]")).toHaveCount(2);
	await search(page).fill("model 709");
	await expect(popover(page).getByRole("option")).toHaveCount(1);
	await search(page).press("Enter");
	await expect(trigger(page)).toHaveAccessibleName("Model: Model 709");
	await ask(page, "last of them", 1);
	expect(turnFor(asked, "last of them").model).toBe("gateway/model-709");
	await client.detach();
});

test("keeps the choice across a reload and shows it live to a second person", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let { client, asked } = await attachClient(room, CATALOG);
	await expect(trigger(page)).toBeVisible();
	await openPicker(page);
	await option(page, "Large").click();
	await openPicker(page);
	await level(page, "high").click();
	await page.keyboard.press("Escape");
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");

	await page.reload();
	await ready(page);
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");

	// Another person opening the document sees the document's choice, not a default of their own.
	let teammate = await open(browser, "ana", room, DESKTOP);
	await expect(trigger(teammate)).toHaveAccessibleName("Model: Large, reasoning high");
	await openPicker(teammate);
	await expect(option(teammate, "Large")).toHaveAttribute("aria-selected", "true");
	await expect(level(teammate, "high")).toHaveAttribute("aria-checked", "true");
	await teammate.keyboard.press("Escape");

	// Their change reaches the first person without a reload, and the next turn runs it.
	await openPicker(teammate);
	await option(teammate, "Deep").click();
	await expect(trigger(teammate)).toHaveAccessibleName("Model: Deep, reasoning high");
	await expect(trigger(page)).toHaveAccessibleName("Model: Deep, reasoning high");
	await ask(page, "as the room chose", 1);
	expect(turnFor(asked, "as the room chose")).toMatchObject({
		model: "beta/deep",
		thinkingLevel: "high",
	});

	// Small, the client's default, chosen for everyone.
	await openPicker(page);
	await option(page, "Small").click();
	await openPicker(page);
	await expect(levels(page)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(trigger(teammate)).toHaveAccessibleName("Model: Small");
	await client.detach();
});

test("keeps a model chosen while it was the default when the client's default moves", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let { client, asked } = await attachClient(room, CATALOG);
	await expect(trigger(page)).toHaveAccessibleName("Model: Small");
	await openPicker(page);
	await option(page, "Small").click();
	await expect(trigger(page)).toHaveAccessibleName("Model: Small");

	// The client now runs Large when a turn names none, and still offers Small.
	client.report({ models: { available: [LARGE, SMALL, DEEP], default: { id: "acme/large" } } });
	await openPicker(page);
	await expect(option(page, "Large")).toContainText("Default");
	await expect(option(page, "Small")).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("Escape");
	// The document's choice stands, for a person who opens it now too, with nothing said as lost.
	await expect(trigger(page)).toHaveAccessibleName("Model: Small");
	let teammate = await open(browser, "ana", room, DESKTOP);
	await expect(trigger(teammate)).toHaveAccessibleName("Model: Small");
	await expect(chat(page).getByText("no longer available")).toHaveCount(0);
	await ask(page, "after the default moved", 1);
	expect(turnFor(asked, "after the default moved").model).toBe("acme/small");
	await client.detach();
});

test("falls back to the default with a notice when the chosen model has gone, and restores it when it returns", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let { client, asked } = await attachClient(room, CATALOG);
	await expect(trigger(page)).toBeVisible();
	await openPicker(page);
	await option(page, "Large").click();
	await openPicker(page);
	await level(page, "high").click();
	await page.keyboard.press("Escape");
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await expect(chat(page).getByText("no longer available")).toHaveCount(0);

	// The client no longer offers Large: what will run is the default, and the composer says so.
	client.report(WITHOUT_LARGE);
	// The chosen model keeps the display name the catalog reported.
	let gone = "Large is no longer available, so Chopin used its default model.";
	await expect(trigger(page)).toHaveAccessibleName(`Model: Small, ${gone}`);
	// The tooltip stays short: the composer's notice already says why.
	await expect(trigger(page)).toHaveAttribute("title", "Model: Small");
	await expect(notice(page).filter({ hasText: gone })).toBeVisible();
	await shoot(chat(page), "model-picker-gone-desktop");
	await openPicker(page);
	await expect(option(page, "Large")).toHaveCount(0);
	await expect(option(page, "Small")).toHaveAttribute("aria-selected", "true");
	await expect(popover(page).getByRole("status").filter({ hasText: gone })).toBeVisible();
	await page.keyboard.press("Escape");

	// A turn runs the default, with neither the gone model nor its level, and Chat says so once.
	await ask(page, "while it is gone", 1);
	expect(turnFor(asked, "while it is gone").model).toBeUndefined();
	expect(turnFor(asked, "while it is gone").thinkingLevel).toBeUndefined();
	await ask(page, "and again", 2);
	await expect(chat(page).getByText(gone, { exact: true })).toHaveCount(1);
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	let said = chat(page).locator("[data-entry-author='system'], li, div").filter({ hasText: gone });
	await expect(said.first()).toBeVisible();

	// The model returns: the stored choice is back in force.
	client.report(CATALOG);
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	await ask(page, "restored", 3);
	expect(turnFor(asked, "restored")).toMatchObject({ model: "acme/large", thinkingLevel: "high" });

	// Choosing again replaces what was lost, and a level its model no longer lists falls back alone.
	client.report({
		models: {
			available: [{ ...LARGE, thinkingLevels: ["off", "low"] }, SMALL, DEEP],
			default: { id: "acme/small" },
		},
	});
	let reasoning =
		"high reasoning is no longer available for this model, so Chopin used its default.";
	await expect(trigger(page)).toHaveAccessibleName(`Model: Large, ${reasoning}`);
	await ask(page, "level gone", 4);
	expect(turnFor(asked, "level gone")).toMatchObject({ model: "acme/large" });
	expect(turnFor(asked, "level gone").thinkingLevel).toBeUndefined();
	await client.detach();
});

test("says a saved choice has gone once a turn fell back for a client that offered the catalog and never reported it, and not before", async ({ browser }) => {
	test.setTimeout(180_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let teammate = await open(browser, "ana", room, DESKTOP);
	let readerContext = await browser.newContext(DESKTOP);
	let reader = await readerContext.newPage();
	await authenticate(reader, `score-reader-${room.slice(0, 8)}`, ORIGIN);
	await reader.goto(`${ORIGIN}${roomPath(room)}`);
	await expect(content(reader)).toHaveAttribute("contenteditable", "false");
	let first = await attachClient(room, CATALOG);
	await expect(trigger(page)).toBeVisible();
	await openPicker(page);
	await option(page, "Large").click();
	await openPicker(page);
	await level(page, "high").click();
	await page.keyboard.press("Escape");
	await expect(trigger(teammate)).toHaveAccessibleName("Model: Large, reasoning high");
	let gone = "Large is no longer available, so Chopin used its default model.";

	// Nobody is attached: the choice is neither gone nor honored, and nothing says it has gone.
	await first.client.detach();
	await expect(trigger(page)).toHaveCount(0);
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);

	// A client that offers the catalog and has yet to report is the same: nothing is said yet.
	let silent = await attachClient(room, CATALOG, { silent: true });
	await expect(strip(page).filter({ hasText: NONE })).toHaveCount(0);
	await page.waitForTimeout(500);
	await expect(trigger(page)).toHaveCount(0);
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	await expect(notice(teammate).filter({ hasText: gone })).toHaveCount(0);

	// A turn runs the client's default and Chat records why once, including after a reload.
	// The composer's duplicate notice goes; the reader has no composer notice either.
	await ask(page, "while it never reports", 1);
	expect(turnFor(silent.asked, "while it never reports").model).toBeUndefined();
	expect(turnFor(silent.asked, "while it never reports").thinkingLevel).toBeUndefined();
	await expect(chat(page).getByText(gone, { exact: true })).toHaveCount(1);
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	await expect(notice(teammate).filter({ hasText: gone })).toHaveCount(0);
	await expect(trigger(page)).toHaveCount(0);
	await expect(trigger(reader)).toHaveCount(0);
	await expect(notice(reader).filter({ hasText: "no longer available" })).toHaveCount(0);
	await shoot(chat(page), "model-picker-never-reported-desktop");
	await page.reload();
	await ready(page);
	await expect(chat(page).getByText(gone, { exact: true })).toHaveCount(1);
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);

	// It reports at last: the picker returns with the choice, and the notice goes.
	silent.client.report(CATALOG);
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	await expect(notice(teammate).filter({ hasText: gone })).toHaveCount(0);
	await ask(page, "once it reports", 2);
	expect(turnFor(silent.asked, "once it reports")).toMatchObject({
		model: "acme/large",
		thinkingLevel: "high",
	});

	// The next client that never reports starts over: what an earlier one fell back on is not said
	// of it before a turn has, and nothing is said once it has gone.
	await silent.client.detach();
	let later = await attachClient(room, CATALOG, { silent: true });
	await expect(strip(page).filter({ hasText: NONE })).toHaveCount(0);
	await page.waitForTimeout(500);
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	await ask(page, "while the next never reports", 3);
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	await later.client.detach();
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
});

test("keeps a saved choice's notice until Chat records the fallback when the client withdraws every model or an older client takes its place", async ({ browser }) => {
	test.setTimeout(180_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let teammate = await open(browser, "ana", room, DESKTOP);
	let readerContext = await browser.newContext(DESKTOP);
	let reader = await readerContext.newPage();
	await authenticate(reader, `score-reader-${room.slice(0, 8)}`, ORIGIN);
	await reader.goto(`${ORIGIN}${roomPath(room)}`);
	await expect(content(reader)).toHaveAttribute("contenteditable", "false");
	let { client, asked } = await attachClient(room, CATALOG);
	await expect(trigger(page)).toBeVisible();
	await openPicker(page);
	await option(page, "Large").click();
	await openPicker(page);
	await level(page, "high").click();
	await page.keyboard.press("Escape");
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await expect(trigger(teammate)).toHaveAccessibleName("Model: Large, reasoning high");
	await expect(notice(page).filter({ hasText: "no longer available" })).toHaveCount(0);
	let gone = "Large is no longer available, so Chopin used its default model.";

	// The client withdraws every model: the picker goes, and the saved choice's words stay, to
	// everyone who can write, before any turn. Somebody who can only read sees neither.
	client.report({ models: { available: [] } });
	await expect(trigger(page)).toHaveCount(0);
	await expect(trigger(teammate)).toHaveCount(0);
	await expect(notice(page).filter({ hasText: gone })).toBeVisible();
	await expect(notice(teammate).filter({ hasText: gone })).toBeVisible();
	await expect(trigger(reader)).toHaveCount(0);
	await expect(notice(reader).filter({ hasText: "no longer available" })).toHaveCount(0);
	await shoot(chat(page), "model-picker-withdrawn-desktop");

	// The default runs, Chat says so once, and the duplicate notice is gone even after a reload.
	await ask(page, "while it is withdrawn", 1);
	expect(turnFor(asked, "while it is withdrawn").model).toBeUndefined();
	expect(turnFor(asked, "while it is withdrawn").thinkingLevel).toBeUndefined();
	await expect(chat(page).getByText(gone, { exact: true })).toHaveCount(1);
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	await page.reload();
	await ready(page);
	await expect(chat(page).getByText(gone, { exact: true })).toHaveCount(1);
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	await expect(trigger(page)).toHaveCount(0);

	// The client goes, and an older one that reports no models takes its place. Nothing is said while
	// nobody is attached: the choice is neither gone nor honored, and the machine's status speaks.
	await client.detach();
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	let older = await attachClient(room);
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	await expect(notice(teammate).filter({ hasText: gone })).toHaveCount(0);
	await expect(trigger(page)).toHaveCount(0);
	await ask(page, "with an older client", 2);
	expect(turnFor(older.asked, "with an older client").model).toBeUndefined();
	expect(turnFor(older.asked, "with an older client").thinkingLevel).toBeUndefined();
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);

	// A client that offers the model again brings the picker and the choice back, as it was stored.
	await older.client.detach();
	let back = await attachClient(room, CATALOG);
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(0);
	await expect(notice(teammate).filter({ hasText: gone })).toHaveCount(0);
	await ask(page, "restored", 3);
	expect(turnFor(back.asked, "restored")).toMatchObject({
		model: "acme/large",
		thinkingLevel: "high",
	});
	await back.client.detach();
});

test("says nothing of a model nobody chose when no model is offered, while a client is attached or not", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	// An older client, from the start: no picker, and the default is not a choice to be told as gone.
	let older = await attachClient(room);
	await expect(trigger(page)).toHaveCount(0);
	await expect(notice(page)).toHaveCount(0);
	await ask(page, "with an older client", 1);
	expect(turnFor(older.asked, "with an older client").model).toBeUndefined();
	await expect(notice(page)).toHaveCount(0);
	await expect(chat(page).getByText("no longer available")).toHaveCount(0);
	await older.client.detach();

	// A client that offers models, then withdraws them, with nothing chosen.
	let { client } = await attachClient(room, CATALOG);
	await expect(trigger(page)).toBeVisible();
	await expect(trigger(page)).toHaveAccessibleName("Model: Small");
	client.report({ models: { available: [] } });
	await expect(trigger(page)).toHaveCount(0);
	await expect(notice(page)).toHaveCount(0);
	client.report(CATALOG);
	await expect(trigger(page)).toHaveAccessibleName("Model: Small");
	await expect(notice(page)).toHaveCount(0);
	await client.detach();
	await expect(trigger(page)).toHaveCount(0);
	await expect(notice(page).filter({ hasText: "no longer available" })).toHaveCount(0);
});

test("says the default ran when a turn cannot read the document's model choice, to everyone, until one can", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let teammate = await open(browser, "ana", room, DESKTOP);
	let { client, asked } = await attachClient(room, CATALOG);
	await expect(trigger(page)).toBeVisible();
	await openPicker(page);
	await option(page, "Large").click();
	await openPicker(page);
	await level(page, "high").click();
	await page.keyboard.press("Escape");
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await expect(trigger(teammate)).toHaveAccessibleName("Model: Large, reasoning high");

	// The server cannot read the stored choice: the turn runs the client's default, never silently.
	let unread = "This document's model choice couldn't be read, so Chopin used its default model.";
	await choicesReadable(false);
	try {
		await ask(page, "while it cannot be read", 1);
		expect(turnFor(asked, "while it cannot be read").model).toBeUndefined();
		expect(turnFor(asked, "while it cannot be read").thinkingLevel).toBeUndefined();
		// Every composer says so in its notice, and Chat says it once on the turn.
		await expect(notice(page).filter({ hasText: unread })).toBeVisible();
		await expect(notice(teammate).filter({ hasText: unread })).toBeVisible();
		await expect(chat(page).getByText(unread, { exact: true })).toHaveCount(2);
		await shoot(chat(page), "model-picker-unreadable-desktop");
	} finally {
		await choicesReadable(true);
	}

	// A turn that can read it runs the stored choice again, and the notice goes with the cause.
	await ask(page, "once it can", 2);
	expect(turnFor(asked, "once it can")).toMatchObject({
		model: "acme/large",
		thinkingLevel: "high",
	});
	await expect(notice(page).filter({ hasText: unread })).toHaveCount(0);
	await expect(notice(teammate).filter({ hasText: unread })).toHaveCount(0);
	await expect(chat(page).getByText(unread, { exact: true })).toHaveCount(1);
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await client.detach();
});

test("gives way to the room's connection banner and comes back with the connection, and stays beside the machine's own banner", async ({ browser }) => {
	test.setTimeout(180_000);
	let room = await newRoom();
	let { page, cut, restore } = await openCuttable(browser, HANDLE, room, DESKTOP);
	let { client } = await attachClient(room, CATALOG);
	await expect(trigger(page)).toBeVisible();
	await openPicker(page);
	await option(page, "Large").click();
	await openPicker(page);
	await level(page, "high").click();
	await page.keyboard.press("Escape");
	let gone = "Large is no longer available, so Chopin used its default model.";
	let unread = "This document's model choice couldn't be read, so Chopin used its default model.";

	// The model has gone: its notice is drawn, and no banner is above it.
	client.report(WITHOUT_LARGE);
	await expect(notice(page).filter({ hasText: gone })).toBeVisible();
	await expect(connectionBanner(page)).toHaveCount(0);

	// The room's own connection is lost: its banner is the one thing said while it lasts, as it is
	// for the composer's other notices, and the picker is still there.
	await cut();
	await expect(connectionBanner(page)).toHaveAttribute("data-layer", "socket", {
		timeout: 15_000,
	});
	await expect(notice(page)).toHaveCount(0);
	await expect(trigger(page)).toBeVisible();

	// It is back: the banner says so and goes, and the notice returns, once.
	await restore();
	await expect(connectionBanner(page)).toHaveCount(0, { timeout: 30_000 });
	await expect(notice(page).filter({ hasText: gone })).toHaveCount(1);
	await expect(trigger(page)).toHaveAccessibleName(`Model: Small, ${gone}`);

	// The saved choice cannot be read: the turn runs the default, and the composer says so.
	client.report(CATALOG);
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await choicesReadable(false);
	try {
		await ask(page, "while it cannot be read", 1);
		await expect(notice(page).filter({ hasText: unread })).toBeVisible();

		// The machine goes. Its banner is another cause: drawn above the notice, which stays, and
		// both describe the draft.
		await client.detach();
		await expect(connectionBanner(page)).toHaveAttribute("data-layer", "planner");
		await expect(strip(page)).toHaveText(HELD);
		await expect(notice(page).filter({ hasText: unread })).toBeVisible();
		await expect(connectionBanner(page)).toHaveCount(1);
		let [banner, words] = await Promise.all([
			strip(page).boundingBox(),
			notice(page).boundingBox(),
		]);
		// Stacked as the composer's strips are: the notice starts below the banner's top and covers
		// no more of it than the half rem each strip is tucked under the next.
		expect(words!.y).toBeGreaterThan(banner!.y);
		expect(banner!.y + banner!.height - words!.y).toBeLessThanOrEqual(9);
		let described = await chatInput(chat(page)).getAttribute("aria-describedby");
		expect(described).toContain((await strip(page).getAttribute("id"))!);
		expect(described).toContain((await notice(page).getAttribute("id"))!);
	} finally {
		await choicesReadable(true);
	}

	// A machine returns: its banner goes and the notice stays until a turn can read the choice.
	let again = await attachClient(room, CATALOG);
	await expect(connectionBanner(page)).toHaveCount(0);
	await expect(notice(page).filter({ hasText: unread })).toBeVisible();
	await ask(page, "once it can", 2);
	expect(turnFor(again.asked, "once it can")).toMatchObject({
		model: "acme/large",
		thinkingLevel: "high",
	});
	await expect(notice(page)).toHaveCount(0);
	await again.client.detach();
});

test("names the model on a phone trigger, opens a list as wide as the composer and chooses by touch", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, PHONE);
	// Ten times slower, so a read of the popover's geometry taken before its entrance ends is
	// wrong every time and not only when the machine is busy.
	let animations = await page.context().newCDPSession(page);
	await animations.send("Animation.enable");
	await animations.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
	let { client } = await attachClient(room, CATALOG);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).tap();
	// Chat slides in from the side; read it once it has settled.
	await expect.poll(async () => (await chat(page).boundingBox())?.x).toBe(0);
	let model = trigger(page);
	await expect(model).toBeVisible();
	await expect(model).toHaveAccessibleName("Model: Small");
	// The pill keeps the model's name, drawn as a 28px ghost pill with a 44px touch target.
	await expect(name(model)).toBeVisible();
	await expect(name(model)).toHaveText("Small");
	let box = (await model.boundingBox())!;
	expect(box.height).toBeCloseTo(28, 0);
	expect(await model.evaluate(element => getComputedStyle(element, "::after").height)).toBe("44px");
	await expectInsideViewport(model);
	await expectNoHorizontalOverflow(page);
	await shoot(page, "model-picker-closed-phone");

	await model.tap();
	await expect(popover(page)).toBeVisible();
	await settled(popover(page));
	await expectInsideViewport(popover(page));
	await expectNoHorizontalOverflow(page);
	await option(page, "Large").tap();
	await expect(popover(page)).toHaveCount(0);
	await expect(model).toHaveAccessibleName("Model: Large");
	await expect(name(model)).toHaveText("Large");
	await expect(name(model)).toBeVisible();

	await model.tap();
	await expect(levels(page).getByRole("radio")).toHaveCount(5);
	await settled(popover(page));
	await expectInsideViewport(levels(page));
	for (let radio of await levels(page).getByRole("radio").all()) {
		await expectInsideViewport(radio);
		// A level is drawn as the element draws it and reached through its 44px target.
		expect(await radio.evaluate(element => getComputedStyle(element, "::after").height)).toBe(
			"44px",
		);
	}
	await level(page, "xhigh").tap();
	await expect(model).toHaveAccessibleName("Model: Large, reasoning xhigh");
	await expect(popover(page)).toBeVisible();
	// The level is in the accessible name and the open list, and in lighter ink beside the name.
	await expect(name(model)).toBeVisible();
	await expect(model.locator("span").nth(1)).toHaveText("xhigh");
	await shoot(page, "model-picker-open-phone");
	await expectAccessible(page);
	await expectNoHorizontalOverflow(page);
	await client.detach();
});

test("keeps the model's name on a touch phone's trigger at every phone width, cutting a long one short", async ({ browser }) => {
	test.setTimeout(180_000);
	let room = await newRoom();
	let longName = "Acme Reasoning Ultra with an Extremely Long Name 2.5 Preview";
	let attached: Awaited<ReturnType<typeof attachClient>> | undefined;
	for (let width of [320, 360, 390, 430]) {
		let page = await open(browser, HANDLE, room, {
			...PHONE,
			viewport: { width, height: 844 },
		});
		// The Planner's owner is somebody signed in, so the client attaches once the first page is.
		attached ??= await attachClient(room, {
			models: {
				available: [
					{ id: "acme/small", name: "Small", description: "Fast for short questions." },
					{ id: "acme/long", name: longName, thinkingLevels: ["low", "high"] },
				],
				default: { id: "acme/small" },
			},
		});
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).tap();
		await expect.poll(async () => (await chat(page).boundingBox())?.x).toBe(0);
		let model = trigger(page);
		let label = name(model);
		let words = async () =>
			label.evaluate(element => ({
				clipped: element.scrollWidth > element.clientWidth,
				ellipsis: getComputedStyle(element).textOverflow,
			}));
		// The toolbar rests as one row under the draft and every control in it stays inside the phone,
		// apart from the others, with the longest name given way to an ellipsis.
		let row = async () => {
			let mention = chat(page).getByRole("button", { name: "Mention docs" });
			let mode = chat(page).getByRole("button", { name: "Ask Chopin", exact: true });
			let send = chat(page).getByRole("button", { name: "Send message" });
			let controls = [mention, mode, model, send];
			let boxes = await Promise.all(controls.map(async control => (await control.boundingBox())!));
			for (let control of controls) await expectInsideViewport(control);
			for (let index = 1; index < boxes.length; index++) {
				let before = boxes[index - 1]!;
				expect(before.x + before.width, `control ${index} at ${width}px`)
					.toBeLessThanOrEqual(boxes[index]!.x + 1);
				expect(Math.abs(before.y + before.height / 2 - boxes[index]!.y - boxes[index]!.height / 2))
					.toBeLessThanOrEqual(2);
			}
			// The draft keeps its own row above them, as wide as the box.
			expect((await chatInput(chat(page)).boundingBox())!.width, `draft at ${width}px`)
				.toBeGreaterThanOrEqual(width - 60);
			expect(boxes[2]!.height).toBeCloseTo(28, 0);
			await expectNoHorizontalOverflow(page);
		};

		await expect(model).toHaveAccessibleName("Model: Small");
		await expect(label).toBeVisible();
		await expect(label).toHaveText("Small");
		// A short name shows whole.
		expect(await words()).toMatchObject({ clipped: false });
		await row();

		// A long one is cut short with an ellipsis, in the same row, and keeps its words in the name.
		await model.tap();
		await expect(popover(page)).toBeVisible();
		await option(page, "Acme Reasoning").tap();
		await expect(popover(page)).toHaveCount(0);
		await expect(model).toHaveAccessibleName(`Model: ${longName}`);
		await expect(label).toBeVisible();
		await expect(label).toHaveText(longName);
		expect(await words()).toEqual({ clipped: true, ellipsis: "ellipsis" });
		await row();
		await shoot(page, `model-picker-long-name-phone-${width}`);

		// Choosing a level keeps the name and the layout, and Small comes back as it was.
		await model.tap();
		await level(page, "high").tap();
		// Touch has no Escape: the trigger that opened the list closes it.
		await model.tap();
		await expect(popover(page)).toHaveCount(0);
		await expect(model).toHaveAccessibleName(`Model: ${longName}, reasoning high`);
		await row();
		await model.tap();
		await option(page, "Small").tap();
		await expect(model).toHaveAccessibleName("Model: Small");
		await expect(label).toHaveText("Small");
		expect(await words()).toMatchObject({ clipped: false });
		await row();
		await page.context().close();
	}
	await attached?.client.detach();
});

test("refuses a choice the catalog does not offer, whatever the browser sends, and keeps the shared one", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, DESKTOP);
	let { client, asked } = await attachClient(room, CATALOG);
	await expect(trigger(page)).toBeVisible();
	await openPicker(page);
	await option(page, "Large").click();
	await expect(trigger(page)).toHaveAccessibleName("Model: Large");

	// A custom client of the same session speaks the wire directly, as the page does.
	let answers = await page.evaluate(async channel => {
		let socket = new WebSocket(`${location.origin.replace("http", "ws")}/ws?channel=${channel}`);
		await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
		let replies: Array<{ kind: string; message?: string; choice?: unknown }> = [];
		socket.addEventListener("message", event => {
			let frame = JSON.parse(event.data);
			if (frame.rid?.startsWith("probe-")) replies.push(frame);
		});
		let ask = (rid: string, fields: object) =>
			socket.send(JSON.stringify({ kind: "chat:model", ts: 0, rid, ...fields }));
		ask("probe-1", { model: "evil/not-offered" });
		ask("probe-2", { model: "acme/large", thinkingLevel: "xhigh-plus" });
		ask("probe-3", { model: 7 });
		ask("probe-4", { model: "x".repeat(300) });
		// An empty model or level is in no catalog, so it is refused like any other the catalog lacks.
		ask("probe-5", { model: "" });
		ask("probe-6", { model: "acme/large", thinkingLevel: "" });
		for (let waited = 0; replies.length < 6 && waited < 8_000; waited += 50) {
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		socket.close();
		return replies;
	}, room);
	expect(answers.map(answer => answer.kind)).toEqual([
		"session:error",
		"session:error",
		"session:error",
		"session:error",
		"session:error",
		"session:error",
	]);
	expect(answers.map(answer => answer.message)).toEqual([
		"That model isn't available.",
		"That model doesn't offer that level of reasoning.",
		"That is not a model choice.",
		// Any string is a choice; only the catalog refuses one it does not list, however long.
		"That model isn't available.",
		"That model isn't available.",
		"That model doesn't offer that level of reasoning.",
	]);
	// Nobody in the room sees any of it, and the next turn still runs the chosen model.
	await expect(trigger(page)).toHaveAccessibleName("Model: Large");
	await ask(page, "after the probes", 1);
	expect(turnFor(asked, "after the probes")).toMatchObject({ model: "acme/large" });
	expect(turnFor(asked, "after the probes").thinkingLevel).toBeUndefined();
	await client.detach();
});
