/**
 * Copying a code block. Chat's block and the document's have the same Copy control: named _Copy
 * code_, then _Copied_ with a check or _Couldn't copy_ with a warning glyph, reached by the
 * keyboard, and named by one tooltip, never a second one beside it or a native title under it. The
 * document's copies the block's source exactly as it is written. An icon button that also carries a
 * native title keeps it held back while it is pressed, so the browser's own hover text never follows
 * the tooltip.
 */

import { content, expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Locator, Page } from "@playwright/test";

const CLIPBOARD = { permissions: ["clipboard-read", "clipboard-write"] };
const PHONE = {
	hasTouch: true,
	isMobile: true,
	permissions: ["clipboard-read", "clipboard-write"],
	viewport: { width: 390, height: 844 },
};
// Tabs, a blank line, trailing spaces and a backtick: what a copy most easily loses.
const SOURCE =
	"export function queueFor(team: string) {\n\tlet name = `queue:${team}`;  \n\n\treturn name;\n}";

function transcript(): Chat.Entry[] {
	return [
		{
			id: "reply",
			author: { kind: "agent" },
			text: ["Here is the helper.", "", "```ts", SOURCE, "```"].join("\n"),
			ts: 1_700_000_060,
		},
	];
}

/** Every tooltip on the page a person can see, by its words. */
async function visibleTooltips(page: Page): Promise<string[]> {
	return await page.evaluate(() =>
		[
			...document.querySelectorAll<HTMLElement>(
				"[data-icon-tooltip], [data-slot='tooltip-content'], [role='tooltip']",
			),
		]
			.filter(element => {
				let style = getComputedStyle(element);
				let rect = element.getBoundingClientRect();
				return style.visibility !== "hidden" && style.display !== "none"
					&& Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
			})
			.map(element => element.textContent?.trim() ?? "")
	);
}

/** Hovers a control and waits past every tooltip's delay, then reads what is shown. */
async function hoverTooltips(page: Page, control: Locator): Promise<string[]> {
	await control.hover();
	await expect.poll(() => visibleTooltips(page)).not.toEqual([]);
	// The shared tooltip waits 400ms and fades in; a second one would be up well before this.
	await page.waitForTimeout(800);
	return await visibleTooltips(page);
}

function codeBlock(page: Page): Locator {
	return content(page).locator(".planCode").first();
}

test("Chat's Copy code names itself with one tooltip, and no native title under it", async ({ join, seed }) => {
	await seed("# Copy\n", { transcript: transcript() });
	let page = await join("ana", CLIPBOARD);
	let message = page.getByRole("complementary", { name: "Chat", exact: true })
		.locator("[data-chat-markdown]").filter({ hasText: "Here is the helper." });
	let copy = message.getByRole("button", { name: "Copy code" });
	await expect(copy).toBeVisible();
	expect(await hoverTooltips(page, copy)).toEqual(["Copy code"]);
	await expect(copy).not.toHaveAttribute("title");
});

test("a pressed icon button with a native title keeps it back until the pointer leaves", async ({ join }) => {
	let page = await join("ana");
	let bold = page.getByRole("complementary", { name: "Chat", exact: true })
		.getByRole("toolbar", { name: "Formatting" }).getByRole("button", {
			name: "Bold",
			exact: true,
		});
	await expect(bold).toHaveAttribute("title", "Bold");
	expect((await hoverTooltips(page, bold)).map(text => text.startsWith("Bold"))).toEqual([true]);
	await expect(bold).not.toHaveAttribute("title");
	await bold.click();
	// The pointer rests on it: the browser would draw the title now, after the tooltip went.
	await bold.hover({ position: { x: 4, y: 4 } });
	await page.waitForTimeout(600);
	await expect(bold).not.toHaveAttribute("title");
	expect(await visibleTooltips(page)).toEqual([]);
	await page.mouse.move(1, 1);
	await expect(bold).toHaveAttribute("title", "Bold");
});

test("a document's code block has a Copy code button that copies its source as written", async ({ join, seed }) => {
	await seed(`\`\`\`ts\n${SOURCE}\n\`\`\`\n\nAfter the block.\n`);
	let page = await join("ana", CLIPBOARD);
	let block = codeBlock(page);
	await expect(block.locator("[data-file]")).toBeVisible();
	await block.hover();
	let copy = block.getByRole("button", { name: "Copy code" });
	await expect(copy).toBeVisible();
	expect(await hoverTooltips(page, copy)).toEqual(["Copy code"]);
	await expect(copy).not.toHaveAttribute("title");

	await copy.click();
	await expect(block.getByRole("button", { name: "Copied" })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SOURCE);
	// Pressing it leaves the caret where it was: the source stays hidden behind its preview.
	await expect(block.locator("[data-plan-source]")).toBeHidden();
	await expect(block.getByRole("button", { name: "Copy code" })).toBeVisible({ timeout: 6_000 });
});

test("the keyboard reaches a document code block's Copy code, and Enter copies", async ({ join, seed }) => {
	await seed("```\nplain words\n\twith a tab\n```\n");
	let page = await join("ana", CLIPBOARD);
	let block = codeBlock(page);
	let copy = block.getByRole("button", { name: "Copy code" });
	await expect(copy).toBeAttached();
	// It is the tab stop before the block's language menu.
	await block.getByRole("button", { name: /^Code language/ }).focus();
	await page.keyboard.press("Shift+Tab");
	await expect(copy).toBeFocused();
	// Focus reveals it, and the tooltip names it once.
	await expect.poll(() => copy.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
	await expect.poll(() => visibleTooltips(page)).toEqual(["Copy code"]);
	await page.keyboard.press("Enter");
	await expect(block.getByRole("button", { name: "Copied" })).toBeFocused();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		"plain words\n\twith a tab",
	);
});

test("a document copy that cannot be made says Couldn't copy, and offers the copy again", async ({ join, page, seed }) => {
	await seed(`\`\`\`ts\n${SOURCE}\n\`\`\`\n`);
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.addInitScript(() => {
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: () => Promise.reject(new Error("refused")) },
		});
	});
	await join("ana");
	let block = codeBlock(page);
	await block.hover();
	await block.getByRole("button", { name: "Copy code" }).click();
	let refused = block.getByRole("button", { name: "Couldn't copy" });
	await expect(refused).toBeVisible();
	await expect(refused.locator("svg.icon-danger")).toBeVisible();
	await expect(block.getByRole("button", { name: "Copy code" })).toBeVisible({ timeout: 6_000 });
	expect(errors).toEqual([]);
});

test("on a phone a document code block's Copy code is shown without hover, with a touch-sized target", async ({ join, seed }) => {
	await seed(`\`\`\`ts\n${SOURCE}\n\`\`\`\n`);
	let page = await join("ana", PHONE);
	let block = codeBlock(page);
	let copy = block.getByRole("button", { name: "Copy code" });
	await expect(copy).toBeVisible();
	await expect(page.locator(":root")).toHaveAttribute("data-plan-coarse-pointer", "");
	expect(await copy.evaluate(element => getComputedStyle(element).opacity)).toBe("1");
	let target = await copy.evaluate(button => {
		let after = getComputedStyle(button, "::after");
		return { width: parseFloat(after.width), height: parseFloat(after.height) };
	});
	expect(target.height).toBeGreaterThanOrEqual(43);
	await copy.tap();
	await expect(block.getByRole("button", { name: "Copied" })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SOURCE);
});
