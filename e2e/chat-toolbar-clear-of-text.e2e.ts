/**
 * A Chat message's hover toolbar stands on the row's top edge, as Slack's does, and never over the
 * row it belongs to: not a line of its text or its name line, not its reaction pills, not its code.
 * Each case compares the bar's rectangle with the client rectangles of everything the row draws, for
 * a message that heads its group and one that continues it, in a narrow and a wide Chat and in a
 * thread. A row whose top edge is scrolled out of the pane shows no bar at all. A pointer heading
 * from the text to the bar across the row before, straight up, slantwise or slowly, still finds it.
 */
import { chatInput, fillChat } from "./chat-input";
import { expect, test } from "./room";

import type { Locator, Page, TestInfo } from "@playwright/test";

const PARAGRAPH =
	"the harp section needs its pedal mechanism regulated, a new set of strings, a rehearsal booking at the venue, and a written sign-off from the principal harpist before anything ships.";

function transcript() {
	let filler = Array.from({ length: 10 }, (_, index) => ({
		id: `f${index}`,
		author: { kind: "member", handle: index % 2 ? "ana" : "ben" },
		text:
			`Filler line ${index}, which runs on long enough to reach the end of a narrow Chat's text column.`,
		ts: 1_700_000_000 + index,
	}));
	return [
		...filler,
		{
			id: "headed",
			author: { kind: "member", handle: "cy" },
			text: `${PARAGRAPH} ${PARAGRAPH}`,
			ts: 1_700_000_100,
			reactions: [{ emoji: "✅", handles: ["ben"] }],
		},
		{
			id: "follow",
			author: { kind: "member", handle: "cy" },
			text:
				`${PARAGRAPH} ${PARAGRAPH}\n\n\`\`\`ts\nlet harp = restring("pedal harp", { strings: 47 });\n\`\`\``,
			ts: 1_700_000_101,
			reactions: [{ emoji: "❓", handles: ["ana"] }],
		},
		{
			id: "agent",
			author: { kind: "agent" },
			text: Array.from({ length: 4 }, (_, index) => `Paragraph ${index + 1}: ${PARAGRAPH}`).join(
				"\n\n",
			),
			ts: 1_700_000_102,
		},
		{
			id: "agent-follow",
			author: { kind: "agent" },
			text: `${PARAGRAPH} ${PARAGRAPH}`,
			ts: 1_700_000_103,
		},
		{
			id: "last",
			author: { kind: "member", handle: "ben" },
			text: "That is the root of a thread.",
			ts: 1_700_000_104,
		},
		...Array.from({ length: 10 }, (_, index) => ({
			id: `after${index}`,
			author: { kind: "member", handle: index % 2 ? "ana" : "ben" },
			text: `After line ${index}, so the rows above can scroll to the pane's top.`,
			ts: 1_700_000_200 + index,
		})),
	];
}

function chatOf(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function messageIn(scope: Locator, id: string): Locator {
	return scope.locator(`[data-chat-message-id="${id}"]`);
}

function toolbar(target: Locator): Locator {
	return target.getByRole("toolbar", { name: "Reactions and actions" });
}

type Box = { left: number; top: number; right: number; bottom: number };
type Drawn = { what: string; box: Box };

/** Every rectangle the row draws: its text line by line, its name line, its pills and its code. */
async function drawnBy(target: Locator): Promise<Drawn[]> {
	return target.evaluate(body => {
		let found: { what: string; box: Box }[] = [];
		let keep = (what: string, rect: DOMRect) => {
			if (rect.width < 1 || rect.height < 1) return;
			found.push({
				what,
				box: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
			});
		};
		let head = body.previousElementSibling?.matches("[data-chat-head]")
			? body.previousElementSibling
			: null;
		for (let root of [head, body]) {
			if (!root) continue;
			let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			while (walker.nextNode()) {
				let node = walker.currentNode as Text;
				let parent = node.parentElement;
				if (
					!node.textContent?.trim() || !parent
					|| parent.closest('.sr-only, [data-slot="message-actions"], .chat-gutter-time')
				) continue;
				let range = document.createRange();
				range.selectNodeContents(node);
				for (let rect of range.getClientRects()) keep(node.textContent.trim().slice(0, 30), rect);
			}
		}
		for (let element of body.querySelectorAll(".chat-reaction, pre, img")) {
			keep(element.tagName.toLowerCase(), element.getBoundingClientRect());
		}
		return found;
	});
}

function overlapping(bar: Box, drawn: Drawn[]): string[] {
	return drawn.filter(({ box }) =>
		Math.min(box.right, bar.right) - Math.max(box.left, bar.left) > 0.5
		&& Math.min(box.bottom, bar.bottom) - Math.max(box.top, bar.top) > 0.5
	).map(({ what }) => what);
}

async function barBox(target: Locator): Promise<Box> {
	let box = (await toolbar(target).boundingBox())!;
	return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
}

async function pane(scope: Locator): Promise<Box> {
	let box = (await scope.locator("[data-chat-scroll]").first().boundingBox())!;
	return { left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height };
}

/** Scroll so that the row's top edge is `below` px under the pane's top, or above it if negative. */
async function placeTop(scope: Locator, id: string, below: number): Promise<void> {
	await scope.locator("[data-chat-scroll]").first().evaluate((element, { id, below }) => {
		let target = element.querySelector(`[data-chat-message-id="${id}"]`)!;
		element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top
			- below;
	}, { id, below });
	await scope.page().evaluate(() => new Promise(done => requestAnimationFrame(() => done(0))));
}

async function hoverText(page: Page, target: Locator, at = 0.5): Promise<void> {
	let box = (await target.locator("[data-chat-message-text]").first().boundingBox())!;
	await page.mouse.move(0, 0);
	await page.mouse.move(box.x + box.width * 0.4, box.y + Math.min(box.height * at, box.height - 4));
}

async function attach(info: TestInfo, name: string, value: unknown): Promise<void> {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: "application/json",
	});
}

async function expectClear(
	page: Page,
	scope: Locator,
	id: string,
	label: string,
	info: TestInfo,
): Promise<void> {
	let target = messageIn(scope, id);
	await placeTop(scope, id, 160);
	await hoverText(page, target);
	let bar = toolbar(target);
	await expect(bar, label).toHaveCSS("opacity", "1");
	let box = await barBox(target);
	let drawn = await drawnBy(target);
	let shown = await pane(scope);
	let firstLine = Math.min(...drawn.map(item => item.box.top));
	await attach(info, label, { bar: box, pane: shown, firstLine, drawn: drawn.length });
	expect(drawn.length, `${label}: the row draws text`).toBeGreaterThan(3);
	expect(overlapping(box, drawn), `${label}: the bar covers nothing of its row`).toEqual([]);
	expect(box.bottom, `${label}: the bar stands above the row's first line`).toBeLessThanOrEqual(
		firstLine + 0.5,
	);
	expect(box.top, `${label}: the bar is in the pane`).toBeGreaterThanOrEqual(shown.top);
	let first = bar.getByRole("button").first();
	let aim = (await first.boundingBox())!;
	await page.mouse.move(aim.x + aim.width / 2, aim.y + aim.height / 2, { steps: 8 });
	await expect(bar, `${label}: the pointer reaches the bar from the text`).toHaveCSS(
		"opacity",
		"1",
	);
	expect(await first.evaluate(element => element.matches(":hover")), label).toBe(true);
}

for (let [width, edge] of [["narrow", "Home"], ["wide", "End"]] as const) {
	test(
		`in a ${width} Chat the hover toolbar stands above the row and covers none of its text, pills or code, headed or not`,
		async ({ join, seed }, info) => {
			await seed("# Toolbar\n", { transcript: transcript() });
			let page = await join("ana", { viewport: { width: 1600, height: 900 } });
			await page.getByRole("separator", { name: "Resize chat", exact: true }).press(edge);
			let chat = chatOf(page);
			for (let id of ["headed", "follow", "agent", "agent-follow"]) {
				await expectClear(page, chat, id, `${width} ${id}`, info);
			}
		},
	);
}

test(
	"the first message of a Chat scrolled to its top has room for its toolbar above it",
	async ({ join, seed }, info) => {
		await seed("# Toolbar\n", { transcript: transcript() });
		let page = await join("ana");
		let chat = chatOf(page);
		await chat.locator("[data-chat-scroll]").first().evaluate(element => element.scrollTo(0, 0));
		let target = messageIn(chat, "f0");
		await hoverText(page, target);
		await expect(toolbar(target)).toHaveCSS("opacity", "1");
		let box = await barBox(target);
		let shown = await pane(chat);
		await attach(info, "first row", { bar: box, pane: shown });
		expect(overlapping(box, await drawnBy(target))).toEqual([]);
		expect(box.top).toBeGreaterThanOrEqual(shown.top);
	},
);

test(
	"a message whose top edge is scrolled out of the pane shows no toolbar, and shows it above its first line once that edge is back",
	async ({ join, seed }, info) => {
		await seed("# Toolbar\n", { transcript: transcript() });
		let page = await join("ana");
		let chat = chatOf(page);
		for (let id of ["agent", "follow", "agent-follow"]) {
			let target = messageIn(chat, id);
			let bar = toolbar(target);
			for (let cut of [4, 40]) {
				await placeTop(chat, id, -cut);
				await hoverText(page, target, 0.7);
				let label = `${id}, top edge ${cut} px out`;
				await expect.poll(
					() => target.evaluate(element => getComputedStyle(element, "::before").opacity),
					{ message: `${label}: the row is shown` },
				).toBe("1");
				let box = await barBox(target);
				let shown = await pane(chat);
				await attach(info, label, { bar: box, pane: shown });
				expect(box.bottom, `${label}: the bar left with the row's top edge`).toBeLessThanOrEqual(
					shown.top,
				);
				expect(overlapping(box, await drawnBy(target)), label).toEqual([]);
			}
			await placeTop(chat, id, 120);
			await hoverText(page, target);
			await expect(bar).toHaveCSS("opacity", "1");
			let box = await barBox(target);
			let drawn = await drawnBy(target);
			expect(overlapping(box, drawn), `${id}, back in view`).toEqual([]);
			expect(box.top, `${id}, back in view`).toBeGreaterThanOrEqual((await pane(chat)).top);
		}
	},
);

test(
	"in a thread the hover toolbar of the root and of each reply covers none of its row",
	async ({ join, seed }, info) => {
		await seed("# Toolbar\n", { transcript: transcript() });
		let page = await join("ana", { viewport: { width: 1600, height: 900 } });
		let chat = chatOf(page);
		let root = messageIn(chat, "last");
		await root.scrollIntoViewIfNeeded();
		await root.hover();
		await root.getByRole("button", { name: "Reply in thread" }).click();
		let panel = page.locator("[data-thread-panel]");
		await expect(panel).toBeVisible();
		let input = chatInput(panel);
		for (let text of [`${PARAGRAPH} ${PARAGRAPH}`, `${PARAGRAPH} ${PARAGRAPH}`, "A short reply."]) {
			await fillChat(input, text);
			await input.press("Enter");
			await expect(panel.locator(".chat-message-body").last()).toContainText(text.slice(-30));
		}
		let ids = await panel.locator(".chat-message-body[data-chat-message-id]").evaluateAll(rows =>
			rows.map(row => row.getAttribute("data-chat-message-id")!)
		);
		let headed = await panel.locator(".chat-message-body[data-chat-message-id]").evaluateAll(rows =>
			rows.map(row => row.hasAttribute("data-chat-headed"))
		);
		expect(headed.slice(1, 3), "the first reply heads its run and the second continues it").toEqual(
			[
				true,
				false,
			],
		);
		for (let [index, id] of ids.slice(1, 3).entries()) {
			await expectClear(page, panel, id, `thread reply ${index + 1}`, info);
		}
	},
);

function sameAuthorRun() {
	return Array.from({ length: 16 }, (_, index) => ({
		id: `r${index}`,
		author: { kind: "member", handle: "ben" },
		text: "This is a message with words to read. ".repeat(3).trim(),
		ts: 1_700_000_300 + index,
	}));
}

type Point = { x: number; y: number };

async function stepTo(page: Page, from: Point, to: Point, pauseMs: number): Promise<void> {
	await page.mouse.move(0, 0);
	await page.mouse.move(from.x, from.y);
	await page.waitForTimeout(300);
	let steps = 25;
	for (let at = 1; at <= steps; at++) {
		await page.mouse.move(
			from.x + (to.x - from.x) * at / steps,
			from.y + (to.y - from.y) * at / steps,
		);
		if (pauseMs) await page.waitForTimeout(pauseMs);
	}
}

async function rowUnder(page: Page, point: Point): Promise<string | null> {
	return page.evaluate(({ x, y }) => {
		let hit = document.elementFromPoint(x, y);
		let inBar = hit?.closest('[data-slot="message-actions"]');
		let row = hit?.closest("[data-chat-message-id]")?.getAttribute("data-chat-message-id");
		return row ? `${row}${inBar ? " toolbar" : ""}` : null;
	}, point);
}

async function shownRows(scope: Locator): Promise<string[]> {
	return scope.locator(".chat-message-body[data-chat-message-id]").evaluateAll(rows =>
		rows.filter(row => getComputedStyle(row, "::before").opacity !== "0").map(row =>
			row.getAttribute("data-chat-message-id")!
		)
	);
}

for (
	let [path, pauseMs] of [
		["straight up", 0],
		["up and to the left", 0],
		["up and to the right, quickly", 0],
		["up and to the right, slowly", 70],
		["straight up, slowly", 70],
	] as const
) {
	test(
		`a pointer moving ${path} from a message's text to its toolbar keeps the toolbar and reaches its buttons`,
		async ({ join, seed }, info) => {
			await seed("# Toolbar\n", { transcript: sameAuthorRun() });
			let page = await join("ana", { viewport: { width: 1600, height: 900 } });
			let chat = chatOf(page);
			let target = messageIn(chat, "r8");
			await placeTop(chat, "r8", 160);
			await hoverText(page, target);
			let bar = toolbar(target);
			await expect(bar).toHaveCSS("opacity", "1");
			let row = (await target.boundingBox())!;
			let box = await barBox(target);
			let aim = { x: box.left + 16, y: (box.top + box.bottom) / 2 };
			let start = {
				"straight up": { x: aim.x, y: row.y + row.height - 10 },
				"straight up, slowly": { x: aim.x, y: row.y + row.height - 10 },
				"up and to the left": { x: box.right - 10, y: row.y + row.height - 10 },
				"up and to the right, quickly": { x: row.x + 8, y: row.y + row.height - 10 },
				"up and to the right, slowly": { x: row.x + 8, y: row.y + row.height - 10 },
			}[path];
			await attach(info, path, { row, bar: box, start, aim });
			await stepTo(page, start, aim, pauseMs);
			await page.waitForTimeout(400);
			expect(await rowUnder(page, aim), "the pointer is on r8's toolbar").toBe("r8 toolbar");
			await expect(bar).toHaveCSS("opacity", "1");
			expect(await shownRows(chat)).toEqual(["r8"]);
			await bar.getByRole("button", { name: "Message actions" }).click();
			await expect(page.getByRole("menuitem", { name: "Copy", exact: true })).toBeVisible();
		},
	);
}

test("a pointer moving up from a message's text away from its toolbar, or resting on the row before, gives that row the hover", async ({ join, seed }) => {
	await seed("# Toolbar\n", { transcript: sameAuthorRun() });
	let page = await join("ana", { viewport: { width: 1600, height: 900 } });
	let chat = chatOf(page);
	let target = messageIn(chat, "r8");
	await placeTop(chat, "r8", 160);
	await hoverText(page, target);
	await expect(toolbar(target)).toHaveCSS("opacity", "1");
	let row = (await target.boundingBox())!;
	let box = await barBox(target);
	let below = { x: row.x + row.width / 2, y: row.y + row.height - 10 };

	await stepTo(page, below, { x: row.x + 8, y: box.top + 10 }, 0);
	await expect.poll(() => shownRows(chat)).toEqual(["r7"]);
	await expect(toolbar(target)).toHaveCSS("opacity", "0");

	await stepTo(page, { x: row.x + 8, y: row.y + row.height - 10 }, {
		x: (row.x + 8 + box.left) / 2,
		y: (box.top + box.bottom) / 2,
	}, 0);
	expect(await shownRows(chat), "heading for the bar, r8 stays shown").toEqual(["r8"]);
	await page.waitForTimeout(500);
	await expect.poll(() => shownRows(chat), { message: "resting on r7, it takes the hover" })
		.toEqual(["r7"]);
});
