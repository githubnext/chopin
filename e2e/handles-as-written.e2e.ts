/**
 * A name in Chat reads as GitHub has it, the way Slack shows a username: capitals, digits,
 * underscores and hyphens kept, and the Planner as `chopin`, the name `@chopin` addresses.
 */
import { expect, test } from "./room";

import type { Page } from "@playwright/test";

function chat(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

test("Chat names mona_acme, Hubot-Bot and the Planner exactly as written", async ({ join, seed }) => {
	await seed("# Pilot rollout\n\nThe rollout goes team by team.\n", {
		transcript: [
			{
				id: "m1",
				author: { kind: "member", handle: "mona_acme" },
				text: "Can we keep the pilot to the docs team?",
				ts: 1_700_000_000,
				reactions: [{ emoji: "✅", handles: ["Hubot-Bot", "mona_acme"] }],
			},
			{
				id: "m2",
				author: { kind: "member", handle: "Hubot-Bot" },
				// Sent before the name was drawn in lower case; it still reads as an address.
				text: "@Chopin what would a review need?",
				to: "planner",
				ts: 1_700_000_060,
			},
			{
				id: "a1",
				author: { kind: "agent" },
				text: "A short survey of the docs team.",
				ts: 1_700_000_090,
			},
		],
	});
	let page = await join("ana");
	let names = chat(page).locator("[data-chat-entry] [data-speaker-name]");

	await expect(names).toHaveText(["mona_acme", "Hubot-Bot", "chopin"]);
	await expect(chat(page).locator('[data-speaker-kind="agent"] [data-chat-avatar] [role="img"]'))
		.toHaveAccessibleName("chopin");

	let asked = chat(page).locator('[data-chat-message-id="m2"]');
	await expect(asked.locator(".chat-mention")).toHaveText("@chopin");
	await expect(asked).not.toContainText("@Chopin");

	await expect(
		chat(page).getByRole("button", {
			name: "Hubot-Bot and mona_acme reacted with ✅",
			exact: true,
		}),
	).toBeVisible();
});
