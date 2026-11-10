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
import { chatInput, fillChat } from "./chat-input";
import { createChannel, registerTestDatabase } from "./database";
import { NONE, strip } from "./planner-status";
import { e2eDatabaseName, e2ePort } from "./ports";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { authenticate, content, expect, ready, roomPath, test } from "./room";
import { HOST, ROOT } from "./servers";

import type { Browser, Locator, Page } from "@playwright/test";
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

async function attachClient(room: string, capabilities?: CapabilityCatalog) {
	let asked: Asked[] = [];
	let client = await connectAgent({
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

async function newRoom() {
	let room = crypto.randomUUID();
	await createChannel(PORT, room);
	return room;
}

function chat(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

/** The control in the composer's footer: named for the model that will run and its level. */
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

function levels(page: Page) {
	return popover(page).getByRole("radiogroup", { name: "Reasoning", exact: true });
}

function level(page: Page, name: string) {
	return levels(page).getByRole("radio", { name, exact: true });
}

async function openPicker(page: Page) {
	await trigger(page).click();
	await expect(popover(page)).toBeVisible();
	await expect(search(page)).toBeFocused();
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
	let result = await new AxeBuilder({ page }).include("[data-chat-model-picker]").analyze();
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
	let list = popover(page).getByRole("listbox", { name: "Models", exact: true });
	await expect(list.getByRole("group", { name: "Acme" }).getByRole("option")).toHaveCount(2);
	await expect(list.getByRole("group", { name: "Beta" }).getByRole("option")).toHaveCount(1);
	await expect(list.getByRole("option")).toHaveText([
		/^Large\s*Slower and more careful\.$/,
		/^Small\s*Fast for short questions\.\s*Default$/,
		/^Deep\s*Reads the whole repository first\.$/,
	]);
	// The model that will run is tinted; none has a check mark.
	await expect(option(page, "Small")).toHaveAttribute("aria-selected", "true");
	await expect(option(page, "Large")).toHaveAttribute("aria-selected", "false");
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
	await expect(popover(page).getByRole("status")).toHaveText("No matching models.");
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
		"Off",
		"Low",
		"High",
		"Extra high",
	]);
	await expect(level(page, "Default")).toHaveAttribute("aria-checked", "true");
	await level(page, "High").click();
	await expect(level(page, "High")).toHaveAttribute("aria-checked", "true");
	await expect(popover(page)).toBeVisible();
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await expect(trigger(page)).toContainText("High");
	await shoot(page, "model-picker-reasoning-desktop");
	// Escape closes it from the level just chosen, and the trigger has the focus again.
	await expect(level(page, "High")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(popover(page)).toHaveCount(0);
	await expect(trigger(page)).toBeFocused();
	await openPicker(page);

	// Another model that offers the level keeps it; one that does not drops it, and hides the control.
	await option(page, "Deep").click();
	await expect(trigger(page)).toHaveAccessibleName("Model: Deep, reasoning high");
	await openPicker(page);
	await expect(levels(page).getByRole("radio")).toHaveText(["Default", "Low", "Medium", "High"]);
	await option(page, "Small").click();
	await expect(trigger(page)).toHaveAccessibleName("Model: Small");
	await openPicker(page);
	await expect(levels(page)).toHaveCount(0);
	await page.keyboard.press("Escape");

	// The next turn, and only it, carries the choice the room holds.
	await ask(page, "first", 1);
	expect(turnFor(asked, "first").model).toBeUndefined();
	expect(turnFor(asked, "first").thinkingLevel).toBeUndefined();
	await openPicker(page);
	await option(page, "Large").click();
	await openPicker(page);
	await level(page, "Low").click();
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

	// Enter opens it with the search field focused and the model that will run active.
	await trigger(page).focus();
	await trigger(page).press("Enter");
	await expect(search(page)).toBeFocused();
	await expect(search(page)).toHaveAttribute("aria-expanded", "true");
	let active = async () => {
		let id = await search(page).getAttribute("aria-activedescendant");
		if (!id) return "none";
		let row = page.locator(`[id="${id}"]`);
		await expect(row).toHaveAttribute("data-active", "true");
		return (await row.innerText()).split("\n")[0]!;
	};
	expect(await active()).toBe("Small");

	// The arrow keys move the active row and wrap at the ends; the field keeps the focus.
	await search(page).press("ArrowDown");
	expect(await active()).toBe("Deep");
	await search(page).press("ArrowDown");
	expect(await active()).toBe("Large");
	await search(page).press("ArrowUp");
	expect(await active()).toBe("Deep");
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
	await expect(level(page, "Low")).toHaveAttribute("aria-checked", "true");
	await expect(level(page, "Low")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(level(page, "Medium")).toHaveAttribute("aria-checked", "true");
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
	await chatInput(chat(page)).click();
	await expect(popover(page)).toHaveCount(0);
	await expect(chatInput(chat(page))).toBeFocused();
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
	await level(page, "High").click();
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
	await expect(level(teammate, "High")).toHaveAttribute("aria-checked", "true");
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

	// Back to the default for everyone.
	await openPicker(page);
	await option(page, "Small").click();
	await openPicker(page);
	await expect(levels(page)).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(trigger(teammate)).toHaveAccessibleName("Model: Small");
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
	await level(page, "High").click();
	await page.keyboard.press("Escape");
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await expect(chat(page).getByText("no longer available")).toHaveCount(0);

	// The client no longer offers Large: what will run is the default, and the composer says so.
	client.report(WITHOUT_LARGE);
	// The catalog no longer lists it, so it is named by the id the client gave it.
	let gone = "acme/large is no longer available, so Chopin used its default model.";
	await expect(trigger(page)).toHaveAccessibleName(`Model: Small, ${gone}`);
	// The tooltip stays short: the strip above the composer already says why.
	await expect(trigger(page)).toHaveAttribute("title", "Model: Small");
	await expect(strip(page).filter({ hasText: gone })).toBeVisible();
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
	await expect(chat(page).getByText(gone, { exact: true })).toHaveCount(2);
	let said = chat(page).locator("[data-entry-author='system'], li, div").filter({ hasText: gone });
	await expect(said.first()).toBeVisible();

	// The model returns: the stored choice is back in force.
	client.report(CATALOG);
	await expect(trigger(page)).toHaveAccessibleName("Model: Large, reasoning high");
	await expect(strip(page).filter({ hasText: gone })).toHaveCount(0);
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
		"High reasoning is no longer available for this model, so Chopin used its default.";
	await expect(trigger(page)).toHaveAccessibleName(`Model: Large, ${reasoning}`);
	await ask(page, "level gone", 4);
	expect(turnFor(asked, "level gone")).toMatchObject({ model: "acme/large" });
	expect(turnFor(asked, "level gone").thinkingLevel).toBeUndefined();
	await client.detach();
});

test("is one icon on a phone, opens a list as wide as the composer and chooses by touch", async ({ browser }) => {
	test.setTimeout(120_000);
	let room = await newRoom();
	let page = await open(browser, HANDLE, room, PHONE);
	let { client } = await attachClient(room, CATALOG);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).tap();
	// Chat slides in from the side; read it once it has settled.
	await expect.poll(async () => (await chat(page).boundingBox())?.x).toBe(0);
	let model = trigger(page);
	await expect(model).toBeVisible();
	await expect(model).toHaveAccessibleName("Model: Small");
	// The words give way to the icon; the target stays a full touch target.
	await expect(model.locator(".composer-model-name")).toBeHidden();
	let box = (await model.boundingBox())!;
	expect(box.width).toBeGreaterThanOrEqual(36);
	expect(box.height).toBeGreaterThanOrEqual(36);
	await expectInsideViewport(model);
	await expectNoHorizontalOverflow(page);
	await shoot(page, "model-picker-closed-phone");

	await model.tap();
	await expect(popover(page)).toBeVisible();
	await expectInsideViewport(popover(page));
	await expectNoHorizontalOverflow(page);
	await option(page, "Large").tap();
	await expect(popover(page)).toHaveCount(0);
	await expect(model).toHaveAccessibleName("Model: Large");

	await model.tap();
	await expect(levels(page).getByRole("radio")).toHaveCount(5);
	await expectInsideViewport(levels(page));
	for (let radio of await levels(page).getByRole("radio").all()) {
		await expectInsideViewport(radio);
		// The composer's own controls set the size of a touch target here, the trigger among them
		// (the pill control is in rem, so the two differ by under a pixel).
		expect((await radio.boundingBox())!.height).toBeGreaterThanOrEqual(box.height - 1);
	}
	await level(page, "Extra high").tap();
	await expect(model).toHaveAccessibleName("Model: Large, reasoning extra high");
	await expect(popover(page)).toBeVisible();
	await shoot(page, "model-picker-open-phone");
	await expectAccessible(page);
	await expectNoHorizontalOverflow(page);
	await client.detach();
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
		for (let waited = 0; replies.length < 4 && waited < 8_000; waited += 50) {
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
	]);
	expect(answers.map(answer => answer.message)).toEqual([
		"That model isn't available.",
		"That model doesn't offer that level of reasoning.",
		"That is not a model choice.",
		"That is not a model choice.",
	]);
	// Nobody in the room sees any of it, and the next turn still runs the chosen model.
	await expect(trigger(page)).toHaveAccessibleName("Model: Large");
	await ask(page, "after the probes", 1);
	expect(turnFor(asked, "after the probes")).toMatchObject({ model: "acme/large" });
	expect(turnFor(asked, "after the probes").thinkingLevel).toBeUndefined();
	await client.detach();
});
