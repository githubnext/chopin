/** Light, Dark and System: chosen in the account menu, drawn from the first frame, kept per browser. */

import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

/** The ground each theme draws (`--color-ground`), as the browser paints it. */
const GROUND = { light: "rgb(244, 244, 241)", dark: "rgb(24, 23, 20)" } as const;

function themeRow(page: Page) {
	return page.getByRole("group", { name: "Theme" });
}

function segment(page: Page, name: "Light" | "Dark" | "System"): Locator {
	return themeRow(page).getByRole("menuitemradio", { name, exact: true });
}

async function openAccountMenu(page: Page) {
	await page.locator(".project-sidebar-account").click();
	await expect(page.getByRole("menu")).toBeVisible();
}

/** What the page draws: the theme on <html>, its scheme, and the ground as painted pixels. */
async function drawn(page: Page) {
	return page.evaluate(() => {
		let root = document.documentElement;
		let canvas = document.createElement("canvas").getContext("2d")!;
		canvas.fillStyle = getComputedStyle(document.body).backgroundColor;
		canvas.fillRect(0, 0, 1, 1);
		let [red, green, blue] = canvas.getImageData(0, 0, 1, 1).data;
		return {
			theme: root.dataset.theme,
			dark: root.classList.contains("dark"),
			scheme: getComputedStyle(root).colorScheme,
			ground: `rgb(${red}, ${green}, ${blue})`,
			metaScheme: document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content,
			metaGround: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
		};
	});
}

function painted(theme: "light" | "dark") {
	return {
		theme,
		dark: theme === "dark",
		scheme: theme,
		ground: GROUND[theme],
		metaScheme: theme,
		metaGround: theme === "dark" ? "#181714" : "#f4f4f1",
	};
}

test("each choice repaints the page at once, with no colour easing, and keeps the menu open", async ({ join }) => {
	let page = await join("ana");
	expect(await drawn(page)).toEqual(painted("light"));
	await openAccountMenu(page);
	await expect(segment(page, "System")).toHaveAttribute("aria-checked", "true");

	for (let [name, theme] of [["Dark", "dark"], ["Light", "light"], ["Dark", "dark"]] as const) {
		await segment(page, name).click();
		// The very next frame is the new theme, whole: nothing eases from the old colours.
		let moving = await page.evaluate(() =>
			new Promise<number>(resolve =>
				requestAnimationFrame(() =>
					resolve(
						document.getAnimations().filter(animation =>
							animation instanceof CSSTransition && animation.playState === "running"
						).length,
					)
				)
			)
		);
		expect(moving).toBe(0);
		expect(await drawn(page)).toEqual(painted(theme));
		await expect(page.getByRole("menu")).toBeVisible();
		await expect(segment(page, name)).toHaveAttribute("aria-checked", "true");
		for (let other of (["Light", "Dark", "System"] as const).filter(item => item !== name)) {
			await expect(segment(page, other)).toHaveAttribute("aria-checked", "false");
		}
	}
	await segment(page, "System").click();
	expect(await drawn(page)).toEqual(painted("light"));
});

test("a choice is kept in this browser and drawn from the very first frame after a reload", async ({ join }) => {
	let page = await join("ana");
	// Read before anything is drawn: the theme as the body first appears, and the ground in the
	// first frame the browser renders.
	await page.addInitScript(() => {
		let seen: Record<string, string | undefined> = {};
		(window as unknown as { firstFrame: typeof seen }).firstFrame = seen;
		new MutationObserver((_, observer) => {
			if (!document.body) return;
			seen.atBody = document.documentElement.dataset.theme;
			observer.disconnect();
		}).observe(document, { childList: true, subtree: true });
		requestAnimationFrame(() => {
			seen.atFirstFrame = getComputedStyle(document.body).backgroundColor;
			seen.themeAtFirstFrame = document.documentElement.dataset.theme;
		});
	});
	let firstFrame = () =>
		page.evaluate(() => (window as unknown as { firstFrame: Record<string, string> }).firstFrame);
	let ground = (value: string) =>
		page.evaluate(colour => {
			let canvas = document.createElement("canvas").getContext("2d")!;
			canvas.fillStyle = colour;
			canvas.fillRect(0, 0, 1, 1);
			let [red, green, blue] = canvas.getImageData(0, 0, 1, 1).data;
			return `rgb(${red}, ${green}, ${blue})`;
		}, value);

	await openAccountMenu(page);
	await segment(page, "Dark").click();
	await page.reload();
	await expect.poll(async () => (await firstFrame()).atFirstFrame).toBeTruthy();
	let first = await firstFrame();
	expect(first.atBody).toBe("dark");
	expect(first.themeAtFirstFrame).toBe("dark");
	expect(await ground(first.atFirstFrame!)).toBe(GROUND.dark);
	expect(await drawn(page)).toEqual(painted("dark"));

	// System, with the system dark: dark from the first frame too.
	await page.emulateMedia({ colorScheme: "dark" });
	await openAccountMenu(page);
	await segment(page, "System").click();
	await page.reload();
	await expect.poll(async () => (await firstFrame()).atFirstFrame).toBeTruthy();
	first = await firstFrame();
	expect(first.atBody).toBe("dark");
	expect(await ground(first.atFirstFrame!)).toBe(GROUND.dark);

	// Light, with the system dark: light from the first frame.
	await openAccountMenu(page);
	await segment(page, "Light").click();
	await page.reload();
	await expect.poll(async () => (await firstFrame()).atFirstFrame).toBeTruthy();
	first = await firstFrame();
	expect(first.atBody).toBe("light");
	expect(await ground(first.atFirstFrame!)).toBe(GROUND.light);
});

test("System follows the system's scheme while the page is open; Light and Dark hold", async ({ join }) => {
	let page = await join("ana");
	await page.emulateMedia({ colorScheme: "dark" });
	await expect.poll(() => drawn(page)).toEqual(painted("dark"));
	await page.emulateMedia({ colorScheme: "light" });
	await expect.poll(() => drawn(page)).toEqual(painted("light"));

	await openAccountMenu(page);
	await segment(page, "Light").click();
	await page.emulateMedia({ colorScheme: "dark" });
	// A change the page did not follow leaves nothing to wait for; give it the same chance.
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
	expect(await drawn(page)).toEqual(painted("light"));
	await segment(page, "Dark").click();
	await page.emulateMedia({ colorScheme: "light" });
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
	expect(await drawn(page)).toEqual(painted("dark"));
});

test("another tab of the same browser takes the new choice", async ({ join }) => {
	let page = await join("ana");
	let other = await page.context().newPage();
	await other.goto(page.url());
	await expect.poll(() => drawn(other)).toEqual(painted("light"));
	await openAccountMenu(page);
	await segment(page, "Dark").click();
	await expect.poll(() => drawn(other)).toEqual(painted("dark"));
	await other.close();
});

test("the keyboard reaches the theme row in the menu's order and chooses along it without leaving", async ({ join }) => {
	let page = await join("ana");
	let trigger = page.locator(".project-sidebar-account");
	await trigger.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByRole("menuitem", { name: "Manage repository access" })).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(page.getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeFocused();
	// The row is one stop, entered at its chosen segment.
	await page.keyboard.press("ArrowDown");
	await expect(segment(page, "System")).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(segment(page, "Dark")).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await expect(segment(page, "Dark")).toHaveAttribute("aria-checked", "true");
	await expect(segment(page, "Dark")).toBeFocused();
	await expect(page.getByRole("menu")).toBeVisible();
	// Along the row, round its ends; Space chooses as Enter does.
	await page.keyboard.press("ArrowLeft");
	await expect(segment(page, "Light")).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(segment(page, "System")).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(segment(page, "Light")).toBeFocused();
	await page.keyboard.press("Space");
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
	// Down leaves the row for the next item; Up comes back to its chosen segment.
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowDown");
	await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeFocused();
	await page.keyboard.press("ArrowUp");
	await expect(segment(page, "Light")).toBeFocused();
	await page.keyboard.press("ArrowUp");
	await expect(page.getByRole("menuitem", { name: "Keyboard shortcuts" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(trigger).toBeFocused();
});
