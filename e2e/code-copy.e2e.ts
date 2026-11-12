/**
 * One hover text names a control. Chat's code block Copy is named by its own tooltip, never a second
 * one beside it or a native title under it. An icon button that also carries a native title keeps it
 * held back while it is pressed, so the browser's own hover text never follows the tooltip.
 */

import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Locator, Page } from "@playwright/test";

const CLIPBOARD = { permissions: ["clipboard-read", "clipboard-write"] };
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
