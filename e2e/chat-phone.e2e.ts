import { chatInput } from "./chat-input";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { expect, openIsolatedRoom, test } from "./room";
import { installVisualViewport, setVisualViewport } from "./visual-viewport";

import type { Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

async function openPhoneChat(page: Page): Promise<void> {
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).click();
	await expect(chatInput(chatPane(page))).toBeVisible();
}

/** From the top of the pill to the bottom of the composer, leaving out the status line above it. */
function pillHeight(page: Page): Promise<number> {
	return chatPane(page).locator(".chat-composer").evaluate(composer => {
		let surface = composer.querySelector(".composer-surface")!.getBoundingClientRect();
		return composer.getBoundingClientRect().bottom - surface.top;
	});
}

test("a phone composer rests as one pill with a reference button, draft and send", async ({ join }) => {
	let page = await join("ana", PHONE);
	await openPhoneChat(page);
	let chat = chatPane(page);
	let draft = chatInput(chat);
	let send = chat.getByRole("button", { name: "Send message" });
	let reference = chat.getByRole("button", { name: "Mention docs" });

	expect(await pillHeight(page)).toBeLessThanOrEqual(64);
	let [draftBox, sendBox, referenceBox] = await Promise.all([
		draft.boundingBox(),
		send.boundingBox(),
		reference.boundingBox(),
	]);
	// One row: the reference button leads, the send button trails the draft.
	expect(referenceBox!.x + referenceBox!.width).toBeLessThanOrEqual(draftBox!.x + 1);
	expect(sendBox!.x).toBeGreaterThanOrEqual(draftBox!.x + draftBox!.width - 1);
	expect(Math.abs(sendBox!.y + sendBox!.height - (draftBox!.y + draftBox!.height)))
		.toBeLessThanOrEqual(1);
	expect(sendBox!.width).toBeCloseTo(36, 0);
	expect(sendBox!.height).toBeCloseTo(36, 0);
	// The status stays readable as one line above the pill.
	let notice = chat.getByRole("status").filter({ hasText: "Chopin unavailable" });
	await expect(notice).toBeVisible();
	expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(28);
	// Disabled send is drawn solid rather than faded.
	await expect(send).toBeDisabled();
	expect(await send.evaluate(element => getComputedStyle(element).opacity)).toBe("1");

	await draft.click();
	await page.keyboard.type("One more line to send");
	await expect(send).toBeEnabled();
	await expectNoHorizontalOverflow(page);
});

test("phone mention and reference pickers rest on the composer as a full-width list", async ({ join }) => {
	let page = await join("ana", PHONE);
	await join("cy");
	await expect(page.getByRole("group", { name: /People here: ana, cy$/ })).toBeVisible();
	await openPhoneChat(page);
	let chat = chatPane(page);
	let draft = chatInput(chat);
	let surface = chat.locator(".composer-surface");

	await draft.click();
	await page.keyboard.type("@");
	let mentions = chat.locator("[data-chat-mention-picker]");
	await expect(mentions.getByRole("option", { name: "cy" })).toBeVisible();
	let [list, pill] = await Promise.all([mentions.boundingBox(), surface.boundingBox()]);
	expect(Math.abs(list!.x - pill!.x)).toBeLessThanOrEqual(1);
	expect(Math.abs(list!.width - pill!.width)).toBeLessThanOrEqual(1);
	expect(list!.y + list!.height).toBeLessThanOrEqual(pill!.y);
	expect(pill!.y - (list!.y + list!.height)).toBeLessThanOrEqual(8);
	let row = await mentions.getByRole("option", { name: "cy" }).boundingBox();
	expect(row!.height).toBeGreaterThanOrEqual(44);
	expect(await mentions.evaluate(element => getComputedStyle(element).overscrollBehaviorY))
		.toBe("contain");

	await page.keyboard.press("Backspace");
	await page.keyboard.type("#");
	let references = chat.locator("[data-chat-reference-picker]");
	await expect(references).toBeVisible();
	let referenceList = await references.boundingBox();
	expect(Math.abs(referenceList!.width - pill!.width)).toBeLessThanOrEqual(1);
	expect(referenceList!.height).toBeLessThanOrEqual(844 * 0.4 + 1);
});

test("an open keyboard leaves the phone transcript most of the exposed height", async ({ baseURL, browser, room }) => {
	let emulation = await openIsolatedRoom(
		browser,
		baseURL!,
		room,
		"ana",
		PHONE,
		context =>
			installVisualViewport(context, {
				height: 844,
				offsetLeft: 0,
				offsetTop: 0,
				pageLeft: 0,
				pageTop: 0,
				scale: 1,
				width: 390,
			}),
	);
	try {
		let page = emulation.page;
		await openPhoneChat(page);
		let chat = chatPane(page);
		let draft = chatInput(chat);
		await draft.click();
		await setVisualViewport(page, { event: "resize", height: 508 });
		await page.keyboard.type(
			"A draft long enough to wrap onto a second line in the phone composer pill",
		);
		let send = chat.getByRole("button", { name: "Send message" });
		await expectInsideViewport(draft);
		await expectInsideViewport(send);
		let transcript = await chat.locator(".chat-composer").evaluate(composer => {
			let pane = composer.parentElement!.getBoundingClientRect();
			return composer.getBoundingClientRect().top - pane.top;
		});
		// The composer sits on the keyboard and the transcript keeps the rest.
		expect((await send.boundingBox())!.y + 36).toBeGreaterThan(508 - 64);
		expect(transcript).toBeGreaterThanOrEqual(200);
	} finally {
		await emulation.close();
	}
});

test("the desktop composer keeps its labelled mode switch, footer and dropdown pickers", async ({ join }) => {
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await join("cy");
	let chat = chatPane(page);
	let draft = chatInput(chat);
	await expect(draft).toBeVisible();
	await expect(chat.locator(".composer-mode-label")).toHaveText("Chat");
	expect(
		await chat.locator(".composer-surface").evaluate(element => getComputedStyle(element).display),
	)
		.not.toBe("flex");
	let [draftBox, sendBox] = await Promise.all([
		draft.boundingBox(),
		chat.getByRole("button", { name: "Send message" }).boundingBox(),
	]);
	expect(sendBox!.y).toBeGreaterThanOrEqual(draftBox!.y + draftBox!.height - 1);

	await draft.click();
	await page.keyboard.type("@");
	let mentions = chat.locator("[data-chat-mention-picker]");
	await expect(mentions.getByRole("option", { name: "cy" })).toBeVisible();
	let [list, pill] = await Promise.all([
		mentions.boundingBox(),
		chat.locator(".composer-surface").boundingBox(),
	]);
	expect(list!.width).toBeLessThan(pill!.width / 2);
});
