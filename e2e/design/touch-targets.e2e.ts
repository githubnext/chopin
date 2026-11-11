import { expect } from "@playwright/test";
import { plate, test } from "./fixture";

/**
 * A menu row keeps its own height on touch. An invisible 44px target grows around it, and the rows
 * stand a target apart, so a finger inside a row reaches that row and not its neighbour.
 */
test("a menu row does not grow on touch; only its target does, and neighbouring targets never overlap", async ({ page }) => {
	let trigger = plate(page, "interactive-document-actions").getByRole("button", {
		name: "Actions for Design system audit",
	});
	await trigger.focus();
	await page.keyboard.press("ArrowDown");
	let menu = page.getByRole("menu", { name: "Actions for Design system audit", exact: true });
	await expect(menu).toBeVisible();
	await expect.poll(() => menu.evaluate(node => node.getAnimations({ subtree: true }).length))
		.toBe(0);
	let rows = menu.getByRole("menuitem");
	let count = await rows.count();
	expect(count).toBeGreaterThan(2);
	let size = async () => {
		let sizes = [];
		for (let index = 0; index < count; index++) {
			let box = (await rows.nth(index).boundingBox())!;
			sizes.push([box.width, box.height]);
		}
		return sizes;
	};
	let fine = await size();
	for (let index = 0; index < count; index++) {
		expect(await rows.nth(index).evaluate(node => getComputedStyle(node, "::after").content))
			.toBe("none");
	}

	await page.evaluate(() => document.documentElement.setAttribute("data-plan-coarse-pointer", ""));
	// Same visible rows, drawn as tall as before. Only their spacing moved.
	expect(await size()).toEqual(fine);
	for (let index = 0; index < count; index++) {
		let after = await rows.nth(index).evaluate(node => {
			let style = getComputedStyle(node, "::after");
			return { content: style.content, height: style.height };
		});
		expect(after).toEqual({ content: '""', height: "44px" });
	}

	// A finger just inside the foot of a row reaches that row, and one just past it the next:
	// the targets meet, and do not overlap.
	let reaches = (x: number, y: number) =>
		page.evaluate(([px, py]) => {
			let row = document.elementFromPoint(px!, py!)?.closest('[role="menuitem"]');
			return row?.textContent ?? null;
		}, [x, y]);
	for (let index = 0; index < count - 1; index++) {
		let upper = (await rows.nth(index).boundingBox())!;
		let lower = (await rows.nth(index + 1).boundingBox())!;
		let x = upper.x + upper.width / 2;
		let own = await rows.nth(index).textContent();
		let next = await rows.nth(index + 1).textContent();
		expect(await reaches(x, upper.y + upper.height - 1)).toBe(own);
		expect(await reaches(x, upper.y + upper.height + 6)).toBe(own);
		expect(await reaches(x, lower.y - 6)).toBe(next);
		expect(await reaches(x, lower.y + 1)).toBe(next);
	}
});
