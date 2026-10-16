import { mkdir } from "node:fs/promises";
import {
	CONNECTOR_PLATFORM_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_SERVICE_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "../packages/protocol/connector";
import { CONNECTOR_PROTOCOL } from "../apps/connector/src/version";
import { authenticate, expect, ready, test } from "./room";
import { createChannel, seedChannel, titleChannel } from "./database";
import { RELEASE } from "./release";
import { failedBuild } from "./build-seed";

import type { Locator, Page } from "@playwright/test";

const PHONE = {
	hasTouch: true,
	isMobile: true,
	viewport: { width: 390, height: 844 },
	deviceScaleFactor: 3,
};
/** Twice the pixels, so the close crops of the buttons read. */
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

/** Each test pairs machines for its own person, so their machine lists start empty. */
function person() {
	return `mo-${crypto.randomUUID().slice(0, 8)}`;
}

/** A first build's tasks, so Build plan can start without a Planner. */
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

/**
 * Pair a machine for the person signed in on `page` with a key, as Add a server's script would,
 * and connect a checkout of octo-org/score; returns the connection's token.
 */
async function connected(page: Page, label: string, headers: Record<string, string> = {}) {
	let origin = new URL(page.url()).origin;
	let back = page.url();
	await page.goto("/auth/github/connector?key");
	await expect(page).toHaveURL(/\/machines\?server$/);
	let minted = await (await page.request.post("/api/connector/pairing-keys", {
		data: {},
		headers: { origin },
	})).json() as { key: string };
	let checkout = { repository: "octo-org/score", commit: "a".repeat(40), label };
	let post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
		fetch(new URL(path, origin), {
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
	let open = async () => {
		let opened = await post("/api/connector/connections", checkout, {
			[CONNECTOR_PLATFORM_HEADER]: "linux x64",
			...headers,
			authorization: `Bearer ${paired.token}`,
		});
		expect(opened.status, await opened.clone().text()).toBe(200);
		return (await opened.json() as { token: string }).token;
	};
	let token = await open();
	await page.goto(back);
	return {
		/** Connect the checkout again with the same machine, as chopin connect does after Ctrl-C. */
		reconnect: async () => {
			token = await open();
		},
		/** Disconnect the checkout, as Ctrl-C in chopin connect does. */
		disconnect: () =>
			post("/connector/mcp", {
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "disconnect_workspace", arguments: {} },
			}, { authorization: `Bearer ${token}` }),
	};
}

async function shoot(target: Page | Locator, name: string) {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	// Past a menu's or sheet's entrance.
	await new Promise(resolve => setTimeout(resolve, 400));
	await target.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** A close crop of one or more neighbouring controls with room around them, at three times. */
async function crop(page: Page, targets: Locator | Locator[], name: string) {
	if (!SHOTS) return;
	let boxes = await Promise.all([targets].flat().map(async item => (await item.boundingBox())!));
	let left = Math.min(...boxes.map(box => box.x));
	let top = Math.min(...boxes.map(box => box.y));
	let right = Math.max(...boxes.map(box => box.x + box.width));
	let bottom = Math.max(...boxes.map(box => box.y + box.height));
	await mkdir(SHOTS, { recursive: true });
	await new Promise(resolve => setTimeout(resolve, 300));
	await page.screenshot({
		path: `${SHOTS}/${name}.png`,
		clip: { x: left - 12, y: top - 10, width: right - left + 24, height: bottom - top + 20 },
	});
}

/** The Chat composer, whose bottom row holds the machine button just before Send. */
function composer(page: Page) {
	return page.locator(".chat-composer");
}

/** The document title's actions button, not the sidebar row's of the same name. */
function titleActions(page: Page) {
	return page.getByRole("group", { name: /^Document: / })
		.getByRole("button", { name: /^Actions for / });
}

/** Open the title's menu and swap it to Machine's machine list. */
async function runOn(page: Page) {
	await titleActions(page).click();
	let menu = page.getByRole("menu", { name: /^Actions for / });
	await menu.getByRole("menuitem", { name: /^Machine\b/ }).click();
	await expect(menu.getByRole("menuitemradio").first()).toBeVisible();
	return menu;
}

/** On a phone: the top bar's actions sheet, then Machine's own sheet of machines. */
async function phoneRunOn(page: Page) {
	await page.locator(".phone-top-bar").getByRole("button", { name: /^Actions for / }).tap();
	await page.getByRole("dialog", { name: /^Actions for / })
		.getByRole("button", { name: /^Machine: / }).tap();
	let sheet = page.getByRole("dialog", { name: "Machine", exact: true });
	await expect(sheet).toBeVisible();
	await expect(sheet).toContainText("Machine for this document");
	return sheet;
}

test("Machine in the title's menu chooses where work runs, and an offline choice stops Build plan", async ({ seed, join: enter }) => {
	await seed("# Machine choice\n\nThe build goes to the machine chosen here.\n", { graph: GRAPH });
	let page = await enter(person(), DESKTOP);
	let box = await connected(page, "build-box", { [CONNECTOR_SERVICE_HEADER]: "1" });
	await connected(page, "laptop");
	await page.reload();
	let menu = page.getByRole("menu", { name: /^Actions for / });

	// Machine sits in the title's menu, saying the default is in use.
	await titleActions(page).click();
	let item = menu.getByRole("menuitem", { name: /^Machine\b/ });
	await expect(item).toContainText("Default");
	await shoot(page, "desktop-title-menu");
	// ArrowRight opens the list; it starts on the chosen row.
	await expect(menu.getByRole("menuitem").first()).toBeFocused();
	await item.focus();
	await page.keyboard.press("ArrowRight");
	await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
	let fallback = menu.getByRole("menuitemradio", { name: /^Default machine/ });
	await expect(fallback).toHaveAttribute("aria-checked", "true");
	await expect(fallback).toBeFocused();
	await expect(fallback).toContainText(/build-box|laptop/);
	await expect(menu.getByRole("menuitemradio", { name: /^build-box/ })).toContainText("Connected");
	await expect(menu.getByRole("menuitemradio", { name: /^build-box/ }))
		.toHaveAttribute("aria-checked", "false");
	await shoot(page, "desktop-machine");
	// ArrowLeft goes back to the actions, on Machine; Escape closes and returns focus.
	await page.keyboard.press("ArrowLeft");
	await expect(menu.getByRole("menuitem", { name: /^Machine\b/ })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
	await expect(titleActions(page)).toBeFocused();

	// Choosing a machine closes the menu and is remembered across a reload.
	await (await runOn(page)).getByRole("menuitemradio", { name: /^build-box/ }).click();
	await expect(menu).toBeHidden();
	await page.reload();
	await titleActions(page).click();
	await expect(menu.getByRole("menuitem", { name: /^Machine\b/ })).toContainText("build-box");
	await menu.getByRole("menuitem", { name: /^Machine\b/ }).click();
	await expect(menu.getByRole("menuitemradio", { name: /^build-box/ }))
		.toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Escape");

	// An offline choice stops Build plan rather than using the laptop: dimmed, still focusable,
	// with the reason only in its accessible description.
	await box.disconnect();
	await page.reload();
	let build = page.getByRole("button", { name: "Build plan", exact: true });
	let plan = page.locator(".build-plan");
	let offlineLook = async (enabled: boolean) => {
		if (enabled) {
			await expect(plan).not.toHaveClass(/\bmachine-offline\b/);
			await expect(build).not.toHaveAttribute("aria-disabled", "true");
		} else {
			await expect(plan).toHaveClass(/\bmachine-offline\b/);
			await expect(build).toHaveAttribute("aria-disabled", "true");
		}
	};
	await offlineLook(false);
	await expect(build).toHaveAccessibleDescription("build-box is offline");
	await expect(build).not.toHaveAttribute("disabled");
	await expect(build).not.toHaveAttribute("data-tooltip");
	await expect(plan).toHaveText("Build plan");
	await build.focus();
	await expect(build).toBeFocused();
	// Pressing it starts nothing and says nothing.
	let posted: string[] = [];
	let record = (request: import("@playwright/test").Request) => {
		let path = new URL(request.url()).pathname;
		if (request.method() === "POST" && /implementation|build/.test(path)) posted.push(path);
	};
	page.on("request", record);
	await plan.click({ force: true });
	await page.keyboard.press("Enter");
	await page.waitForTimeout(500);
	page.off("request", record);
	expect(posted).toEqual([]);
	await expect(plan).toHaveText("Build plan");
	await expect(page.getByRole("alert").filter({ hasText: /offline/i })).toHaveCount(0);
	await crop(page, plan, "desktop-build-offline");
	// Machine's list shows the chosen machine offline and not choosable.
	await runOn(page);
	let offline = menu.getByRole("menuitemradio", { name: /^build-box/ });
	await expect(offline).toHaveAttribute("aria-disabled", "true");
	await expect(offline).toHaveAttribute("aria-checked", "true");
	await expect(offline).toContainText("Offline");
	await shoot(page, "desktop-machine-offline");
	await page.keyboard.press("Escape");

	// The machine reconnecting enables Build plan again, as choosing the default does.
	await box.reconnect();
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await offlineLook(true);
	await box.disconnect();
	await page.reload();
	await offlineLook(false);
	await (await runOn(page)).getByRole("menuitemradio", { name: /^Default machine/ }).click();
	await offlineLook(true);
	await titleActions(page).click();
	await expect(menu.getByRole("menuitem", { name: /^Machine\b/ })).toContainText("Default");
	await menu.getByRole("menuitem", { name: /^Machine\b/ }).click();
	await expect(menu.getByRole("menuitemradio", { name: /^Default machine/ })).toContainText(
		"laptop",
	);
});

test("on a phone, Machine in the actions sheet opens a sheet of machines", async ({ join: enter }) => {
	let page = await enter(person(), PHONE);
	let box = await connected(page, "build-box", { [CONNECTOR_SERVICE_HEADER]: "1" });
	await page.reload();
	let sheet = await phoneRunOn(page);
	let row = sheet.getByRole("menuitemradio", { name: /^build-box/ });
	await expect(sheet.getByRole("menuitemradio", { name: /^Default machine/ }))
		.toHaveAttribute("aria-checked", "true");
	await expect(row).toContainText("Connected");
	expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	await shoot(page, "phone-sheet");
	await row.tap();
	await expect(sheet).toBeHidden();
	await page.locator(".phone-top-bar").getByRole("button", { name: /^Actions for / }).tap();
	await expect(
		page.getByRole("dialog", { name: /^Actions for / })
			.getByRole("button", { name: "Machine: build-box", exact: true }),
	).toBeVisible();
	await page.getByRole("dialog", { name: /^Actions for / })
		.getByRole("button", { name: "Cancel", exact: true }).tap();
	await expect(page.getByRole("dialog", { name: /^Actions for / })).toBeHidden();

	// Offline, its row is still checked but can't be chosen.
	await box.disconnect();
	await page.reload();
	sheet = await phoneRunOn(page);
	row = sheet.getByRole("menuitemradio", { name: /^build-box/ });
	await expect(row).toHaveAttribute("aria-checked", "true");
	await expect(row).toHaveAttribute("aria-disabled", "true");
	await expect(row).toContainText("Offline");
	await shoot(page, "phone-sheet-offline");
});

/** Sixty characters: a machine named as people name their computers, at length. */
const LONG_NAME = "alex-lavaee-workstation-in-the-basement-closet-under-stairs2";

test("a phone's Machine sheet keeps a long machine name inside its rows", async ({ join: enter }) => {
	expect(LONG_NAME).toHaveLength(60);
	let page = await enter(person(), PHONE);
	await connected(page, LONG_NAME, { [CONNECTOR_SERVICE_HEADER]: "1" });
	await page.reload();
	let sheet = await phoneRunOn(page);
	let row = sheet.getByRole("menuitemradio", { name: new RegExp(`^${LONG_NAME}`) });
	// The full name stays in the row's accessible name, however it is cut on screen.
	await expect(row).toBeVisible();
	// After the sheet's rise, every row and its detail inside the window, and the sheet never
	// scrolls sideways.
	await page.waitForTimeout(800);
	let measured = await sheet.evaluate(item => {
		let group = item.querySelector(".action-sheet-group")!;
		return {
			scroll: group.scrollWidth,
			client: group.clientWidth,
			rights: [...group.querySelectorAll("[role=menuitemradio], .action-sheet-detail")]
				.map(target => target.getBoundingClientRect().right),
		};
	});
	expect(measured.scroll).toBeLessThanOrEqual(measured.client);
	expect(measured.rights.length).toBeGreaterThanOrEqual(4);
	for (let right of measured.rights) expect(right).toBeLessThanOrEqual(390);
	await shoot(page, "phone-sheet-long-name");
	await row.tap();
	await expect(sheet).toBeHidden();
	await page.locator(".phone-top-bar").getByRole("button", { name: /^Actions for / }).tap();
	await expect(
		page.getByRole("dialog", { name: /^Actions for / })
			.getByRole("button", { name: `Machine: ${LONG_NAME}`, exact: true }),
	).toBeInViewport();
});

test("a chosen machine going offline and coming back shows within seconds, without a reload", async ({ seed, join: enter }) => {
	await seed("# Live machines\n\nThe build goes to the machine chosen here.\n", { graph: GRAPH });
	let page = await enter(person(), DESKTOP);
	let box = await connected(page, "build-box");
	let laptop = await connected(page, "laptop");
	await page.reload();
	let build = page.getByRole("button", { name: "Build plan", exact: true });
	let plan = page.locator(".build-plan");
	let entry = page.getByRole("complementary", { name: "Projects" })
		.getByRole("button", { name: /^Machines/ });
	await (await runOn(page)).getByRole("menuitemradio", { name: /^build-box/ }).click();
	await expect(build).not.toHaveAttribute("aria-disabled", "true");
	await expect(entry).toHaveAccessibleName("Machines, 2 connected");
	await expect(entry).toContainText("2/2");
	await shoot(page, "live-before-full");

	// The machine stops. Nothing reloads the page or refocuses its window, and within five seconds
	// Build plan greys and the sidebar counts one connected.
	let live = { timeout: 5_000 };
	await box.disconnect();
	await expect(build).toHaveAttribute("aria-disabled", "true", live);
	await expect(build).toHaveAccessibleDescription("build-box is offline");
	await expect(plan).toHaveClass(/\bmachine-offline\b/);
	await expect(entry).toHaveAccessibleName("Machines, 2 paired, 1 connected", live);
	await expect(entry).toContainText("1/2");
	await shoot(page, "live-offline-full");

	// It comes back, and so does Build plan.
	await box.reconnect();
	await expect(build).not.toHaveAttribute("aria-disabled", "true", live);
	await expect(plan).not.toHaveClass(/\bmachine-offline\b/);
	await expect(entry).toHaveAccessibleName("Machines, 2 connected", live);

	// On the Machines page, the sidebar's count follows the table.
	await entry.click();
	await page.getByRole("menuitem", { name: "Manage machines", exact: true }).click();
	await expect(page).toHaveURL(/\/machines$/);
	let rows = page.getByRole("table", { name: "Your machines" });
	await expect(rows.getByRole("row", { name: /laptop/ })).toContainText("Connected");
	await laptop.disconnect();
	await expect(rows.getByRole("row", { name: /laptop/ })).not.toContainText("Connected", live);
	await expect(entry).toHaveAccessibleName("Machines, 2 paired, 1 connected", live);
});

test("one choice, two buttons: Chat's and Build plan's machine button choose where work runs", async ({ seed, join: enter }) => {
	await seed("# Machine choice\n\nThe build goes to the machine chosen here.\n", { graph: GRAPH });
	let page = await enter(person(), DESKTOP);
	let box = await connected(page, "build-box", { [CONNECTOR_SERVICE_HEADER]: "1" });
	await connected(page, "laptop");
	await page.reload();
	let chat = composer(page).getByRole("button", { name: /^Machine: / });
	let header = page.locator(".machine-button:not(.composer-machine .machine-button)").first();
	await expect(chat).toHaveAccessibleName(/^Machine: Default machine, uses (build-box|laptop)$/);
	await expect(header).toHaveAccessibleName(await chat.getAttribute("aria-label") ?? "");
	await expect(chat).toContainText("Default machine");
	// Inside the composer's bottom row at its right end, just left of Send.
	let send = composer(page).getByRole("button", { name: "Send message" });
	let [machineBox, sendBox] = [(await chat.boundingBox())!, (await send.boundingBox())!];
	expect(sendBox.x - (machineBox.x + machineBox.width)).toBeLessThanOrEqual(8);
	expect(Math.abs(machineBox.y + machineBox.height / 2 - (sendBox.y + sendBox.height / 2)))
		.toBeLessThanOrEqual(1);
	await crop(page, chat, "desktop-chat-automatic");
	await shoot(page, "desktop-closed");

	// The menu: Automatic and what it uses, the machines, then Add machine.
	await chat.click();
	let menu = page.getByRole("menu", { name: "Machine for this document" });
	await expect(menu).toBeVisible();
	await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
	let automatic = menu.getByRole("menuitemradio", { name: /^Default machine/ });
	await expect(automatic).toHaveAttribute("aria-checked", "true");
	await expect(automatic).toBeFocused();
	await expect(automatic).toContainText(/Uses (build-box|laptop) now/);
	await expect(menu.getByRole("menuitemradio", { name: /^build-box/ }))
		.toContainText(`Connected with chopin ${RELEASE} on Linux`);
	await expect(menu.getByRole("menuitem", { name: "Add machine…" })).toBeVisible();
	// Opened upward from the composer, inside the window.
	let panel = (await menu.boundingBox())!;
	expect(panel.y + panel.height).toBeLessThanOrEqual((await chat.boundingBox())!.y);
	await shoot(page, "desktop-chat-menu");
	await page.keyboard.press("ArrowDown");
	await expect(menu.getByRole("menuitemradio").nth(1)).toBeFocused();
	await page.keyboard.press("End");
	await expect(menu.getByRole("menuitem", { name: "Add machine…" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(menu).toBeHidden();
	await expect(chat).toBeFocused();

	// Choosing in Chat changes Build plan's button too.
	await chat.click();
	await menu.getByRole("menuitemradio", { name: /^build-box/ }).click();
	await expect(chat).toHaveAccessibleName("Machine: build-box, connected");
	await expect(header).toHaveAccessibleName("Machine: build-box, connected");
	await expect(header).toContainText("build-box");
	await crop(page, chat, "desktop-chat-connected");
	let [planBox, headerBox] = [
		(await page.locator(".build-plan").boundingBox())!,
		(await header.boundingBox())!,
	];
	expect(headerBox.x - (planBox.x + planBox.width)).toBeLessThanOrEqual(8);
	expect(headerBox.x).toBeGreaterThan(planBox.x + planBox.width - 0.5);
	expect(Math.abs(headerBox.height - planBox.height)).toBeLessThanOrEqual(1);
	await crop(page, [page.locator(".build-plan"), header], "desktop-build-connected");
	await header.click();
	await expect(menu.getByRole("menuitemradio", { name: /^build-box/ }))
		.toHaveAttribute("aria-checked", "true");
	await shoot(page, "desktop-build-menu");
	await page.keyboard.press("Escape");
	await page.reload();
	await expect(chat).toHaveAccessibleName("Machine: build-box, connected");

	// An offline choice stops Build plan rather than using the laptop. Offline looks the same in
	// all three places, dimmed as the menu's offline row is, and is never written beside them.
	await box.disconnect();
	await page.reload();
	await expect(header).toHaveAccessibleName("Machine: build-box, offline");
	await expect(chat).toHaveAccessibleName("Machine: build-box, offline");
	let build = page.getByRole("button", { name: "Build plan", exact: true });
	let plan = page.locator(".build-plan");
	let dimmed = (target: Locator) => target.evaluate(item => getComputedStyle(item).opacity);
	let offlineLook = async (enabled: boolean) => {
		for (let target of [plan, header, chat]) {
			if (enabled) await expect(target).not.toHaveClass(/\bmachine-offline\b/);
			else await expect(target).toHaveClass(/\bmachine-offline\b/);
		}
		if (enabled) await expect(build).not.toHaveAttribute("aria-disabled", "true");
		else await expect(build).toHaveAttribute("aria-disabled", "true");
	};
	await offlineLook(false);
	await expect(build).toHaveAccessibleDescription("build-box is offline");
	await expect(build).not.toHaveAttribute("disabled");
	await expect(build).not.toHaveAttribute("data-tooltip");
	await expect(plan).toHaveText("Build plan");
	for (let target of [header, chat]) expect(await target.innerText()).not.toMatch(/offline/i);
	let look = await dimmed(plan);
	expect(await dimmed(header)).toBe(look);
	expect(await dimmed(chat)).toBe(look);
	// Still focusable, so the keyboard and a screen reader find it and its reason.
	await build.focus();
	await expect(build).toBeFocused();
	// Pressing it starts nothing and says nothing.
	let posted: string[] = [];
	let record = (request: import("@playwright/test").Request) => {
		let path = new URL(request.url()).pathname;
		if (request.method() === "POST" && /implementation|build/.test(path)) posted.push(path);
	};
	page.on("request", record);
	await plan.click({ force: true });
	await page.keyboard.press("Enter");
	await page.waitForTimeout(500);
	page.off("request", record);
	expect(posted).toEqual([]);
	await expect(plan).toHaveText("Build plan");
	await expect(page.getByRole("alert").filter({ hasText: /offline/i })).toHaveCount(0);
	await crop(page, [plan, header], "desktop-build-offline");
	await crop(page, chat, "desktop-chat-offline");
	await shoot(page, "desktop-offline");
	await header.click();
	let offline = menu.getByRole("menuitemradio", { name: /^build-box/ });
	await expect(offline).toHaveAttribute("aria-disabled", "true");
	await expect(offline).toContainText("Offline");
	// The menu's offline row is the same dimmed look.
	await expect(offline).toHaveClass(/\bmachine-offline\b/);
	expect(await dimmed(offline)).toBe(look);
	await shoot(page, "desktop-offline-menu");
	await page.keyboard.press("Escape");

	// The machine reconnecting enables Build plan again, as choosing Automatic does.
	await box.reconnect();
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(header).toHaveAccessibleName("Machine: build-box, connected");
	await offlineLook(true);
	await box.disconnect();
	await page.reload();
	await offlineLook(false);
	await header.click();
	await menu.getByRole("menuitemradio", { name: /^Default machine/ }).click();
	await expect(header).toHaveAccessibleName("Machine: Default machine, uses laptop");
	await offlineLook(true);

	// A star in the menu sets the favorite Automatic prefers, without changing the choice.
	await header.click();
	let boxRow = menu.locator(".machine-menu-row").filter({
		has: page.getByRole("menuitemradio", { name: /^build-box/ }),
	});
	let star = menu.getByRole("button", { name: "Favorite build-box" });
	await expect(star).toHaveAttribute("aria-pressed", "false");
	await boxRow.hover();
	await star.click();
	let starred = menu.getByRole("button", { name: "Remove build-box as favorite" });
	await expect(starred).toHaveAttribute("aria-pressed", "true");
	await expect(menu).toBeVisible();
	await expect(header).toHaveAccessibleName("Machine: Default machine, uses laptop");
	// The favorite is offline, so Automatic says so and uses the laptop.
	await expect(menu.getByRole("menuitemradio", { name: /^Default machine/ }))
		.toContainText("Uses laptop now because build-box is offline");
	await expect(menu.getByRole("button", { name: /favorite/i })).toHaveCount(2);
	await expect(menu.locator("[data-star][aria-pressed=true]")).toHaveCount(1);
	await page.keyboard.press("Escape");
	// Back online, Automatic uses the favorite.
	await box.reconnect();
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(header).toHaveAccessibleName("Machine: Default machine, uses build-box");
	await header.click();
	// Starred on its own row only; Automatic's line just names it.
	await expect(menu.getByRole("menuitemradio", { name: /^Default machine/ }))
		.toContainText("Uses build-box now");
	// The star is its own control: Right from the machine's row, Left back.
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("ArrowDown");
	let focusedRow = page.locator(":focus");
	await expect(focusedRow).toHaveAttribute("role", "menuitemradio");
	let rowName = await focusedRow.getAttribute("aria-checked");
	expect(rowName).toBe("false");
	let laptopStar = menu.getByRole("button", { name: "Favorite laptop" });
	let target = (await focusedRow.textContent())?.startsWith("build-box") ? starred : laptopStar;
	await page.keyboard.press("ArrowRight");
	await expect(target).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(focusedRow).toHaveAttribute("role", "menuitemradio");
	await shoot(page, "desktop-favorite-menu");
	await page.keyboard.press("Escape");

	// Add machine opens the Machines page's Add your computer.
	await chat.click();
	await menu.getByRole("menuitem", { name: "Add machine…" }).click();
	await expect(page).toHaveURL(/\/machines$/);
	await expect(page.getByRole("dialog", { name: "Add your computer" })).toBeVisible();
});

test("on a phone the machine button is a 44px icon in the composer, opening a sheet", async ({ join: enter }) => {
	let page = await enter(person(), PHONE);
	let box = await connected(page, "build-box", { [CONNECTOR_SERVICE_HEADER]: "1" });
	await page.reload();
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
	let pill = composer(page).locator(".composer-surface");
	let button = composer(page).getByRole("button", { name: /^Machine: / });
	await expect(button).toBeInViewport({ ratio: 1 });
	// After the Chat pane's slide.
	await page.waitForTimeout(800);
	let size = (await button.boundingBox())!;
	// As round as the pill's other controls, with a 44px touch target around it.
	expect(size.height).toBe(36);
	let reach = async (dx: number, dy: number) =>
		page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest(".machine-button"), [
			size.x + size.width / 2 + dx,
			size.y + size.height / 2 + dy,
		]);
	await expect.poll(() => reach(0, -21)).toBe(true);
	// It fits the composer's pill, beside the draft, mode switch and send.
	let surface = (await pill.boundingBox())!;
	expect(size.x + size.width).toBeLessThanOrEqual(surface.x + surface.width);
	expect(size.y + size.height).toBeLessThanOrEqual(surface.y + surface.height + 0.5);
	let draft = (await composer(page).locator(".composer-draft-input").boundingBox())!;
	expect(draft.width).toBeGreaterThan(120);
	await crop(page, button, "phone-chat-automatic");
	await shoot(page, "phone-closed");
	await button.tap();
	let sheet = page.getByRole("dialog", { name: "Machine for this document" });
	await expect(sheet).toBeVisible();
	let row = sheet.getByRole("menuitemradio", { name: /^build-box/ });
	expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
	// Its star sits at the right end of its own row. Both are measured in one frame, as the sheet
	// may still be rising.
	let star = sheet.getByRole("button", { name: "Favorite build-box" });
	let [rowBox, starBox] = await star.evaluate(item => {
		let rowItem = item.parentElement!.querySelector("[role=menuitemradio]")!;
		return [rowItem.getBoundingClientRect().toJSON(), item.getBoundingClientRect().toJSON()];
	}) as Array<{ x: number; y: number; width: number; height: number }>;
	expect(starBox!.y).toBeGreaterThanOrEqual(rowBox!.y);
	expect(starBox!.y + starBox!.height).toBeLessThanOrEqual(rowBox!.y + rowBox!.height);
	expect(starBox!.x).toBeGreaterThan(rowBox!.x + rowBox!.width / 2);
	await shoot(page, "phone-sheet");
	await row.tap();
	await expect(sheet).toBeHidden();
	await expect(button).toHaveAccessibleName("Machine: build-box, connected");
	await crop(page, button, "phone-chat-connected");
	await box.disconnect();
	await page.reload();
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
	await expect(button).toHaveAccessibleName("Machine: build-box, offline");
	// Dimmed as the sheet's offline row is, and still a button that opens the sheet.
	await expect(button).toHaveClass(/\bmachine-offline\b/);
	await expect(button).not.toHaveAttribute("aria-disabled", "true");
	await page.waitForTimeout(800);
	await crop(page, button, "phone-chat-offline");
	await shoot(page, "phone-chat-offline-full");
	await button.tap();
	await expect(sheet.getByRole("menuitemradio", { name: /^build-box/ }))
		.toHaveAttribute("aria-disabled", "true");
	await expect(sheet.getByRole("menuitemradio", { name: /^build-box/ }))
		.toHaveClass(/\bmachine-offline\b/);
	await shoot(page, "phone-sheet-offline");
});

test("a long machine name shrinks the machine button before Send or Build plan on a 320px window", async ({ seed, join: enter }) => {
	expect(LONG_NAME).toHaveLength(60);
	await seed("# Machine choice\n\nThe build goes to the machine chosen here.\n", { graph: GRAPH });
	let page = await enter(person(), { viewport: { width: 320, height: 800 }, deviceScaleFactor: 3 });
	await connected(page, LONG_NAME, { [CONNECTOR_SERVICE_HEADER]: "1" });
	await page.reload();
	let views = page.getByRole("navigation", { name: "Workspace view" });
	let chat = composer(page).getByRole("button", { name: /^Machine: / });
	let send = composer(page).getByRole("button", { name: "Send message" });
	let footer = composer(page).locator(".composer-footer");
	let viewport = page.viewportSize()!;
	// Every control of the composer's bottom row, Send included, whole inside the window, with the
	// machine button inside the row.
	let fits = async () => {
		let [row, button, sending] = await footer.evaluate(item => {
			let box = (target: Element | null) => target!.getBoundingClientRect().toJSON();
			return [
				box(item),
				box(item.querySelector(".machine-button")),
				box(item.querySelector(".send-action")),
			];
		}) as Array<{ x: number; y: number; width: number; height: number }>;
		expect(sending!.x).toBeGreaterThanOrEqual(0);
		expect(sending!.x + sending!.width).toBeLessThanOrEqual(viewport.width);
		expect(button!.x).toBeGreaterThanOrEqual(row!.x);
		expect(button!.x + button!.width).toBeLessThanOrEqual(sending!.x);
		expect(row!.x + row!.width).toBeLessThanOrEqual(viewport.width);
	};
	await views.getByRole("button", { name: /^Chat/ }).click();
	await expect(chat).toBeVisible();
	await chat.click();
	await page.getByRole("menu", { name: "Machine for this document" })
		.getByRole("menuitemradio", { name: new RegExp(`^${LONG_NAME}`) }).click();
	await expect(chat).toHaveAccessibleName(`Machine: ${LONG_NAME}, connected`);
	await fits();
	// Send still sends from where it is.
	await expect(send).toBeInViewport({ ratio: 1 });
	await crop(page, footer, "narrow-chat-long-name");
	await shoot(page, "narrow-chat-long-name-full");
	// Build plan's row in the header keeps Build plan whole beside the button.
	await views.getByRole("button", { name: /^Document/ }).click();
	let header = page.locator(".room-header .machine-button");
	await expect(header).toHaveAccessibleName(`Machine: ${LONG_NAME}, connected`);
	await expect(page.locator(".build-plan")).toBeInViewport({ ratio: 1 });
	await expect(header).toBeInViewport({ ratio: 1 });
	await shoot(page, "narrow-header-long-name");
	// A laptop's title bar gives the button a quarter at most, so the document's title keeps the
	// rest; the name still shows, cut short.
	await page.setViewportSize({ width: 1280, height: 800 });
	let bar = page.locator(".document-title-bar");
	let titled = bar.locator(".machine-button");
	await expect(titled.locator(".machine-button-name")).toBeVisible();
	let [barBox, titledBox] = [(await bar.boundingBox())!, (await titled.boundingBox())!];
	expect(titledBox.width).toBeLessThanOrEqual(barBox.width / 4 + 0.5);
	await expect(page.locator(".build-plan")).toBeInViewport({ ratio: 1 });
	await crop(page, [page.locator(".build-plan"), titled], "desktop-build-long-name");
});

test("the title's Machine, Chat's button and Build plan's button share one choice", async ({ seed, join: enter }) => {
	await seed("# Machine choice\n\nThe build goes to the machine chosen here.\n", { graph: GRAPH });
	let page = await enter(person(), DESKTOP);
	await connected(page, "build-box", { [CONNECTOR_SERVICE_HEADER]: "1" });
	await connected(page, "laptop");
	await page.reload();
	let chat = composer(page).getByRole("button", { name: /^Machine: / });
	let header = page.locator(".machine-button:not(.composer-machine .machine-button)").first();
	let menu = page.getByRole("menu", { name: "Machine for this document" });
	let titleMenu = page.getByRole("menu", { name: /^Actions for / });
	let titleSays = async (name: string) => {
		await titleActions(page).click();
		await expect(titleMenu.getByRole("menuitem", { name: /^Machine\b/ })).toContainText(name);
		await page.keyboard.press("Escape");
	};
	// Both buttons sit where they did: Chat's just before Send, Build plan's right after it.
	await expect(chat).toBeVisible();
	await expect(header).toBeVisible();
	let [plan, beside] = [
		(await page.locator(".build-plan").boundingBox())!,
		(await header.boundingBox())!,
	];
	expect(beside.x).toBeGreaterThan(plan.x + plan.width - 0.5);
	expect(Math.abs(beside.height - plan.height)).toBeLessThanOrEqual(1);

	// Chosen in the title's menu: both buttons follow.
	await (await runOn(page)).getByRole("menuitemradio", { name: /^laptop/ }).click();
	await expect(chat).toHaveAccessibleName("Machine: laptop, connected");
	await expect(header).toHaveAccessibleName("Machine: laptop, connected");
	// Chosen in Chat: Build plan's button and the title's menu follow.
	await chat.click();
	await menu.getByRole("menuitemradio", { name: /^build-box/ }).click();
	await expect(header).toHaveAccessibleName("Machine: build-box, connected");
	await titleSays("build-box");
	// Chosen beside Build plan: Chat's button and the title's menu follow.
	await header.click();
	await menu.getByRole("menuitemradio", { name: /^Default machine/ }).click();
	await expect(chat).toHaveAccessibleName(/^Machine: Default machine, uses /);
	await titleSays("Default");
	await shoot(page, "three-places-in-step");
});

/** Pair and connect `count` machines, the last with a long name; keys pair ten at most. */
async function machines(page: Page, count: number) {
	let labels: string[] = [];
	for (let index = 0; index < count; index++) {
		let label = index === count - 1 ? LONG_NAME : `machine-${String(index + 1).padStart(2, "0")}`;
		labels.push(label);
		if (index < 10) {
			await connected(page, label, index % 2 ? {} : { [CONNECTOR_SERVICE_HEADER]: "1" });
			continue;
		}
		// Pairing keys are limited to ten a window, so the rest pair as a browser approves them.
		let origin = new URL(page.url()).origin;
		let back = page.url();
		let post = (path: string, body: unknown, extra: Record<string, string> = {}) =>
			fetch(new URL(path, origin), {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL),
					[CONNECTOR_VERSION_HEADER]: RELEASE,
					...extra,
				},
				body: JSON.stringify(body),
			});
		let pending = await (await post("/api/connector/pairings", { label })).json() as {
			id: string;
			secret: string;
			url: string;
		};
		await page.goto(pending.url);
		await page.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(page.getByRole("status").filter({ hasText: "Connected" })).toHaveText(
			"Connected",
		);
		let claimed = await (await post(`/api/connector/pairings/${pending.id}/claim`, {
			secret: pending.secret,
		})).json() as { token: string };
		let opened = await post("/api/connector/connections", { label, checkouts: [] }, {
			[CONNECTOR_PLATFORM_HEADER]: "linux x64",
			authorization: `Bearer ${claimed.token}`,
		});
		expect(opened.status, await opened.clone().text()).toBe(200);
		await page.goto(back);
	}
	return labels;
}

/**
 * In a panel of machine rows: it stays inside the window, every row and Add machine… can be
 * scrolled into view inside it and reached, and End moves focus to the last row, which scrolls
 * into view.
 */
async function reachable(page: Page, panel: Locator, labels: string[]) {
	// A visible phone drawer may still be rising; actionability waits for stable geometry.
	await panel.getByRole("menuitemradio").first().click({ trial: true });
	let viewport = page.viewportSize()!;
	let box = (await panel.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.y).toBeGreaterThanOrEqual(0);
	expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
	expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
	if (labels.length >= 12) {
		expect(await panel.evaluate(item => item.scrollHeight > item.clientHeight)).toBe(true);
	}
	for (let label of labels) {
		let row = panel.getByRole("menuitemradio", { name: new RegExp(`^${label}`) });
		await row.scrollIntoViewIfNeeded();
		await row.click({ trial: true });
		expect(await shownIn(row, panel), label).toBe(true);
	}
	let add = panel.getByRole("menuitem", { name: "Add machine…" });
	await add.scrollIntoViewIfNeeded();
	await add.click({ trial: true });
	expect(await shownIn(add, panel)).toBe(true);
}

/** Whether `item` is whole inside the scrolled `panel`, to the pixel, and so can be clicked. */
async function shownIn(item: Locator, panel: Locator) {
	return item.evaluate((element, container) => {
		let box = element.getBoundingClientRect();
		let frame = container!.getBoundingClientRect();
		let hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
		return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1
			&& box.left >= frame.left - 1 && box.right <= frame.right + 1
			&& box.bottom <= window.innerHeight + 1 && box.top >= -1
			&& !!hit && element.contains(hit);
	}, await panel.elementHandle());
}

test("twelve machines in a short window: the machine menu fits, scrolls and reaches every row", async ({ seed, join: enter }) => {
	await seed("# Machine choice\n\nThe build goes to the machine chosen here.\n", { graph: GRAPH });
	let page = await enter(person(), { viewport: { width: 1280, height: 600 } });
	let labels = await machines(page, 12);
	await page.reload();
	let menu = page.getByRole("menu", { name: "Machine for this document" });
	// From Chat's button at the window's foot, the menu opens upward.
	let chat = composer(page).getByRole("button", { name: /^Machine: / });
	await chat.click();
	await expect(menu).toBeVisible();
	await shoot(page, "short-window-chat-menu");
	await reachable(page, menu, labels);
	// The keyboard reaches the rows out of view.
	await page.keyboard.press("Home");
	await page.keyboard.press("End");
	await expect(menu.getByRole("menuitem", { name: "Add machine…" })).toBeFocused();
	expect(await shownIn(menu.getByRole("menuitem", { name: "Add machine…" }), menu)).toBe(true);
	await page.keyboard.press("ArrowUp");
	let bottom = menu.getByRole("menuitemradio").last();
	await expect(bottom).toBeFocused();
	expect(await shownIn(bottom, menu)).toBe(true);
	let last = menu.getByRole("menuitemradio", { name: new RegExp(`^${LONG_NAME}`) });
	// A long name ends in an ellipsis inside its row, its whole name in its title.
	await expect(last.locator(".machine-menu-title")).toHaveAttribute("title", LONG_NAME);
	expect(await last.evaluate(item => item.scrollWidth <= item.clientWidth + 1)).toBe(true);
	await last.click();
	await expect(chat).toHaveAccessibleName(`Machine: ${LONG_NAME}, connected`);
	// From Build plan's button at the window's top, the menu opens downward and scrolls too.
	let header = page.locator(".machine-button:not(.composer-machine .machine-button)").first();
	await header.click();
	await expect(menu).toBeVisible();
	await reachable(page, menu, labels);
	await page.keyboard.press("Escape");
	// The title's menu shows the same rows, inside the window, scrolling.
	let titleMenu = await runOn(page);
	let box = (await titleMenu.boundingBox())!;
	expect(box.y + box.height).toBeLessThanOrEqual(600.5);
	await page.keyboard.press("End");
	let titleLast = titleMenu.getByRole("menuitemradio").last();
	await expect(titleLast).toBeFocused();
	expect(await shownIn(titleLast, titleMenu)).toBe(true);
	await shoot(page, "short-window-title-menu");
	await page.keyboard.press("Escape");
});

for (let height of [1080, 969]) {
	test(
		`machine menus fit after creating projects without reloading at 1920x${height}`,
		async ({ page, baseURL }, testInfo) => {
			await page.setViewportSize({ width: 1920, height });
			await authenticate(page, `document-creator-${crypto.randomUUID()}`, baseURL!);
			await page.goto("/");
			let labels = await machines(page, 3);
			let sidebar = page.getByRole("complementary", { name: "Projects" });
			let add = page.getByRole("dialog", { name: "Add project", exact: true });
			// An account without projects opens this asynchronously after navigation loads.
			await expect(add).toBeVisible();
			for (let repository of ["score", "archive-1", "archive-8"]) {
				if (repository !== "score") {
					await sidebar.getByRole("button", { name: "Add project", exact: true }).click();
				}
				await add.getByRole("textbox", { name: "Search repositories" }).fill(repository);
				await add.getByRole("option", { name: `octo-org/${repository}`, exact: true }).click();
				await expect(add).toBeHidden();
				let create = sidebar.getByRole("button", {
					name: `New document in ${repository}`,
					exact: true,
				});
				await create.locator("..").hover();
				await create.click();
				let title = page.getByRole("textbox", { name: "Document title", exact: true });
				await title.fill(`Menu check ${repository}`);
				await title.press("Enter");
				await ready(page);
				let chat = composer(page).getByRole("button", { name: /^Machine: / });
				await chat.click();
				let menu = page.getByRole("menu", { name: "Machine for this document" });
				await expect(menu).toBeVisible();
				await shoot(page, `creation-${height}-${repository}-chat`);
				await testInfo.attach(`creation ${repository}`, {
					body: await page.screenshot(),
					contentType: "image/png",
				});
				await reachable(page, menu, labels);
				let panel = (await menu.boundingBox())!;
				expect(panel.y + panel.height).toBeLessThanOrEqual((await chat.boundingBox())!.y);
				await page.keyboard.press("Escape");
				await page.locator(".document-title-bar .machine-button").click();
				await reachable(page, menu, labels);
				await shoot(page, `creation-${height}-${repository}-build`);
				await page.keyboard.press("Escape");
				let entry = sidebar.getByRole("button", { name: /^Machines/ });
				await entry.click();
				let defaults = page.getByRole("menu").filter({ hasText: "Default machine" });
				await defaults.getByRole("menuitemradio").first().click({ trial: true });
				await settledMenu(defaults);
				expect((await defaults.boundingBox())!.y + (await defaults.boundingBox())!.height)
					.toBeLessThanOrEqual((await entry.boundingBox())!.y);
				for (let row of await defaults.locator('[role^="menuitem"]').all()) {
					expect(await shownIn(row, defaults)).toBe(true);
					await row.click({ trial: true });
				}
				await page.keyboard.press("Escape");
			}
		},
	);
}

for (let height of [800, 600, "phone"] as const) {
	test(
		`populated workspace machine menus fit and reach every row at ${height}`,
		async ({ seed, join: enter }, testInfo) => {
			await seed(
				"# Machine choice\n\n" + "A populated document with its sidebar projects.\n\n".repeat(30),
				{
					graph: GRAPH,
				},
			);
			let page = await enter(
				person(),
				height === "phone" ? PHONE : { viewport: { width: 1280, height } },
			);
			let port = Number(new URL(page.url()).port);
			let origin = new URL(page.url()).origin;
			for (
				let [id, name] of [["R_score", "score"], ["R_archive_1", "archive-1"], [
					"R_archive_2",
					"archive-2",
				]]
			) {
				for (let index = 0; index < 2; index++) {
					let document = crypto.randomUUID();
					await createChannel(port, document, { id: id!, owner: "octo-org", name: name! });
					await titleChannel(port, document, `${name} document ${index + 1}`);
					await seedChannel(
						port,
						document,
						`# ${name} document ${index + 1}\n\nWorkspace content.\n`,
					);
				}
				let added = await page.request.post("/api/navigation/projects", {
					headers: { origin },
					data: { owner: "octo-org", repository: name },
				});
				expect(added.ok(), await added.text()).toBe(true);
			}
			let labels = await machines(page, 3);
			await page.reload();
			if (height === "phone") {
				await page.getByRole("navigation", { name: "Workspace view" })
					.getByRole("button", { name: "Chat", exact: true }).tap();
			} else {
				let sidebar = page.getByRole("complementary", { name: "Projects" });
				for (let name of ["score", "archive-1", "archive-2"]) {
					await expect(sidebar.getByRole("button", { name: new RegExp(`^${name}(?:,|$)`) }))
						.toBeVisible();
				}
				await expect(sidebar.getByRole("link", { name: "score document 1", exact: true }).first())
					.toBeVisible();
			}
			let chat = composer(page).getByRole("button", { name: /^Machine: / });
			await chat.click();
			let menu = height === "phone"
				? page.getByRole("dialog", { name: "Machine for this document" }).locator(
					".machine-sheet-group",
				)
				: page.getByRole("menu", { name: "Machine for this document" });
			await expect(menu).toBeVisible();
			await shoot(page, `populated-${height}-chat`);
			await testInfo.attach("populated machine menu", {
				body: await page.screenshot(),
				contentType: "image/png",
			});
			await reachable(page, menu, labels);
			if (height === "phone") return;
			let panel = (await menu.boundingBox())!;
			expect(panel.y + panel.height).toBeLessThanOrEqual((await chat.boundingBox())!.y);
			await page.keyboard.press("Home");
			await expect(menu.getByRole("menuitemradio", { name: /^Default machine/ })).toBeFocused();
			await page.keyboard.press("End");
			await expect(menu.getByRole("menuitem", { name: "Add machine…" })).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(chat).toBeFocused();
			await page.locator(".document-title-bar .machine-button").click();
			await reachable(page, menu, labels);
			await page.keyboard.press("Escape");
			let titleMenu = await runOn(page);
			let titlePanel = (await titleMenu.boundingBox())!;
			expect(titlePanel.y + titlePanel.height).toBeLessThanOrEqual(height);
			await page.keyboard.press("End");
			expect(await shownIn(titleMenu.getByRole("menuitemradio").last(), titleMenu)).toBe(true);
		},
	);
}

test("twelve machines on a phone: the machine sheet scrolls to its last row and Add machine", async ({ join: enter }) => {
	let page = await enter(person(), PHONE);
	let labels = await machines(page, 12);
	await page.reload();
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
	await composer(page).getByRole("button", { name: /^Machine: / }).tap();
	let sheet = page.getByRole("dialog", { name: "Machine for this document" });
	await expect(sheet).toBeVisible();
	await page.waitForTimeout(800);
	let group = sheet.locator(".machine-sheet-group");
	let box = (await group.boundingBox())!;
	expect(box.y).toBeGreaterThanOrEqual(0);
	expect(box.y + box.height).toBeLessThanOrEqual(844.5);
	for (let label of labels) {
		let row = sheet.getByRole("menuitemradio", { name: new RegExp(`^${label}`) });
		await row.scrollIntoViewIfNeeded();
		expect(await shownIn(row, group), label).toBe(true);
	}
	let add = sheet.getByRole("menuitem", { name: "Add machine…" });
	await add.scrollIntoViewIfNeeded();
	expect(await shownIn(add, group)).toBe(true);
	await shoot(page, "phone-sheet-twelve-scrolled");
	let last = sheet.getByRole("menuitemradio", { name: new RegExp(`^${LONG_NAME}`) });
	await last.scrollIntoViewIfNeeded();
	await last.tap();
	await expect(sheet).toBeHidden();
	await expect(composer(page).getByRole("button", { name: /^Machine: / }))
		.toHaveAccessibleName(`Machine: ${LONG_NAME}, connected`);
});

/** Wait for actual placement and entrance motion, not an arbitrary delay. */
async function settledMenu(menu: Locator) {
	await menu.evaluate(async element => {
		await Promise.all(
			element.getAnimations({ subtree: true }).map(animation => animation.finished),
		);
		await new Promise<void>(resolve => {
			let previous = "";
			let stable = 0;
			let measure = () => {
				let box = element.getBoundingClientRect();
				let current = `${box.x},${box.y},${box.width},${box.height}`;
				stable = current === previous ? stable + 1 : 0;
				previous = current;
				if (stable === 3) resolve();
				else requestAnimationFrame(measure);
			};
			requestAnimationFrame(measure);
		});
	});
}

for (
	let viewport of [
		{ width: 1862, height: 1039 },
		{ width: 1920, height: 1080 },
		{ width: 1280, height: 800 },
		{ width: 1280, height: 600 },
		PHONE.viewport,
	]
) {
	for (let projects of [1, 3]) {
		test(`populated sidebar Default machine fits ${viewport.width}x${viewport.height} with ${projects} projects`, async ({ seed, join: enter }) => {
			let title = `Sidebar ${viewport.width}x${viewport.height} ${projects}`;
			await seed(`# ${title}\n\nA document open beside Chat.\n`, {
				graph: GRAPH,
				builds: [failedBuild(GRAPH)],
			});
			let phone = viewport.width === 390;
			let page = await enter(person(), phone ? PHONE : { viewport });
			await connected(page, "devbox");
			for (let index = 0; index < projects; index++) {
				let name = index === 0 ? "score" : `archive-${index}`;
				if (index > 0) {
					for (let document of [1, 2]) {
						let id = crypto.randomUUID();
						await createChannel(Number(new URL(page.url()).port), id, {
							id: `R_archive_${index}`,
							owner: "octo-org",
							name,
						});
						await seedChannel(
							Number(new URL(page.url()).port),
							id,
							`# ${name} ${document}\n\nContent.\n`,
						);
					}
				}
				let added = await page.request.post("/api/navigation/projects", {
					headers: { origin: new URL(page.url()).origin },
					data: { owner: "octo-org", repository: name },
				});
				expect(added.ok(), await added.text()).toBe(true);
			}
			await page.reload();
			await page.getByRole("button", { name: "Build", exact: true }).click();
			if (phone) {
				// Phones intentionally link to Machines from the documents sheet instead of a menu.
				await page.getByRole("button", { name: "Documents", exact: true }).tap();
				let link = page.getByRole("link", { name: /^Machines/ });
				await link.scrollIntoViewIfNeeded();
				await expect(link).toBeInViewport({ ratio: 1 });
				await link.tap();
				await expect(page).toHaveURL(/\/machines$/);
				await expect(page.getByRole("button", { name: "Favorite devbox", exact: true }))
					.toBeVisible();
				return;
			}
			let sidebar = page.getByRole("complementary", { name: "Projects" });
			await expect(sidebar.getByRole("link", { name: title, exact: true })).toBeVisible();
			let entry = sidebar.getByRole("button", { name: /^Machines/ });
			await expect(entry).toBeInViewport({ ratio: 1 });
			await entry.click();
			let menu = page.getByRole("menu").filter({ hasText: "Default machine" });
			await menu.getByRole("menuitemradio").first().click({ trial: true });
			await settledMenu(menu);
			if (SHOTS) {
				await mkdir(SHOTS, { recursive: true });
				await page.screenshot({
					path: `${SHOTS}/sidebar-${viewport.width}x${viewport.height}-${projects}.png`,
				});
			}
			let panel = (await menu.boundingBox())!;
			let trigger = (await entry.boundingBox())!;
			expect(panel.y).toBeGreaterThanOrEqual(0);
			expect(panel.y + panel.height).toBeLessThanOrEqual(trigger.y);
			for (let row of await menu.locator('[role^="menuitem"]').all()) {
				expect(await shownIn(row, menu)).toBe(true);
				await row.click({ trial: true });
			}
		});
	}
}

test("the populated sidebar menu scrolls and refits while the viewport shrinks", async ({ seed, join: enter }) => {
	test.setTimeout(90_000);
	await seed("# Sidebar menu\n\n" + "A long document.\n\n".repeat(80), {
		graph: GRAPH,
		builds: [failedBuild(GRAPH)],
	});
	let page = await enter(person(), { viewport: { width: 1862, height: 1039 } });
	await machines(page, 30);
	let added = await page.request.post("/api/navigation/projects", {
		headers: { origin: new URL(page.url()).origin },
		data: { owner: "octo-org", repository: "score" },
	});
	expect(added.ok(), await added.text()).toBe(true);
	await page.reload();
	await page.getByRole("button", { name: "Build", exact: true }).click();
	let sidebar = page.getByRole("complementary", { name: "Projects" });
	let entry = sidebar.getByRole("button", { name: /^Machines/ });
	await entry.click();
	let menu = page.getByRole("menu").filter({ hasText: "Default machine" });
	await menu.getByRole("menuitemradio").first().click({ trial: true });
	await page.keyboard.press("End");
	let last = menu.getByRole("menuitem", { name: "Manage machines", exact: true });
	await expect(last).toBeFocused();
	expect(await shownIn(last, menu)).toBe(true);
	await page.setViewportSize({ width: 1280, height: 600 });
	await settledMenu(menu);
	if (SHOTS) {
		await mkdir(SHOTS, { recursive: true });
		await page.screenshot({ path: `${SHOTS}/sidebar-default-machine-resize.png` });
	}
	expect(await shownIn(last, menu)).toBe(true);
	let panel = (await menu.boundingBox())!;
	let trigger = (await entry.boundingBox())!;
	expect(trigger.y + trigger.height).toBeLessThanOrEqual(600);
	expect(panel.y).toBeGreaterThanOrEqual(0);
	expect(panel.y + panel.height).toBeLessThanOrEqual(trigger.y);
	for (let row of await menu.locator('[role^="menuitem"]').all()) {
		await row.scrollIntoViewIfNeeded();
		await row.click({ trial: true });
		expect(await shownIn(row, menu)).toBe(true);
	}
});

for (let width of [1280, 600, 390]) {
	test(`the sidebar's default machine control is never clipped at ${width}px`, async ({ join: enter }) => {
		let phone = width === 390;
		let page = await enter(
			person(),
			phone ? PHONE : { viewport: { width, height: 800 } },
		);
		await connected(page, "studio");
		// The newest, so Any available uses it and says so.
		await connected(page, LONG_NAME, { [CONNECTOR_SERVICE_HEADER]: "1" });
		await page.reload();
		// Narrower than a desktop, the sidebar or a phone's documents sheet opens first.
		if (width < 1280) {
			let show = page.getByRole("button", { name: /^(Show sidebar|Documents)$/ }).first();
			await expect(show).toBeVisible();
			await show.click();
		}
		/** Whether an element shows all it holds, inside the window. */
		let whole = (target: Locator) =>
			target.evaluate(item => {
				let box = item.getBoundingClientRect();
				return item.scrollWidth <= item.clientWidth + 1 && box.left >= 0
					&& box.right <= document.documentElement.clientWidth + 0.5;
			});
		if (phone) {
			// A phone's documents sheet links to the Machines page, whole.
			let link = page.getByRole("link", { name: /^Machines/ });
			await expect(link).toBeVisible();
			expect(await whole(link)).toBe(true);
			await shoot(page, `sidebar-default-machine-${width}`);
			return;
		}
		let entry = page.getByRole("button", { name: /^Machines/ });
		expect(await whole(entry)).toBe(true);
		await entry.click();
		let menu = page.getByRole("menu");
		await expect(menu.getByText("Default machine", { exact: true })).toBeVisible();
		let any = menu.getByRole("menuitemradio", { name: /^Any available/ });
		await expect(any).toContainText(`Uses ${LONG_NAME}`);
		let long = menu.getByRole("menuitemradio", { name: new RegExp(`^${LONG_NAME}`) });
		// Every row whole inside the menu, the menu inside the window; a long name or detail ends
		// in an ellipsis, its whole text in its title and the row's accessible name.
		for (let row of await menu.getByRole("menuitemradio").all()) {
			expect(await whole(row)).toBe(true);
		}
		expect(await whole(menu)).toBe(true);
		await expect(any.getByText("Any available", { exact: true })).toBeVisible();
		await expect(any.locator(".app-menu-item-meta")).toHaveAttribute("title", `Uses ${LONG_NAME}`);
		await expect(long.getByTitle(LONG_NAME, { exact: true })).toBeVisible();
		await expect(long.locator(".app-menu-item-meta")).toHaveText("Connected");
		expect(
			await long.locator(".app-menu-item-meta").evaluate(item =>
				item.scrollWidth <= item.clientWidth
			),
		).toBe(true);
		await shoot(page, `sidebar-default-machine-${width}`);
		// Chosen as the default, it is the entry's, and the menu still fits.
		await long.click();
		await entry.click();
		await expect(long).toHaveAttribute("aria-checked", "true");
		expect(await whole(menu)).toBe(true);
		await page.keyboard.press("Escape");
	});
}

test("the machine choice shows only while the person has a paired machine, appearing and going live", async ({ seed, join: enter }) => {
	await seed("# Machine choice\n\nThe build goes to the machine chosen here.\n", { graph: GRAPH });
	let page = await enter(person(), DESKTOP);
	let chat = composer(page).getByRole("button", { name: /^Machine: / });
	let header = page.locator(".machine-button:not(.composer-machine .machine-button)");
	let send = composer(page).getByRole("button", { name: "Send message" });
	let build = page.getByRole("button", { name: "Build plan", exact: true });
	let machineItem = async () => {
		await titleActions(page).click();
		let menu = page.getByRole("menu", { name: /^Actions for / });
		await expect(menu.getByRole("menuitem").first()).toBeVisible();
		let count = await menu.getByRole("menuitem", { name: /^Machine\b/ }).count();
		await page.keyboard.press("Escape");
		return count;
	};
	// No machine paired: no selector in Chat, beside Build plan or in the title's menu, and no
	// prompt to add one there either.
	await expect(build).toBeVisible();
	await expect(chat).toHaveCount(0);
	await expect(header).toHaveCount(0);
	expect(await machineItem()).toBe(0);
	await expect(page.getByRole("main").getByText("Add machine", { exact: false })).toHaveCount(0);
	let before = { send: (await send.boundingBox())!, build: (await build.boundingBox())! };

	// The first machine pairs in another tab: the selector appears here, with no reload, and Send
	// stays where it was.
	let other = await page.context().newPage();
	await other.goto(page.url());
	await connected(other, "build-box", { [CONNECTOR_SERVICE_HEADER]: "1" });
	let live = { timeout: 10_000 };
	await expect(chat).toBeVisible(live);
	await expect(header).toBeVisible(live);
	expect(await machineItem()).toBe(1);
	let after = { send: (await send.boundingBox())!, build: (await build.boundingBox())! };
	expect(after.send.x).toBeCloseTo(before.send.x, 0);
	expect(after.send.y).toBeCloseTo(before.send.y, 0);
	expect(after.build.width).toBeCloseTo(before.build.width, 0);
	expect(after.build.height).toBeCloseTo(before.build.height, 0);
	await shoot(page, "selector-appears");

	// Removing the last machine takes the selector away again, live.
	let { machines } = await (await page.request.get("/api/connector/machines")).json() as {
		machines: Array<{ id: string }>;
	};
	let origin = new URL(page.url()).origin;
	for (let { id } of machines) {
		let revoked = await page.request.post(`/api/connector/machines/${id}/revoke`, {
			data: {},
			headers: { origin },
		});
		expect(revoked.status()).toBe(200);
	}
	await expect(chat).toHaveCount(0, live);
	await expect(header).toHaveCount(0, live);
	expect(await machineItem()).toBe(0);
	await other.close();
});
