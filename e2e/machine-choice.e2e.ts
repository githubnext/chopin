import { mkdir } from "node:fs/promises";
import {
	CONNECTOR_PLATFORM_HEADER,
	CONNECTOR_PROTOCOL_HEADER,
	CONNECTOR_SERVICE_HEADER,
	CONNECTOR_VERSION_HEADER,
} from "../packages/protocol/connector";
import { CONNECTOR_PROTOCOL } from "../apps/connector/src/version";
import { expect, test } from "./room";

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
	await expect(page).toHaveURL(/\/connect\?server$/);
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
				[CONNECTOR_VERSION_HEADER]: "0.0.5",
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

function composer(page: Page) {
	return page.locator(".chat-composer");
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

test("one choice, two buttons: Chat's and Build plan's machine button choose where work runs", async ({ seed, join: enter }) => {
	await seed("# Machine choice\n\nThe build goes to the machine chosen here.\n", { graph: GRAPH });
	let page = await enter(person(), DESKTOP);
	let box = await connected(page, "build-box", { [CONNECTOR_SERVICE_HEADER]: "1" });
	await connected(page, "laptop");
	await page.reload();
	let chat = composer(page).getByRole("button", { name: /^Machine: / });
	let header = page.locator(".machine-button:not(.composer-machine .machine-button)").first();
	await expect(chat).toHaveAccessibleName(/^Machine: Automatic, uses (build-box|laptop)$/);
	await expect(header).toHaveAccessibleName(await chat.getAttribute("aria-label") ?? "");
	await expect(chat).toContainText("Automatic");
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
	let automatic = menu.getByRole("menuitemradio", { name: /^Automatic/ });
	await expect(automatic).toHaveAttribute("aria-checked", "true");
	await expect(automatic).toBeFocused();
	await expect(automatic).toContainText(/Uses (build-box|laptop) now/);
	await expect(menu.getByRole("menuitemradio", { name: /^build-box/ }))
		.toContainText("Connected · chopin 0.0.5 · Linux");
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
	await menu.getByRole("menuitemradio", { name: /^Automatic/ }).click();
	await expect(header).toHaveAccessibleName("Machine: Automatic, uses laptop");
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
	await expect(header).toHaveAccessibleName("Machine: Automatic, uses laptop");
	// The favorite is offline, so Automatic says so and uses the laptop.
	await expect(menu.getByRole("menuitemradio", { name: /^Automatic/ }))
		.toContainText("Uses laptop now · build-box is offline");
	await expect(menu.getByRole("button", { name: /favorite/i })).toHaveCount(2);
	await expect(menu.locator("[data-star][aria-pressed=true]")).toHaveCount(1);
	await page.keyboard.press("Escape");
	// Back online, Automatic uses the favorite.
	await box.reconnect();
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect(header).toHaveAccessibleName("Machine: Automatic, uses build-box");
	await header.click();
	await expect(menu.getByRole("menuitemradio", { name: /^Automatic/ }))
		.toContainText("Uses build-box (favorite) now");
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
	await expect(page).toHaveURL(/\/connect$/);
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
