import { expect, test } from "@playwright/test";
import { load, prepareRoomSource } from "./room-source-native";

import type { ConversationPlan } from "../../packages/protocol/index";
import type { Page } from "@playwright/test";

test.beforeAll(prepareRoomSource);

let FAILURE = "Message analysis failed. You can retry from Chat.";
let CARD = "A conversation card was updated.";

function state(
	revision: number,
	queue: ConversationPlan.QueueItem[] = [],
	events: ConversationPlan.Event[] = [],
): ConversationPlan.State {
	return { schemaVersion: 1, revision, queue, events, threads: [], analysis: [] };
}

async function receive(page: Page, value: ConversationPlan.State) {
	await page.evaluate(state =>
		window.roomSourceProbe.receive({
			kind: "conversation-plan:snapshot",
			state,
			jobs: [],
			ts: 1,
		}), value);
	await flush(page);
}

function region(page: Page) {
	return page.locator('p[role="status"][aria-live="polite"]');
}

test("a subsequent Jev failure appears in the actual host live region", async ({ page }) => {
	let errors = await load(page);
	await receive(page, state(1));
	await receive(page, state(2, [{ messageId: "m1", status: "failed", attempts: 1 }]));
	await expect(region(page)).toHaveText(FAILURE);
	await expect(region(page)).toHaveClass(/sr-only/);
	expect(errors).toEqual([]);
});

async function flush(page: Page) {
	await page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
}

function event(
	id: string,
	type: "thread.opened" | "card.linked" | "option.added",
): ConversationPlan.Event {
	let base = {
		id,
		threadId: "unrendered-thread",
		observedThreadVersion: 0,
		origin: "human" as const,
		actor: { kind: "member" as const, handle: "ana" },
		at: 1,
	};
	if (type === "thread.opened") return { ...base, type, question: "Which rollout?" };
	if (type === "card.linked") return { ...base, type, questionnaireId: "unrendered-card" };
	return { ...base, type, contribution: { id, text: "Pilot", authoring: "quoted" } };
}

function failed(messageId = "m1"): ConversationPlan.QueueItem {
	return { messageId, status: "failed", attempts: 1 };
}

declare global {
	interface Window {
		conversationAnnouncementProbe: {
			region: Element;
			child: Element | null;
			changes: number;
			observer: MutationObserver;
		};
	}
}

async function observe(page: Page) {
	await region(page).evaluate(element => {
		window.conversationAnnouncementProbe?.observer.disconnect();
		let observer = new MutationObserver(records => {
			window.conversationAnnouncementProbe.changes += records.length;
		});
		window.conversationAnnouncementProbe = {
			region: element,
			child: element.firstElementChild,
			changes: 0,
			observer,
		};
		observer.observe(element, { childList: true, subtree: true, characterData: true });
	});
}

async function changes(page: Page) {
	await flush(page);
	return page.evaluate(() => window.conversationAnnouncementProbe.changes);
}

test("the first historical snapshot stays silent, including persistent failures", async ({ page }) => {
	let errors = await load(page);
	await receive(page, state(40, [failed()], [event("old-update", "option.added")]));
	await expect(region(page)).toHaveText("");
	await observe(page);
	await receive(page, state(41, [failed()], [event("old-update", "option.added")]));
	expect(await changes(page)).toBe(0);
	await expect(region(page)).toHaveText("");
	expect(errors).toEqual([]);
});

test("stale, equal and persistent failed snapshots do not mutate the announcement", async ({ page }) => {
	let errors = await load(page);
	await receive(page, state(1));
	await receive(page, state(2, [failed()]));
	await expect(region(page)).toHaveText(FAILURE);
	await observe(page);
	await receive(page, state(1, [failed("stale-failure")]));
	await receive(page, state(2, [failed("equal-failure")]));
	expect(await changes(page)).toBe(0);
	await receive(page, state(3, [failed("equal-failure")]));
	expect(await changes(page)).toBe(0);
	await expect(region(page)).toHaveText(FAILURE);
	expect(errors).toEqual([]);
});

test("retry then repeat failure replaces the descendant while preserving the live region", async ({ page }) => {
	let errors = await load(page);
	await receive(page, state(1));
	await receive(page, state(2, [failed()]));
	await expect(region(page)).toHaveText(FAILURE);
	await observe(page);
	await receive(page, state(3, [{ messageId: "m1", status: "pending", attempts: 2 }]));
	expect(await changes(page)).toBe(0);
	await receive(page, state(4, [{ messageId: "m1", status: "failed", attempts: 2 }]));
	await expect(region(page)).toHaveText(FAILURE);
	expect(await changes(page)).toBeGreaterThan(0);
	expect(
		await region(page).evaluate(element => ({
			sameRegion: element === window.conversationAnnouncementProbe.region,
			newChild: element.firstElementChild !== window.conversationAnnouncementProbe.child,
			oldChildDetached: window.conversationAnnouncementProbe.child?.isConnected === false,
		})),
	).toEqual({ sameRegion: true, newChild: true, oldChildDetached: true });
	expect(errors).toEqual([]);
});

test("accepted card updates announce while thread openings and card links stay quiet", async ({ page }) => {
	let errors = await load(page);
	await receive(page, state(1));
	await observe(page);
	let opened = event("opened", "thread.opened");
	let linked = event("linked", "card.linked");
	await receive(page, state(2, [], [opened]));
	await receive(page, state(3, [], [opened, linked]));
	expect(await changes(page)).toBe(0);
	await expect(region(page)).toHaveText("");
	await receive(page, state(4, [], [opened, linked, event("option", "option.added")]));
	await expect(region(page)).toHaveText(CARD);
	expect(await changes(page)).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

test("a simultaneous failure wins over card growth and the card update is not replayed", async ({ page }) => {
	let errors = await load(page);
	await receive(page, state(1));
	let updated = event("updated", "option.added");
	await page.evaluate(states => {
		for (let state of states) {
			window.roomSourceProbe.receive({
				kind: "conversation-plan:snapshot",
				state,
				jobs: [],
				ts: 1,
			});
		}
	}, [state(2, [], [updated]), state(3, [failed()], [updated])]);
	await flush(page);
	await expect(region(page)).toHaveText(FAILURE);
	await observe(page);
	await receive(page, state(4, [failed()], [updated]));
	await receive(page, state(5, [], [updated]));
	expect(await changes(page)).toBe(0);
	await expect(region(page)).toHaveText(FAILURE);
	expect(errors).toEqual([]);
});

test("Planner jobs and ordinary chat delivery do not announce conversation changes", async ({ page }) => {
	let errors = await load(page);
	await receive(page, state(1));
	await observe(page);
	await page.evaluate(() => {
		window.roomSourceProbe.receive({
			kind: "conversation-plan:jobs",
			jobs: [{
				id: "failed-job",
				kind: "refine",
				target: "card",
				trigger: "m1",
				status: "failed",
				attempts: 1,
				at: "2026-10-01T10:00:00Z",
			}],
			ts: 2,
		});
		window.roomSourceProbe.receive({
			kind: "chat:history",
			entries: [{
				id: "ordinary",
				text: "A regular chat message.",
				author: { kind: "member", handle: "ana" },
				ts: 2,
			}],
			queued: [],
			busy: false,
			ts: 2,
		});
	});
	await flush(page);
	await expect(page.locator('[data-chat-message-id="ordinary"]')).toBeVisible();
	expect(await changes(page)).toBe(0);
	await expect(region(page)).toHaveText("");
	expect(errors).toEqual([]);
});

test("coalesced reset and first snapshot clear stale text without announcing historical state", async ({ page }) => {
	let errors = await load(page);
	await receive(page, state(1));
	await receive(page, state(2, [failed()]));
	await expect(region(page)).toHaveText(FAILURE);
	await observe(page);
	await page.evaluate(state => {
		window.roomSourceProbe.resetConversation();
		window.roomSourceProbe.receive({
			kind: "conversation-plan:snapshot",
			state,
			jobs: [],
			ts: 40,
		});
	}, state(40, [failed("historical")], [event("historical-update", "option.added")]));
	await flush(page);
	await expect(region(page)).toHaveText("");
	expect(
		await region(page).evaluate(element => element === window.conversationAnnouncementProbe.region),
	).toBe(true);
	await observe(page);
	await receive(
		page,
		state(41, [failed("historical")], [event("historical-update", "option.added")]),
	);
	expect(await changes(page)).toBe(0);
	await receive(
		page,
		state(42, [failed("historical"), failed("new-failure")], [
			event("historical-update", "option.added"),
		]),
	);
	await expect(region(page)).toHaveText(FAILURE);
	expect(await changes(page)).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

test("a replacement room establishes a silent history baseline before its next failure", async ({ page }) => {
	let errors = await load(page);
	await receive(page, state(1));
	await receive(page, state(2, [failed()]));
	await expect(region(page)).toHaveText(FAILURE);
	await page.evaluate(() => window.roomSourceProbe.changeRoom("room-b"));
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.snapshot().room)).toBe(
		"room-b",
	);
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.sockets.length)).toBe(2);
	await receive(page, state(100, [failed("history")], [event("history", "option.added")]));
	await expect(region(page)).toHaveText("");
	await observe(page);
	await receive(
		page,
		state(101, [failed("history"), failed("room-b-failure")], [
			event("history", "option.added"),
		]),
	);
	await expect(region(page)).toHaveText(FAILURE);
	expect(await changes(page)).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});

test("unmount removes the region and later reset or frames do not update its detached node", async ({ page }) => {
	let errors = await load(page);
	await receive(page, state(1));
	await receive(page, state(2, [failed()]));
	await expect(region(page)).toHaveText(FAILURE);
	await observe(page);
	await page.evaluate(() => window.roomSourceProbe.unmount());
	await expect(region(page)).toHaveCount(0);
	let before = await changes(page);
	await page.evaluate(state => {
		window.roomSourceProbe.resetConversation();
		window.roomSourceProbe.receive({
			kind: "conversation-plan:snapshot",
			state,
			jobs: [],
			ts: 3,
		});
	}, state(3, [failed("detached-failure")]));
	expect(await changes(page)).toBe(before);
	expect(
		await page.evaluate(() => ({
			connected: window.conversationAnnouncementProbe.region.isConnected,
			text: window.conversationAnnouncementProbe.region.textContent,
		})),
	).toEqual({ connected: false, text: FAILURE });
	await page.evaluate(() => window.conversationAnnouncementProbe.observer.disconnect());
	expect(errors).toEqual([]);
});
