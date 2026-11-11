/**
 * While a pane's edge is dragged, the blocks of the document and of Chat that are far from the
 * window are left out of layout, so that a long document does not have to be laid out in full on
 * every step. What a person sees must not change: the blocks near the window are drawn as they
 * always were, the reader keeps their place, and what the drag ends on is what a keyboard step to
 * the same width ends on. Which blocks are near, and what a block keeps while it is left out, is
 * `pane-drag-skip.test.ts`; that the browser really skips them, and gives them back, is here.
 */

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { storedResolvedComment } from "../apps/server/src/testing/plan";
import { content, expect, ready, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

/*
 * A trace's snapshot of the page reads the scroll offset of every element, and each read inside a
 * block that is left out of layout makes the browser lay that block out again for the read: with
 * tables scrolled sideways and a drag in progress, a snapshot took seconds, and each action takes
 * two. No reader of the page does that; only the trace does, so these tests run without one.
 */
test.use({ trace: "off", viewport: { width: 1440, height: 900 } });

const SECTIONS = 14;
const PARAGRAPH = "The rollout of the token service goes team by team, and each team signs off "
	+ "before the next begins. Keep the notes short and say who owns each step.";

function row(cell: (column: number) => string): string {
	return `| ${Array.from({ length: 10 }, (_, column) => cell(column)).join(" | ")} |`;
}

/** A table wide enough to scroll inside its own lane, so that it has an offset to keep. */
function table(section: number): string {
	return [
		row(column => `Column ${column}`),
		row(() => "---"),
		...Array.from(
			{ length: 8 },
			(_, line) => row(column => `Cell ${section}.${line}.${column} holds a few words`),
		),
	].join("\n");
}

/** Four top-level blocks to a section, after the title: heading, paragraph, table, code. */
function source(): string {
	return `# Specification\n\n${
		Array.from(
			{ length: SECTIONS },
			(_, section) =>
				`## Section ${section}\n\n${PARAGRAPH} This is paragraph ${section}.\n\n${
					table(section)
				}\n\n`
				+ `\`\`\`ts\nlet section${section} = ${section};\n\`\`\`\n`,
		).join("\n")
	}`;
}

function transcript(): Chat.Entry[] {
	return Array.from({ length: 70 }, (_, index) => ({
		id: `message-${index}`,
		author: { kind: "member" as const, handle: index % 2 ? "ana" : "ben" },
		text: `Message ${index} about the rollout plan and what it still needs from each team, `
			+ `written long enough that it takes a few lines of the pane and then some more.`,
		ts: 1_700_000_000 + index,
	}));
}

/** Two frames, so that anything the last pointer move scheduled for the next frame has happened. */
function settle(page: Page) {
	return page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 200)))
		)
	);
}

/**
 * Put the document at a share of its scrollable length, or with the paragraph that has this text in
 * the middle of its window, and Chat at a share of its own, and wait until they stay. Only the
 * document's own scroller moves: `scrollIntoView` would move the one around it too.
 *
 * Both are asked again if they did not stay. A render of Chat that comes between the write and the
 * scroll event the write causes finds the reader still at the newest line, which every render
 * keeps them on, and puts the rail back there. Chat renders again for each change that another
 * test of a run makes to the repository's documents (the rail was written once in four seconds
 * with no other writer, and fourteen times with one creating a document every 300 ms), so in a
 * run of many specs a render lands in that frame now and then. A paragraph that was put in the
 * middle once stopped 37 px from where every other run stopped, in a run of 300 under that load;
 * what moved it is not known, so it too is put again until it is in the middle.
 */
async function place(page: Page, document: number | string | undefined, chat: number) {
	let held = false;
	for (let attempt = 0; attempt < 5 && !held; attempt++) {
		let target = await page.evaluate(
			([document_, chat_]: [number | string | undefined, number]) => {
				let scroller: HTMLElement | null = window.document.querySelector(
					".plan-content[contenteditable='true']",
				);
				while (
					scroller
					&& !(getComputedStyle(scroller).overflowY === "auto"
						&& scroller.scrollHeight > scroller.clientHeight + 100)
				) scroller = scroller.parentElement;
				if (typeof document_ === "number") {
					scroller!.scrollTop = (scroller!.scrollHeight - scroller!.clientHeight) * document_;
				} else if (typeof document_ === "string") {
					let paragraph = [...window.document.querySelectorAll(".plan-content > p")]
						.find(element => element.textContent!.includes(document_))!;
					let box = scroller!.getBoundingClientRect();
					scroller!.scrollTop += paragraph.getBoundingClientRect().top - box.top - box.height / 2;
				}
				let rail = window.document.querySelector<HTMLElement>("[data-chat-scroll]")!;
				rail.scrollTop = (rail.scrollHeight - rail.clientHeight) * chat_;
				return rail.scrollTop;
			},
			[document, chat] as [number | string | undefined, number],
		);
		await settle(page);
		held = await page.evaluate(
			([wanted, document_]: [number, number | string | undefined]) => {
				let rail = window.document.querySelector<HTMLElement>("[data-chat-scroll]")!;
				if (Math.abs(rail.scrollTop - wanted) > 1) return false;
				if (typeof document_ !== "string") return true;
				let scroller: HTMLElement | null = window.document.querySelector(
					".plan-content[contenteditable='true']",
				);
				while (
					scroller
					&& !(getComputedStyle(scroller).overflowY === "auto"
						&& scroller.scrollHeight > scroller.clientHeight + 100)
				) scroller = scroller.parentElement;
				let paragraph = [...window.document.querySelectorAll(".plan-content > p")]
					.find(element => element.textContent!.includes(document_))!;
				let box = scroller!.getBoundingClientRect();
				return Math.abs(paragraph.getBoundingClientRect().top - box.top - box.height / 2) <= 1;
			},
			[target, document] as [number, number | string | undefined],
		);
	}
	expect(held, "the document and Chat stay where they were put").toBe(true);
}

/** Where the reader is, in both panes, as the browser keeps it. */
function reading(page: Page) {
	return page.evaluate(() => {
		let root = window.document.querySelector<HTMLElement>(".plan-content[contenteditable='true']")!;
		let scroller: HTMLElement | null = root;
		while (
			scroller
			&& !(getComputedStyle(scroller).overflowY === "auto"
				&& scroller.scrollHeight > scroller.clientHeight + 100)
		) scroller = scroller.parentElement;
		let rail = window.document.querySelector<HTMLElement>("[data-chat-scroll]")!;
		let stack = window.document.querySelector<HTMLElement>("[data-chat-stack]")!;
		let [inDocument, inChat] = (
			[[scroller!, [...root.children]], [rail, [...stack.children]]] as const
		).map(([container, items]) => {
			let top = container.getBoundingClientRect().top;
			let index = items.findIndex(item => item.getBoundingClientRect().bottom > top + 1);
			return `${index} at ${
				(items[index]!.getBoundingClientRect().top - top).toFixed(1)
			} of ${container.scrollHeight}`;
		});
		return { chat: inChat, document: inDocument };
	});
}

async function pressEdge(page: Page, label: string) {
	let handle = page.getByRole("separator", { name: label });
	let box = (await handle.boundingBox())!;
	let x = box.x + box.width / 2;
	let y = box.y + Math.min(box.height / 2, 300);
	await page.mouse.move(x, y);
	await page.mouse.down();
	return { move: (by: number, steps = 8) => page.mouse.move(x + by, y, { steps }), x, y };
}

test("a drag leaves the far blocks of the document and of Chat out of layout, and the near ones alone", async ({ join, page, seed }) => {
	await seed(source(), { transcript: transcript() });
	await join("ana");
	await expect(content(page).locator("table")).toHaveCount(SECTIONS);
	await expect(page.getByText("Message 69 about the rollout plan")).toBeVisible();
	await place(page, 0.5, 0.5);
	let heights = await page.evaluate(() =>
		[...window.document.querySelectorAll(".plan-content > table")].map(table =>
			table.getBoundingClientRect().height
		)
	);

	let edge = await pressEdge(page, "Resize chat");
	await edge.move(40);
	await settle(page);

	let during = await page.evaluate(() => {
		let tables = [...window.document.querySelectorAll<HTMLTableElement>(".plan-content > table")];
		let near = tables.find(table => {
			let box = table.getBoundingClientRect();
			return box.bottom > 0 && box.top < innerHeight;
		})!;
		let far = tables[0]!;
		let rows = [...window.document.querySelectorAll<HTMLElement>("[data-chat-stack] > *")];
		let seen = rows.find(row => {
			let box = row.getBoundingClientRect();
			return box.bottom > 100 && box.top < innerHeight - 100;
		})!;
		return {
			dragging: window.document.documentElement.hasAttribute("data-pane-dragging"),
			farHeight: far.getBoundingClientRect().height,
			farLaidOut: far.rows[3]!.cells[3]!.checkVisibility({ contentVisibilityAuto: true }),
			farMarked: far.hasAttribute("data-drag-skip"),
			nearLaidOut: near.rows[1]!.cells[1]!.checkVisibility({ contentVisibilityAuto: true }),
			nearMarked: near.hasAttribute("data-drag-skip"),
			rowFarLaidOut: rows[0]!.firstElementChild!.checkVisibility({ contentVisibilityAuto: true }),
			rowFarMarked: rows[0]!.hasAttribute("data-drag-skip"),
			rowNearMarked: seen.hasAttribute("data-drag-skip"),
		};
	});
	// The page says a drag is on, and the blocks far from the window are not laid out...
	expect(during.dragging).toBe(true);
	expect(during.farMarked).toBe(true);
	expect(during.farLaidOut).toBe(false);
	expect(during.rowFarMarked).toBe(true);
	expect(during.rowFarLaidOut).toBe(false);
	// ...at the height they had, so nothing moves around them; the ones the reader sees are laid out as ever.
	expect(during.farHeight).toBeCloseTo(heights[0]!, 0);
	expect(during.nearMarked).toBe(false);
	expect(during.nearLaidOut).toBe(true);
	expect(during.rowNearMarked).toBe(false);

	await page.mouse.up();
	// Nothing of it is left behind, not even an empty style attribute on a block.
	await expect.poll(() =>
		page.evaluate(() => window.document.documentElement.hasAttribute("data-pane-dragging"))
	)
		.toBe(false);
	expect(
		await page.evaluate(() => ({
			marked: window.document.querySelectorAll("[data-drag-skip]").length,
			sized: window.document.querySelectorAll("[style*='--drag-skip-size']").length,
			style: window.document.querySelector(".plan-content > table")!.getAttribute("style"),
		})),
	).toEqual({ marked: 0, sized: 0, style: null });
});

test("a press on an edge that never moves it leaves nothing out of layout", async ({ join, page, seed }) => {
	await seed(source(), { transcript: transcript() });
	await join("ana");
	await expect(content(page).locator("table")).toHaveCount(SECTIONS);
	await page.evaluate(() => {
		let log: string[] = [];
		(window as unknown as { __dragLog: string[] }).__dragLog = log;
		new MutationObserver(() =>
			log.push(String(window.document.documentElement.hasAttribute("data-pane-dragging")))
		)
			.observe(window.document.documentElement, {
				attributeFilter: ["data-pane-dragging"],
				attributes: true,
			});
	});

	await pressEdge(page, "Resize chat");
	await page.mouse.up();
	await settle(page);

	expect(await page.evaluate(() => (window as unknown as { __dragLog: string[] }).__dragLog))
		.toEqual([]);
});

test("the Projects sidebar's edge leaves the far blocks out of layout in the same way", async ({ join, page, seed }) => {
	await seed(source(), { transcript: transcript() });
	await join("ana");
	await expect(content(page).locator("table")).toHaveCount(SECTIONS);
	await place(page, 0.5, 0.5);

	let edge = await pressEdge(page, "Resize Projects sidebar");
	await edge.move(40);
	await settle(page);
	expect(
		await page.evaluate(() => ({
			dragging: window.document.documentElement.hasAttribute("data-pane-dragging"),
			marked: window.document.querySelectorAll("[data-drag-skip]").length > 0,
		})),
	).toEqual({ dragging: true, marked: true });

	await page.mouse.up();
	await expect.poll(() =>
		page.evaluate(() => window.document.querySelectorAll("[data-drag-skip]").length)
	)
		.toBe(0);
	expect(
		await page.evaluate(() => window.document.documentElement.hasAttribute("data-pane-dragging")),
	)
		.toBe(false);
});

test("a block the reader scrolls to during the drag is laid out as they reach it", async ({ join, page, seed }) => {
	await seed(source(), { transcript: transcript() });
	await join("ana");
	await expect(content(page).locator("table")).toHaveCount(SECTIONS);

	let edge = await pressEdge(page, "Resize chat");
	await edge.move(40);
	await settle(page);
	// Scrolling while the button is down brings blocks into view that were far when the drag began.
	await place(page, 0.85, 0.5);

	let reached = await page.evaluate(() => {
		let table = [...window.document.querySelectorAll<HTMLTableElement>(".plan-content > table")]
			.find(table => {
				let box = table.getBoundingClientRect();
				return box.bottom > 150 && box.top < innerHeight - 150;
			})!;
		let cell = table.rows[2]!.cells[1]!;
		return {
			laidOut: cell.checkVisibility({ contentVisibilityAuto: true }),
			text: cell.textContent,
			wide: cell.getBoundingClientRect().width > 0,
		};
	});
	expect(reached.laidOut).toBe(true);
	expect(reached.wide).toBe(true);
	expect(reached.text).toMatch(/^Cell \d+\.1\.1 holds/);

	await page.mouse.up();
});

test("wide tables keep how far they were scrolled sideways through a drag that left them out of layout", async ({ join, page, seed }) => {
	await seed(source(), { transcript: transcript() });
	await join("ana");
	await expect(content(page).locator("table")).toHaveCount(SECTIONS);
	let first = content(page).locator("table").first();
	let second = content(page).locator("table").nth(1);
	await first.evaluate(element => (element.scrollLeft = 130));
	await second.evaluate(element => (element.scrollLeft = 90));
	expect(await first.evaluate(element => element.scrollLeft)).toBe(130);

	await place(page, 0.7, 0.5);
	let edge = await pressEdge(page, "Resize chat");
	await edge.move(48);
	await settle(page);
	// Both are far from the window now, and the browser has no sideways offset to give a table whose
	// contents it has not laid out.
	expect(
		await page.evaluate(() =>
			[...window.document.querySelectorAll(".plan-content > table")].slice(0, 2).map(table =>
				table.hasAttribute("data-drag-skip")
			)
		),
	).toEqual([true, true]);
	await page.mouse.up();
	await expect.poll(() =>
		page.evaluate(() => window.document.querySelectorAll("[data-drag-skip]").length)
	)
		.toBe(0);

	await place(page, 0, 0.5);
	expect(await first.evaluate(element => element.scrollLeft)).toBe(130);
	expect(await second.evaluate(element => element.scrollLeft)).toBe(90);
});

/**
 * A comment on a paragraph in the middle of the document, as a thread the room carries: its chip
 * is placed beside the paragraph, and the place is measured from the layout.
 */
async function commented() {
	let section = 6;
	let block = 1 + 4 * section + 1;
	let made = await storedResolvedComment(source(), `This is paragraph ${section}`, {
		block,
		notes: ["Should each team sign off in writing?"],
		resolver: "ana",
		result: [],
	});
	let { result: _result, quote: _quote, resolver: _resolver, at: _at, ...rest } = made.thread;
	return { ...rest, status: "open" as const };
}

function chipBox(element: Element) {
	return element.getBoundingClientRect().toJSON() as DOMRect;
}

/**
 * One photograph for every face, and a wait for it before a picture. A face (`face.tsx`) shows its
 * person's initial until their photograph arrives (the picture the server stored for their login,
 * which the fake GitHub puts on example.invalid, or else github.com), so the page a picture shows
 * depends on how long github.com took. The drag's picture is taken on the first load and the
 * keyboard step's after a reload, which finds the photograph in the cache; when it arrives between
 * the two, they differ in the faces and nowhere else. Answering the requests here takes the network
 * out of both pictures without loosening what they are compared on: the faces are drawn, and the
 * same.
 */
const FACE = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80">'
	+ '<rect width="80" height="80" fill="#e6ece8"/><circle cx="40" cy="31" r="13" fill="#66776d"/>'
	+ '<path d="M17 73c0-27 46-27 46 0" fill="#66776d"/></svg>';

function fixFaces(page: Page) {
	return page.route(
		/^https:\/\/(avatars\.githubusercontent\.com\/|(github\.com|example\.invalid)\/[^/?]+\.png(\?|$))/,
		route => route.fulfill({ body: FACE, contentType: "image/svg+xml" }),
	);
}

/** Every face beside the Projects sidebar has its photograph, or gave up and shows its initial. */
function facesSettled(page: Page) {
	return expect.poll(
		() =>
			page.evaluate(() =>
				[...window.document.images]
					.filter(image => !image.closest(".project-sidebar-frame"))
					.every(image => image.complete && getComputedStyle(image).opacity !== "0")
			),
		{ message: "every face is drawn from its photograph or its initial" },
	).toBe(true);
}

/**
 * What the workspace shows, the document and Chat, as a picture: everything to the right of the
 * Projects sidebar. The sidebar lists every document that the other tests of a run make in the
 * repository, and shows how many decisions are open in them, so a picture of it changes whenever
 * one of those tests runs, and neither the drag nor the keyboard step has anything to do with what
 * it lists. The Projects edge's own width is held to the same value by the test, not by a picture.
 */
async function workspaceShot(page: Page) {
	await facesSettled(page);
	let sidebar = (await page.locator(".project-sidebar-frame").boundingBox())!;
	let left = sidebar.x + sidebar.width;
	let view = page.viewportSize()!;
	return page.screenshot({
		clip: { x: left, y: 0, width: view.width - left, height: view.height },
	});
}

function same(first: Buffer, second: Buffer) {
	return createHash("sha256").update(first).digest("hex")
		=== createHash("sha256").update(second).digest("hex");
}

const EDGES = [
	{ edge: "Resize chat", label: "Chat", pane: "aside.workspace-chat-panel" },
	{ edge: "Resize Projects sidebar", label: "Projects sidebar", pane: ".project-sidebar-frame" },
];

for (let { edge, label, pane } of EDGES) {
	test(
		`a ${label} drag ends on the same page, and the reader in the same place, as a keyboard step to the same width`,
		async ({ join, page, seed }, testInfo) => {
			await seed(source(), { transcript: transcript(), threads: [await commented()] });
			await fixFaces(page);
			await join("ana");
			await expect(content(page).locator("table")).toHaveCount(SECTIONS);
			let handle = page.getByRole("separator", { name: edge });
			let chip = page.getByRole("button", { name: /^Comment on/ });

			/**
			 * Until the chip and the reader have stopped moving: code is coloured after the document has
			 * opened, and each block that is changes its height when it is.
			 */
			async function steady() {
				let still = 0;
				let last = "";
				for (let reads = 0; reads < 60 && still < 3; reads++) {
					await settle(page);
					let now = JSON.stringify([await chip.evaluate(chipBox), await reading(page)]);
					still = now === last ? still + 1 : 0;
					last = now;
				}
				expect(still).toBe(3);
				return JSON.parse(last) as [DOMRect, Awaited<ReturnType<typeof reading>>];
			}

			/** The commented paragraph in the middle of the window, so that its chip is beside it. */
			async function reach() {
				await expect(page.getByText("Message 69 about the rollout plan")).toBeVisible();
				// Once the document has its final height: the paragraph is placed by where it is.
				let height = "";
				for (let reads = 0, still = 0; reads < 60 && still < 3; reads++) {
					await settle(page);
					let now = (await reading(page)).document.split(" of ")[1]!;
					still = now === height ? still + 1 : 0;
					height = now;
				}
				await place(page, "This is paragraph 6.", 0.5);
				await expect(chip).toBeVisible();
				return steady();
			}

			/** A page with nothing hovered or focused, so that only what the width made is in the picture. */
			async function ended() {
				await page.mouse.move(5, 5);
				await page.evaluate(() => (window.document.activeElement as HTMLElement | null)?.blur());
				let [box, where] = await steady();
				return { chip: box, reading: where, shot: await workspaceShot(page) };
			}

			let width = () =>
				page.evaluate(
					selector => window.document.querySelector(selector)!.getBoundingClientRect().width,
					pane,
				);
			let opened = await reach();
			let before = await width();
			let drag = await pressEdge(page, edge);
			await drag.move(96, 12);
			await page.mouse.up();
			let dragged = await ended();
			// The edge went where the pointer went, so the layout really changed under the reader.
			expect(await width()).toBe(before + 96);

			await page.evaluate(() => localStorage.clear());
			await page.reload();
			await ready(page);
			await expect(content(page).locator("table")).toHaveCount(SECTIONS);
			// The same place before the two ways of resizing, or what they end on says nothing of them.
			expect(await reach()).toEqual(opened);
			await handle.focus();
			for (let step = 0; step < 6; step++) await page.keyboard.press("ArrowRight");
			let stepped = await ended();

			expect(await width()).toBe(before + 96);
			await writeFile(testInfo.outputPath("dragged.png"), dragged.shot);
			await writeFile(testInfo.outputPath("stepped.png"), stepped.shot);
			expect(dragged.chip).toEqual(stepped.chip);
			expect(dragged.reading).toEqual(stepped.reading);
			expect(same(dragged.shot, stepped.shot)).toBe(true);
		},
	);
}
