/**
 * Dragging a pane's edge moves it through the page, not through React, and saves its width once.
 *
 * What a person sees is the existing tests' business (the edge follows the pointer, the keyboard
 * steps, a taken-away drag puts the bar down). These pin how it is done: nothing is stored while
 * the pointer is down, the stored width is the one the drag ended on, and the layout questions
 * that used to be asked on every step are not asked at all.
 */

import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Locator, Page } from "@playwright/test";

type Watch = {
	writes: string[];
	documentAnimations: number;
	chatEffects: number;
	reducedMotionReads: number;
};

declare global {
	interface Window {
		__paneWatch: Watch;
	}
}

function transcript(): Chat.Entry[] {
	return Array.from({ length: 40 }, (_, index) => ({
		id: `message-${index}`,
		author: { kind: "member" as const, handle: index % 2 ? "ana" : "ben" },
		text: `Message ${index} about the rollout plan and what it still needs.`,
		ts: 1_700_000_000 + index,
	}));
}

/**
 * The Projects list holds every document the other tests of a run made, and each row reads the
 * reduced-motion preference as it renders, so a count of those reads says what the room does only
 * when the list is the same length whenever the test runs. It lists the document the test made.
 */
async function ownCatalogue(page: Page, room: string) {
	let slug = `test-${room.slice(0, 8)}`;
	await page.route("**/api/repositories/octo-org/score/channels*", route =>
		route.fulfill({
			json: {
				canEdit: true,
				channels: [{
					createdAt: "2026-08-19T12:00:00.000Z",
					createdBy: "U_ana",
					descriptionRevision: 0,
					id: room,
					repositoryId: "R_score",
					repositoryName: "score",
					repositoryOwner: "octo-org",
					revision: 0,
					slug,
					title: `Test ${room.slice(0, 8)}`,
					updatedAt: "2026-08-19T12:00:00.000Z",
				}],
				repository: {
					defaultBranch: "main",
					fullName: "octo-org/score",
					id: "R_score",
					name: "score",
					owner: "octo-org",
					ownerAvatarUrl: "https://example.invalid/octo-org.png",
					permissions: { admin: false, pull: true, push: true },
					private: true,
					url: "https://github.com/octo-org/score",
				},
			},
		}));
}

/** Count what a drag must not do, from before the page's own scripts run. */
async function watch(page: Page) {
	await page.addInitScript(() => {
		let log: Watch = { writes: [], documentAnimations: 0, chatEffects: 0, reducedMotionReads: 0 };
		window.__paneWatch = log;
		let setItem = Storage.prototype.setItem;
		Storage.prototype.setItem = function(key: string, value: string) {
			if (key.startsWith("chopin:pane:")) log.writes.push(`${key}=${value}`);
			return setItem.call(this, key, value);
		};
		// The page-wide scan for running animations, once asked on every layout change.
		let getAnimations = Document.prototype.getAnimations;
		Document.prototype.getAnimations = function() {
			log.documentAnimations++;
			return getAnimations.call(this);
		};
		// Every message, and much else in the room, reads the reduced-motion preference as it renders.
		let matchMedia = window.matchMedia.bind(window);
		window.matchMedia = function(query: string) {
			if (query.includes("prefers-reduced-motion")) log.reducedMotionReads++;
			return matchMedia(query);
		};
		// The Chat measurement effect looks for its cards with this selector on every run.
		let querySelectorAll = Element.prototype.querySelectorAll;
		Element.prototype.querySelectorAll = function(selector: string) {
			if (selector.includes("data-chat-placement")) log.chatEffects++;
			return querySelectorAll.call(this, selector);
		};
	});
}

function watched(page: Page): Promise<Watch> {
	return page.evaluate(() => structuredClone(window.__paneWatch));
}

function box(target: Locator) {
	return target.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect);
}

/** Two frames, so that anything the last pointer move scheduled for the next frame has happened. */
function settle(page: Page) {
	return page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
}

test("a Chat resize follows the pointer, and saves its width once, when the drag ends", async ({ join, page, seed }) => {
	await seed("# Resize\n", { transcript: transcript() });
	await watch(page);
	await join("ana");
	let rail = page.getByRole("complementary", { name: "Chat", exact: true });
	let handle = page.getByRole("separator", { name: "Resize chat" });
	await expect(rail.getByText("Message 39 about the rollout plan")).toBeVisible();
	await settle(page);
	let before = (await box(rail)).width;
	let opening = await watched(page);
	let start = await box(handle);
	let x = start.x + start.width / 2;
	let y = start.y + start.height / 2;

	await handle.hover();
	await page.mouse.down();
	await page.mouse.move(x + 40, y, { steps: 10 });
	await settle(page);

	// The pane and the handle follow the pointer while it is down...
	expect((await box(rail)).width).toBeCloseTo(before + 40, 0);
	await expect(handle).toHaveAttribute("aria-valuenow", String(before + 40));
	// ...and nothing has been stored, and no layout question has been asked of the Chat, for it.
	let moving = await watched(page);
	expect(moving.writes).toEqual(opening.writes);
	expect(moving.chatEffects).toBe(opening.chatEffects);
	expect(moving.documentAnimations).toBe(opening.documentAnimations);

	await page.mouse.up();
	await expect.poll(async () => (await watched(page)).writes)
		.toEqual([...opening.writes, `chopin:pane:chat=${before + 40}`]);
	await expect(handle).toHaveAttribute("aria-valuenow", String(before + 40));
	expect((await box(rail)).width).toBeCloseTo(before + 40, 0);
});

test("a Chat resize that the browser takes away still saves the width it reached", async ({ join, page }) => {
	await watch(page);
	await join("ana");
	let rail = page.getByRole("complementary", { name: "Chat", exact: true });
	let handle = page.getByRole("separator", { name: "Resize chat" });
	let before = (await box(rail)).width;
	let opening = await watched(page);
	let start = await box(handle);

	await handle.hover();
	await page.mouse.down();
	await page.mouse.move(start.x + start.width / 2 + 40, start.y + start.height / 2, { steps: 4 });
	await handle.evaluate(element => (element as HTMLElement).releasePointerCapture(1));
	await page.mouse.up();

	await expect(handle).not.toHaveAttribute("data-dragging");
	await expect.poll(async () => (await watched(page)).writes)
		.toEqual([...opening.writes, `chopin:pane:chat=${before + 40}`]);
	await expect(handle).toHaveAttribute("aria-valuenow", String(before + 40));
});

test("a Projects sidebar resize follows the pointer without asking the page what is animating, and saves its width once", async ({ join, page }) => {
	await watch(page);
	await join("ana");
	let handle = page.getByRole("separator", { name: "Resize Projects sidebar" });
	let sidebar = page.locator(".project-sidebar-frame");
	await expect(handle).toBeVisible();
	await settle(page);
	let before = (await box(sidebar)).width;
	let opening = await watched(page);
	let start = await box(handle);

	await page.mouse.move(start.x + start.width / 2, start.y + 80);
	await page.mouse.down();
	await page.mouse.move(start.x + start.width / 2 + 60, start.y + 80, { steps: 10 });
	await settle(page);

	expect((await box(sidebar)).width).toBeCloseTo(before + 60, 0);
	await expect(handle).toHaveAttribute("aria-valuenow", String(before + 60));
	let moving = await watched(page);
	expect(moving.writes).toEqual(opening.writes);
	expect(moving.documentAnimations).toBe(opening.documentAnimations);

	await page.mouse.up();
	await expect.poll(async () => (await watched(page)).writes)
		.toEqual([...opening.writes, `chopin:pane:projects=${before + 60}`]);
	await expect(handle).toHaveAttribute("aria-valuenow", String(before + 60));
	expect((await box(sidebar)).width).toBeCloseTo(before + 60, 0);
});

test("a Projects sidebar resize renders the workspace on each step, not the room and its Chat", async ({ join, page, room, seed }) => {
	let messages = [0, 1, 2, 3].flatMap(round =>
		transcript().map(entry => ({ ...entry, id: `${round}-${entry.id}` }))
	);
	await seed("# Resize\n", { transcript: messages });
	await watch(page);
	await ownCatalogue(page, room);
	await join("ana");
	let handle = page.getByRole("separator", { name: "Resize Projects sidebar" });
	let rail = page.getByRole("complementary", { name: "Chat", exact: true });
	await expect(rail.getByText("Message 39 about the rollout plan").last()).toBeVisible();
	await settle(page);
	let opening = await watched(page);
	let start = await box(handle);

	await page.mouse.move(start.x + start.width / 2, start.y + 80);
	await page.mouse.down();
	await page.mouse.move(start.x + start.width / 2 + 60, start.y + 80, { steps: 10 });
	await settle(page);
	await page.mouse.up();

	// Each of the 160 messages reads the reduced-motion preference whenever it renders, so the room
	// rendering Chat once is 160 reads: 292 in all for this drag when the room rendered on its
	// steps, about 130 for the workspace and what follows its measure when it does not.
	let moving = await watched(page);
	expect(moving.reducedMotionReads - opening.reducedMotionReads).toBeLessThan(260);
});
