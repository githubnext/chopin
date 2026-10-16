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

/** The Chat composer must stay free of machine controls. */
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
	await expect(page.getByRole("button", { name: /^Machine: / })).toHaveCount(0);
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
 * In a panel of machine rows: it stays inside the window and every row can be
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
	for (let label of labels) {
		let row = panel.getByRole("menuitemradio", { name: new RegExp(`^${label}`) });
		await row.scrollIntoViewIfNeeded();
		await row.click({ trial: true });
		expect(await shownIn(row, panel), label).toBe(true);
	}
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
	let titleMenu = await runOn(page);
	await reachable(page, titleMenu, labels);
	let box = (await titleMenu.boundingBox())!;
	expect(box.y + box.height).toBeLessThanOrEqual(600.5);
	await page.keyboard.press("End");
	let titleLast = titleMenu.getByRole("menuitemradio").last();
	await expect(titleLast).toBeFocused();
	await expect.poll(() => shownIn(titleLast, titleMenu)).toBe(true);
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
				let menu = await runOn(page);
				await reachable(page, menu, labels);
				await testInfo.attach(`creation ${repository}`, {
					body: await page.screenshot(),
					contentType: "image/png",
				});
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
			let menu = height === "phone" ? await phoneRunOn(page) : await runOn(page);
			await expect(menu).toBeVisible();
			await testInfo.attach("populated machine menu", {
				body: await page.screenshot(),
				contentType: "image/png",
			});
			if (height === "phone") {
				for (let label of labels) {
					await expect(menu.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }))
						.toBeVisible();
				}
				return;
			}
			await reachable(page, menu, labels);
			await page.keyboard.press("End");
			await expect(menu.getByRole("menuitemradio").last()).toBeFocused();
		},
	);
}

test("twelve machines on a phone: the title menu machine sheet scrolls to its last row", async ({ join: enter }) => {
	let page = await enter(person(), PHONE);
	let labels = await machines(page, 12);
	await page.reload();
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: "Chat", exact: true }).tap();
	let sheet = await phoneRunOn(page);
	await expect(sheet).toBeVisible();
	await page.waitForTimeout(800);
	let group = sheet.locator(".action-sheet-group");
	let box = (await group.boundingBox())!;
	expect(box.y).toBeGreaterThanOrEqual(0);
	expect(box.y + box.height).toBeLessThanOrEqual(844.5);
	for (let label of labels) {
		let row = sheet.getByRole("menuitemradio", { name: new RegExp(`^${label}`) });
		await row.scrollIntoViewIfNeeded();
		expect(await shownIn(row, group), label).toBe(true);
	}
	await shoot(page, "phone-sheet-twelve-scrolled");
	let last = sheet.getByRole("menuitemradio", { name: new RegExp(`^${LONG_NAME}`) });
	await last.scrollIntoViewIfNeeded();
	await last.tap();
	await expect(sheet).toBeHidden();
	await expect(
		(await phoneRunOn(page)).getByRole("menuitemradio", { name: new RegExp(`^${LONG_NAME}`) }),
	)
		.toHaveAttribute("aria-checked", "true");
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

test("Manage machines closes the sidebar menu after navigation", async ({ join: enter }) => {
	let page = await enter(person(), { viewport: { width: 1862, height: 1039 } });
	await connected(page, "devbox");
	await page.reload();
	let sidebar = page.getByRole("complementary", { name: "Projects" });
	await sidebar.getByRole("button", { name: /^Machines/ }).click();
	let menu = page.getByRole("menu").filter({ hasText: "Default machine" });
	await menu.getByRole("menuitem", { name: "Manage machines", exact: true }).click();
	await expect(page).toHaveURL(/\/machines$/);
	await expect(page.getByRole("heading", { name: "Machines", exact: true })).toBeVisible();
	await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
	// Activating the current destination must close too, without relying on a route change.
	await sidebar.getByRole("button", { name: /^Machines/ }).click();
	await menu.getByRole("menuitem", { name: "Manage machines", exact: true }).click();
	await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
});

test("the sidebar machine menu closes on browser history navigation", async ({ join: enter }) => {
	let page = await enter(person(), { viewport: { width: 1862, height: 1039 } });
	await connected(page, "devbox");
	await page.reload();
	let sidebar = page.getByRole("complementary", { name: "Projects" });
	let entry = sidebar.getByRole("button", { name: /^Machines/ });
	await entry.click();
	await page.getByRole("menuitem", { name: "Manage machines", exact: true }).click();
	await expect(page).toHaveURL(/\/machines$/);
	await entry.click();
	await expect(page.getByRole("menu")).toBeVisible();
	await page.goBack();
	await ready(page);
	await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
});

test("keyboard Manage machines focuses the Machines heading", async ({ join: enter }) => {
	let page = await enter(person(), { viewport: { width: 1862, height: 1039 } });
	await connected(page, "devbox");
	await page.reload();
	let entry = page.getByRole("complementary", { name: "Projects" })
		.getByRole("button", { name: /^Machines/ });
	await entry.focus();
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("End");
	await expect(page.getByRole("menuitem", { name: "Manage machines", exact: true })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(/\/machines$/);
	await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Machines", exact: true })).toBeFocused();
});

for (let activation of ["Enter", "Space", "touch"] as const) {
	test(`sidebar machine items close via ${activation}`, async ({ join: enter }) => {
		let page = await enter(person(), {
			viewport: { width: 1862, height: 1039 },
			hasTouch: activation === "touch",
		});
		await connected(page, "devbox");
		await page.reload();
		let entry = page.getByRole("complementary", { name: "Projects" })
			.getByRole("button", { name: /^Machines/ });
		let open = async () => {
			if (activation === "touch") await entry.tap();
			else {
				await entry.focus();
				await page.keyboard.press("ArrowDown");
			}
			let menu = page.getByRole("menu").filter({ hasText: "Default machine" });
			await expect(menu).toBeVisible();
			await settledMenu(menu);
			return menu;
		};
		let activate = async (item: Locator) => {
			if (activation === "touch") await item.tap();
			else {
				await item.focus();
				await page.keyboard.press(activation);
			}
		};
		for (let name of [/^Any available/, /^devbox/]) {
			await activate((await open()).getByRole("menuitemradio", { name }));
			await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
		}
		await activate((await open()).getByRole("menuitem", { name: "Add machine…", exact: true }));
		await expect(page.getByRole("dialog", { name: "Add your computer" })).toBeVisible();
		await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
		await page.goBack();
		await ready(page);
		let menu = await open();
		if (activation !== "touch") await page.keyboard.press("End");
		await activate(menu.getByRole("menuitem", { name: "Manage machines", exact: true }));
		await expect(page.getByRole("heading", { name: "Machines", exact: true })).toBeFocused();
		await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
	});
}

test("phone machine navigation leaves no menu or sheet behind", async ({ join: enter }) => {
	let page = await enter(person(), PHONE);
	await connected(page, "devbox");
	await page.reload();
	await page.getByRole("button", { name: "Documents", exact: true }).tap();
	await page.getByRole("link", { name: /^Machines/ }).tap();
	await expect(page.getByRole("heading", { name: "Machines", exact: true })).toBeVisible();
	await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: "Documents", exact: true })).toHaveCount(0);
});

test("machine menus close on same-document history navigation", async ({ seed, join: enter }) => {
	await seed("# Machine navigation\n\nA document with a build.\n", { graph: GRAPH });
	let page = await enter(person(), { viewport: { width: 1862, height: 1039 } });
	await connected(page, "devbox");
	await page.reload();
	await page.evaluate(() => history.pushState(null, "", "#machine-menu"));
	await runOn(page);
	await expect(page.getByRole("menu")).toBeVisible();
	await page.goBack();
	await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
});

test("the sidebar machine popup disappears when its trigger unmounts", async ({ join: enter }) => {
	let page = await enter(person(), { viewport: { width: 1862, height: 1039 } });
	await connected(page, "devbox");
	await page.reload();
	await page.getByRole("complementary", { name: "Projects" })
		.getByRole("button", { name: /^Machines/ }).click();
	await expect(page.getByRole("menu")).toBeVisible();
	let { machines } = await (await page.request.get("/api/connector/machines")).json() as {
		machines: Array<{ id: string }>;
	};
	for (let { id } of machines) {
		let removed = await page.request.post(`/api/connector/machines/${id}/revoke`, {
			data: {},
			headers: { origin: new URL(page.url()).origin },
		});
		expect(removed.ok()).toBe(true);
	}
	await expect(
		page.getByRole("complementary", { name: "Projects" })
			.getByRole("link", { name: /^Machines/ }),
	).toBeVisible();
	await expect(page.getByRole("menu", { includeHidden: true })).toHaveCount(0);
});

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

	// Pairing reveals Machine in the title menu only; Build and Send stay in place.
	let other = await page.context().newPage();
	await other.goto(page.url());
	await connected(other, "build-box", { [CONNECTOR_SERVICE_HEADER]: "1" });
	let live = { timeout: 10_000 };
	await expect(chat).toHaveCount(0, live);
	await expect(header).toHaveCount(0, live);
	await expect.poll(machineItem, live).toBe(1);
	let after = { send: (await send.boundingBox())!, build: (await build.boundingBox())! };
	expect(after.send.x).toBeCloseTo(before.send.x, 0);
	expect(after.send.y).toBeCloseTo(before.send.y, 0);
	expect(after.build.x).toBeCloseTo(before.build.x, 0);
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
	await expect.poll(machineItem, live).toBe(0);
	await other.close();
});
