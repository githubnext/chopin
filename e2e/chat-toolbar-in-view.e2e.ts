/**
 * A Chat message's toolbar is where the pointer can reach it whatever part of the message is on
 * screen, as Slack's is: hovering any visible part of a message whose top is scrolled out of the pane
 * shows its bar pinned to the top of what is visible of it, following it while the pane scrolls and
 * back at the row's top-right corner once its top is in view; a message cut by the composer has its
 * bar in the pane too. Each case records where the bar is and whether each of its buttons is on
 * screen, drawn at full strength and the thing the pointer meets.
 */
import { chatInput, fillChat } from "./chat-input";
import { expect, test } from "./room";

import type { Locator, Page, TestInfo } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const WIDE = { viewport: { width: 1600, height: 900 } };
const PARAGRAPH =
	"the harp section needs its pedal mechanism regulated, a new set of strings, a rehearsal booking at the venue, and a written sign-off from the principal harpist before anything ships.";

function paragraphs(count: number): string {
	return Array.from({ length: count }, (_, index) => `Paragraph ${index + 1}: ${PARAGRAPH}`)
		.join("\n\n");
}

function transcript() {
	let filler = (from: number, count: number) =>
		Array.from({ length: count }, (_, index) => ({
			id: `f${from + index}`,
			author: { kind: "member", handle: index % 2 ? "ana" : "ben" },
			text: `Filler line ${from + index}, a short one.`,
			ts: 1_700_000_000 + from + index,
		}));
	return [
		...filler(0, 8),
		{
			id: "short",
			author: { kind: "member", handle: "cy" },
			text: "One short line.",
			ts: 1_700_000_100,
		},
		{ id: "medium", author: { kind: "agent" }, text: paragraphs(3), ts: 1_700_000_101 },
		...filler(20, 3),
		{ id: "tall", author: { kind: "agent" }, text: paragraphs(12), ts: 1_700_000_102 },
		...filler(40, 12),
	];
}

function chatOf(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function scrollerOf(scope: Locator): Locator {
	return scope.locator("[data-chat-scroll]").first();
}

function messageIn(scope: Locator, id: string): Locator {
	return scope.locator(`[data-chat-message-id="${id}"]`);
}

function toolbar(target: Locator): Locator {
	return target.getByRole("toolbar", { name: "Reactions and actions" });
}

/** Where the pane shows rows: its scroller, below a phone's top bar that the rows run under. */
async function shown(scroller: Locator): Promise<{ top: number; bottom: number }> {
	return scroller.evaluate(element => {
		let box = element.getBoundingClientRect();
		let bar = document.querySelector(".phone-top-bar")?.getBoundingClientRect();
		let top = bar && bar.height > 0 && bar.bottom > box.top ? bar.bottom : box.top;
		return { top, bottom: box.bottom };
	});
}

/** Scroll so that `cut` px of the message's top is above the shown part, or below it if negative. */
async function cutTop(scroller: Locator, id: string, cut: number): Promise<void> {
	let { top } = await shown(scroller);
	await scroller.evaluate((element, { id, cut, top }) => {
		let target = element.querySelector(`[data-chat-message-id="${id}"]`)!;
		element.scrollTop += target.getBoundingClientRect().top - top + cut;
	}, { id, cut, top });
	await scroller.page().evaluate(() => new Promise(done => requestAnimationFrame(() => done(0))));
}

/** Scroll so that only `seen` px of the message's top shows above the shown part's bottom. */
async function cutBottom(scroller: Locator, id: string, seen: number): Promise<void> {
	let { bottom } = await shown(scroller);
	await scroller.evaluate((element, { id, seen, bottom }) => {
		let target = element.querySelector(`[data-chat-message-id="${id}"]`)!;
		element.scrollTop += target.getBoundingClientRect().top - (bottom - seen);
	}, { id, seen, bottom });
	await scroller.page().evaluate(() => new Promise(done => requestAnimationFrame(() => done(0))));
}

/** A point on the visible part of the message, away from its toolbar's corner. */
async function visiblePoint(scroller: Locator, target: Locator, at: "top" | "middle" | "bottom") {
	let { top, bottom } = await shown(scroller);
	let box = (await target.boundingBox())!;
	let from = Math.max(top, box.y);
	let to = Math.min(bottom, box.y + box.height);
	expect(to - from, "some of the message is on screen").toBeGreaterThan(4);
	let y = at === "top" ? from + 3 : at === "bottom" ? to - 3 : (from + to) / 2;
	return { x: box.x + box.width * 0.3, y };
}

/** How dark the darkest pixel of `box` is drawn, which a veil over the bar lightens. */
async function darkest(page: Page, box: { x: number; y: number; width: number; height: number }) {
	let png = (await page.screenshot({ animations: "disabled", clip: box })).toString("base64");
	return page.evaluate(async data => {
		let bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
		let bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		let canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		let context = canvas.getContext("2d")!;
		context.drawImage(bitmap, 0, 0);
		let pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
		let lowest = 255;
		for (let at = 0; at < pixels.length; at += 4) {
			lowest = Math.min(
				lowest,
				0.2126 * pixels[at]! + 0.7152 * pixels[at + 1]! + 0.0722 * pixels[at + 2]!,
			);
		}
		return Math.round(lowest);
	}, png);
}

type Button = { name: string; top: number; onScreen: boolean; hit: boolean; ink?: number };
type Seen = {
	bar: { top: number; bottom: number } | null;
	pane: { top: number; bottom: number };
	buttons: Button[];
};

/** Where the bar is and, for each of its buttons, whether it is on screen and what a pointer meets there. */
async function record(scroller: Locator, target: Locator): Promise<Seen> {
	let page = scroller.page();
	let pane = await shown(scroller);
	let bar = toolbar(target);
	let box = await bar.boundingBox();
	let buttons: Button[] = await bar.evaluate(
		(element, pane) =>
			[...element.querySelectorAll("button")].map(button => {
				let rect = button.getBoundingClientRect();
				let corners = [
					[rect.left + 3, rect.top + 3],
					[rect.right - 3, rect.top + 3],
					[rect.left + 3, rect.bottom - 3],
					[rect.right - 3, rect.bottom - 3],
					[rect.left + rect.width / 2, rect.top + rect.height / 2],
				];
				return {
					name: button.getAttribute("aria-label") ?? "",
					top: Math.round(rect.top),
					onScreen: rect.top >= pane.top && rect.bottom <= pane.bottom && rect.width > 0,
					// Its centre is the button itself; its corners are the bar's, where a neighbour's
					// larger touch target may reach over them.
					hit: corners.every(([x, y], index) => {
						let found = document.elementFromPoint(x!, y!);
						return !!found && (index === 4 ? button : element).contains(found);
					}),
				};
			}),
		pane,
	);
	if (box) {
		let more = bar.getByRole("button", { name: "Message actions" });
		let moreBox = await more.boundingBox();
		let index = buttons.findIndex(button => button.name === "Message actions");
		let viewport = page.viewportSize()!;
		if (
			moreBox && index >= 0 && moreBox.y >= 0 && moreBox.y + moreBox.height <= viewport.height
		) {
			buttons[index]!.ink = await darkest(page, moreBox);
		}
	}
	return {
		bar: box ? { top: Math.round(box.y), bottom: Math.round(box.y + box.height) } : null,
		pane: { top: Math.round(pane.top), bottom: Math.round(pane.bottom) },
		buttons,
	};
}

async function attach(info: TestInfo, name: string, value: unknown): Promise<void> {
	await info.attach(name, {
		body: JSON.stringify(value, null, 2),
		contentType: "application/json",
	});
	console.log(`${info.title} :: ${name}: ${JSON.stringify(value)}`);
}

/** The darkest ink of the three-dots button on a bar standing over the middle of the pane. */
async function restingInk(page: Page, scroller: Locator, scope: Locator): Promise<number> {
	let target = messageIn(scope, "f4");
	let pane = await shown(scroller);
	await cutTop(scroller, "f4", -Math.round((pane.bottom - pane.top) / 2));
	await page.mouse.move(0, 0);
	let point = await visiblePoint(scroller, target, "middle");
	await page.mouse.move(point.x, point.y);
	await expect(toolbar(target)).toHaveCSS("opacity", "1");
	let box = (await toolbar(target).getByRole("button", { name: "Message actions" }).boundingBox())!;
	return darkest(page, box);
}

async function expectReachable(
	scroller: Locator,
	target: Locator,
	label: string,
	info: TestInfo,
	resting?: number,
): Promise<Seen> {
	let bar = toolbar(target);
	await expect(bar, label).toHaveCSS("opacity", "1");
	let seen = await record(scroller, target);
	await attach(info, label, seen);
	expect(seen.bar, label).not.toBeNull();
	expect(
		seen.buttons.filter(button => !button.onScreen || !button.hit).map(button => button.name),
		`${label}: buttons off screen or under something`,
	).toEqual([]);
	if (resting !== undefined) {
		let ink = seen.buttons.find(button => button.name === "Message actions")?.ink;
		expect(ink, `${label}: the bar is drawn at full strength`).toBeLessThanOrEqual(resting + 12);
	}
	return seen;
}

test(
	"on a desktop a message whose top is scrolled out of the pane shows its toolbar where the pointer can reach it, short, medium and tall",
	async ({ join, seed }, info) => {
		await seed("# Toolbar\n", { transcript: transcript() });
		let page = await join("ana");
		let chat = chatOf(page);
		let scroller = scrollerOf(chat);
		let resting = await restingInk(page, scroller, chat);

		for (
			let [id, cut, at] of [
				["short", 4, "middle"],
				["medium", 40, "middle"],
				["medium", 120, "top"],
				["medium", 120, "bottom"],
				["tall", 300, "middle"],
			] as const
		) {
			let target = messageIn(chat, id);
			await page.mouse.move(0, 0);
			await cutTop(scroller, id, cut);
			let point = await visiblePoint(scroller, target, at);
			await page.mouse.move(point.x, point.y);
			let label = `${id}, top ${cut} px out, pointer at the ${at} of what shows`;
			// A row that shows less of itself than the pane's 56px top fade keeps its bar at its last line,
			// so the pointer reaches it from there; any other has it clear of the fade, at full strength.
			let seen = await expectReachable(
				scroller,
				target,
				label,
				info,
				id === "short" ? undefined : resting,
			);
			// Pinned to the top of what shows of the message, as Slack's is, not somewhere down its text.
			expect(seen.bar!.top - seen.pane.top, `${label}: next to the pane's top`).toBeLessThanOrEqual(
				58,
			);
			let first = (await toolbar(target).getByRole("button").first().boundingBox())!;
			await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 8 });
			await expect(toolbar(target), label).toHaveCSS("opacity", "1");
			expect(
				await toolbar(target).getByRole("button").first().evaluate(element =>
					element.matches(":hover")
				),
				`${label}: the pointer reaches the first button`,
			).toBe(true);
		}
	},
);

test(
	"on a desktop the toolbar of a message under the pointer follows the pane as it scrolls, and is back at the row's corner once its top is in view",
	async ({ join, seed }, info) => {
		await seed("# Toolbar\n", { transcript: transcript() });
		let page = await join("ana");
		let chat = chatOf(page);
		let scroller = scrollerOf(chat);
		let target = messageIn(chat, "tall");
		let bar = toolbar(target);
		let resting = await restingInk(page, scroller, chat);
		await page.mouse.move(0, 0);
		await cutTop(scroller, "tall", 120);
		let pane = await shown(scroller);
		await page.mouse.move(0, 0);
		await page.mouse.move(400, (pane.top + pane.bottom) / 2);
		await expect(bar).toHaveCSS("opacity", "1");
		let tops: number[] = [];
		for (let step = 0; step < 4; step++) {
			await page.mouse.wheel(0, 80);
			await expect.poll(async () => (await bar.boundingBox())!.y).toBeGreaterThanOrEqual(pane.top);
			tops.push(Math.round((await bar.boundingBox())!.y));
		}
		await attach(info, "bar top while scrolling down 80 px at a time", { pane, tops });
		expect(Math.max(...tops) - Math.min(...tops), "it stays put at the pane's top")
			.toBeLessThanOrEqual(1);
		await expectReachable(scroller, target, "tall, scrolled with the pointer on it", info, resting);

		// Its top back in view: the bar stands at the row's top right, 16 px above the row's shade.
		await cutTop(scroller, "tall", -200);
		await page.mouse.move(0, 0);
		let point = await visiblePoint(scroller, target, "middle");
		await page.mouse.move(point.x, point.y);
		await expect(bar).toHaveCSS("opacity", "1");
		let row = await target.evaluate(element => {
			let style = getComputedStyle(element, "::before");
			return element.getBoundingClientRect().top + Number.parseFloat(style.top);
		});
		let box = (await bar.boundingBox())!;
		await attach(info, "tall, top back in view", { row, bar: box.y });
		expect(row - box.y).toBeCloseTo(16, 0);
	},
);

test(
	"on a desktop a message cut by the composer has its toolbar in the pane, above the composer",
	async ({ join, seed }, info) => {
		await seed("# Toolbar\n", { transcript: transcript() });
		let page = await join("ana");
		let chat = chatOf(page);
		let scroller = scrollerOf(chat);
		for (let [id, seen] of [["medium", 30], ["tall", 60], ["short", 14]] as const) {
			let target = messageIn(chat, id);
			await page.mouse.move(0, 0);
			await cutBottom(scroller, id, seen);
			let point = await visiblePoint(scroller, target, "middle");
			await page.mouse.move(point.x, point.y);
			await expectReachable(
				scroller,
				target,
				`${id}, only its top ${seen} px above the composer`,
				info,
			);
		}
		// A tall message cut at both ends.
		let tall = messageIn(chat, "tall");
		await page.mouse.move(0, 0);
		await cutTop(scroller, "tall", 200);
		let point = await visiblePoint(scroller, tall, "bottom");
		await page.mouse.move(point.x, point.y);
		await expectReachable(scroller, tall, "tall, cut at the top and by the composer", info);
	},
);

test(
	"in a thread panel a reply whose top is scrolled out shows its toolbar where the pointer can reach it",
	async ({ join, seed }, info) => {
		await seed("# Toolbar\n", { transcript: transcript() });
		let page = await join("ana", WIDE);
		let chat = chatOf(page);
		let root = messageIn(chat, "short");
		await root.scrollIntoViewIfNeeded();
		await root.hover();
		await root.getByRole("button", { name: "Reply in thread" }).click();
		let panel = page.locator("[data-thread-panel]");
		await expect(panel).toBeVisible();
		let input = chatInput(panel);
		for (let text of [paragraphs(3), "A short reply.", paragraphs(10), "Another short reply."]) {
			await fillChat(input, text);
			await input.press("Enter");
			await expect(panel.locator(".chat-message-body").last()).toContainText(text.slice(-30));
		}
		let replies = panel.locator(".chat-message-body[data-chat-message-id]");
		let ids = await replies.evaluateAll(rows =>
			rows.map(row => row.getAttribute("data-chat-message-id")!)
		);
		let medium = ids.at(-4)!;
		let tall = ids.at(-2)!;
		let scroller = scrollerOf(panel);
		let resting = await (async () => {
			let target = messageIn(panel, ids.at(-1)!);
			await cutTop(scroller, ids.at(-1)!, -200);
			await page.mouse.move(0, 0);
			let point = await visiblePoint(scroller, target, "middle");
			await page.mouse.move(point.x, point.y);
			await expect(toolbar(target)).toHaveCSS("opacity", "1");
			let box =
				(await toolbar(target).getByRole("button", { name: "Message actions" }).boundingBox())!;
			return darkest(page, box);
		})();
		for (let [id, cut, name] of [[medium, 50, "medium"], [tall, 250, "tall"]] as const) {
			let target = messageIn(panel, id);
			await page.mouse.move(0, 0);
			await cutTop(scroller, id, cut);
			let point = await visiblePoint(scroller, target, "middle");
			await page.mouse.move(point.x, point.y);
			await expectReachable(
				scroller,
				target,
				`thread ${name} reply, top ${cut} px out`,
				info,
				resting,
			);
		}
	},
);

async function hold(page: Page, x: number, y: number): Promise<void> {
	let session = await page.context().newCDPSession(page);
	await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
	await page.waitForTimeout(700);
	await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await session.detach();
}

test(
	"on a phone a long press on a message cut by the top bar or the composer brings up a toolbar whose every button is on screen and what the finger meets",
	async ({ join, seed }, info) => {
		await seed("# Toolbar\n", { transcript: transcript() });
		let page = await join("ana", PHONE);
		await page.getByRole("navigation", { name: "Workspace view" })
			.getByRole("button", { name: /^Chat/ }).click();
		let chat = chatOf(page);
		await expect.poll(async () => (await chat.boundingBox())?.x).toBe(0);
		let scroller = scrollerOf(chat);
		for (
			let [id, how, amount] of [
				["medium", "top", 60],
				["tall", "top", 300],
				["short", "top", 10],
				["medium", "bottom", 40],
				["tall", "bottom", 80],
			] as const
		) {
			let target = messageIn(chat, id);
			if (how === "top") await cutTop(scroller, id, amount);
			else await cutBottom(scroller, id, amount);
			let point = await visiblePoint(scroller, target, "middle");
			await hold(page, point.x, point.y);
			let label = `phone ${id}, ${how} cut (${amount} px)`;
			await expect(toolbar(target), label).toBeVisible();
			await expect.poll(async () => {
				let seen = await record(scroller, target);
				return seen.buttons.filter(button => !button.onScreen || !button.hit).map(button =>
					button.name
				);
			}, { message: label }).toEqual([]);
			await attach(info, label, await record(scroller, target));
			await page.mouse.click(1, 1);
			await expect(toolbar(target)).toBeHidden();
		}
	},
);
