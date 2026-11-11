/**
 * Who a message is for is a chip at the start of the draft, and the chip is the state: none, and the
 * message goes to the team; [✦ Chopin ✕], and it asks Chopin. It comes on by choosing Chopin in the @
 * menu, by the sparkle button and by Command+J or Control+J; it goes off by Backspace at the very
 * start and by its own cross; and it stays on after Chopin is asked.
 */

import { chatCaret, chatInput, expectChatValue } from "./chat-input";
import { expectNoHorizontalOverflow } from "./responsive";
import { expect, test } from "./room";

import type { Chat } from "../packages/protocol/index";
import type { Locator, Page } from "@playwright/test";

const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };

function chatPane(page: Page) {
	return page.getByRole("complementary", { includeHidden: true, name: "Chat" });
}

/** The chip, its remove button and the button that asks, by the names a screen reader hears. */
function parts(chat: Locator) {
	return {
		chip: chat.getByRole("group", { name: "Asking Chopin", exact: true }),
		remove: chat.getByRole("button", { name: "Remove Chopin", exact: true }),
		ask: chat.getByRole("button", { name: "Ask Chopin", exact: true }),
	};
}

async function enablePlanner(page: Page): Promise<void> {
	await page.route("**/api/session", async route => {
		let response = await route.fetch();
		await route.fulfill({ response, json: { ...await response.json(), agent: true } });
	});
}

/** What the browser puts on the wire, the Planner being off in this suite. */
async function recordSends(page: Page): Promise<Chat.Send[]> {
	let sent: Chat.Send[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				try {
					let frame = JSON.parse(message) as Chat.Send;
					if (frame.kind === "chat:send") sent.push(frame);
				} catch {
					// The server owns frames that are not JSON.
				}
			}
			server.send(message);
		});
		server.onMessage(message => route.send(message));
	});
	return sent;
}

/** github.com is not reachable from the harness; answer with a flat tile. */
async function stubAvatars(page: Page): Promise<void> {
	await page.route("https://github.com/*.png*", route => {
		let login = new URL(route.request().url()).pathname.slice(1, -".png".length);
		return route.fulfill({
			contentType: "image/svg+xml",
			body:
				`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="hsl(${
					login.charCodeAt(0) * 11 % 360
				} 40% 55%)"/></svg>`,
		});
	});
}

/** Where the draft's words begin on screen, which is after the chip when there is one. */
function wordsStart(draft: Locator): Promise<{ x: number; y: number }> {
	return draft.evaluate(element => {
		let walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		let node: Node | null;
		while ((node = walker.nextNode())) {
			if (!node.textContent) continue;
			let range = document.createRange();
			range.setStart(node, 0);
			range.setEnd(node, 1);
			let box = range.getBoundingClientRect();
			return { x: box.x, y: box.y };
		}
		return { x: Number.NaN, y: Number.NaN };
	});
}

/** Where the placeholder begins, as the page's x: the pseudo-element is positioned, so it has a used `left`. */
function placeholderStart(draft: Locator): Promise<number> {
	return draft.evaluate(element => {
		let box = element.getBoundingClientRect();
		return box.x + Number.parseFloat(getComputedStyle(element, "::before").left);
	});
}

/** The wire's account of a message: who it went to and the words that went. */
function lastSent(sent: Chat.Send[]) {
	return sent.at(-1) && { text: sent.at(-1)!.text, to: sent.at(-1)!.to };
}

test("with no chip the draft is for the team, and says how to ask Chopin", async ({ join, page }) => {
	await enablePlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let { chip, remove, ask } = parts(chat);
	await expect(draft).toHaveAttribute("data-placeholder", "Message the team, or @Chopin to ask");
	await expect(chip).toHaveCount(0);
	await expect(remove).toHaveCount(0);
	await expect(ask).toBeEnabled();
	// The button names its chord, which the shortcuts sheet lists too.
	await expect(ask).toHaveAttribute("data-tooltip-shortcut", /^(Ctrl\+J|⌘J)$/);
	// There is no Chat/Chopin switch to be in a mode of.
	await expect(chat.getByRole("button", { name: "Talk to Chopin" })).toHaveCount(0);
	await expect(chat.locator("[data-mode]")).toHaveCount(0);
});

test("the sparkle button puts the chip at the start without touching the words or the caret", async ({ join, page }) => {
	await enablePlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let { chip, remove, ask } = parts(chat);
	await draft.fill("outline the export options");
	await draft.press("ArrowLeft");
	await draft.press("ArrowLeft");
	let caret = await chatCaret(draft);
	let before = await wordsStart(draft);

	await ask.click();
	await expect(chip).toBeVisible();
	await expect(chip).toHaveText("Chopin");
	await expectChatValue(draft, "outline the export options");
	await expect(draft).toBeFocused();
	expect(await chatCaret(draft)).toBe(caret);
	// The chip leads the first line and the words begin after it, on the same line.
	let after = await wordsStart(draft);
	let box = (await chip.boundingBox())!;
	expect(box.x + box.width).toBeLessThanOrEqual(after.x);
	expect(after.x).toBeGreaterThan(before.x);
	expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
	expect(box.y).toBeLessThanOrEqual(after.y + 1);
	expect(box.y + box.height).toBeGreaterThanOrEqual(after.y);
	// Asking again is a no-op: the button is spent while the chip is on.
	await expect(ask).toBeDisabled();
	await expect(draft).toHaveAttribute("data-placeholder", "Ask Chopin…");
	await expect(remove).toBeVisible();
});

test("the placeholder begins after the chip, not under it", async ({ join, page }) => {
	await enablePlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let { chip, ask } = parts(chat);
	await ask.click();
	await expect(chip).toBeVisible();
	await expect(draft).toHaveAttribute("data-placeholder", "Ask Chopin…");
	let box = (await chip.boundingBox())!;
	expect(await placeholderStart(draft)).toBeGreaterThanOrEqual(box.x + box.width - 1);
});

test("Command+J and Control+J put the chip on from anywhere in the draft, and never take it off", async ({ join, page }) => {
	await enablePlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let { chip } = parts(chat);
	await draft.fill("what breaks if two people edit offline?");
	for (let index = 0; index < 12; index++) await draft.press("ArrowLeft");
	let caret = await chatCaret(draft);

	await draft.press("ControlOrMeta+j");
	await expect(chip).toBeVisible();
	await expectChatValue(draft, "what breaks if two people edit offline?");
	expect(await chatCaret(draft)).toBe(caret);
	// Not mid-text: the chip is before the first word, wherever the caret was.
	expect((await chip.boundingBox())!.x).toBeLessThan((await wordsStart(draft)).x);

	await draft.press("ControlOrMeta+j");
	await expect(chip).toBeVisible();
	// Shift+Tab, which switched the old mode, is now only Tab backwards.
	await draft.press("Shift+Tab");
	await expect(chip).toBeVisible();
});

test("choosing Chopin in the @ menu puts the chip on and takes the typed @ out of the words", async ({ join, page }) => {
	await enablePlanner(page);
	await stubAvatars(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let { chip } = parts(chat);
	await draft.fill("Hey @ch");
	let menu = chat.getByRole("listbox", { name: "Mentions" });
	await expect(menu).toBeVisible();
	let chopin = menu.getByRole("option", { name: /^Chopin/ });
	await expect(chopin).toHaveAttribute("aria-selected", "true");
	await draft.press("Enter");
	await expect(menu).toHaveCount(0);
	await expect(chip).toBeVisible();
	// No @chopin is left in the words: the chip says who the message is for.
	await expectChatValue(draft, "Hey ");
	expect(await chatCaret(draft)).toBe("Hey ".length);
	await expect(draft).toBeFocused();
});

test("Backspace at the very start takes the chip off, and anywhere else is only a Backspace", async ({ join, page }) => {
	await enablePlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let { chip, ask } = parts(chat);
	await draft.fill("outline it");
	await ask.click();
	await expect(chip).toBeVisible();

	// With the caret after the first letter, Backspace deletes that letter and the chip stays.
	await draft.press("Home");
	await draft.press("ArrowRight");
	await draft.press("Backspace");
	await expectChatValue(draft, "utline it");
	await expect(chip).toBeVisible();

	// With a selection that starts at the start it deletes the selection, not the chip.
	await draft.press("Home");
	await draft.press("Shift+ArrowRight");
	await draft.press("Shift+ArrowRight");
	await draft.press("Backspace");
	await expectChatValue(draft, "line it");
	await expect(chip).toBeVisible();

	// With the caret at the start, nothing in front of it, it takes the chip off and keeps the words.
	await draft.press("Home");
	await draft.press("Backspace");
	await expect(chip).toHaveCount(0);
	await expectChatValue(draft, "line it");
	expect(await chatCaret(draft)).toBe(0);
	await expect(ask).toBeEnabled();
	await expect(draft).toHaveAttribute("data-placeholder", "Message the team, or @Chopin to ask");
	await expect(draft).toBeFocused();
});

test("the chip's own cross takes it off, and a mention typed in the words goes with it", async ({ join, page }) => {
	await enablePlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let { chip, remove } = parts(chat);
	await draft.fill("outline it");
	await parts(chat).ask.click();
	await expect(chip).toBeVisible();
	await remove.click();
	await expect(chip).toHaveCount(0);
	await expectChatValue(draft, "outline it");
	await expect(draft).toBeFocused();

	// A message that names Chopin in its words is for Chopin as much as the chip is: it shows the
	// chip, and taking the chip off takes the words out, or the chip would come straight back.
	await draft.fill("@chopin what is left?");
	await page.keyboard.press("Escape");
	await expect(chip).toBeVisible();
	await remove.click();
	await expect(chip).toHaveCount(0);
	await expectChatValue(draft, "what is left?");
});

test("a message with the chip is Chopin's, one without is the team's, and the chip stays on after Chopin is asked", async ({ join, page }) => {
	await enablePlanner(page);
	let sent = await recordSends(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let { chip, remove, ask } = parts(chat);

	await draft.fill("Thanks for the update.");
	await draft.press("Enter");
	await expect.poll(() => lastSent(sent)).toEqual({ text: "Thanks for the update.", to: "room" });
	await expect(chip).toHaveCount(0);

	// Asking Chopin sends what Chopin's mode always did, and the chip is still there for the next.
	await ask.click();
	await draft.fill("Outline the export options.");
	await draft.press("Enter");
	await expect.poll(() => lastSent(sent)).toEqual({
		text: "@chopin Outline the export options.",
		to: "planner",
	});
	await expectChatValue(draft, "");
	await expect(chip).toBeVisible();
	await draft.fill("And the rollback checks.");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect.poll(() => lastSent(sent)).toEqual({
		text: "@chopin And the rollback checks.",
		to: "planner",
	});
	await expect(chip).toBeVisible();

	// Until it is removed.
	await remove.click();
	await draft.fill("Back to the team.");
	await draft.press("Enter");
	await expect.poll(() => lastSent(sent)).toEqual({ text: "Back to the team.", to: "room" });
	await expect(chip).toHaveCount(0);

	// A typed @chopin without the chip still addresses Chopin, as it always has.
	await draft.fill("Could @chopin look at this?");
	await page.keyboard.press("Escape");
	await draft.press("Enter");
	await expect.poll(() => lastSent(sent)).toEqual({
		text: "Could @chopin look at this?",
		to: "planner",
	});
});

test("putting the chip on starts a new undo step, so Chopin's draft has a history of its own", async ({ join, page }) => {
	await enablePlanner(page);
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	await draft.pressSequentially("abc");
	await parts(chat).ask.click();
	await draft.pressSequentially("def");
	await expectChatValue(draft, "abcdef");
	await draft.press("ControlOrMeta+z");
	await expectChatValue(draft, "abc");
});

test("the first line runs after the chip and the rest run under it, and the draft scrolls with it", async ({ join, page }) => {
	await enablePlanner(page);
	await page.setViewportSize({ width: 1440, height: 900 });
	let chat = chatPane(await join("ana"));
	let draft = chatInput(chat);
	let { chip } = parts(chat);
	await parts(chat).ask.click();
	await draft.fill(
		"Compare the offline sync options and list what breaks if two people edit the same paragraph while one of them is on a train",
	);
	await expect(chip).toBeVisible();
	let lines = await draft.evaluate(element => {
		let range = document.createRange();
		range.selectNodeContents(element);
		let starts = new Map<number, number>();
		for (let box of range.getClientRects()) {
			let line = Math.round(box.y);
			starts.set(line, Math.min(starts.get(line) ?? Infinity, box.x));
		}
		return [...starts.values()];
	});
	expect(lines.length).toBeGreaterThan(1);
	let box = (await chip.boundingBox())!;
	// The first line starts after the chip; every later one starts at the field's own edge.
	expect(lines[0]).toBeGreaterThanOrEqual(box.x + box.width - 1);
	for (let start of lines.slice(1)) expect(start).toBeLessThan(box.x + box.width - 4);
	expect(Math.min(...lines.slice(1))).toBeLessThanOrEqual(box.x + 1);
});

test("on a phone the chip is the same chip, with a full touch target on its cross and a screen reader's names", async ({ join }) => {
	// A touch context is its own, so the Planner and the wire are set up on it, then it is opened again.
	let page = await join("ana", PHONE);
	await enablePlanner(page);
	let sent = await recordSends(page);
	await page.reload();
	let chat = chatPane(page);
	await page.getByRole("navigation", { name: "Workspace view" })
		.getByRole("button", { name: /^Chat/ }).tap();
	await expect.poll(async () => (await chat.boundingBox())?.x).toBe(0);
	let draft = chatInput(chat);
	let { chip, remove, ask } = parts(chat);
	await expect(draft).toHaveAttribute("data-placeholder", "Message the team, or @Chopin to ask");

	await ask.tap();
	await expect(chip).toBeVisible();
	await expect(remove).toBeVisible();
	await expect(draft).toHaveAttribute("data-placeholder", "Ask Chopin…");
	// The placeholder begins after the chip, not under it.
	expect(await placeholderStart(draft)).toBeGreaterThanOrEqual(
		(await chip.boundingBox())!.x + (await chip.boundingBox())!.width - 1,
	);
	// The chip leads the draft's first line, inside the box, and the box is no wider than the phone.
	let [chipBox, surface] = await Promise.all([
		chip.boundingBox(),
		chat.locator(".composer-surface").boundingBox(),
	]);
	expect(chipBox!.x).toBeGreaterThanOrEqual(surface!.x);
	expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(surface!.x + surface!.width);
	await draft.tap();
	await page.keyboard.type("what is left? ");
	await expectChatValue(draft, "what is left? ");
	expect((await chip.boundingBox())!.x + chipBox!.width).toBeLessThanOrEqual(
		(await wordsStart(draft)).x,
	);
	// Drawn small, but a full touch target: a finger above or below the cross still reaches it.
	let reach = await remove.evaluate(element => {
		let box = element.getBoundingClientRect();
		let x = box.left + box.width / 2;
		let y = box.top + box.height / 2;
		return [y - 20, y + 20].every(at =>
			document.elementFromPoint(x, at)?.closest("button") === element
		);
	});
	expect(reach).toBe(true);
	await expectNoHorizontalOverflow(page);

	await chat.getByRole("button", { name: "Send message" }).tap();
	await expect.poll(() => lastSent(sent)).toEqual({ text: "@chopin what is left?", to: "planner" });
	await expect(chip).toBeVisible();
	await remove.tap();
	await expect(chip).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
});

test("there is no chip, and no way to ask, where the document has no Planner", async ({ join }) => {
	let chat = chatPane(await join("ana"));
	let { chip, ask } = parts(chat);
	await expect(chatInput(chat)).toHaveAttribute("data-placeholder", "Message the team");
	await expect(ask).toHaveCount(0);
	await expect(chip).toHaveCount(0);
	await chatInput(chat).press("ControlOrMeta+j");
	await expect(chip).toHaveCount(0);
});
