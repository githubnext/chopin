/**
 * Every row state Slack shades spans the Chat container from edge to edge, as Slack's message pane
 * does, and its row's whole pitch from top to bottom, and nothing of the first message is cut off at
 * the top of the transcript.
 *
 * The container is what a person sees Chat lie on. Beside the document, Chat has no frame of its
 * own: it lies on the ground from the sidebar's edge (or the window's) to the document's sheet, or
 * to the thread's divider, and the thread from that divider to the sheet (or to its own panel's
 * edge when the document folds to its bar). Alone, on a phone or in a narrow window, it is the pane
 * it fills.
 *
 * The browser here keeps the system's classic scrollbars (Playwright hides them in headless
 * Chromium), which is where a native bar set a lane aside and the shade stopped short of the edge.
 * The transcript draws its own thumb over the rows instead, so the container has no lane.
 */
import { chatInput } from "./chat-input";
import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

function transcript() {
	let rows = [
		{
			id: "first",
			author: { kind: "member" as const, handle: "ben" },
			text: "🎉🚀",
			ts: 1_700_000_000,
			reactions: [{ emoji: "🎉", handles: ["ana", "ben"] }, { emoji: "👀", handles: ["ben"] }],
		},
		{
			id: "second",
			author: { kind: "member" as const, handle: "ben" },
			text: "Staging is green ✅ and the canary held 🚀",
			ts: 1_700_000_030,
		},
	];
	for (let index = 0; index < 24; index++) {
		rows.push({
			id: `note-${index}`,
			author: { kind: "member" as const, handle: ["ana", "ben", "cy"][index % 3]! },
			text: `Note ${index} on the rollout: the dashboards stay green and the drill is booked.`,
			ts: 1_700_000_100 + index * 600,
			...(index % 4 === 0 ? { reactions: [{ emoji: "👍", handles: ["ben"] }] } : {}),
		});
	}
	return rows;
}

function chatOf(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function message(page: Page, id: string): Locator {
	return chatOf(page).locator(`.chat-split-main [data-chat-message-id="${id}"]`);
}

async function openChatOnPhone(page: Page): Promise<void> {
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect.poll(async () => (await chatOf(page).boundingBox())?.x).toBe(0);
}

async function holdOn(page: Page, target: Locator): Promise<void> {
	let box = (await target.boundingBox())!;
	let session = await page.context().newCDPSession(page);
	let point = { x: box.x + 24, y: box.y + Math.min(8, box.height / 2) };
	await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
	await page.waitForTimeout(700);
	await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await session.detach();
}

/**
 * Where a row's shade, or its source wash, is drawn against the container a person sees it in: both
 * edges, its corner and whether it shows.
 */
async function shade(row: Locator, part: "::before" | ".chat-source-tint" = "::before") {
	return row.evaluate((node, which) => {
		// A thread that opens as a sheet is drawn over the whole window, outside the workspace.
		let root = node.closest<HTMLElement>(".workspace-root");
		let pane = node.closest<HTMLElement>("[data-thread-pane]");
		let view: { left: number; right: number };
		if (!root || root.dataset.workspaceMode !== "split" || "workspacePhone" in root.dataset) {
			view = node.closest(".thread-panel, aside")!.getBoundingClientRect();
		} else {
			let ground = root.getBoundingClientRect();
			let sheet = root.querySelector(".workspace-document-stack:not([hidden]) > main");
			let end = sheet ? sheet.getBoundingClientRect().left : ground.right;
			let thread = root.querySelector<HTMLElement>("[data-thread-pane]");
			if (pane) {
				let divider = Number.parseFloat(getComputedStyle(pane).borderLeftWidth);
				let panel = pane.querySelector("[data-thread-panel]")!.getBoundingClientRect();
				view = {
					left: pane.getBoundingClientRect().left + divider,
					right: sheet ? end : panel.right,
				};
			} else {
				view = { left: ground.left, right: thread ? thread.getBoundingClientRect().left : end };
			}
		}
		let box = node.getBoundingClientRect();
		let style: CSSStyleDeclaration;
		let left: number;
		let right: number;
		if (which === "::before") {
			style = getComputedStyle(node, "::before");
			left = box.left + Number.parseFloat(style.left);
			right = left + Number.parseFloat(style.width);
		} else {
			let tint = node.querySelector(which)!;
			style = getComputedStyle(tint);
			let drawn = tint.getBoundingClientRect();
			left = drawn.left;
			right = drawn.right;
		}
		// What is drawn of it: as far as every box around it that clips it lets it reach, by its
		// overflow at its sides, or by an `inset()` clip path at its own insets.
		for (let at = node.parentElement; at; at = at.parentElement) {
			let clip = at.getBoundingClientRect();
			if (getComputedStyle(at).overflowX !== "visible") {
				left = Math.max(left, clip.left);
				right = Math.min(right, clip.right);
			}
			let path = /^inset\(([^)]*)\)$/.exec(getComputedStyle(at).clipPath);
			if (path) {
				let sides = path[1]!.trim().split(/\s+/).map(Number.parseFloat);
				left = Math.max(left, clip.left + (sides[3] ?? sides[1] ?? sides[0]!));
				right = Math.min(right, clip.right - (sides[1] ?? sides[0]!));
			}
		}
		return {
			start: Math.round(left - view.left),
			end: Math.round(view.right - right),
			radius: style.borderTopLeftRadius,
			opacity: style.opacity,
		};
	}, part);
}

const EDGE_TO_EDGE = { start: 0, end: 0, radius: "0px", opacity: "1" };

/**
 * Where each message's shade begins and ends against its pitch, as Slack's rows tile its message
 * pane: from the middle of the gap to the row before it to the middle of the gap to the row after
 * it. A message's row is its own box, from its group's top when it heads the group and to its
 * group's foot when it ends it; any other row of the transcript (a notice, a thread's lead, the
 * transcript's foot) is its box and has no shade. So neighbouring shades meet with no band between
 * them and none over another. The first row reaches as far above as half the transcript's gap.
 *
 * Then, under a mouse, down three lines (the container's start, the avatars' middle, the text's
 * start), what the pointer finds at every pixel is the row whose pitch it is in, or no message
 * between rows that are not messages: no band where a pointer moving down the transcript shades
 * nothing. A touch screen has no pointer moving down it, and keeps the rows' own boxes.
 *
 * It returns what is out of place, as words, so none is what is right.
 */
function pitches(scroller: Locator): Promise<string[]> {
	return scroller.evaluate(view => {
		let stack = view.querySelector<HTMLElement>(":scope > [data-chat-stack]")!;
		let half = Number.parseFloat(getComputedStyle(stack).rowGap) / 2;
		type Unit = { top: number; bottom: number; body?: HTMLElement; drawn?: [number, number] };
		let units: Unit[] = [];
		for (let row of stack.children) {
			let box = row.getBoundingClientRect();
			if (getComputedStyle(row).position === "absolute" || box.height === 0) continue;
			let bodies = row.matches("[data-chat-entry]")
				? [...row.querySelectorAll<HTMLElement>(".chat-message-body")]
				: [];
			if (!bodies.length) {
				units.push({ top: box.top, bottom: box.bottom });
				continue;
			}
			bodies.forEach((body, index) => {
				let own = body.getBoundingClientRect();
				let style = getComputedStyle(body, "::before");
				let top = own.top + Number.parseFloat(style.top);
				// On a touch screen an engaged message's toolbar stands in a lane above it, its own.
				let lane = Number.parseFloat(getComputedStyle(body).marginBlockStart);
				units.push({
					top: index === 0 ? box.top : own.top - lane,
					bottom: index === bodies.length - 1 ? box.bottom : own.bottom,
					body,
					drawn: [top, top + Number.parseFloat(style.height)],
				});
			});
		}
		let wrong: string[] = [];
		let owners: { top: number; bottom: number; body?: HTMLElement }[] = [];
		units.forEach((unit, index) => {
			let before = units[index - 1];
			let after = units[index + 1];
			let top = before ? (before.bottom + unit.top) / 2 : unit.top - half;
			let bottom = after ? (unit.bottom + after.top) / 2 : unit.bottom + half;
			owners.push({ top, bottom, body: unit.body });
			if (!unit.body) return;
			let id = unit.body.dataset.chatMessageId;
			let [drawnTop, drawnBottom] = unit.drawn!;
			if (Math.abs(drawnTop - top) >= 0.5) {
				wrong.push(`${id}'s shade starts ${(drawnTop - top).toFixed(1)}px from its pitch`);
			}
			if (Math.abs(drawnBottom - bottom) >= 0.5) {
				wrong.push(`${id}'s shade ends ${(drawnBottom - bottom).toFixed(1)}px from its pitch`);
			}
		});
		if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return wrong;
		let frame = view.getBoundingClientRect();
		let first = stack.querySelector<HTMLElement>(".chat-message-body")!.getBoundingClientRect();
		let avatar = stack.querySelector("[data-chat-entry] > [data-chat-avatar]")!
			.getBoundingClientRect();
		let lines = {
			container: frame.left + 1,
			avatars: avatar.left + avatar.width / 2,
			text: first.left + 4,
		};
		// Below what runs under a phone's top bar; the pixel either side of a boundary is either row's.
		let from = frame.top + (Number.parseFloat(getComputedStyle(view).scrollPaddingTop) || 0);
		for (let [line, x] of Object.entries(lines)) {
			for (let y = Math.ceil(from) + 1; y < frame.bottom - 1; y++) {
				let owner = owners.find(owner => y >= owner.top + 1 && y < owner.bottom - 1);
				if (!owner) continue;
				let hit = document.elementFromPoint(x, y);
				// What is drawn over the transcript (a resize grip at its edge, a bar over its top) is not
				// a band in it, nor is a neighbour's touch target that stands past its row.
				if (!hit || !view.contains(hit)) continue;
				let found = hit.closest<HTMLElement>(".chat-message-body")
					?? hit.closest("[data-chat-head]")?.nextElementSibling as HTMLElement | null
					?? undefined;
				if (found && found !== owner.body && hit.closest("button")) continue;
				if (found !== owner.body) {
					wrong.push(
						`at ${line} ${Math.round(y - frame.top)}px down the pointer finds ${
							found?.dataset.chatMessageId ?? "no message"
						}, in ${owner.body?.dataset.chatMessageId ?? "no message"}'s pitch`,
					);
					y = Math.ceil(owner.bottom);
				}
			}
		}
		return wrong;
	});
}

/** Whether the container sets a lane aside for a scrollbar: its client width short of its width. */
function lane(scroller: Locator): Promise<number> {
	return scroller.evaluate(node => (node as HTMLElement).offsetWidth - node.clientWidth);
}

/**
 * How far each part sticks out above what the container shows (on a phone, below the top bar the
 * transcript runs under); 0 when it is whole.
 */
function overhang(parts: Locator): Promise<number[]> {
	return parts.evaluateAll(nodes =>
		nodes.map(node => {
			let view = node.closest<HTMLElement>("[data-chat-scroll]")!;
			let top = view.getBoundingClientRect().top
				+ (Number.parseFloat(getComputedStyle(view).scrollPaddingTop) || 0);
			return Math.max(0, Math.ceil(top - node.getBoundingClientRect().top));
		})
	);
}

test("on a desktop every shaded row spans the Chat container edge to edge and its whole pitch, under classic scrollbars, with the thumb drawn over the rows", async ({ join, seed }) => {
	await seed("# Rows\n", { transcript: transcript() });
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	expect(await page.evaluate(() => document.documentElement.dataset.scrollbars)).toBe("classic");
	let scroller = chatOf(page).locator(".chat-split-main [data-chat-scroll]");
	await expect(message(page, "note-23")).toBeVisible();
	expect(await scroller.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
	expect(await lane(scroller)).toBe(0);

	let row = message(page, "note-20");
	await row.scrollIntoViewIfNeeded();
	await expect.poll(() => pitches(scroller)).toEqual([]);

	// Hovered.
	await row.locator("[data-chat-message-text]").hover();
	await expect.poll(() => shade(row)).toEqual(EDGE_TO_EDGE);
	// And in the gap above its row and the gap below it, halfway to its neighbours.
	for (let [at, past] of [["top", -4], ["bottom", 4]] as const) {
		let point = await row.evaluate((node, [at, past]) => {
			let entry = node.closest("[data-chat-entry]")!.getBoundingClientRect();
			return { x: node.getBoundingClientRect().left + 4, y: entry[at] + past };
		}, [at, past] as const);
		await page.mouse.move(point.x, point.y);
		await expect.poll(() => shade(row), `${past}px past its ${at}`).toEqual(EDGE_TO_EDGE);
	}

	// Keyboard focus within the row.
	await page.mouse.move(0, 0);
	await expect.poll(() => shade(row).then(drawn => drawn.opacity)).toBe("0");
	await row.getByRole("button", { name: "Message actions" }).focus();
	await page.keyboard.press("Shift+Tab");
	await expect.poll(() => shade(row)).toEqual(EDGE_TO_EDGE);
	await page.keyboard.press("Escape");
	await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

	// Its menu open, with the pointer gone.
	await row.locator("[data-chat-message-text]").hover();
	await row.getByRole("button", { name: "Message actions" }).click();
	await expect(page.getByRole("menu")).toBeVisible();
	await page.mouse.move(0, 0);
	await expect.poll(() => shade(row)).toEqual(EDGE_TO_EDGE);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);

	// Its emoji picker open.
	await row.locator("[data-chat-message-text]").hover();
	await row.getByRole("toolbar").getByRole("button", { name: "Add reaction" }).click();
	await expect(page.getByRole("dialog", { name: "Add reaction" })).toBeVisible();
	await page.mouse.move(0, 0);
	await expect.poll(() => shade(row)).toEqual(EDGE_TO_EDGE);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Add reaction" })).toHaveCount(0);

	// A message jumped to: the transcript draws this wash in the row it scrolls to, then fades it.
	await page.mouse.move(0, 0);
	await row.evaluate(node => {
		let tint = document.createElement("span");
		tint.className = "chat-source-tint";
		tint.style.animationPlayState = "paused";
		node.setAttribute("data-chat-source", "");
		node.prepend(tint);
	});
	expect(await shade(row, ".chat-source-tint")).toEqual(EDGE_TO_EDGE);
	// Over the same pitch as the shade.
	expect(
		await row.evaluate(node => {
			let tint = node.querySelector(".chat-source-tint")!.getBoundingClientRect();
			let style = getComputedStyle(node, "::before");
			let top = node.getBoundingClientRect().top + Number.parseFloat(style.top);
			return [
				Math.round(tint.top - top),
				Math.round(tint.bottom - top - Number.parseFloat(style.height)),
			];
		}),
	).toEqual([0, 0]);
	await row.evaluate(node => node.querySelector(".chat-source-tint")!.remove());

	// The scrollbar is drawn over the rows' end: shown while the pane is scrolled or pointed at,
	// within the container, and it scrolls the transcript when dragged. The rows' shade runs on over
	// the 8px before the document's sheet, where Resize chat is taken; the thumb ends where that
	// grip begins, so a drag takes the thumb and not the pane's edge.
	let thumb = chatOf(page).locator(".chat-split-main .chat-scroll-thumb");
	let view = (await scroller.boundingBox())!;
	await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
	await expect(thumb).toHaveCSS("opacity", "1");
	let bar = (await thumb.boundingBox())!;
	let sheet = (await page.locator(".workspace-document-panel").boundingBox())!;
	let grip = await page.getByRole("separator", { name: "Resize chat" }).evaluate(handle =>
		handle.getBoundingClientRect().left
		+ Number.parseFloat(getComputedStyle(handle, "::before").left)
	);
	expect(Math.round(view.x + view.width)).toBe(Math.round(sheet.x));
	expect(Math.round(sheet.x - grip)).toBe(8);
	expect(Math.round(grip - (bar.x + bar.width))).toBe(0);
	expect(bar.width).toBe(10);
	expect(bar.y).toBeGreaterThanOrEqual(view.y);
	expect(bar.y + bar.height).toBeLessThanOrEqual(view.y + view.height);
	let before = await scroller.evaluate(node => node.scrollTop);
	await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
	await page.mouse.down();
	await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2 - 120, { steps: 4 });
	await page.mouse.up();
	expect(await scroller.evaluate(node => node.scrollTop)).toBeLessThan(before - 120);
	await page.mouse.move(0, 0);
	await expect(thumb).toHaveCSS("opacity", "0");
	// It is not in the accessibility tree, and keyboard scrolling is the transcript's own.
	await expect(thumb.locator("xpath=..")).toHaveAttribute("aria-hidden", "true");

	// The message whose thread is open keeps its row selected, edge to edge, and the thread's
	// first reply is shaded across the thread panel.
	let second = message(page, "second");
	await second.scrollIntoViewIfNeeded();
	await second.locator("[data-chat-message-text]").hover();
	await second.getByRole("button", { name: "Reply in thread" }).click();
	let panel = page.locator("[data-thread-panel]");
	await expect(panel).toBeVisible();
	await chatInput(panel).fill("Booked for three 🎉");
	await panel.getByRole("button", { name: "Send message" }).click();
	let reply = panel.locator(".chat-message-body", { hasText: "Booked for three" });
	await expect(reply).toBeVisible();
	await page.mouse.move(0, 0);
	await expect.poll(() => shade(second)).toEqual(EDGE_TO_EDGE);
	// The document folds to its bar here: the thread's rows end at its own panel's edge.
	await expect(page.locator(".workspace-root")).toHaveAttribute("data-document-collapsed", "true");
	await reply.locator("[data-chat-message-text]").hover();
	await expect.poll(() => shade(reply)).toEqual(EDGE_TO_EDGE);
	expect(await lane(panel.locator("[data-chat-scroll]"))).toBe(0);
	// The first reply's toolbar and emoji, and the root's, are whole at the top of the thread.
	let replyBar = reply.getByRole("toolbar", { name: "Reactions and actions" });
	await expect(replyBar).toHaveCSS("opacity", "1");
	expect(await overhang(replyBar)).toEqual([0]);
	expect(await overhang(reply.locator(".chat-emoji"))).toEqual([0]);
	expect(await overhang(panel.locator("[data-thread-root-message] .chat-emoji"))).toEqual([0, 0]);
	// The thread's rows and Chat's tile their panes, the document folded.
	await page.mouse.move(0, 0);
	await expect.poll(() => pitches(panel.locator("[data-chat-scroll]"))).toEqual([]);
	await expect.poll(() => pitches(scroller)).toEqual([]);
});

/**
 * A person's message and one grouped under it, a notice, the agent's two (the second with an
 * image), and a last pair.
 */
function kinds() {
	return [
		{
			id: "ben-1",
			author: { kind: "member" as const, handle: "ben" },
			text: "Staging is green.",
			ts: 1_700_000_000,
		},
		{
			id: "ben-2",
			author: { kind: "member" as const, handle: "ben" },
			text: "The canary held.",
			ts: 1_700_000_030,
		},
		{
			id: "notice",
			author: { kind: "system" as const },
			text: "ana asked chopin to break the plan into tasks.",
			ts: 1_700_000_060,
		},
		{
			id: "agent-1",
			author: { kind: "agent" as const },
			text: "I moved the key into `router.ts`.",
			ts: 1_700_000_090,
		},
		{
			id: "agent-2",
			author: { kind: "agent" as const },
			text: "And left the drill on the plan.",
			ts: 1_700_000_100,
			images: [{ src: `/images/${"b".repeat(64)}.png`, width: 640, height: 360 }],
		},
		{
			id: "ana-1",
			author: { kind: "member" as const, handle: "ana" },
			text: "Booked it.",
			ts: 1_700_000_200,
		},
		{
			id: "ana-2",
			author: { kind: "member" as const, handle: "ana" },
			text: "For Thursday.",
			ts: 1_700_000_230,
		},
	];
}

for (
	let [label, width, split] of [
		["a 1920 window, where the thread opens beside the document", 1920, true],
		["a 1100 window, without the sidebar", 1100, true],
		["a 640 window, where Chat fills the frame", 640, false],
	] as const
) {
	test(`in ${label} every kind of row is shaded edge to edge and over its whole pitch, in Chat and in its thread`, async ({ join, seed }) => {
		await seed("# Rows\n", { transcript: kinds() });
		let page = await join("ana", { viewport: { width, height: 900 } });
		if (!split) {
			await page.getByRole("navigation", { name: "Workspace view" })
				.getByRole("button", { name: /^Chat/ }).click();
			// Chat slides in to fill the frame; the rows are pointed at once it is there.
			let frame = (await page.locator(".workspace-frame").boundingBox())!;
			await expect.poll(async () => (await chatOf(page).boundingBox())?.x).toBe(frame.x);
		}
		await expect(message(page, "ana-2")).toBeVisible();
		for (let id of ["ben-1", "ben-2", "agent-1", "agent-2", "ana-1", "ana-2"]) {
			let row = message(page, id);
			await row.locator("[data-chat-message-text]").hover({ position: { x: 4, y: 4 } });
			await expect.poll(() => shade(row), id).toEqual(EDGE_TO_EDGE);
		}
		let main = chatOf(page).locator(".chat-split-main [data-chat-scroll]");
		await page.mouse.move(0, 0);
		await expect.poll(() => pitches(main)).toEqual([]);
		// In the gap between the notice and the agent's row, 4px above the row, the pointer is on it.
		let agent = message(page, "agent-1");
		let gap = await agent.evaluate(node => {
			let text = node.getBoundingClientRect();
			return {
				x: text.left + 4,
				y: node.closest("[data-chat-entry]")!.getBoundingClientRect().top - 4,
			};
		});
		await page.mouse.move(gap.x, gap.y);
		await expect.poll(() => shade(agent)).toEqual(EDGE_TO_EDGE);

		let root = message(page, "ben-2");
		await root.locator("[data-chat-message-text]").hover({ position: { x: 4, y: 4 } });
		await root.getByRole("button", { name: "Reply in thread" }).click();
		let panel = page.locator("[data-thread-panel]");
		await expect(panel).toBeVisible();
		await chatInput(panel).fill("Booked for three");
		await panel.getByRole("button", { name: "Send message" }).click();
		let reply = panel.locator(".chat-message-body", { hasText: "Booked for three" });
		await expect(reply).toBeVisible();
		await chatInput(panel).fill("And the room.");
		await panel.getByRole("button", { name: "Send message" }).click();
		await expect(panel.locator(".chat-message-body", { hasText: "And the room." })).toBeVisible();
		await reply.locator("[data-chat-message-text]").hover({ position: { x: 4, y: 4 } });
		await expect.poll(() => shade(reply)).toEqual(EDGE_TO_EDGE);
		await page.mouse.move(0, 0);
		// The thread's replies, grouped under its lead, tile it as Chat's rows tile Chat.
		await expect.poll(() => pitches(panel.locator("[data-chat-scroll]"))).toEqual([]);
		if (split) {
			await expect.poll(() => shade(root)).toEqual(EDGE_TO_EDGE);
			await expect.poll(() => pitches(main)).toEqual([]);
		}
	});
}

test("on a desktop the first message's toolbar, its jumbomoji and its reactions are whole at the top of the transcript", async ({ join, seed }) => {
	await seed("# Rows\n", { transcript: transcript() });
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	let scroller = chatOf(page).locator(".chat-split-main [data-chat-scroll]");
	let first = message(page, "first");
	await expect(message(page, "note-23")).toBeVisible();
	await scroller.evaluate(node => node.scrollTo({ top: 0 }));
	await expect(first).toBeInViewport();

	await first.locator("[data-chat-message-text]").hover();
	let bar = first.getByRole("toolbar", { name: "Reactions and actions" });
	await expect(bar).toHaveCSS("opacity", "1");
	expect(await overhang(bar)).toEqual([0]);
	expect(await overhang(bar.getByRole("button"))).toEqual([0, 0, 0, 0, 0, 0]);
	// The bar's shadow too: it clears the container's top by more than its own 1px spread.
	expect(
		await bar.evaluate(node =>
			node.getBoundingClientRect().top
			- node.closest("[data-chat-scroll]")!.getBoundingClientRect().top
		),
	).toBeGreaterThanOrEqual(4);
	expect(await overhang(first.locator(".chat-emoji"))).toEqual([0, 0]);
	expect(await overhang(first.locator(".chat-reaction"))).toEqual([0, 0, 0]);
	// The quick reactions are hit where they are drawn, not under the container's edge.
	let check = (await bar.getByRole("button").first().boundingBox())!;
	expect(
		await page.evaluate(
			({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".chat-message-toolbar"),
			{ x: check.x + check.width / 2, y: check.y + 2 },
		),
	).toBe(true);
});

test("on a phone an engaged row spans the Chat container edge to edge, and the first message's toolbar is whole", async ({ join, seed }) => {
	await seed("# Rows\n", { transcript: transcript() });
	let page = await join("ana", PHONE);
	await openChatOnPhone(page);
	let scroller = chatOf(page).locator(".chat-split-main [data-chat-scroll]");
	await expect(message(page, "note-23")).toBeVisible();
	expect(await lane(scroller)).toBe(0);

	let row = message(page, "note-20");
	await row.scrollIntoViewIfNeeded();
	await expect.poll(() => pitches(scroller)).toEqual([]);
	await holdOn(page, row.locator("[data-chat-message-text]"));
	await expect.poll(() => shade(row)).toEqual(EDGE_TO_EDGE);
	// Its toolbar's lane above it is its own, and its shade still meets its neighbours'.
	await expect.poll(() => pitches(scroller)).toEqual([]);

	await page.locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.mouse.click(1, 1).catch(() => {});
	await scroller.evaluate(node => node.scrollTo({ top: 0 }));
	let first = message(page, "first");
	await expect(first).toBeInViewport();
	await holdOn(page, first.locator("[data-chat-message-text]"));
	let bar = first.getByRole("toolbar", { name: "Reactions and actions" });
	await expect(bar).toBeVisible();
	await expect.poll(() => shade(first)).toEqual(EDGE_TO_EDGE);
	expect(await overhang(bar)).toEqual([0]);
	expect(await overhang(first.locator(".chat-emoji"))).toEqual([0, 0]);
});

test("scrolling a long Chat moves only its thumb: it forces no layout and restyles none of the transcript", async ({ join, seed }) => {
	let rows = Array.from({ length: 160 }, (_, index) => ({
		id: `long-${index}`,
		author: { kind: "member" as const, handle: ["ana", "ben", "cy"][index % 3]! },
		text: `Message ${index} about the rollout plan, and what it still needs from each team.`,
		ts: 1_700_000_000 + index * 120,
		...(index % 3 === 0 ? { reactions: [{ emoji: "👍", handles: ["ben"] }] } : {}),
	}));
	await seed("# Long Chat\n", { transcript: rows });
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	let scroller = chatOf(page).locator(".chat-split-main [data-chat-scroll]");
	await expect(message(page, "long-159")).toBeVisible();
	// Older messages are added in small steps while the page is idle; what grows is not the thumb.
	await expect(message(page, "long-0")).toBeAttached();
	await page.mouse.move(0, 0);
	let settle = () =>
		page.evaluate(() =>
			new Promise<void>(resolve =>
				requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))
			)
		);
	// The last step's own effects, and the frames after them, lay the page out once more.
	for (let frame = 0; frame < 5; frame++) await settle();
	let browser = page.context().browser()!;
	await browser.startTracing(page, {
		categories: ["devtools.timeline", "disabled-by-default-devtools.timeline.stack"],
	});
	for (let step = 0; step < 20; step++) {
		await scroller.evaluate(node => node.scrollBy({ top: -90 }));
		await settle();
	}
	let trace = JSON.parse((await browser.stopTracing()).toString()) as {
		traceEvents: {
			name: string;
			args?: { elementCount?: number; beginData?: { dirtyObjects?: number; stackTrace?: unknown } };
		}[];
	};
	let laid = trace.traceEvents.filter(event => event.name === "Layout")
		.map(event => event.args?.beginData ?? {});
	let restyled = trace.traceEvents
		.filter(event => event.name === "UpdateLayoutTree")
		.map(event => event.args?.elementCount ?? 0);
	// The thumb showed and followed the scroll.
	let thumb = chatOf(page).locator(".chat-split-main .chat-scroll-thumb");
	await expect(thumb).toHaveCSS("opacity", "1");
	expect(await thumb.evaluate(node => node.style.translate)).not.toBe("");
	// Its moves are a transform. No script forced the page's layout (a read after a write would carry
	// its stack), a layout in the frame touched a few objects of the thousands the transcript has, and
	// a style pass touched the thumb and the pane's scroll edge, where anything the transcript's
	// messages answered to would restyle thousands.
	expect(laid.filter(layout => layout.stackTrace).length, "layouts a script forced").toBe(0);
	expect(Math.max(0, ...laid.map(layout => layout.dirtyObjects ?? 0))).toBeLessThan(40);
	expect(restyled.length).toBeGreaterThan(0);
	expect(Math.max(...restyled)).toBeLessThan(40);
});
