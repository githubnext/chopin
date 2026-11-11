/**
 * Where the message toolbar, its row highlight and the emoji picker sit, on a desktop and on a phone:
 * the highlight shades the message and leaves its avatar, name and time drawn, a long press brings
 * up a toolbar that covers no text and stays in the part of the transcript that is on screen, and
 * the picker stays inside the viewport once its emoji have loaded.
 */
import { expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const PARAGRAPH =
	"the harp section needs its pedal mechanism regulated, a new set of strings, a rehearsal booking at the venue, and a written sign-off from the principal harpist before anything ships.";

function transcript() {
	let tall = Array.from({ length: 9 }, (_, index) => `Paragraph ${index + 1}: ${PARAGRAPH}`)
		.join("\n\n");
	return [
		{
			id: "m1",
			author: { kind: "member", handle: "ana" },
			text: "@chopin Can you **tighten the intro** and list what the harp section needs?",
			to: "planner",
			ts: 1_700_000_001,
			reactions: [{ emoji: "✅", handles: ["ben"] }],
		},
		{
			id: "m2",
			author: { kind: "agent" },
			text:
				"I tightened the intro and added a checklist.\n\n- Restring the pedal harp\n- Re-regulate the discs\n\nThe booking depends on the venue.",
			ts: 1_700_000_002,
			reactions: [{ emoji: "❓", handles: ["ben", "ana"] }],
		},
		{
			id: "m3",
			author: { kind: "member", handle: "ben" },
			text: "Looks right. I'll take the booking.",
			ts: 1_700_000_003,
		},
		{
			id: "m4",
			author: { kind: "member", handle: "ana" },
			text:
				"Thanks. Ask the venue about a second rehearsal, with a very long line that wraps over several lines on a narrow phone width.",
			ts: 1_700_000_004,
		},
		{
			id: "m5",
			author: { kind: "member", handle: "ana" },
			text: "And a third one on Friday morning if the hall is free.",
			ts: 1_700_000_005,
		},
		{ id: "m6", author: { kind: "agent" }, text: tall, ts: 1_700_000_006 },
		{
			id: "m7",
			author: { kind: "member", handle: "ben" },
			text: "That is the last one, short and at the very end.",
			ts: 1_700_000_007,
		},
	];
}

function chatOf(page: Page) {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function message(page: Page, id: string): Locator {
	return chatOf(page).locator(`[data-chat-message-id="${id}"]`);
}

function entryOf(page: Page, id: string): Locator {
	return chatOf(page).locator("[data-chat-entry]").filter({
		has: page.locator(`[data-chat-message-id="${id}"]`),
	});
}

function toolbar(target: Locator): Locator {
	return target.getByRole("toolbar", { name: "Reactions and actions" });
}

function scroller(page: Page): Locator {
	return chatOf(page).locator("[data-chat-scroll]");
}

async function darkest(page: Page, target: Locator): Promise<number> {
	let png = (await target.screenshot({ animations: "disabled" })).toString("base64");
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
		return lowest;
	}, png);
}

async function coveredText(bar: Locator, within?: string): Promise<string[]> {
	return bar.evaluate((element, scope) => {
		let box = element.getBoundingClientRect();
		let found: string[] = [];
		let walker = document.createTreeWalker(
			(scope ? element.closest(scope) : null) ?? element.closest("[data-chat-scroll]")!,
			NodeFilter.SHOW_TEXT,
		);
		while (walker.nextNode()) {
			let node = walker.currentNode as Text;
			let parent = node.parentElement;
			if (
				!node.textContent?.trim() || !parent
				|| parent.closest('.sr-only, [data-slot="message-actions"]')
				|| getComputedStyle(parent).visibility === "hidden"
			) continue;
			let range = document.createRange();
			range.selectNodeContents(node);
			for (let rect of range.getClientRects()) {
				let across = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
				let down = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
				if (rect.width > 1 && rect.height > 1 && across > 1 && down > 1) {
					found.push(node.textContent.trim().slice(0, 40));
				}
			}
		}
		return found;
	}, within);
}

async function hold(page: Page, x: number, y: number): Promise<void> {
	let session = await page.context().newCDPSession(page);
	await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
	await page.waitForTimeout(700);
	await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await session.detach();
}

async function holdOn(page: Page, target: Locator): Promise<void> {
	await target.scrollIntoViewIfNeeded();
	let box = (await target.boundingBox())!;
	await hold(page, box.x + 24, box.y + Math.min(8, box.height / 2));
}

async function openChatOnPhone(page: Page): Promise<void> {
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect.poll(async () => (await chatOf(page).boundingBox())?.x).toBe(0);
}

test("the row highlight shades a message and leaves its avatar, name and time drawn, on hover and on focus", async ({ join, seed }) => {
	await seed("# Layout\n", { transcript: transcript() });
	let page = await join("ana");
	let entry = entryOf(page, "m2");
	let name = entry.getByText("Chopin", { exact: true });
	let time = entry.locator(".text-2xs");
	let avatar = entry.locator(".w-6").first();
	await expect(name).toBeVisible();
	let drawn = async () => ({
		name: await darkest(page, name),
		time: await darkest(page, time),
		avatar: await darkest(page, avatar),
	});
	let rest = await drawn();
	expect(rest.name).toBeLessThan(100);
	expect(rest.avatar).toBeLessThan(150);

	await message(page, "m2").hover();
	await expect.poll(() =>
		message(page, "m2").evaluate(element => getComputedStyle(element, "::before").opacity)
	).toBe("1");
	let hovered = await drawn();
	expect(hovered.name).toBeLessThan(100);
	expect(hovered.time).toBeLessThan(200);
	expect(hovered.avatar).toBeLessThan(150);

	await page.mouse.move(0, 0);
	await message(page, "m2").getByRole("button", { name: "Message actions" }).focus();
	await page.keyboard.press("Shift+Tab");
	await expect.poll(() =>
		message(page, "m2").evaluate(element => getComputedStyle(element, "::before").opacity)
	).toBe("1");
	let focused = await drawn();
	expect(focused.name).toBeLessThan(100);
	expect(focused.avatar).toBeLessThan(150);
});

async function walk(
	page: Page,
	from: { x: number; y: number },
	to: { x: number; y: number },
	speed: number,
) {
	let step = 8;
	await page.mouse.move(from.x, from.y);
	await page.waitForTimeout(400);
	let steps = Math.max(
		1,
		Math.round(Math.hypot(to.x - from.x, to.y - from.y) / (speed * step / 1000)),
	);
	for (let at = 1; at <= steps; at++) {
		await page.mouse.move(
			from.x + (to.x - from.x) * at / steps,
			from.y + (to.y - from.y) * at / steps,
		);
		await page.waitForTimeout(step);
	}
	await page.waitForTimeout(300);
}

async function reveal(page: Page, id: string): Promise<void> {
	await scroller(page).evaluate((element, wanted) => {
		let top =
			element.querySelector(`[data-chat-message-id="${wanted}"]`)!.getBoundingClientRect().top
			- element.getBoundingClientRect().top;
		element.scrollTop += top - 120;
	}, id);
	await expect.poll(async () => (await message(page, id).boundingBox())!.y).toBeGreaterThan(0);
}

async function centre(target: Locator) {
	let box = (await target.boundingBox())!;
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

for (let id of ["m2", "m1"]) {
	for (let speed of [150, 400, 900, 2000]) {
		test(`a pointer walked from ${id}'s text to its toolbar, at ${speed} px a second, finds the toolbar and its buttons`, async ({ join, seed }) => {
			await seed("# Layout\n", { transcript: transcript() });
			let page = await join("ana");
			await reveal(page, id);
			let target = message(page, id);
			let bar = toolbar(target);
			let button = bar.getByRole("button").first();
			let text = await centre(target.locator("[data-chat-message-text] p").first());
			let aim = await centre(button);
			await walk(page, { x: text.x, y: text.y }, aim, speed);
			await expect(bar).toHaveCSS("opacity", "1");
			expect(await button.evaluate(element => element.matches(":hover"))).toBe(true);
			expect(await target.evaluate(element => getComputedStyle(element, "::before").opacity)).toBe(
				"1",
			);
		});
	}
}

test("a heading shows the toolbar and the row highlight over its whole width, and the pointer reaches the toolbar from it", async ({ join, seed }) => {
	await seed("# Layout\n", { transcript: transcript() });
	let page = await join("ana");
	await reveal(page, "m2");
	let entry = entryOf(page, "m2");
	let head = entry.locator("[data-chat-head]");
	let target = message(page, "m2");
	let bar = toolbar(target);
	let shade = () => target.evaluate(element => getComputedStyle(element, "::before").opacity);
	let headBox = (await head.boundingBox())!;
	let nameBox = (await entry.getByText("Chopin", { exact: true }).boundingBox())!;
	let bodyBox = (await target.boundingBox())!;
	expect(headBox.y + headBox.height).toBeLessThan(bodyBox.y);

	for (
		let where of [
			{ x: nameBox.x + nameBox.width / 2, y: headBox.y + headBox.height / 2 },
			{ x: headBox.x + 4, y: headBox.y + headBox.height / 2 },
			{ x: bodyBox.x + bodyBox.width * 0.45, y: headBox.y + headBox.height / 2 },
			{ x: bodyBox.x + bodyBox.width * 0.45, y: (headBox.y + headBox.height + bodyBox.y) / 2 },
		]
	) {
		await page.mouse.move(0, 0);
		await expect(bar).toHaveCSS("opacity", "0");
		await page.mouse.move(where.x, where.y);
		await expect(bar).toHaveCSS("opacity", "1");
		await expect.poll(shade).toBe("1");
	}

	let from = { x: nameBox.x + nameBox.width / 2, y: headBox.y + headBox.height / 2 };
	await page.mouse.move(0, 0);
	let first = (await bar.getByRole("button").first().boundingBox())!;
	// The lower part of the first button, which is level with the heading.
	await walk(page, from, { x: first.x + first.width / 2, y: first.y + first.height * 0.85 }, 400);
	await expect(bar).toHaveCSS("opacity", "1");
	expect(
		await bar.getByRole("button").first().evaluate(element => element.matches(":hover")),
	).toBe(true);
});

test("on a phone a long press brings up a toolbar that covers no text, on a message that heads its group, one that continues it and the first", async ({ join, seed }) => {
	await seed("# Layout\n", { transcript: transcript() });
	let page = await join("ana", PHONE);
	await openChatOnPhone(page);
	for (let id of ["m2", "m3", "m4", "m5", "m7"]) {
		let target = message(page, id);
		await holdOn(page, target);
		let bar = toolbar(target);
		await expect(bar, id).toBeVisible();
		expect(await coveredText(bar), id).toEqual([]);
		let [barBox, view] = await Promise.all([bar.boundingBox(), scroller(page).boundingBox()]);
		expect(barBox!.y, id).toBeGreaterThanOrEqual(view!.y);
		expect(barBox!.y + barBox!.height, id).toBeLessThanOrEqual(view!.y + view!.height);
		await page.mouse.click(1, 1);
	}

	await scroller(page).evaluate(element => element.scrollTo(0, 0));
	let first = message(page, "m1");
	await holdOn(page, first);
	let bar = toolbar(first);
	await expect(bar).toBeVisible();
	expect(await coveredText(bar)).toEqual([]);
	let [barBox, view] = await Promise.all([bar.boundingBox(), scroller(page).boundingBox()]);
	expect(barBox!.y).toBeGreaterThanOrEqual(view!.y);
});

async function unmet(bar: Locator): Promise<string[]> {
	return bar.evaluate(element => {
		let top = document.querySelector(".phone-top-bar")!.getBoundingClientRect();
		let missed: string[] = [];
		for (let button of element.querySelectorAll("button")) {
			let box = button.getBoundingClientRect();
			let hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
			if (!hit || !button.contains(hit)) {
				missed.push(`${button.getAttribute("aria-label")} meets ${hit?.className || hit?.tagName}`);
			}
			if (box.top < top.bottom) {
				missed.push(`${button.getAttribute("aria-label")} is under the top bar`);
			}
		}
		return missed;
	});
}

test("on a phone every button of the toolbar a long press brings up is what the finger meets, below the top bar", async ({ join, seed }) => {
	await seed("# Layout\n", { transcript: transcript() });
	let page = await join("ana", PHONE);
	await openChatOnPhone(page);
	for (let id of ["m2", "m3", "m4", "m5", "m7", "m1"]) {
		let target = message(page, id);
		await holdOn(page, target);
		let bar = toolbar(target);
		await expect(bar, id).toBeVisible();
		await expect.poll(() => unmet(bar), { message: id }).toEqual([]);
		await page.mouse.click(1, 1);
	}
	let tall = message(page, "m6");
	let view = (await scroller(page).boundingBox())!;
	await tall.scrollIntoViewIfNeeded();
	await scroller(page).evaluate((element, wanted) => {
		let top = element.querySelector('[data-chat-message-id="m6"]')!.getBoundingClientRect().top
			- element.getBoundingClientRect().top;
		element.scrollTop += top + wanted;
	}, 80);
	await hold(page, view.x + view.width / 2, view.y + view.height / 2);
	await expect(toolbar(tall)).toBeVisible();
	await expect.poll(() => unmet(toolbar(tall)), { message: "m6" }).toEqual([]);
});

test("on a phone every message's toolbar is in the accessibility tree and a key press brings it up, below the top bar and over no text", async ({ join, seed }) => {
	await seed("# Layout\n", { transcript: transcript() });
	let page = await join("ana", PHONE);
	await openChatOnPhone(page);
	await expect(chatOf(page).getByRole("toolbar", { name: "Reactions and actions" })).toHaveCount(7);
	for (let id of ["m2", "m3", "m7"]) {
		let target = message(page, id);
		await target.scrollIntoViewIfNeeded();
		let bar = toolbar(target);
		await expect(bar.getByRole("button", { name: "Message actions" }), id).toBeAttached();
		await bar.getByRole("button", { name: "Message actions" }).focus();
		await page.keyboard.press("ArrowLeft");
		await expect(bar, id).toBeVisible();
		await expect(bar, id).toHaveCSS("opacity", "1");
		expect(await coveredText(bar), id).toEqual([]);
		await expect.poll(() => unmet(bar), { message: id }).toEqual([]);
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	}
});

test("on a phone a reaction pill is a 44 px target in both directions, and a tap on its edge toggles it", async ({ join, seed }) => {
	await seed("# Layout\n", { transcript: transcript() });
	let page = await join("ana", PHONE);
	await openChatOnPhone(page);
	let target = message(page, "m2");
	await target.scrollIntoViewIfNeeded();
	let pill = target.locator('[data-chat-reaction="❓"]');
	await expect(pill).toBeVisible();
	let reach = async () =>
		pill.evaluate(element => {
			let box = element.getBoundingClientRect();
			let at = (x: number, y: number) => {
				let hit = document.elementFromPoint(x, y);
				return !!hit && element.contains(hit);
			};
			let x = box.x + box.width / 2;
			let y = box.y + box.height / 2;
			return {
				up: at(x, y - 21),
				down: at(x, y + 21),
				left: at(x - 21, y),
				right: at(x + 21, y),
			};
		});
	expect(await reach()).toEqual({ up: true, down: true, left: true, right: true });
	let box = (await pill.boundingBox())!;
	await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height + 15);
	await expect(target.getByRole("button", { name: "You reacted with ❓" })).toBeVisible();
});

test("on a desktop the toolbar of a message taller than the viewport stays in the visible part of it while the pointer is on it", async ({ join, seed }) => {
	await seed("# Layout\n", { transcript: transcript() });
	let page = await join("ana");
	let target = message(page, "m6");
	let view = (await scroller(page).boundingBox())!;
	await scroller(page).evaluate((element, wanted) => {
		let top = element.querySelector('[data-chat-message-id="m6"]')!.getBoundingClientRect().top
			- element.getBoundingClientRect().top;
		element.scrollTop += top + wanted;
	}, 80);
	expect((await target.boundingBox())!.y).toBeLessThan(view.y - 40);
	await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
	let bar = toolbar(target);
	await expect(bar).toHaveCSS("opacity", "1");
	await expect.poll(async () => (await bar.boundingBox())!.y).toBeGreaterThanOrEqual(view.y);
	let barBox = (await bar.boundingBox())!;
	expect(barBox.y + barBox.height).toBeLessThanOrEqual(view.y + view.height);
	for (let button of await bar.getByRole("button").all()) {
		let hit = await button.evaluate(element => {
			let box = element.getBoundingClientRect();
			let at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
			return !!at && element.contains(at);
		});
		expect(hit).toBe(true);
	}
	let first = (await bar.getByRole("button").first().boundingBox())!;
	await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 12 });
	await expect(bar).toHaveCSS("opacity", "1");
});

test("on a desktop the toolbar kept in view on a message taller than the viewport covers none of that message's text, at the middle, near the top and near the end", async ({ join, seed }) => {
	await seed("# Layout\n", { transcript: transcript() });
	let page = await join("ana");
	let target = message(page, "m6");
	let bar = toolbar(target);
	let view = (await scroller(page).boundingBox())!;
	expect((await target.boundingBox())!.height).toBeGreaterThan(view.height);
	for (let hidden of [80, 300, 520]) {
		await scroller(page).evaluate((element, wanted) => {
			let top = element.querySelector('[data-chat-message-id="m6"]')!.getBoundingClientRect().top
				- element.getBoundingClientRect().top;
			element.scrollTop += top + wanted;
		}, hidden);
		await page.mouse.move(0, 0);
		await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
		await expect(bar, String(hidden)).toHaveCSS("opacity", "1");
		await expect.poll(async () => (await bar.boundingBox())!.y, { message: String(hidden) })
			.toBeGreaterThanOrEqual(view.y);
		await expect.poll(() => coveredText(bar, "[data-chat-message-id]"), { message: String(hidden) })
			.toEqual([]);
	}
});

test("on a desktop a message that is 13 px shorter than the pane, scrolled until its top is 78 px above it, still has its toolbar in the pane and clear of its text", async ({ join, seed }) => {
	let almost = [
		{ id: "n1", author: { kind: "member", handle: "ben" }, text: "Before it.", ts: 1_700_000_001 },
		{
			id: "n2",
			author: { kind: "agent" },
			text: Array.from({ length: 4 }, (_, index) => `Paragraph ${index + 1}: ${PARAGRAPH}`).join(
				"\n\n",
			),
			ts: 1_700_000_002,
		},
		...Array.from({ length: 6 }, (_, index) => ({
			id: `n${index + 3}`,
			author: { kind: "member", handle: "ben" },
			text: `After it, line ${index + 1}.`,
			ts: 1_700_000_003 + index,
		})),
	];
	await seed("# Layout\n", { transcript: almost });
	let page = await join("ana");
	let target = message(page, "n2");
	let bar = toolbar(target);
	let size = page.viewportSize()!;
	let [view, box] = await Promise.all([scroller(page).boundingBox(), target.boundingBox()]);
	await page.setViewportSize({
		width: size.width,
		height: Math.round(size.height + box!.height + 13 - view!.height),
	});
	// The pane is 13 px taller than the message is before any toolbar column is set aside for it.
	await expect.poll(async () => Math.round((await scroller(page).boundingBox())!.height))
		.toBe(Math.round(box!.height + 13));
	let pane = (await scroller(page).boundingBox())!;
	await scroller(page).evaluate((element, wanted) => {
		let top = element.querySelector('[data-chat-message-id="n2"]')!.getBoundingClientRect().top
			- element.getBoundingClientRect().top;
		element.scrollTop += top + wanted;
	}, 78);
	let seen = (await target.boundingBox())!;
	expect(Math.round(pane.y - seen.y)).toBe(78);

	await page.mouse.move(0, 0);
	await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
	await expect(bar).toHaveCSS("opacity", "1");
	await expect.poll(async () => (await bar.boundingBox())!.y).toBeGreaterThanOrEqual(pane.y);
	await expect.poll(() => coveredText(bar, "[data-chat-message-id]")).toEqual([]);
	let first = (await bar.getByRole("button").first().boundingBox())!;
	await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 12 });
	await expect(bar).toHaveCSS("opacity", "1");
	expect(
		await bar.getByRole("button").first().evaluate(element => element.matches(":hover")),
	).toBe(true);
});

test("on a phone a long press in the middle of a message taller than the screen keeps the toolbar on screen, with every button a touch target", async ({ join, seed }) => {
	await seed("# Layout\n", { transcript: transcript() });
	let page = await join("ana", PHONE);
	await openChatOnPhone(page);
	let target = message(page, "m6");
	let view = (await scroller(page).boundingBox())!;
	await target.scrollIntoViewIfNeeded();
	let height = (await target.boundingBox())!.height;
	expect(height).toBeGreaterThan(view.height * 0.6);
	await scroller(page).evaluate((element, wanted) => {
		let top = element.querySelector('[data-chat-message-id="m6"]')!.getBoundingClientRect().top
			- element.getBoundingClientRect().top;
		element.scrollTop += top + wanted;
	}, 80);
	let box = (await target.boundingBox())!;
	expect(box.y).toBeLessThan(view.y - 40);
	await hold(page, view.x + view.width / 2, view.y + view.height / 2);
	let bar = toolbar(target);
	await expect(bar).toBeVisible();
	await expect.poll(() => coveredText(bar)).toEqual([]);
	let barBox = (await bar.boundingBox())!;
	expect(barBox.y).toBeGreaterThanOrEqual(view.y);
	expect(barBox.y + barBox.height).toBeLessThanOrEqual(view.y + view.height);
	for (let button of await bar.getByRole("button").all()) {
		let size = (await button.boundingBox())!;
		expect(size.width).toBe(28);
		expect(size.height).toBe(28);
		let hit = await button.evaluate(element => {
			let rect = element.getBoundingClientRect();
			let after = getComputedStyle(element, "::after");
			let x = rect.x + rect.width / 2;
			let y = rect.y + rect.height / 2;
			let at = (px: number, py: number) => {
				let found = document.elementFromPoint(px, py);
				return !!found && element.contains(found);
			};
			return {
				width: Number.parseFloat(after.width),
				height: Number.parseFloat(after.height),
				up: at(x, y - 21),
				down: at(x, y + 21),
			};
		});
		expect(hit).toEqual({ width: 44, height: 44, up: true, down: true });
	}
	await expect(bar.getByRole("button")).toHaveCount(5);
	expect(barBox.x).toBeGreaterThanOrEqual(0);
	expect(barBox.x + barBox.width).toBeLessThanOrEqual(390);
});

for (let [name, options] of [["desktop", undefined], ["phone", PHONE]] as const) {
	test(`on a ${name} the emoji picker stays inside the viewport once its emoji have loaded, with the search field focused`, async ({ join, seed }) => {
		await seed("# Layout\n", { transcript: transcript().filter(item => item.id !== "m6") });
		let page = await join("ana", options);
		if (options) await openChatOnPhone(page);
		let viewport = page.viewportSize()!;
		let target = message(page, "m7");
		if (options) await holdOn(page, target);
		else await target.hover();
		await toolbar(target).getByRole("button", { name: "Add reaction" }).click();
		let picker = page.getByRole("dialog", { name: "Add reaction" });
		let field = picker.getByRole("textbox", { name: "Search emoji, or paste one" });
		await expect(field).toBeFocused();
		await expect(picker.locator("[data-emoji]").nth(200)).toBeAttached();

		let panel = page.locator(".chat-message-picker");
		await expect.poll(async () => {
			let box = (await panel.boundingBox())!;
			return box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width
				&& box.y + box.height <= viewport.height;
		}).toBe(true);
		await expect(field).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(picker.locator("[data-emoji]").first()).toBeFocused();
		await page.waitForTimeout(400);
		await expect(picker.locator("[data-emoji]").first()).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(picker).toHaveCount(0);
	});
}
