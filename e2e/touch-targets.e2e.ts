import { installPointerMedia } from "./pointer-media";
import { expect, openIsolatedRoom, test } from "./room";

import type { Page } from "@playwright/test";

/**
 * A control keeps its look on touch: its visible box is the same as with a mouse, and an invisible
 * target of 44px grows around it. Only a primary coarse pointer asks for the target, so a
 * touch-screen laptop used with a mouse keeps the desktop's sizes.
 */
const VIEWPORT = { width: 1440, height: 900 };

async function composerButton(page: Page) {
	let button = page.getByRole("complementary", { name: "Chat", exact: true })
		.locator(".chat-composer button:visible").first();
	await expect(button).toBeVisible();
	return button;
}

async function describe(page: Page) {
	let button = await composerButton(page);
	let box = (await button.boundingBox())!;
	let facts = await button.evaluate(node => {
		let after = getComputedStyle(node, "::after");
		let style = getComputedStyle(node);
		return {
			attribute: document.documentElement.hasAttribute("data-plan-coarse-pointer"),
			after: { content: after.content, width: after.width, height: after.height },
			minHeight: style.minHeight,
			minWidth: style.minWidth,
		};
	});
	return { box, ...facts };
}

test("a touch laptop used with a mouse keeps the desktop's sizes; a touch primary pointer grows only the target", async ({ baseURL, browser, room }) => {
	let mouse = await openIsolatedRoom(
		browser,
		baseURL!,
		room,
		"ana",
		{ hasTouch: true, viewport: VIEWPORT },
		context => installPointerMedia(context, { coarse: true, primaryCoarse: false }),
	);
	let touch = await openIsolatedRoom(
		browser,
		baseURL!,
		room,
		"bo",
		{ hasTouch: true, viewport: VIEWPORT },
		context => installPointerMedia(context, { coarse: true, primaryCoarse: true }),
	);
	try {
		let hybrid = await describe(mouse.page);
		expect(hybrid.attribute, "any-pointer: coarse alone asks for nothing").toBe(false);
		expect(hybrid.after.content).toBe("none");
		expect(hybrid.minHeight).not.toBe("44px");
		expect(hybrid.minWidth).not.toBe("44px");

		let primary = await describe(touch.page);
		expect(primary.attribute).toBe(true);
		// The same visible box as the mouse's: it never grows.
		expect(primary.box.width).toBeCloseTo(hybrid.box.width, 1);
		expect(primary.box.height).toBeCloseTo(hybrid.box.height, 1);
		expect(primary.minHeight).not.toBe("44px");
		expect(primary.minWidth).not.toBe("44px");
		// And an invisible target of at least 44px around it, which a finger just outside it reaches.
		expect(primary.after.content).toBe('""');
		expect(Number.parseFloat(primary.after.width)).toBeGreaterThanOrEqual(44);
		expect(Number.parseFloat(primary.after.height)).toBeGreaterThanOrEqual(44);
		let button = await composerButton(touch.page);
		let box = (await button.boundingBox())!;
		let reach = Math.max(0, (44 - box.height) / 2);
		if (reach > 1) {
			let hit = await touch.page.evaluate(
				([x, y]) =>
					document.elementFromPoint(x!, y!)?.closest("button")?.getAttribute("aria-label")
						?? document.elementFromPoint(x!, y!)?.closest("button")?.textContent,
				[box.x + box.width / 2, box.y - reach + 2],
			);
			let own = await button.evaluate(node => node.getAttribute("aria-label") ?? node.textContent);
			expect(hit).toBe(own);
		}
	} finally {
		await mouse.close();
		await touch.close();
	}
});
