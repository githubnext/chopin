import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

async function enablePlanner(page: Page): Promise<void> {
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		let session = await response.json() as Record<string, unknown>;
		await route.fulfill({ response, json: { ...session, agent: true } });
	});
}

/** github.com is not reachable from the harness; answer with a flat tile, and fail one login. */
async function stubAvatars(page: Page): Promise<void> {
	await page.route("https://github.com/*.png*", route => {
		let login = new URL(route.request().url()).pathname.slice(1, -".png".length);
		if (login === "bo") return route.abort();
		return route.fulfill({
			contentType: "image/svg+xml",
			body:
				`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="hsl(${
					login.charCodeAt(0) * 11 % 360
				} 40% 55%)"/></svg>`,
		});
	});
}

function names(page: Page) {
	return chatPane(page).getByRole("listbox", { name: "Mentions" }).getByRole("option")
		.evaluateAll(options => options.map(option => option.getAttribute("aria-label")));
}

test("the @ picker lists the Planner, people here and past authors, and sends only @chopin to the Planner", async ({ join, page }) => {
	let sent: Chat.Send[] = [];
	await enablePlanner(page);
	await stubAvatars(page);
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				try {
					let frame = JSON.parse(message) as Chat.Send;
					if (frame.kind === "chat:send") sent.push(frame);
				} catch {
					// The server still owns malformed and non-chat frames.
				}
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});

	let ana = await join("ana");
	// `bo` speaks and leaves, so appears only as a Chat author.
	let leaving = await join("bo");
	let bo = chatPane(leaving).getByPlaceholder("Use @chopin to ask Chopin");
	await bo.fill("Morning, both.");
	await chatPane(leaving).getByRole("button", { name: "Send message" }).click();
	await expect(chatPane(ana).getByText("Morning, both.")).toBeVisible();
	await leaving.context().close();
	await join("cy");
	await expect(ana.getByRole("group", { name: /People here: ana, cy$/ })).toBeVisible();

	let chat = chatPane(ana);
	let draft = chat.getByPlaceholder("Use @chopin to ask Chopin");
	let list = chat.getByRole("listbox", { name: "Mentions" });
	await expect(draft).toHaveAttribute("role", "combobox");

	await draft.fill("Ask @");
	await expect(list).toBeVisible();
	await expect(draft).toHaveAttribute("aria-expanded", "true");
	expect(await names(ana)).toEqual(["chopin", "cy", "bo"]);
	await expect(list.getByRole("option", { name: "cy" }).locator("img")).toHaveAttribute(
		"src",
		"https://github.com/cy.png?size=40",
	);
	// The failed photograph falls back to the login's initial.
	await expect(list.getByRole("option", { name: "bo" }).locator("img")).toHaveCount(0);
	await expect(list.getByRole("option", { name: "bo" })).toHaveText("bbo");
	await expect(list.getByRole("option", { name: "chopin" })).toHaveAttribute(
		"aria-selected",
		"true",
	);

	await draft.press("ArrowDown");
	await expect(list.getByRole("option", { name: "cy" })).toHaveAttribute("aria-selected", "true");
	await expect(draft).toHaveAttribute(
		"aria-activedescendant",
		(await list.getByRole("option", { name: "cy" }).getAttribute("id"))!,
	);
	await draft.press("ArrowUp");
	await draft.press("ArrowUp");
	await expect(list.getByRole("option", { name: "bo" })).toHaveAttribute("aria-selected", "true");

	await draft.pressSequentially("C");
	expect(await names(ana)).toEqual(["chopin", "cy"]);
	await draft.press("Backspace");
	await draft.pressSequentially("ch");
	expect(await names(ana)).toEqual(["chopin"]);
	await draft.press("Enter");
	await expect(draft).toHaveValue("Ask @chopin ");
	await expect(list).toHaveCount(0);
	await expect(draft).toBeFocused();
	await draft.pressSequentially("what is open?");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => sent.at(-1)?.text).toBe("Ask @chopin what is open?");
	expect(sent.at(-1)?.to).toBe("planner");

	await draft.fill("Thanks @cy");
	await draft.press("Tab");
	await expect(draft).toHaveValue("Thanks @cy ");
	await draft.pressSequentially("for looking.");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => sent.at(-1)?.text).toBe("Thanks @cy for looking.");
	expect(sent.at(-1)?.to).toBe("room");

	await draft.fill("Mail a@b");
	await expect(list).toHaveCount(0);
	await draft.fill("@c");
	await expect(list).toBeVisible();
	await draft.press("Escape");
	await expect(list).toHaveCount(0);
	await expect(draft).toHaveValue("@c");
	await draft.fill("@zzz");
	await expect(list).toHaveCount(0);
	await draft.press("Enter");
	await expect.poll(() => sent.at(-1)?.text).toBe("@zzz");
});

test("the @ picker stays inside a narrow Chat panel", async ({ join, page }) => {
	await enablePlanner(page);
	await stubAvatars(page);
	await page.setViewportSize({ width: 390, height: 520 });
	let opened = await join("ana");
	await opened.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /Chat/ }).click();
	let chat = chatPane(opened);
	let draft = chat.getByPlaceholder("Use @chopin to ask Chopin");
	await draft.fill("@");
	let list = chat.locator("[data-chat-mention-picker]");
	await expect(list).toBeVisible();
	expect(await names(opened)).toEqual(["chopin"]);
	await expectInsideViewport(list);
	await expectNoHorizontalOverflow(opened);
	let panel = await chat.boundingBox();
	let box = await list.boundingBox();
	expect(box!.x).toBeGreaterThanOrEqual(panel!.x);
	expect(box!.x + box!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
});
