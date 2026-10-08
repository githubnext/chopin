import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Locator } from "@playwright/test";

function transcript(): Chat.Entry[] {
	return Array.from({ length: 30 }, (_, index) => ({
		id: `message-${index}`,
		author: { kind: "member" as const, handle: index % 2 ? "ana" : "ben" },
		text: `Message ${index} about the rollout plan and what it still needs.`,
		ts: 1_700_000_000 + index,
	}));
}

async function gap(scroller: Locator): Promise<number> {
	return scroller.evaluate(element =>
		element.scrollHeight - element.scrollTop - element.clientHeight
	);
}

/** A row growing in place, as an expanded work disclosure or a changing card does. */
async function growLastRow(scroller: Locator): Promise<void> {
	await scroller.evaluate(element => {
		let rows = element.querySelectorAll(".chat-message-body");
		let filler = document.createElement("div");
		filler.style.height = "80px";
		rows[rows.length - 1]!.append(filler);
	});
}

test("a long transcript follows a growing row only for a reader at the bottom", async ({ join, seed }) => {
	await seed("# Anchoring\n", { transcript: transcript() });
	let page = await join("ana");
	let chat = page.getByRole("complementary", { name: "Chat", exact: true });
	await expect(chat.getByText("Message 29 about the rollout plan")).toBeVisible();
	let scroller = chat.locator("[data-chat-stack]").locator("..");
	expect(await scroller.evaluate(element => element.scrollHeight > element.clientHeight * 1.5))
		.toBe(true);
	await expect.poll(() => gap(scroller)).toBeLessThanOrEqual(2);

	await growLastRow(scroller);
	await expect.poll(() => gap(scroller)).toBeLessThanOrEqual(2);

	await scroller.evaluate(element => element.scrollTop -= 300);
	let reading = await scroller.evaluate(element => element.scrollTop);
	await growLastRow(scroller);
	await page.waitForTimeout(200);
	expect(await scroller.evaluate(element => element.scrollTop)).toBe(reading);
	expect(await gap(scroller)).toBeGreaterThan(300);
});
