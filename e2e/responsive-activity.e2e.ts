import { expect, test } from "./room";
import { expectNoHorizontalOverflow, RESPONSIVE_SOURCE } from "./responsive";

import type { Page } from "@playwright/test";

async function interceptBusyHistory(page: Page) {
	let send: ((frame: Record<string, unknown>) => void) | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		send = frame => route.send(JSON.stringify(frame));
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message !== "string") return route.send(message);
			let frame = JSON.parse(message) as Record<string, unknown>;
			if (frame.kind === "chat:history") {
				frame = {
					...frame,
					busy: true,
					turn: {
						id: "hydrated-turn",
						handle: "ana",
						responded: false,
						started: 1_700_000_000,
					},
				};
			}
			route.send(JSON.stringify(frame));
		});
	});
	return { send: (frame: Record<string, unknown>) => send?.(frame) };
}

test("the compact room header preserves long identity and secondary actions", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 320, height: 568 });
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		let session = await response.json() as Record<string, unknown>;
		await route.fulfill({ response, json: { ...session, agent: true } });
	});
	await page.route("**/api/repositories/octo-org/score/documents/**", async route => {
		let response = await route.fetch();
		let detail = await response.json() as {
			channel: Record<string, unknown>;
			repository: Record<string, unknown>;
		};
		await route.fulfill({
			response,
			json: {
				...detail,
				channel: {
					...detail.channel,
					title: "A channel title long enough to require compact overflow handling",
				},
				repository: {
					...detail.repository,
					fullName: "octo-organization/a-repository-name-that-cannot-fit",
				},
			},
		});
	});
	page = await join("an-extraordinarily-long-member-handle");
	await join("ben-with-a-long-handle");
	await join("cass-with-a-long-handle");
	await join("dee-with-a-long-handle");
	await join("eli-with-a-long-handle");
	let header = page.getByRole("banner");
	await expect(header.getByTitle("octo-organization/a-repository-name-that-cannot-fit"))
		.toBeVisible();
	await expect(
		header.getByTitle("A channel title long enough to require compact overflow handling"),
	).toBeVisible();
	let people = header.getByRole("group", { name: /People here:/ });
	await expect(people).toBeVisible();
	let faces = people.locator('img, [role="img"]');
	await expect(faces).toHaveCount(5);
	let visibleFaces = await faces.evaluateAll(faces =>
		faces.filter(face => face.getBoundingClientRect().width > 0).length
	);
	expect(visibleFaces).toBe(3);
	await expect(people.getByText("+2")).toBeVisible();
	await expect(header.getByRole("button", { name: "More room actions" })).toHaveCount(0);
	await expect(header.getByRole("button", { name: /planner session/i })).toHaveCount(0);
	await expect(header.getByRole("status")).toHaveCount(0);
	await expect(header).not.toContainText("connected");
	await expect(header.getByRole("menu")).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test("a compact header hides connection state when no room action is available", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	let header = page.getByRole("banner");
	await expect(header.getByRole("button", { name: "More room actions" })).toHaveCount(0);
	await expect(header.getByRole("status")).toHaveCount(0);
	await expect(header).not.toContainText("connected");
});

test("busy history exposes working state without creating false unread activity", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 390, height: 844 });
	let socket = await interceptBusyHistory(page);
	page = await join("ana");
	let conversation = page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Conversation/ });
	await expect(conversation).toHaveAccessibleName("Conversation, Planner working");
	await expect(conversation).not.toContainText("Working");
	await expectNoHorizontalOverflow(page);
	socket.send({ kind: "chat:state", ts: 0, busy: false });
	socket.send({
		kind: "chat:state",
		ts: 0,
		busy: true,
		turn: { id: "new-turn", handle: "ana", responded: false, started: 1_700_000_001 },
	});
	await expect(conversation).toHaveAccessibleName("Conversation, Planner working");
});

test("a closed desktop Conversation toggle exposes initial planner activity", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.addInitScript(() => localStorage.setItem("chopin:pane:chat:open", "false"));
	await interceptBusyHistory(page);
	page = await join("ana");
	let toggle = page.getByRole("button", { name: "Show conversation pane, Planner working" });
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(toggle.locator('span[aria-hidden="true"]')).toHaveCount(1);
});

test("a closed desktop Conversation tab keeps unread activity visible", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.addInitScript(() => localStorage.setItem("chopin:pane:chat:open", "false"));
	page = await join("ana");
	let sender = await join("ben");
	await sender.getByPlaceholder("Message the room — use @ai to ask Planner").fill(
		"A new room message",
	);
	await sender.getByRole("button", { name: "Send message" }).click();
	let toggle = page.getByRole("button", { name: "Show conversation pane, 1 unread" });
	await expect(toggle).toBeVisible();
	await expect(toggle.locator('span[aria-hidden="true"]')).toHaveCount(1);
	await toggle.click();
	await expect(page.getByRole("heading", { name: "Conversation" })).toBeFocused();
	await expect(page.getByRole("button", { name: "Hide conversation pane" })).toBeVisible();
});

test("completed tool names wrap instead of truncating", async ({ join, seed }) => {
	let toolName = "averylongcompletedtoolnamethatmustwrapwithoutbeingtruncatedinsideconversation";
	await seed(RESPONSIVE_SOURCE, {
		transcript: [{
			id: "tool-entry",
			author: { kind: "agent" },
			text: "Finished.",
			ts: 1_700_000_000,
			tools: [{ id: "long-tool", name: toolName, status: "done", took: 38 }],
		}],
	});
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /Conversation/ }).click();
	await page.getByRole("button", { name: /1 tool/ }).click();
	let name = page.getByText(`A${toolName.slice(1)}`);
	let geometry = await name.evaluate(element => ({
		clientWidth: element.clientWidth,
		height: element.getBoundingClientRect().height,
		scrollWidth: element.scrollWidth,
	}));
	expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
	expect(geometry.height).toBeGreaterThan(24);
});

test("conversation activity appears while closed and clears when opened", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE, {
		transcript: [{
			id: "history",
			author: { kind: "member", handle: "cass" },
			text: "An older room message",
			ts: 1_700_000_000,
		}],
	});
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	await expect(nav.getByRole("button", { name: "Conversation" })).toBeVisible();
	let sender = await join("ben");
	await sender.getByPlaceholder("Message the room — use @ai to ask Planner").fill(
		"A new room message",
	);
	await sender.getByRole("button", { name: "Send message" }).click();
	await expect(nav.getByRole("button", { name: "Conversation, 1 unread" })).toBeVisible();
	await nav.getByRole("button", { name: /Conversation/ }).click();
	await expect(nav.getByRole("button", { name: "Conversation" })).toBeVisible();
});

test("a Conversation draft survives Chromium orientation emulation", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /Conversation/ }).click();
	let textarea = page.getByPlaceholder("Message the room — use @ai to ask Planner");
	await textarea.fill("Keep this draft");
	await page.setViewportSize({ width: 844, height: 390 });
	await expect(textarea).toHaveValue("Keep this draft");
	await expectNoHorizontalOverflow(page);
});
