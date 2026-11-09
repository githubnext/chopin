/**
 * Chat follows its newest line for a reader who is on it, and costs the page nothing when the
 * room renders for a reason that has nothing to do with it.
 *
 * Two costs sat in every render of the transcript. Every message's Markdown was parsed again,
 * though the room renders for polls, presence and a dozen other reasons that change no message;
 * and a layout effect moved the transcript to its newest line by reading `scrollHeight` in the
 * commit that had just changed it, which makes the browser lay the page out for the read and
 * again for the frame. What a reader sees is the same: a transcript that follows a reader at the
 * bottom, and leaves one who scrolled up where they are.
 */

import { chatInput } from "./chat-input";
import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Locator, Page } from "@playwright/test";

const MESSAGES = 14;

function transcript(): Chat.Entry[] {
	return Array.from({ length: 30 }, (_, index) => ({
		id: `message-${index}`,
		author: { kind: "member" as const, handle: index % 2 ? "ana" : "ben" },
		text:
			`**Message ${index}** about the rollout plan, with \`code\` and a [link](https://example.com).`,
		ts: 1_700_000_000 + index,
	}));
}

function chatOf(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function scrollerOf(page: Page): Locator {
	return chatOf(page).locator("[data-chat-stack]").locator("..");
}

async function gap(scroller: Locator): Promise<number> {
	return scroller.evaluate(element =>
		element.scrollHeight - element.scrollTop - element.clientHeight
	);
}

async function say(page: Page, text: string) {
	let input = chatInput(chatOf(page));
	await input.fill(text);
	await input.press("Enter");
}

test("a transcript follows a reader at the bottom to a new message and leaves one who scrolled up", async ({ join, seed }) => {
	await seed("# Following\n", { transcript: transcript() });
	let ana = await join("ana");
	let ben = await join("ben");
	let scroller = scrollerOf(ana);
	await expect(chatOf(ana).getByText("Message 29", { exact: false })).toBeVisible();
	await expect.poll(() => gap(scroller)).toBeLessThanOrEqual(2);

	// At the bottom: someone else's message is followed.
	await say(ben, "First thing ben adds.");
	await expect(chatOf(ana).getByText("First thing ben adds.")).toBeVisible();
	await expect.poll(() => gap(scroller)).toBeLessThanOrEqual(2);

	// Scrolled up: it arrives, and the reader is not moved.
	await scroller.evaluate(element => element.scrollTop -= 400);
	let reading = await scroller.evaluate(element => element.scrollTop);
	await say(ben, "Second thing ben adds.");
	await expect(chatOf(ana).getByText("Second thing ben adds.")).toBeAttached();
	await ana.waitForTimeout(300);
	expect(await scroller.evaluate(element => element.scrollTop)).toBe(reading);
	expect(await gap(scroller)).toBeGreaterThan(300);

	// Their own message always comes into view, wherever they had scrolled.
	await say(ana, "Ana answers from where she was.");
	await expect(chatOf(ana).getByText("Ana answers from where she was.")).toBeVisible();
	await expect.poll(() => gap(scroller)).toBeLessThanOrEqual(2);
});

test("a render of the room that touches no message does not parse any message's Markdown again", async ({ join, page, seed }) => {
	await seed("# Quiet rows\n", { transcript: transcript().slice(0, MESSAGES) });
	// Every function component that performed work in a commit and is the Markdown parser, found as
	// the DevTools do: mounted subtrees whole, and for the rest only where a fiber and its alternate
	// differ, since a subtree that bailed out keeps the flags of the last time it rendered.
	await page.addInitScript(() => {
		type Fiber = {
			alternate: Fiber | null;
			child: Fiber | null;
			sibling: Fiber | null;
			flags: number;
			memoizedProps: Record<string, unknown> | null;
		};
		let parses = 0;
		let commits = 0;
		Object.defineProperty(window, "__parses", { get: () => parses });
		Object.defineProperty(window, "__commits", { get: () => commits });
		let count = (fiber: Fiber) => {
			if (
				fiber.flags & 1 && fiber.memoizedProps && typeof fiber.memoizedProps === "object"
				&& "unwrapDisallowed" in fiber.memoizedProps
			) parses++;
		};
		let mounted = (fiber: Fiber) => {
			count(fiber);
			for (let child = fiber.child; child; child = child.sibling) mounted(child);
		};
		let visit = (next: Fiber, previous: Fiber) => {
			count(next);
			if (next.child === previous.child) return;
			for (let child = next.child; child; child = child.sibling) {
				if (child.alternate) visit(child, child.alternate);
				else mounted(child);
			}
		};
		Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
			value: {
				supportsFiber: true,
				renderers: new Map(),
				inject: () => 1,
				onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
					commits++;
					if (root.current.alternate) visit(root.current, root.current.alternate);
				},
				onCommitFiberUnmount() {},
				onPostCommitFiberRoot() {},
				checkDCE() {},
			},
		});
	});
	// The person's machines, asked for again whenever the window regains focus, answer something
	// different each time: the room renders for it and for nothing in Chat.
	let online = true;
	let answered = 0;
	await page.route("**/api/connector/machines", async route => {
		answered++;
		await route.fulfill({
			json: {
				machines: [{
					id: "M_box",
					label: "build-box",
					teammate: false,
					favorite: false,
					repositories: ["octo-org/score"],
					autoRun: false,
					shared: false,
					finishing: 0,
					createdAt: 1_000,
					lastSeenAt: 2_000,
					connected: online,
					version: null,
					hostname: null,
					platform: null,
					agent: null,
					sandbox: null,
					service: false,
					planner: false,
					reauthorize: false,
				}],
			},
		});
	});
	let count = (name: "__parses" | "__commits") =>
		page.evaluate(key => (window as unknown as Record<string, number>)[key]!, name);
	await join("ana");
	await expect(chatOf(page).getByText(`Message ${MESSAGES - 1}`, { exact: false })).toBeVisible();
	await expect.poll(() => answered).toBeGreaterThan(0);
	// The page has settled once nothing has been committed for a while.
	let last = await count("__commits");
	for (let still = 0; still < 12;) {
		await page.waitForTimeout(100);
		let now = await count("__commits");
		still = now === last ? still + 1 : 0;
		last = now;
	}
	let before = { commits: last, parses: await count("__parses") };
	expect(before.parses, "the transcript's Markdown was parsed when it opened").toBeGreaterThan(0);

	online = false;
	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expect.poll(() => count("__commits")).toBeGreaterThan(before.commits);
	await page.waitForTimeout(500);
	expect(await count("__parses"), "messages parsed again by a render that changed none").toBe(
		before.parses,
	);
});

test("the transcript reads its scroll height only with its layout current", async ({ join, page, seed }) => {
	await seed("# Reads\n", { transcript: transcript() });
	// A read of `scrollHeight` while the transcript's own changes are still waiting to be reported
	// to a MutationObserver was made in the same task as the change, before the browser could lay
	// out: it makes the browser do that now, and again for the frame.
	await page.addInitScript(() => {
		let dirty = 0;
		Object.defineProperty(window, "__dirtyReads", { get: () => dirty });
		let pending = new MutationObserver(() => {});
		pending.observe(document, {
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true,
		});
		let native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!;
		Object.defineProperty(Element.prototype, "scrollHeight", {
			configurable: true,
			get(this: Element) {
				if (this.hasAttribute("data-chat-scroll")) {
					let records = pending.takeRecords();
					if (records.some(record => this.contains(record.target))) dirty++;
				}
				return native.get!.call(this);
			},
		});
	});
	let ana = await join("ana");
	let ben = await join("ben", { viewport: { width: 1280, height: 800 } });
	await expect(chatOf(ana).getByText("Message 29", { exact: false })).toBeVisible();
	for (let index of [1, 2, 3]) {
		await say(ben, `Ben's line ${index}.`);
		await expect(chatOf(ana).getByText(`Ben's line ${index}.`)).toBeVisible();
	}
	for (let index of [1, 2]) {
		await say(ana, `Ana's line ${index}.`);
		await expect(chatOf(ana).getByText(`Ana's line ${index}.`)).toBeVisible();
	}
	await ana.waitForTimeout(300);
	expect(
		await ana.evaluate(() => (window as unknown as { __dirtyReads: number }).__dirtyReads),
		"reads of the transcript's scroll height made in the commit that changed it",
	).toBe(0);
});
