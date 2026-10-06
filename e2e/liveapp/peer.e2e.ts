import { content, expect, test, written } from "../room";
import { protocolPeer } from "./peer";

test("the authenticated protocol peer sends edits through durable collaboration", async ({ browser, join, room }) => {
	let page = await join("ana");
	if (process.env.LIVEAPP_TEST_INTEGRATED === "1") {
		await page.getByRole("button", { name: "Collapse developer widget" }).click();
	}
	await content(page).click();
	await page.keyboard.type("Protocol baseline.");
	await written(page, room, /Protocol baseline\./);
	let peer = await protocolPeer(browser, new URL(page.url()).origin, room);
	try {
		await expect.poll(peer.text).toContain("Protocol baseline.");
		await peer.append(" Remote protocol edit.");
		await expect(content(page)).toContainText("Remote protocol edit.");
		await written(page, room, /Protocol baseline\. Remote protocol edit\./);
	} finally {
		peer.close();
	}
});
