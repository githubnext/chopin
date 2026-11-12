/**
 * Notion's two width settings, in Chopin's document: Full width, a setting of the whole document in
 * its actions menu, and Wrap lines, a setting of one code block. Both belong to the document, so
 * every reader sees them as soon as a writer changes them. Widths, wrapping and a second reader's
 * view are browser behaviour; the fence flag's round trip and the setting's storage are unit tests.
 */

import AxeBuilder from "@axe-core/playwright";

import { authenticate, content, expect, ready, test, written } from "./room";

import type { Page } from "@playwright/test";

const LONG = "let unreasonablyLongName = [" + Array.from({ length: 24 }, (_, i) => `value${i}`)
	.join(", ")
	+ "];";

const DOCUMENT = `# Width notes

A paragraph long enough to show where the column stops, and where it stops when the document uses
the whole sheet instead.

\`\`\`ts
${LONG}
\`\`\`

\`\`\`ts
${LONG}
\`\`\`
`;

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

function column(page: Page) {
	return content(page).evaluate(element => element.getBoundingClientRect().width);
}

/** The sheet's own width: the most the column can take. */
function sheet(page: Page) {
	return page.locator("[data-live-document] [data-plan-scroll]").evaluate(element =>
		element.clientWidth
	);
}

function menuButton(page: Page) {
	return page.getByRole("group", { name: "Document: Width notes", exact: true })
		.getByRole("button", { name: "Actions for Width notes", exact: true });
}

function fullWidth(page: Page) {
	return page.getByRole("menuitemcheckbox", { name: "Full width", exact: true });
}

async function expectAccessible(page: Page, selector: string): Promise<void> {
	let result = await new AxeBuilder({ page }).include(selector).analyze();
	expect(
		result.violations.map(violation =>
			`${violation.id}: ${violation.help} ${violation.nodes.map(node => node.html).join(" ")}`
		),
	).toEqual([]);
}

test("Full width widens the column for every reader, and stays", async ({ browser, baseURL, join, room, seed }) => {
	await seed(DOCUMENT);
	let ana = await join("ana");
	await ana.setViewportSize({ width: 1600, height: 900 });
	let bo = await join("bo", { viewport: { width: 1600, height: 900 } });
	let readable = await column(ana);
	let whole = await sheet(ana);
	expect(readable).toBeLessThanOrEqual(763);
	expect(whole).toBeGreaterThan(readable + 40);

	await menuButton(ana).click();
	await expect(fullWidth(ana)).toHaveAttribute("aria-checked", "false");
	await expectAccessible(ana, "[role=menu]");
	await fullWidth(ana).click();
	// The menu stays open, so the change is seen behind it, and the switch says it is on.
	await expect(fullWidth(ana)).toHaveAttribute("aria-checked", "true");
	await expect.poll(() => column(ana)).toBeCloseTo(whole, 0);
	// The other reader's column follows without a reload.
	await expect.poll(() => column(bo)).toBeCloseTo(whole, 0);
	await ana.keyboard.press("Escape");
	await expect(ana.getByRole("menu")).toHaveCount(0);

	// It belongs to the document: a reader who opens it later sees it full width.
	let carol = await browser.newContext({ baseURL, viewport: { width: 1600, height: 900 } });
	try {
		let page = await carol.newPage();
		await authenticate(page, "carol", baseURL!);
		await page.goto(ana.url());
		await ready(page);
		await expect.poll(() => column(page)).toBeCloseTo(whole, 0);
	} finally {
		await carol.close();
	}

	// Off again, from the keyboard: ArrowUp opens the menu on its last row, the setting.
	await menuButton(ana).focus();
	await ana.keyboard.press("ArrowUp");
	await expect(fullWidth(ana)).toBeFocused();
	await ana.keyboard.press("Enter");
	await expect(fullWidth(ana)).toHaveAttribute("aria-checked", "false");
	await expect.poll(() => column(ana)).toBeLessThanOrEqual(763);
	await expect.poll(() => column(bo)).toBeLessThanOrEqual(763);
	await written(ana, room, /^```ts$/m);
});

test("Full width keeps the reader's place as the column moves", async ({ join, seed }) => {
	let paragraphs = Array.from(
		{ length: 40 },
		(_, i) =>
			`Paragraph ${i}: a sentence that wraps over several lines at the readable measure and fewer at full width, so the text above the reader changes height.`,
	).join("\n\n");
	await seed(`# Width notes\n\n${paragraphs}\n`);
	let ana = await join("ana");
	await ana.setViewportSize({ width: 1600, height: 900 });
	let target = content(ana).getByText("Paragraph 30:", { exact: false });
	await target.scrollIntoViewIfNeeded();
	await ana.locator("[data-plan-scroll]").first().evaluate((scroller, text) => {
		let block = [...scroller.querySelectorAll(".plan-content > p")].find(p =>
			p.textContent?.startsWith(text)
		)!;
		scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top
			- 120;
	}, "Paragraph 30:");
	let before = await target.evaluate(element => element.getBoundingClientRect().top);
	await menuButton(ana).click();
	await fullWidth(ana).click();
	await expect(fullWidth(ana)).toHaveAttribute("aria-checked", "true");
	let whole = await sheet(ana);
	await expect.poll(() => column(ana)).toBeCloseTo(whole, 0);
	await expect.poll(() => target.evaluate(element => element.getBoundingClientRect().top))
		.toBeCloseTo(before, -1);
});

test("Wrap lines wraps one block for every reader, and stays", async ({ join, room, seed }) => {
	await seed(DOCUMENT);
	let ana = await join("ana");
	let bo = await join("bo");
	let blocks = content(ana).locator(".planCode");
	let wraps = (page: Page, index: number) =>
		content(page).locator(".planCode").nth(index).locator("pre[data-overflow]").first()
			.getAttribute("data-overflow");
	await expect.poll(() => wraps(ana, 0)).toBe("scroll");

	await blocks.first().hover();
	let toggle = blocks.first().getByRole("button", { name: "Wrap lines", exact: true });
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await expectAccessible(ana, ".planCode .plan-code-chrome");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-pressed", "true");

	await expect.poll(() => wraps(ana, 0)).toBe("wrap");
	await expect.poll(() => wraps(ana, 1)).toBe("scroll");
	await expect.poll(() => wraps(bo, 0)).toBe("wrap");
	await expect.poll(() => wraps(bo, 1)).toBe("scroll");
	// A wrapped block scrolls nothing sideways.
	await expect.poll(() =>
		blocks.first().locator(".plan-code-view").evaluate(view => view.scrollWidth - view.clientWidth)
	).toBeLessThanOrEqual(1);
	await written(ana, room, /^```ts wrap\n/m);

	await bo.reload();
	await expect.poll(() => wraps(bo, 0)).toBe("wrap");
	await expect.poll(() => wraps(bo, 1)).toBe("scroll");

	// Off from the keyboard: the button is reachable by Tab in the block's controls.
	await toggle.focus();
	await ana.keyboard.press("Space");
	await expect(toggle).toHaveAttribute("aria-pressed", "false");
	await expect.poll(() => wraps(bo, 0)).toBe("scroll");
	await written(ana, room, /^```ts\nlet unreasonablyLongName/m);
});

test("an earlier version is read at the document's width, with its blocks wrapped", async ({ join, room, seed }) => {
	await seed(DOCUMENT.replace("```ts\n", "```ts wrap\n"));
	let ana = await join("ana");
	await ana.setViewportSize({ width: 1600, height: 900 });
	await content(ana).getByText("A paragraph long enough").click();
	await ana.keyboard.press("End");
	await ana.keyboard.type(" Edited.");
	await written(ana, room, /Edited\./);
	// A second person's edit makes Ana's an earlier session.
	let bo = await join("bo");
	await content(bo).getByText("A paragraph long enough").click();
	await bo.keyboard.press("End");
	await bo.keyboard.type(" Again.");
	await written(bo, room, /Again\./);
	await menuButton(ana).click();
	await fullWidth(ana).click();
	await ana.keyboard.press("Escape");

	await ana.getByRole("button", { name: "History", exact: true }).click();
	let older = ana.locator("button.history-entry:not([aria-current])").last();
	await expect(older).toBeVisible({ timeout: 15_000 });
	await older.click();
	let version = ana.locator(".history-version .plan-content");
	await expect(version).toBeVisible();
	let whole = await ana.locator(".history-version [data-plan-scroll]").evaluate(element =>
		element.clientWidth
	);
	await expect.poll(() => version.evaluate(element => element.getBoundingClientRect().width))
		.toBeCloseTo(whole, 0);
	await expect(ana.locator(".history-version .planCode").first()).toHaveAttribute(
		"data-plan-wrap",
		"",
	);
	await expect(ana.locator(".history-version .planCode").nth(1)).not.toHaveAttribute(
		"data-plan-wrap",
		"",
	);
});

test("a phone keeps its own column and offers neither setting", async ({ baseURL, join, room, seed }) => {
	await seed(DOCUMENT.replace("```ts\n", "```ts wrap\n"));
	let ana = await join("ana", PHONE);
	let set = await ana.request.patch(`/api/channels/${room}`, {
		data: { fullWidth: true },
		headers: { origin: baseURL! },
	});
	expect(set.status()).toBe(200);
	await expect(ana.locator(".history-layout-main")).not.toHaveAttribute("data-document-width");
	let width = await column(ana);
	expect(width).toBeLessThanOrEqual(390);
	await expect(content(ana).getByRole("button", { name: "Wrap lines" })).toHaveCount(0);
});
