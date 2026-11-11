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
	// The pane slides in from the side; measure it once it has arrived at the left edge.
	await expect.poll(async () => (await chatPane(page).boundingBox())?.x).toBe(0);
}

/** From the top of the box to the bottom of the composer, leaving out the status line above it. */
function boxHeight(page: Page): Promise<number> {
	return chatPane(page).locator(".chat-composer").evaluate(composer => {
		let surface = composer.querySelector(".composer-surface")!.getBoundingClientRect();
		return composer.getBoundingClientRect().bottom - surface.top;
	});
}

test("a phone composer is the message box: the draft above a row with the reference button, and a rounded-square send", async ({ join }) => {
	let page = await join("ana", PHONE);
	await openPhoneChat(page);
	let chat = chatPane(page);
	let draft = chatInput(chat);
	let send = chat.getByRole("button", { name: "Send message" });
	let reference = chat.getByRole("button", { name: "Mention docs" });

	// The formatting toolbar gives way on a phone, and so does the button that turns it on.
	await expect(chat.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);
	await expect(chat.getByRole("button", { name: "Formatting", exact: true })).toBeHidden();
	// One line of draft over one row of 28px controls.
	expect(await boxHeight(page)).toBeLessThanOrEqual(112);
	let [draftBox, sendBox, referenceBox] = await Promise.all([
		draft.boundingBox(),
		send.boundingBox(),
		reference.boundingBox(),
	]);
	// The row sits under the draft: the reference button leads, the send button trails.
	expect(referenceBox!.y).toBeGreaterThanOrEqual(draftBox!.y + draftBox!.height - 1);
	expect(sendBox!.y).toBeGreaterThanOrEqual(draftBox!.y + draftBox!.height - 1);
	expect(referenceBox!.x).toBeLessThan(sendBox!.x);
	expect(Math.abs(sendBox!.y + sendBox!.height / 2 - (referenceBox!.y + referenceBox!.height / 2)))
		.toBeLessThanOrEqual(1);
	// A 28px square whatever the pointer: only its target grows.
	expect(sendBox!.width).toBeCloseTo(28, 0);
	expect(sendBox!.height).toBeCloseTo(28, 0);
	// The status stays readable as one line above the box.
	let notice = chat.getByRole("status").filter({ hasText: "Replies are off on this server." });
	await expect(notice).toBeVisible();
	expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(28);
	await expect(send).toBeDisabled();

	await draft.click();
	await page.keyboard.type("One more line to send");
	await expect(send).toBeEnabled();
	await expectNoHorizontalOverflow(page);
});

test("the phone's mention menu is assistant-ui's own, resting on the composer, and its reference picker is a full-width list", async ({ join }) => {
	let page = await join("ana", PHONE);
	await join("cy");
	// The phone top bar carries no presence; the picker below waits for cy instead.
	await openPhoneChat(page);
	let chat = chatPane(page);
	let draft = chatInput(chat);
	let surface = chat.locator(".composer-surface");

	await draft.click();
	await page.keyboard.type("@");
	let mentions = chat.locator("[data-chat-mention-picker]");
	await expect(mentions.getByRole("option", { name: "cy" })).toBeVisible();
	let pill = (await surface.boundingBox())!;
	// The menu scales in from its entrance; measure once it has settled. It keeps assistant-ui's own
	// 288px (`w-72`), starts at the composer's edge and rests on it.
	await expect.poll(async () => (await mentions.boundingBox())!.width).toBeCloseTo(288, 0);
	let list = (await mentions.boundingBox())!;
	expect(Math.abs(list.x - pill.x)).toBeLessThanOrEqual(2);
	expect(list.x + list.width).toBeLessThanOrEqual(pill.x + pill.width);
	expect(list.y + list.height).toBeLessThanOrEqual(pill.y);
	expect(pill.y - (list.y + list.height)).toBeLessThanOrEqual(8);
	// The list scrolls inside it without chaining to the transcript behind.
	expect(
		await mentions.getByRole("listbox").evaluate(element =>
			getComputedStyle(element).overscrollBehaviorY
		),
	)
		.toBe("contain");

	await page.keyboard.press("Backspace");
	await page.keyboard.type("#");
	let references = chat.locator("[data-chat-reference-picker]");
	await expect(references).toBeVisible();
	await expect.poll(async () => Math.abs((await references.boundingBox())!.width - pill.width))
		.toBeLessThanOrEqual(1);
	expect((await references.boundingBox())!.height).toBeLessThanOrEqual(844 * 0.4 + 1);
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

test("a phone transcript at the bottom stays pinned when a message arrives with the keyboard open", async ({ baseURL, browser, join, room }) => {
	let cy = await join("cy", { viewport: { width: 1440, height: 900 } });
	let cyChat = chatPane(cy);
	let cyDraft = chatInput(cyChat);
	for (let index = 1; index <= 12; index++) {
		await cyDraft.fill(`Earlier message ${index} long enough to take a line or two on a phone`);
		await cyChat.getByRole("button", { name: "Send message" }).click();
		await expect(cyChat.getByText(`Earlier message ${index} `)).toBeVisible();
	}
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
		await chatInput(chat).click();
		await setVisualViewport(page, { event: "resize", height: 508 });
		await page.keyboard.type("Typing while cy talks");

		await cyDraft.fill("The newest message from cy");
		await cyChat.getByRole("button", { name: "Send message" }).click();
		let newest = chat.getByText("The newest message from cy");
		await expect(newest).toBeVisible();
		let composer = chat.locator(".chat-composer");
		await expect.poll(async () => {
			let [message, below] = await Promise.all([newest.boundingBox(), composer.boundingBox()]);
			return message!.y + message!.height <= below!.y && message!.y >= 0;
		}).toBe(true);
	} finally {
		await emulation.close();
	}
});

test("the desktop composer keeps its Ask Chopin button, toolbar and dropdown menus", async ({ join }) => {
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	// The Planner is off in this suite; the session says it is on, as the composer reads it.
	await page.context().route("**/api/session", async route => {
		let response = await route.fetch();
		await route.fulfill({ response, json: { ...await response.json(), agent: true } });
	});
	await page.reload();
	await join("cy");
	let chat = chatPane(page);
	let draft = chatInput(chat);
	await expect(draft).toBeVisible();
	await expect(chat.getByRole("button", { name: "Ask Chopin", exact: true })).toBeVisible();
	await expect(chat.getByRole("button", { name: "Talk to Chopin" })).toHaveCount(0);
	let [draftBox, sendBox] = await Promise.all([
		draft.boundingBox(),
		chat.getByRole("button", { name: "Send message" }).boundingBox(),
	]);
	expect(sendBox!.y).toBeGreaterThanOrEqual(draftBox!.y + draftBox!.height - 1);

	await draft.click();
	await page.keyboard.type("@");
	let mentions = chat.locator("[data-chat-mention-picker]");
	await expect(mentions.getByRole("option", { name: "cy" })).toBeVisible();
	// A dropdown at assistant-ui's own 288px once it has settled, not a list as wide as the box.
	await expect.poll(async () => (await mentions.boundingBox())!.width).toBeCloseTo(288, 0);
	let pill = await chat.locator(".composer-surface").boundingBox();
	expect((await mentions.boundingBox())!.width).toBeLessThan(pill!.width);
});

test("a phone composer shows the removable Chopin chip while a message addresses Chopin", async ({ join }) => {
	let page = await join("ana", PHONE);
	// The Planner is off in this suite; the session says it is on, as the composer reads it.
	await page.context().route("**/api/session", async route => {
		let response = await route.fetch();
		await route.fulfill({ response, json: { ...await response.json(), agent: true } });
	});
	await page.reload();
	await openPhoneChat(page);
	let chat = chatPane(page);
	let draft = chatInput(chat);
	let chip = chat.getByRole("button", { name: "Remove Chopin", exact: true });
	// The button that asks is spent while the chip shows.
	let mode = chat.getByRole("button", { name: "Ask Chopin", exact: true });
	await expect(chip).toHaveCount(0);

	// A mention addresses Chopin; the chip says so at the start of the draft, inside the pill.
	await draft.click();
	await page.keyboard.type("@chopin what is left? ");
	await expect(chip).toBeVisible();
	await expect(mode).toBeDisabled();
	let [chipBox, draftBox, pill] = await Promise.all([
		chip.boundingBox(),
		draft.boundingBox(),
		chat.locator(".composer-surface").boundingBox(),
	]);
	expect(chipBox!.y).toBeGreaterThanOrEqual(draftBox!.y);
	expect(chipBox!.y).toBeGreaterThanOrEqual(pill!.y);
	expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(pill!.x + pill!.width);
	// Drawn small, but a full touch target.
	let reach = await chip.evaluate(element => {
		let box = element.getBoundingClientRect();
		let x = box.left + box.width / 2;
		let y = box.top + box.height / 2;
		return [y - 21, y + 21].every(at =>
			document.elementFromPoint(x, at)?.closest("button") === element
		);
	});
	expect(reach).toBe(true);

	// Removing the chip removes the address, as switching to Chat does.
	await chip.tap();
	await expect(chip).toHaveCount(0);
	await expect(mode).toBeEnabled();
	// No leading space is left where the mention was.
	expect(await draft.textContent()).toBe("what is left? ");

	// The button turns it back on without a mention.
	await expect(mode).toBeVisible();
	await mode.tap();
	await expect(chip).toBeVisible();
	await chip.tap();
	await expect(mode).toBeEnabled();
	await expectNoHorizontalOverflow(page);
});
