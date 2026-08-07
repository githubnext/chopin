/** Browser coverage for the shell's resize handles. */

import { expect, test } from "./room";

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
