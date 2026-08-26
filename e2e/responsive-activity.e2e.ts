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

test("the compact room header preserves member identity and secondary actions", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 320, height: 568 });
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		let session = await response.json() as Record<string, unknown>;
		await route.fulfill({ response, json: { ...session, agent: true } });
	});
	page = await join("an-extraordinarily-long-member-handle");
	await join("ben-with-a-long-handle");
	await join("cass-with-a-long-handle");
	await join("dee-with-a-long-handle");
	await join("eli-with-a-long-handle");
	let header = page.getByRole("banner");
	await expect(header.locator('[aria-label^="Document:"]')).toBeVisible();
	await expect(header.getByRole("button", { name: /^Actions for / })).toBeVisible();
	await expect(page.getByRole("button", { name: "Open Projects sidebar" })).toBeVisible();
	let people = header.getByRole("group", { name: /People here:/ });
	await expect(people).toBeVisible();
	await expect(header.getByRole("button", { name: "More room actions" })).toHaveCount(0);
	await expect(header.getByRole("button", { name: /planner session/i })).toHaveCount(0);
	await expect(header.getByRole("status")).toHaveCount(0);
	await expect(header.getByRole("menu")).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test("a compact header hides connection state when no room action is available", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	let header = page.getByRole("banner");
	await expect(header.getByRole("button", { name: "More room actions" })).toHaveCount(0);
	await expect(header.getByRole("status")).toHaveCount(0);
});

test("busy history exposes working state without creating false unread activity", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 390, height: 844 });
	let socket = await interceptBusyHistory(page);
	page = await join("ana");
	let chat = page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ });
	await expect(chat).toHaveAccessibleName("Chat, Planner working");
	await expectNoHorizontalOverflow(page);
	socket.send({ kind: "chat:state", ts: 0, busy: false });
	socket.send({
		kind: "chat:state",
		ts: 0,
		busy: true,
		turn: { id: "new-turn", handle: "ana", responded: false, started: 1_700_000_001 },
	});
	await expect(chat).toHaveAccessibleName("Chat, Planner working");
});

test("a closed desktop Chat toggle exposes initial planner activity", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.addInitScript(() => localStorage.setItem("chopin:pane:chat:open", "false"));
	await interceptBusyHistory(page);
	page = await join("ana");
	let toggle = page.getByRole("button", { name: "Show chat pane, Planner working" });
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(toggle.locator('span[aria-hidden="true"]')).toHaveCount(1);
});

test("a closed desktop Chat tab keeps unread activity visible", async ({ join, page, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.addInitScript(() => localStorage.setItem("chopin:pane:chat:open", "false"));
	page = await join("ana");
	await page.getByRole("button", { name: "Show chat pane" }).hover();
	await page.evaluate(() => {
		let record = { ends: 0, starts: 0 };
		Reflect.set(window, "__feedbackCountTransitions", record);
		document.addEventListener("transitionstart", event => {
			if (
				event.target instanceof Element
				&& event.target.matches('[data-motion-feedback="count"]')
			) record.starts++;
		}, true);
		document.addEventListener("transitionend", event => {
			if (
				event.target instanceof Element
				&& event.target.matches('[data-motion-feedback="count"]')
			) record.ends++;
		}, true);
	});
	let sender = await join("ben");
	await sender.getByPlaceholder("Use @chopin to ask Chopin").fill(
		"A new room message",
	);
	await sender.getByRole("button", { name: "Send message" }).click();
	let toggle = page.getByRole("button", { name: "Show chat pane, 1 unread" });
	await expect(toggle).toBeVisible();
	await expect(toggle.locator('span[aria-hidden="true"]')).toHaveCount(1);
	let count = toggle.locator('[data-motion-feedback="count"]');
	expect(
		await count.evaluate(element =>
			getComputedStyle(element).transitionDuration.split(",").some(duration =>
				parseFloat(duration) > 0
			)
		),
	).toBe(true);
	await expect.poll(() =>
		page.evaluate(() => {
			let record = Reflect.get(window, "__feedbackCountTransitions") as {
				ends: number;
				starts: number;
			};
			return record.starts > 0 && record.ends >= record.starts;
		})
	).toBe(true);
	let settled = await count.evaluate(element => ({
		opacity: getComputedStyle(element).opacity,
		transform: getComputedStyle(element).transform,
	}));
	let starts = await page.evaluate(() => {
		let record = Reflect.get(window, "__feedbackCountTransitions") as { starts: number };
		return record.starts;
	});
	await page.keyboard.press("Tab");
	await count.evaluate(() =>
		new Promise<void>(resolve => {
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		})
	);
	await expect(count).toHaveCSS("transition-duration", "0s");
	expect(
		await count.evaluate(element => ({
			opacity: getComputedStyle(element).opacity,
			transform: getComputedStyle(element).transform,
		})),
	).toEqual(settled);
	expect(
		await page.evaluate(() => {
			let record = Reflect.get(window, "__feedbackCountTransitions") as { starts: number };
			return record.starts;
		}),
	).toBe(starts);
	await toggle.click();
	await expect(page.getByRole("heading", { name: "Chat" })).toBeFocused();
	await expect(page.getByRole("button", { name: "Hide chat pane" })).toBeVisible();
});

test("completed tool names wrap in compact Chat", async ({ join, seed }) => {
	let toolName = "averylongcompletedtoolnamethatmustwrapwithoutbeingtruncatedinsidechat";
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
		.getByRole("button", { name: /Chat/ }).click();
	await page.getByRole("button", { name: /1 tool/ }).click();
	let name = page.getByText(`A${toolName.slice(1)}`);
	let fragments = await name.evaluate(element => {
		let range = document.createRange();
		range.selectNodeContents(element);
		return range.getClientRects().length;
	});
	expect(fragments).toBeGreaterThan(1);
	await expectNoHorizontalOverflow(page);
});

test("chat activity appears while closed and clears when opened", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE, {
		transcript: [{
			id: "history",
			author: { kind: "member", handle: "cass" },
			text: "An older room message",
			ts: 1_700_000_000,
		}],
	});
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	await page.emulateMedia({ reducedMotion: "reduce" });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	let chat = nav.getByRole("button", { name: "Chat" });
	await expect(chat).toBeVisible();
	await chat.hover();
	let sender = await join("ben");
	await sender.getByPlaceholder("Use @chopin to ask Chopin").fill(
		"A new room message",
	);
	await sender.getByRole("button", { name: "Send message" }).click();
	chat = nav.getByRole("button", { name: "Chat, 1 unread" });
	await expect(chat).toBeVisible();
	await expect(chat.locator('[data-motion-feedback="count"]')).toHaveCSS(
		"transition-duration",
		"0s",
	);
	await nav.getByRole("button", { name: /Chat/ }).click();
	await expect(nav.getByRole("button", { name: "Chat" })).toBeVisible();
});

test("keyboard-created actionable feedback stays immediate", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	let nav = page.getByRole("navigation", { name: "Workspace view" });
	await page.keyboard.press("Tab");
	let sender = await join("ben");
	await sender.getByPlaceholder("Use @chopin to ask Chopin").fill(
		"A keyboard-modality room message",
	);
	await sender.getByRole("button", { name: "Send message" }).click();
	let chat = nav.getByRole("button", { name: "Chat, 1 unread" });
	await expect(chat).toBeVisible();
	await expect(chat.locator('[data-motion-feedback="count"]')).toHaveCSS(
		"transition-duration",
		"0s",
	);
});

test("a Chat draft survives Chromium orientation emulation", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("ana", { viewport: { width: 390, height: 844 } });
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /Chat/ }).click();
	let textarea = page.getByPlaceholder("Use @chopin to ask Chopin");
	await textarea.fill("Keep this draft");
	await page.setViewportSize({ width: 844, height: 390 });
	await expect(textarea).toHaveValue("Keep this draft");
	await expectNoHorizontalOverflow(page);
});
