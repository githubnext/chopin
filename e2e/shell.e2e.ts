/** Browser coverage for the shell's layout and controls. */

import { expect, ready, test } from "./room";

import type { Locator, Page } from "@playwright/test";

function rails(page: Page) {
	return {
		chat: page.locator("aside").first(),
		decisions: page.locator("aside").last(),
	};
}

function box(target: Locator) {
	return target.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect);
}

function drawn(handle: Locator): Promise<string> {
	return handle.evaluate(element => getComputedStyle(element, "::after").opacity);
}

const PANES = [
	{ label: "conversation", name: "Resize the conversation", region: "pane-chat" },
	{ label: "decisions", name: "Resize the decisions", region: "pane-decisions" },
] as const;

test("a drag the browser takes away still puts the bar down", async ({ join, page }) => {
	await join("ana");

	let handle = page.getByRole("separator", { name: "Resize the conversation" });
	let start = await box(handle);

	await handle.hover();
	await page.mouse.down();
	await page.mouse.move(start.x + 40, start.y + start.height / 2);
	await expect.poll(() => drawn(handle)).toBe("1");

	await handle.evaluate(element => {
		// Releasing capture models a cancelled pointer without depending on its cause.
		(element as HTMLElement).releasePointerCapture(1);
	});
	await page.mouse.move(0, 0);
	await page.mouse.up();

	await expect.poll(() => drawn(handle)).toBe("0");
});

/** Find a handle through the same tab order a keyboard user follows. */
async function tabTo(page: Page, target: Locator, presses = 24): Promise<void> {
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

	let stops: string[] = [];
	for (let press = 0; press < presses; press++) {
		await page.keyboard.press("Tab");
		if (await target.evaluate(element => element === document.activeElement)) return;

		stops.push(
			await page.evaluate(() => {
				let active = document.activeElement as HTMLElement | null;
				if (!active || active === document.body) return "nothing";
				return active.getAttribute("aria-label") ?? active.localName;
			}),
		);
	}

	throw new Error(`never reached by tabbing forward; stopped at ${stops.join(" → ")}`);
}

test("both rail handles are keyboard reachable and resize their rail", async ({ join, page }) => {
	await join("ana");

	for (
		let { grew, name, rail } of [
			{ name: "Resize the conversation", rail: rails(page).chat, grew: 32 },
			{ name: "Resize the decisions", rail: rails(page).decisions, grew: -32 },
		]
	) {
		let handle = page.getByRole("separator", { name });
		let before = (await box(rail)).width;

		await tabTo(page, handle);
		await handle.press("ArrowRight");
		await handle.press("ArrowRight");

		let after = (await box(rail)).width;
		expect({ rail: name, moved: after - before }).toEqual({ rail: name, moved: grew });
		await expect(handle).toHaveAttribute("aria-valuenow", String(after));
	}
});

test("side panes remember whether they are open and how wide they were", async ({ join, page }) => {
	await page.setViewportSize({ width: 1600, height: 800 });
	await join("ana");

	for (let pane of PANES) {
		await page.getByRole("separator", { name: pane.name }).press("End");
		let toggle = page.getByRole("button", { name: `Hide ${pane.label} pane` });
		await expect(toggle).toHaveAttribute("aria-controls", pane.region);
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		await toggle.click();
		await expect(page.locator(`#${pane.region}`)).toBeHidden();
	}
	await expect(page.getByRole("separator")).toHaveCount(0);

	await page.reload();
	await ready(page);

	for (let pane of PANES) {
		let toggle = page.getByRole("button", { name: `Show ${pane.label} pane` });
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await toggle.click();
		await expect(page.locator(`#${pane.region}`)).toBeVisible();
		await expect.poll(async () => (await box(page.locator(`#${pane.region}`))).width).toBe(520);
	}
});

test("the document keeps 400 pixels before the panes take the deficit", async ({ join, page }) => {
	await page.setViewportSize({ width: 760, height: 800 });
	await join("ana");

	expect((await box(page.locator("main"))).width).toBe(400);
	expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(760);
});

test("chat keeps its draft while hidden", async ({ join }) => {
	let page = await join("ana");
	let draft = page.locator("#pane-chat textarea");

	await draft.fill("unfinished thought");
	await page.getByRole("button", { name: "Hide conversation pane" }).click();
	await page.getByRole("button", { name: "Show conversation pane" }).click();
	await expect(draft).toHaveValue("unfinished thought");
});
