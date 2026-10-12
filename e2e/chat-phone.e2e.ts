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
	// The list scales in from the menu entrance; measure once it has settled.
	await expect.poll(async () => Math.abs((await mentions.boundingBox())!.width - pill.width))
		.toBeLessThanOrEqual(1);
	let list = (await mentions.boundingBox())!;
	expect(Math.abs(list.x - pill.x)).toBeLessThanOrEqual(1);
	expect(list.y + list.height).toBeLessThanOrEqual(pill.y);
	expect(pill.y - (list.y + list.height)).toBeLessThanOrEqual(8);
	// Layout height: the entrance's scale can leave the drawn box a hair short.
	expect(
		await mentions.getByRole("option", { name: "cy" }).evaluate(row =>
			(row as HTMLElement).offsetHeight
		),
	)
		.toBeGreaterThanOrEqual(44);
	expect(await mentions.evaluate(element => getComputedStyle(element).overscrollBehaviorY))
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

test("a phone composer shows a removable Chopin chip while a message addresses Chopin", async ({ join }) => {
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
	let mode = chat.getByRole("button", { name: "Talk to Chopin", exact: true });
	await expect(chip).toHaveCount(0);

	// A mention addresses Chopin; the chip says so above the draft, inside the pill.
	await draft.click();
	await page.keyboard.type("@chopin what is left? ");
	await expect(chip).toBeVisible();
	await expect(mode).toHaveAttribute("aria-pressed", "true");
	let [chipBox, draftBox, pill] = await Promise.all([
		chip.boundingBox(),
		draft.boundingBox(),
		chat.locator(".composer-surface").boundingBox(),
	]);
	expect(chipBox!.y + chipBox!.height).toBeLessThanOrEqual(draftBox!.y + 1);
	expect(chipBox!.y).toBeGreaterThanOrEqual(pill!.y);
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
	await expect(mode).toHaveAttribute("aria-pressed", "false");
	expect(await draft.textContent()).not.toContain("@chopin");

	// The switch turns it back on without a mention.
	await mode.tap();
	await expect(chip).toBeVisible();
	await chip.tap();
	await expect(mode).toHaveAttribute("aria-pressed", "false");
	await expectNoHorizontalOverflow(page);
});
