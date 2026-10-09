/**
 * Icons keep their declared size beside text that wraps.
 *
 * Each icon is a flex item; without `flex-shrink: 0` a long label squeezes it
 * narrower than its height. Layout is browser behaviour, so this measures every
 * visible icon on the surfaces where labels wrap, at phone width.
 */

import { content, expect, test } from "./room";
import { CHOSEN, SETTLED_ANSWER, SOURCE, STATE } from "./source/icon-size.fixture";

import type { Locator, Page } from "@playwright/test";

/** Icons whose rendered box differs from the size they were declared at. */
function squeezed(scope: Locator) {
	return scope.evaluateAll(roots =>
		roots.flatMap(root =>
			[...root.querySelectorAll("svg[width]")].flatMap(icon => {
				let box = icon.getBoundingClientRect();
				if (box.width === 0 && box.height === 0) return [];
				let size = Number(icon.getAttribute("width"));
				return Math.abs(box.width - size) > 0.5 || Math.abs(box.height - size) > 0.5
					? [
						`${box.width.toFixed(1)}×${box.height.toFixed(1)}, declared ${size}: ${
							root.textContent?.slice(0, 60)
						}`,
					]
					: [];
			})
		)
	);
}

/** How far an icon's centre sits from the centre of its row's first text line. */
function firstLineOffset(row: Locator) {
	return row.evaluate(element => {
		let icon = element.querySelector("svg")!.getBoundingClientRect();
		let top = element.getBoundingClientRect().top;
		let line = Number.parseFloat(getComputedStyle(element).lineHeight);
		return Math.abs(icon.top + icon.height / 2 - (top + line / 2));
	});
}

async function phone(page: Page) {
	await page.setViewportSize({ width: 390, height: 844 });
}

test("icons keep their size and sit on the first line beside wrapped decision text", async ({ join, seed }) => {
	await seed(SOURCE, STATE);
	let page = await join("ana");
	await phone(page);

	let settled = content(page).locator("[data-card-settled]");
	await expect(settled).toContainText(SETTLED_ANSWER);
	expect((await settled.boundingBox())!.height).toBeGreaterThan(30);
	expect(await squeezed(settled)).toEqual([]);
	expect(await firstLineOffset(settled)).toBeLessThan(1.5);

	await page.getByRole("button", { name: `Decision: ${CHOSEN}` }).click();
	let dialog = page.getByRole("dialog", { name: "Decision" });
	await expect(dialog).toContainText("Phased over a whole quarter");
	let answers = dialog.locator(".plan-decision-answer");
	await expect(answers).toHaveCount(3);
	expect(await squeezed(dialog)).toEqual([]);
	for (let answer of await answers.all()) {
		expect(await firstLineOffset(answer)).toBeLessThan(1.5);
	}
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);

	await page.getByRole("button", { name: /^Decisions/ }).click();
	let decisions = page.locator('[data-document-view="decisions"]');
	await decisions.getByRole("button", { name: /resolved/ }).click();
	await expect(decisions).toContainText("How should we roll this out?");
	await expect.poll(() => squeezed(decisions)).toEqual([]);
});

test("header, menu, Chat and sidebar icons keep their size when every row wraps", async ({ join, seed }) => {
	await seed(SOURCE, STATE);
	let page = await join("ana");
	await phone(page);

	// Squeeze every row the way a long title or label would.
	let narrow = (scope: Locator) =>
		scope.evaluateAll(roots => {
			for (let root of roots) {
				for (let icon of root.querySelectorAll("svg[width]")) {
					let row = icon.parentElement;
					if (row && getComputedStyle(row).display.includes("flex")) row.style.maxWidth = "2.5rem";
				}
			}
		});

	let header = page.getByRole("banner");
	await narrow(header);
	await expect.poll(() => squeezed(header)).toEqual([]);

	await page.getByRole("button", { name: /^Actions for / }).click();
	let menu = page.getByRole("menu");
	await expect(menu).toBeVisible();
	await narrow(menu);
	await expect.poll(() => squeezed(menu)).toEqual([]);
	await page.keyboard.press("Escape");

	await page.getByRole("button", { name: "Chat", exact: true }).click();
	let chat = page.getByRole("complementary", { name: "Chat" });
	await expect(chat.getByRole("combobox", { name: "Message" })).toBeVisible();
	await narrow(chat);
	await expect.poll(() => squeezed(chat)).toEqual([]);

	await page.getByRole("button", { name: "Show sidebar" }).click();
	let sidebar = page.getByRole("navigation", { name: /project|sidebar|documents/i });
	await expect(sidebar.first()).toBeVisible();
	await narrow(sidebar);
	await expect.poll(() => squeezed(sidebar)).toEqual([]);
});
