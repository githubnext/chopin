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

async function coveredText(bar: Locator): Promise<string[]> {
	return bar.evaluate(element => {
		let box = element.getBoundingClientRect();
		let found: string[] = [];
		let walker = document.createTreeWalker(
			element.closest("[data-chat-scroll]")!,
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
	});
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
	let barBox = (await bar.boundingBox())!;
	expect(barBox.y).toBeGreaterThanOrEqual(view.y);
	expect(barBox.y + barBox.height).toBeLessThanOrEqual(view.y + view.height);
	for (let button of await bar.getByRole("button").all()) {
		let size = (await button.boundingBox())!;
		expect(size.width).toBeGreaterThanOrEqual(44);
		expect(size.height).toBeGreaterThanOrEqual(44);
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
