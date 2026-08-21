/** Selection contracts at the compact workspace boundary. */

import { content, expect, test, written } from "./room";

import type { Locator } from "@playwright/test";

const PROSE = "Room state lives on disk as MDX beside the transcript.";
const SECOND = "A second block remains after the marked passage.";
const TWO_BLOCKS = `${PROSE}\n\n${SECOND}\n`;
const LONG_PLAN = Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}.`).join(
	"\n\n",
);

type Activation = "keyboard" | "pointer" | "programmatic";

async function activateDestination(
	nav: Locator,
	name: "Document" | RegExp,
	activation: Activation,
): Promise<void> {
	let button = nav.getByRole("button", { name });
	if (activation === "keyboard") {
		await button.focus();
		await button.press("Enter");
	} else if (activation === "programmatic") {
		await button.evaluate(element => (element as HTMLElement).click());
	} else await button.click();
}

for (
	let example of [
		{
			activation: "pointer",
			token: "POINTERDESTINATION",
		},
		{
			activation: "keyboard",
			token: "KEYBOARDDESTINATION",
		},
		{
			activation: "programmatic",
			token: "PROGRAMMATICDESTINATION",
		},
	] as const
) {
	test(`${example.activation} compact navigation lets a fresh editor click replace the saved selection`, async ({ join, room, seed }) => {
		await seed(TWO_BLOCKS);
		let page = await join("ana", { viewport: { width: 390, height: 844 } });
		let nav = page.getByRole("navigation", { name: "Workspace view" });
		let paragraphs = page.locator('[aria-label="editable markdown"] > p');
		let first = paragraphs.first();
		let second = paragraphs.nth(1);

		await first.selectText();
		await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe(PROSE);
		await activateDestination(nav, /^Decisions/, example.activation);
		await expect(page.locator("#workspace-decisions-heading")).toBeFocused();
		await activateDestination(nav, "Document", example.activation);
		await expect(page.locator("#workspace-plan-heading")).toBeFocused();

		await second.click();
		await page.evaluate(() => new Promise(requestAnimationFrame));
		await page.keyboard.type(example.token);

		await expect(first).toHaveText(PROSE);
		await expect(second).toContainText(example.token);
		expect((await second.textContent())?.replace(example.token, "")).toBe(SECOND);
		await written(
			page,
			room,
			new RegExp(`^A second block[^\\n]*${example.token}[^\\n]*$`, "m"),
		);
	});
}

for (
	let viewport of [
		{ height: 568, width: 320 },
		{ height: 844, width: 390 },
	]
) {
	test(`${viewport.width}×${viewport.height} keyboard navigation resumes the Plan selection after every destination`, async ({ join, room, seed }) => {
		await seed(LONG_PLAN);
		let page = await join("ana", { viewport });
		let nav = page.getByRole("navigation", { name: "Workspace view" });
		let selected = content(page).getByText("Paragraph 9.", { exact: true });
		let selectedBlock = page.locator('[aria-label="editable markdown"] > p').nth(8);
		await selected.selectText();

		await activateDestination(nav, /^Conversation/, "keyboard");
		await expect(page.locator("#workspace-conversation-heading")).toBeFocused();
		await expect(page.locator("main")).toBeHidden();
		await activateDestination(nav, /^Decisions/, "keyboard");
		await expect(page.locator("#workspace-decisions-heading")).toBeFocused();
		await activateDestination(nav, "Document", "keyboard");
		await expect(page.locator("#workspace-plan-heading")).toBeFocused();

		await page.keyboard.press("Tab");
		await expect(content(page)).toBeFocused();
		await page.keyboard.type("KEYBOARDRESUME");

		await expect(selectedBlock).toHaveText("KEYBOARDRESUME");
		await written(
			page,
			room,
			/^Paragraph 8\.\n\nKEYBOARDRESUME\n\nParagraph 10\.$/m,
		);
	});
}
