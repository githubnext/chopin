import { mkdir } from "node:fs/promises";
import {
	CONNECTOR_PLATFORM_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_SERVICE_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "../packages/protocol/connector";
import { CONNECTOR_PROTOCOL } from "../apps/connector/src/version";
import { expect, test } from "./room";
import { RELEASE } from "./release";

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

	// Machine'sits in the title's menu, saying the default is in use.
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

test("a phone's Machine'sheet keeps a long machine name inside its rows", async ({ join: enter }) => {
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
		.getByRole("link", { name: /^Machines/ });
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
	await expect(page).toHaveURL(/\/machines$/);
	let rows = page.getByRole("table", { name: "Your machines" });
	await expect(rows.getByRole("row", { name: /laptop/ })).toContainText("Connected");
	await laptop.disconnect();
	await expect(rows.getByRole("row", { name: /laptop/ })).not.toContainText("Connected", live);
	await expect(entry).toHaveAccessibleName("Machines, 2 paired, 1 connected", live);
});
