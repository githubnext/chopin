/**
 * Chat reads a message as Markdown with MarkdownText, assistant-ui's element adapted to take its text
 * as a prop: GitHub's tables, strikethrough and task lists, a header on a fenced block with a button
 * that copies it, nothing from raw HTML, links that open in a new tab, a reply that renders as it
 * streams, and links that stay the same elements while the room renders for other reasons.
 */

import AxeBuilder from "@axe-core/playwright";

import { chatInput } from "./chat-input";
import { expectNoHorizontalOverflow } from "./responsive";
import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

const PHONE = {
	hasTouch: true,
	isMobile: true,
	permissions: ["clipboard-read", "clipboard-write"],
	viewport: { width: 390, height: 844 },
};
const CLIPBOARD = { permissions: ["clipboard-read", "clipboard-write"] };
const CODE = "export function queueFor(team: string) {\n\treturn `queue:${team}`;\n}";

const REPLY = [
	"# Rollout outline",
	"",
	"I read the **queue** code and the *pilot* notes, see [the design note](https://example.com/design) and `src/queue.ts`.",
	"",
	"- Move the shared queue to one queue per team",
	"  - Keep the old one for a week",
	"",
	"1. Ship the migration",
	"2. Flip the flag",
	"",
	"> Risk: a team with no queue falls back to the shared one.",
	"",
	"| Queue | Owner | State |",
	"| --- | --- | --- |",
	"| shared | platform | retiring |",
	"| per team | each team | new |",
	"",
	"- [x] Migration written",
	"- [ ] Rollback tested",
	"",
	"```ts",
	CODE,
	"```",
	"",
	"~~Nothing else needs to change~~ The migration needs a rollback step. About ~5 minutes, ~10 at most.",
].join("\n");

function transcript(text = REPLY): Chat.Entry[] {
	return [
		{
			id: "ask",
			author: { kind: "member", handle: "ana" },
			text: "Outline the rollout?",
			ts: 1_700_000_000,
		},
		{ id: "reply", author: { kind: "agent" }, text, ts: 1_700_000_060 },
	];
}

function chatOf(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function messageOf(page: Page) {
	return chatOf(page).locator("[data-chat-markdown]").filter({ hasText: "Rollout outline" });
}

test("a message reads as Markdown, with GitHub's tables, strikethrough and task lists", async ({ join, seed }) => {
	await seed("# Markdown\n", { transcript: transcript() });
	let page = await join("ana");
	let message = messageOf(page);
	await expect(message).toBeVisible();

	// A heading in Chat is a line of text, as it always was.
	await expect(message.locator("h1, h2, h3, h4, h5, h6")).toHaveCount(0);
	await expect(message.getByText("Rollout outline", { exact: true })).toBeVisible();
	await expect(message.locator("strong")).toHaveText("queue");
	await expect(message.locator("em")).toHaveText("pilot");
	await expect(message.locator("blockquote")).toContainText("falls back to the shared one");
	await expect(message.getByRole("list").first().getByRole("listitem").first()).toContainText(
		"Move the shared queue",
	);
	// What the element adds: a table in its own lane, strikethrough with two tildes, and task boxes.
	let table = message.getByRole("table");
	await expect(table.getByRole("columnheader")).toHaveText(["Queue", "Owner", "State"]);
	await expect(table.getByRole("row")).toHaveCount(3);
	await expect(table.getByRole("cell", { name: "retiring" })).toBeVisible();
	await expect(message.locator("del")).toHaveText("Nothing else needs to change");
	await expect(message).toContainText("About ~5 minutes, ~10 at most.");
	let boxes = message.getByRole("checkbox");
	await expect(boxes).toHaveCount(2);
	await expect(boxes.first()).toBeChecked();
	await expect(boxes.last()).not.toBeChecked();
	await expect(boxes.first()).toBeDisabled();
	// The message is settled.
	await expect(message).toHaveAttribute("data-status", "complete");
});

test("raw HTML, scripts and images never reach the page, and a link opens in a new tab", async ({ join, seed }) => {
	await seed("# Safe\n", {
		transcript: transcript(
			[
				"Rollout outline",
				"",
				"<script>window.__ran = true</script>",
				"",
				'<img src="https://example.invalid/pixel.png" onerror="window.__ran = true">',
				"",
				"![remote](https://example.invalid/remote.png)",
				"",
				"[a script](javascript:window.__ran=true) and [a page](https://example.com/page)",
			].join("\n"),
		),
	});
	let page = await join("ana");
	let message = messageOf(page);
	await expect(message).toBeVisible();
	await expect(message.locator("script, img, iframe, object, embed")).toHaveCount(0);
	expect(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran))
		.toBeUndefined();
	let links = message.getByRole("link");
	await expect(links.filter({ hasText: "a page" })).toHaveAttribute("target", "_blank");
	await expect(links.filter({ hasText: "a page" })).toHaveAttribute("rel", "noopener noreferrer");
	for (let link of await links.all()) {
		expect(await link.getAttribute("href")).not.toMatch(/^javascript:/i);
	}
});

test("a fenced block has its language and a button that copies it, reached and pressed by keyboard", async ({ join, seed }) => {
	await seed("# Copy\n", { transcript: transcript() });
	let page = await join("ana", CLIPBOARD);
	let message = messageOf(page);
	await expect(message).toBeVisible();
	await expect(message.locator(".aui-code-header-language")).toHaveText("ts");
	let copy = message.getByRole("button", { name: "Copy code" });
	await expect(copy).toHaveCount(1);

	// Tab reaches it from the message's own link, and Enter copies.
	await message.getByRole("link", { name: "the design note" }).focus();
	for (let step = 0; step < 6; step++) {
		await page.keyboard.press("Tab");
		if (await copy.evaluate(element => element === document.activeElement)) break;
	}
	await expect(copy).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(message.getByRole("button", { name: "Copied" })).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${CODE}\n`);
	// After a moment it offers the copy again.
	await expect(message.getByRole("button", { name: "Copy code" })).toBeVisible({ timeout: 6_000 });
});

test("Chat's Markdown has no accessibility violations", async ({ join, seed }) => {
	await seed("# Axe\n", { transcript: transcript() });
	let page = await join("ana");
	await expect(messageOf(page)).toBeVisible();
	let result = await new AxeBuilder({ page }).include("[data-chat-markdown]").analyze();
	expect(
		result.violations.map(violation => ({
			rule: violation.id,
			targets: violation.nodes.map(node => node.target),
		})),
	).toEqual([]);
});

test("on a phone a table scrolls in its own lane, the page never widens and the copy button is a target", async ({ join, seed }) => {
	await seed("# Phone\n", {
		transcript: transcript(
			[
				"Rollout outline",
				"",
				"| Queue | Owner | State | Region | Notes | Cost |",
				"| --- | --- | --- | --- | --- | --- |",
				"| shared-queue-for-everyone | platform-engineering | retiring-in-march | eu-west | needs a rollback step first | 1200 |",
				"",
				"```ts",
				"export const longLine = 'a line that is much longer than a phone is wide, so it has to wrap or scroll in its block';",
				"```",
			].join("\n"),
		),
	});
	let page = await join("ana", PHONE);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect(chatInput(chatOf(page))).toBeVisible();
	let message = messageOf(page);
	await expect(message).toBeVisible();
	await expectNoHorizontalOverflow(page);
	let lane = message.locator(".aui-md-table-wrapper");
	await expect(lane).toBeVisible();
	expect(await lane.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
	expect(await lane.evaluate(element => getComputedStyle(element).overflowX)).toBe("auto");
	let box = (await message.getByRole("button", { name: "Copy code" }).boundingBox())!;
	expect(box.width).toBeGreaterThanOrEqual(24);
	expect(box.height).toBeGreaterThanOrEqual(24);
});

/** A page whose socket is scripted: the test sends the frames a Planner's reply is made of. */
async function scripted(page: Page) {
	let send: ((frame: Record<string, unknown>) => void) | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		send = frame => route.send(JSON.stringify(frame));
		route.onMessage(message => server.send(message));
		server.onMessage(message => route.send(message));
	});
	return (frame: Record<string, unknown>) => send?.(frame);
}

test("a reply renders as it streams, and what has already been drawn stays the same elements", async ({ join, page, seed }) => {
	await seed("# Streaming\n", { transcript: [] });
	let send = await scripted(page);
	await join("ana");
	let entry = { id: "live", author: { kind: "agent" }, text: "", ts: 1_700_000_100 };
	let live = chatOf(page).locator("[data-chat-markdown]").filter({ hasText: "First paragraph" });
	await expect.poll(async () => {
		send({
			kind: "chat:message",
			ts: 0,
			entry: {
				...entry,
				text: "First paragraph with [a link](https://example.com/live).",
				streaming: true,
			},
		});
		return await live.count();
	}).toBe(1);
	await expect(live).toHaveAttribute("data-status", "running");
	let link = live.getByRole("link", { name: "a link" });
	await link.evaluate(element => {
		(window as unknown as { __link?: Element }).__link = element;
	});

	// More text arrives in deltas: a list, then a table that is only drawn once its rows are whole.
	send({ kind: "chat:delta", ts: 0, id: "live", text: "\n\n- one\n- tw" });
	await expect(live.getByRole("listitem")).toHaveText(["one", "tw"]);
	send({
		kind: "chat:delta",
		ts: 0,
		id: "live",
		text: "o\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nlet a",
	});
	await expect(live.getByRole("table")).toBeVisible();
	await expect(live.locator("pre code")).toHaveText("let a");
	await expect(live).toHaveAttribute("data-status", "running");
	// The paragraph that was already complete is the same element, with the same link.
	expect(
		await live.evaluate(root =>
			root.querySelector("a") === (window as unknown as { __link?: Element }).__link
		),
	).toBe(true);

	send({
		kind: "chat:message",
		ts: 0,
		entry: {
			...entry,
			text:
				"First paragraph with [a link](https://example.com/live).\n\n- one\n- two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```ts\nlet a = 1;\n```",
		},
	});
	await expect(live).toHaveAttribute("data-status", "complete");
	await expect(live.locator("pre code")).toHaveText("let a = 1;");
	expect(
		await live.evaluate(root =>
			root.querySelector("a") === (window as unknown as { __link?: Element }).__link
		),
	).toBe(true);
});

test("a message's links stay the same elements while other people write", async ({ join, seed }) => {
	await seed("# Identity\n", { transcript: transcript() });
	let ana = await join("ana");
	let ben = await join("ben");
	let link = messageOf(ana).getByRole("link", { name: "the design note" });
	await expect(link).toBeVisible();
	await link.evaluate(element => {
		(window as unknown as { __link?: Element }).__link = element;
		element.setAttribute("data-marked", "");
	});
	for (let index of [1, 2, 3]) {
		let input = chatInput(chatOf(ben));
		await input.fill(`Ben's line ${index} with **weight**.`);
		await input.press("Enter");
		await expect(chatOf(ana).getByText(`Ben's line ${index}`)).toBeVisible();
	}
	expect(
		await ana.evaluate(() => {
			let marked = document.querySelector("[data-marked]");
			return !!marked && marked.isConnected
				&& marked === (window as unknown as { __link?: Element }).__link;
		}),
	).toBe(true);
});

/**
 * Counts, as the DevTools do, every Markdown parse a commit made: the function component react-markdown
 * draws, which is the one that has both the parser's options and the text as its children. Mounted
 * subtrees count whole; for the rest only fibers that differ from their alternate, since a subtree
 * that bailed out keeps the flags of the last time it rendered.
 */
async function countParses(page: Page) {
	await page.addInitScript(() => {
		type Fiber = {
			alternate: Fiber | null;
			child: Fiber | null;
			sibling: Fiber | null;
			flags: number;
			memoizedProps: Record<string, unknown> | null;
		};
		let parses = 0;
		Object.defineProperty(window, "__parses", { get: () => parses });
		let count = (fiber: Fiber) => {
			let props = fiber.memoizedProps;
			if (
				fiber.flags & 1 && props && typeof props === "object" && "unwrapDisallowed" in props
				&& typeof props["children"] === "string"
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
					if (root.current.alternate) visit(root.current, root.current.alternate);
					else mounted(root.current);
				},
				onCommitFiberUnmount() {},
				onPostCommitFiberRoot() {},
				checkDCE() {},
			},
		});
	});
	return () => page.evaluate(() => (window as unknown as { __parses: number }).__parses);
}

test("each streamed update parses the message once, and the finished message is not parsed again", async ({ join, page, seed }) => {
	await seed("# Parses\n", { transcript: [] });
	let parses = await countParses(page);
	let send = await scripted(page);
	await join("ana");
	let entry = { id: "live", author: { kind: "agent" }, text: "", ts: 1_700_000_100 };
	let live = chatOf(page).locator("[data-chat-markdown]").filter({ hasText: "Start" });
	await expect.poll(async () => {
		send({
			kind: "chat:message",
			ts: 0,
			entry: {
				...entry,
				text: "Start of a reply with [a link](https://example.com/a)",
				streaming: true,
			},
		});
		return await live.count();
	}).toBe(1);
	// The page is quiet once nothing has been parsed for a moment.
	let settle = async () => {
		let last = await parses();
		for (let still = 0; still < 6;) {
			await page.waitForTimeout(80);
			let now = await parses();
			still = now === last ? still + 1 : 0;
			last = now;
		}
		return last;
	};
	let before = await settle();
	expect(before, "the first text was parsed").toBeGreaterThan(0);
	for (let step = 1; step <= 6; step++) {
		send({ kind: "chat:delta", ts: 0, id: "live", text: ` word${step}` });
		await expect(live).toContainText(`word${step}`);
		let after = await settle();
		expect(after - before, `parses made for update ${step}`).toBe(1);
		before = after;
	}
	// The message settles: one parse for the text the last delta already had, none for its status.
	send({
		kind: "chat:message",
		ts: 0,
		entry: {
			...entry,
			text:
				"Start of a reply with [a link](https://example.com/a) word1 word2 word3 word4 word5 word6",
		},
	});
	await expect(live).toHaveAttribute("data-status", "complete");
	expect(await settle() - before, "parses made when the message finished").toBe(0);
});
