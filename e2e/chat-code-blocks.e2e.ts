/**
 * A fenced block in a Chat message is Slack's code block in Chopin's colours: as wide as the
 * message's text, in main Chat and the thread panel, on a desktop and a phone, a tall message
 * included; long lines scroll inside it in a lane the keyboard reaches; a block that names its
 * language is coloured with the document's highlighter, in Chopin's text roles, and one that names
 * none stays as written; a block that streams in keeps what it already coloured.
 */

import AxeBuilder from "@axe-core/playwright";

import { expectNoHorizontalOverflow } from "./responsive";
import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Locator, Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

const TS = "export function queueFor(team: string) {\n\treturn `queue:${team}`; // one per team\n}";
const LONG =
	'fn main() { println!("a line that is much longer than the Chat pane is wide, so its block has to scroll sideways"); }';
const PARAGRAPH =
	"The harp section needs its pedal mechanism regulated, a new set of strings and a rehearsal booking at the venue before anything ships.";

/** A message taller than the pane: prose, a short block, a long one, a one-liner, one in a list, a plain one. */
const TALL = [
	"Here is the queue helper.",
	"",
	"```ts",
	TS,
	"```",
	"",
	...Array.from({ length: 6 }, (_, index) => [`Paragraph ${index + 1}: ${PARAGRAPH}`, ""]).flat(),
	"A long one:",
	"",
	"```rust",
	LONG,
	"```",
	"",
	"```bash",
	"bun test",
	"```",
	"",
	"- an item with code",
	"",
	"  ```python",
	"  print('hi')",
	"  ```",
	"",
	"```",
	"no language here",
	"```",
].join("\n");

function transcript(): Chat.Entry[] {
	return [
		{
			id: "ask",
			author: { kind: "member", handle: "ana" },
			text: "Can you check this?\n\n```ts\nlet a = 1;\n```",
			ts: 1_700_000_000,
		},
		// The next of ana's messages has no name line, so the toolbar's room sits beside its first block.
		{
			id: "more",
			author: { kind: "member", handle: "ana" },
			text: '```json\n{ "queue": "per team" }\n```',
			ts: 1_700_000_010,
		},
		{ id: "reply", author: { kind: "agent" }, text: TALL, ts: 1_700_000_060 },
	];
}

function chatOf(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function reply(scope: Locator): Locator {
	return scope.locator("[data-chat-markdown]").filter({ hasText: "queue helper" });
}

/**
 * Each code block, and its header, against the column it sits in: the message's text, or the list
 * item it belongs to. Each paragraph too, so a message whose words were narrowed shows it.
 */
async function shortfalls(scope: Locator): Promise<string[]> {
	return scope.evaluate(root => {
		let found: string[] = [];
		let blocks = root.querySelectorAll(
			"[data-chat-markdown], [data-chat-markdown] :is(.aui-code-header-root, .aui-md-pre), [data-chat-markdown] > :is(p, .aui-md-p)",
		);
		for (let block of blocks) {
			// The column is the content box of what holds the block: the message's text, or a list item.
			let parent = block.parentElement!;
			let style = getComputedStyle(parent);
			let wanted = parent.getBoundingClientRect().width - parseFloat(style.paddingInlineStart)
				- parseFloat(style.paddingInlineEnd);
			let width = block.getBoundingClientRect().width;
			if (Math.abs(width - wanted) > 0.5) {
				found.push(
					`${block.className.split(" ")[0] || block.tagName} ${Math.round(width)} of ${
						Math.round(wanted)
					}: ${block.textContent?.slice(0, 24)}`,
				);
			}
		}
		return found;
	});
}

async function openThread(page: Page): Promise<Locator> {
	let row = chatOf(page).locator(".chat-message-body").filter({ hasText: "queue helper" });
	await row.hover();
	await row.getByRole("button", { name: "Reply in thread" }).click();
	let panel = page.locator("[data-thread-panel]");
	await expect(panel.locator(".aui-md-pre").first()).toBeVisible();
	return panel;
}

test("a code block is as wide as the message's text, in a message taller than the pane too, in Chat and in the thread panel", async ({ join, page, seed }) => {
	await seed("# Code\n", { transcript: transcript() });
	await join("ana");
	let chat = chatOf(page);
	await expect(reply(chat).locator(".aui-md-pre")).toHaveCount(5);
	let pane = (await chat.locator("[data-chat-scroll]").boundingBox())!;
	expect((await reply(chat).boundingBox())!.height).toBeGreaterThan(pane.height);
	// The message's text is the row's whole column: the same width as a short message's.
	let widths = await chat.locator("[data-chat-markdown]").evaluateAll(nodes =>
		nodes.map(node => Math.round(node.getBoundingClientRect().width))
	);
	expect(new Set(widths).size).toBe(1);
	expect(await shortfalls(chat)).toEqual([]);
	// With the pointer on it and its toolbar kept in view over it, nothing moves.
	await reply(chat).hover();
	expect(await shortfalls(chat)).toEqual([]);

	let panel = await openThread(page);
	expect(await shortfalls(panel)).toEqual([]);
	await expect.poll(() => shortfalls(chat)).toEqual([]);
});

test("a long line scrolls inside its block, never widening the message, and the keyboard reaches and scrolls it", async ({ join, page, seed }) => {
	await seed("# Code\n", { transcript: transcript() });
	await join("ana");
	let message = reply(chatOf(page));
	let long = message.locator(".aui-md-pre").filter({ hasText: "println" });
	await long.scrollIntoViewIfNeeded();
	expect(await long.evaluate(element => element.scrollWidth - element.clientWidth))
		.toBeGreaterThan(40);
	expect(await long.evaluate(element => getComputedStyle(element).overflowX)).toBe("auto");
	await expectNoHorizontalOverflow(page);
	expect(await shortfalls(chatOf(page))).toEqual([]);

	await message.locator(".aui-code-header-root").filter({ hasText: "rust" })
		.getByRole("button", { name: "Copy code" }).focus();
	await page.keyboard.press("Tab");
	await expect(long).toBeFocused();
	// The lane says it has focus with the keyboard ring.
	expect(await long.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe("none");
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => long.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
});

/** A colour as the screen draws it, by painting it, so a token's `oklch()` becomes sRGB. */
async function painted(page: Page, colours: string[]): Promise<number[][]> {
	return page.evaluate(list => {
		let canvas = new OffscreenCanvas(1, 1);
		let context = canvas.getContext("2d", { willReadFrequently: true })!;
		return list.map(colour => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = colour;
			context.fillRect(0, 0, 1, 1);
			return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
		});
	}, colours);
}

function luminance(rgb: number[]): number {
	let [r, g, b] = rgb.map(value => {
		let channel = value / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG's contrast ratio of two sRGB colours. */
function contrast(a: number[], b: number[]): number {
	let [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light! + 0.05) / (dark! + 0.05);
}

test("a block that names its language is coloured by it in Chopin's text roles at 4.5:1 or more, one that names none is as written, and the code's text is the code", async ({ join, page, seed }) => {
	await seed("# Code\n", { transcript: transcript() });
	await join("ana");
	let message = reply(chatOf(page));
	let ts = message.locator(".aui-md-pre").filter({ hasText: "queueFor" });
	await expect(ts.locator('[data-token="keyword"]').first()).toBeVisible();
	await expect(ts.locator('[data-token="keyword"]').first()).toHaveText("export");
	await expect(ts.locator('[data-token="string-expression"], [data-token="string"]').first())
		.toBeVisible();
	await expect(ts.locator('[data-token="comment"]')).toContainText("one per team");
	// Python inside a list item and a one-line shell command are coloured too.
	await expect(message.locator(".aui-md-pre").filter({ hasText: "print" }).locator("[data-token]"))
		.not.toHaveCount(0);
	await expect(
		message.locator(".aui-md-pre").filter({ hasText: "no language here" }).locator("[data-token]"),
	).toHaveCount(0);
	// A block with no caption has no empty header row: its copy button stands in the corner of the code.
	let plain = message.locator(".aui-md-pre").filter({ hasText: "no language here" });
	let corner = await plain.evaluate(pre => {
		let header = pre.previousElementSibling!;
		let button = header.querySelector("button")!.getBoundingClientRect();
		let box = pre.getBoundingClientRect();
		return {
			gap: Math.round(box.top - header.getBoundingClientRect().top),
			inside: button.top >= box.top && button.right <= box.right,
		};
	});
	expect(corner).toEqual({ gap: 1, inside: true });
	// The text of a coloured block is exactly the code, as copying it reads it.
	expect(await ts.locator("code").evaluate(element => element.textContent)).toBe(`${TS}\n`);
	expect(await ts.locator("code").innerText()).toBe(`${TS}\n`);

	// Each role's colour is one of Chopin's tokens and reads on the block's ground.
	let ground = await ts.evaluate(element => getComputedStyle(element).backgroundColor);
	let roles = await message.locator("[data-token]").evaluateAll(nodes => {
		let seen = new Map<string, string>();
		for (let node of nodes) {
			seen.set(node.getAttribute("data-token")!, getComputedStyle(node).color);
		}
		return [...seen];
	});
	expect(roles.map(([role]) => role)).toEqual(
		expect.arrayContaining(["keyword", "comment", "function"]),
	);
	let [base, ...inks] = await painted(page, [ground, ...roles.map(([, colour]) => colour)]);
	let failing = roles.flatMap(([role], index) => {
		let ratio = contrast(inks[index]!, base!);
		return ratio < 4.5 ? [`${role} ${ratio.toFixed(2)}`] : [];
	});
	expect(failing).toEqual([]);
	// The header's caption is text (4.5:1) and its copy icon a control people need to see (3:1).
	let header = message.locator(".aui-code-header-root").filter({ hasText: "ts" }).first();
	let [caption, icon, headerGround] = await painted(page, [
		await header.locator(".aui-code-header-language").evaluate(node =>
			getComputedStyle(node).color
		),
		await header.locator("svg").evaluate(node => getComputedStyle(node).color),
		await header.evaluate(node => getComputedStyle(node).backgroundColor),
	]);
	expect(contrast(caption!, headerGround!)).toBeGreaterThanOrEqual(4.5);
	expect(contrast(icon!, headerGround!)).toBeGreaterThanOrEqual(3);
	let tokens = await page.evaluate(() => {
		let probe = document.createElement("span");
		document.body.append(probe);
		let read = (name: string) => {
			probe.style.color = `var(${name})`;
			return getComputedStyle(probe).color;
		};
		let found = {
			keyword: read("--color-brand-ink"),
			comment: read("--color-text-tertiary"),
			function: read("--color-merged-icon"),
		};
		probe.remove();
		return found;
	});
	let byRole = Object.fromEntries(roles);
	expect({
		keyword: byRole.keyword,
		comment: byRole.comment,
		function: byRole.function,
	}).toEqual(tokens);

	let results = await new AxeBuilder({ page }).include("[data-chat-markdown]").analyze();
	expect(results.violations).toEqual([]);
});

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

test("a block that streams in keeps the lines it already coloured, the same elements, as it grows", async ({ join, page, seed }) => {
	await seed("# Streaming\n", { transcript: [] });
	let send = await scripted(page);
	await join("ana");
	let entry = { id: "live", author: { kind: "agent" }, ts: 1_700_000_100 };
	let live = chatOf(page).locator("[data-chat-markdown]").filter({ hasText: "Streaming code" });
	await expect.poll(async () => {
		send({
			kind: "chat:message",
			ts: 0,
			entry: { ...entry, text: "Streaming code:\n\n```ts\nconst first = 1;\ncon", streaming: true },
		});
		return await live.count();
	}).toBe(1);
	let code = live.locator(".aui-md-pre");
	let first = code.locator('[data-token="keyword"]').first();
	await expect(first).toHaveText("const");
	await first.evaluate(element => {
		(window as unknown as { __first?: Element }).__first = element;
	});
	for (let delta of ["st sec", "ond = 2;\n", "const third", " = 3;"]) {
		send({ kind: "chat:delta", ts: 0, id: "live", text: delta });
	}
	await expect(code.locator("code")).toHaveText(
		"const first = 1;\nconst second = 2;\nconst third = 3;",
	);
	await expect(code.locator('[data-token="keyword"]', { hasText: /^const$/ })).toHaveCount(3);
	expect(
		await code.evaluate(root =>
			root.querySelector("[data-token]") === (window as unknown as { __first?: Element }).__first
		),
	).toBe(true);
	send({
		kind: "chat:message",
		ts: 0,
		entry: {
			...entry,
			text: "Streaming code:\n\n```ts\nconst first = 1;\nconst second = 2;\nconst third = 3;\n```",
		},
	});
	await expect(live).toHaveAttribute("data-status", "complete");
	await expect(code.locator('[data-token="keyword"]', { hasText: /^const$/ })).toHaveCount(3);
});

test.describe("on a phone", () => {
	test.use(PHONE);

	test("a code block is as wide as the message's text, a long line scrolls inside it, and the page never widens", async ({ join, page, seed }) => {
		await seed("# Code\n", { transcript: transcript() });
		await join("ana");
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).click();
		let chat = chatOf(page);
		await expect(reply(chat).locator(".aui-md-pre")).toHaveCount(5);
		await expect(reply(chat).locator('[data-token="keyword"]').first()).toBeVisible();
		expect(await shortfalls(chat)).toEqual([]);
		await expectNoHorizontalOverflow(page);
		// A long line keeps its line and scrolls inside its block, as on a desktop.
		let long = reply(chat).locator(".aui-md-pre").filter({ hasText: "println" });
		expect(await long.evaluate(element => getComputedStyle(element).whiteSpace)).toBe("pre");
		expect(await long.evaluate(element => element.scrollWidth - element.clientWidth))
			.toBeGreaterThan(40);
	});
});
