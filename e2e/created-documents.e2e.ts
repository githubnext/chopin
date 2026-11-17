import { createChannel, testChannelPath, testChannelSlug } from "./database";
import { expect, test } from "./room";

function portOf(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

test(
	"a document the Planner created is one Chat line whose title opens it in the same tab",
	async ({ baseURL, join, room, seed }) => {
		let created = crypto.randomUUID();
		await createChannel(portOf(baseURL!), created);
		let title = `Test ${created.slice(0, 8)}`;
		await seed("# Whole app\n\nEvery feature at once.\n", {
			transcript: [
				{
					id: "msg-mona",
					author: { kind: "member", handle: "mona_acme" },
					text: "Split this into one document per feature.",
					ts: 1_700_000_000,
				},
				{
					id: "notice-created",
					author: { kind: "system" },
					text: `chopin created ${title} for @mona_acme.`,
					ts: 1_700_000_010,
					document: { channelId: created, title, path: testChannelPath(created) },
				},
			],
		});

		let page = await join("mona_acme");
		let pane = page.getByRole("complementary", { name: "Chat" });
		let line = pane.locator(`[data-chat-created-document="${created}"]`);
		// Chat drops the `@` from a handle in a system line, as it does everywhere.
		await expect(line).toHaveText(`chopin created ${title} for mona_acme.`);
		let link = line.getByRole("link", { name: title, exact: true });
		await expect(link).toHaveAttribute("href", testChannelPath(created));
		await expect(link).not.toHaveAttribute("target", "_blank");

		await link.click();
		await expect(page).toHaveURL(new RegExp(`${testChannelSlug(created)}$`));
	},
);
