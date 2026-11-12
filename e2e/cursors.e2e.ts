/**
 * The cursor says what a thing does, in a live document (DESIGN.md, Cursors): the pointer on
 * everything a click acts on, the zoom on a picture, the text cursor in the draft and the document,
 * the open hand on a table's grip and the closed one while it is held, and the divider's resize
 * cursor, which a drag keeps over the whole page however far the pointer outruns the divider. Each
 * cursor is read from the element the browser finds under the mouse, so a layer left on top fails.
 */
import { PNG } from "./chat-attachments";
import { seedChannelImage } from "./database";
import { content, expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";
import type { Chat } from "../packages/protocol/index";

const TABLE = ["| Item | Note |", "| ---- | ---- |", "| one  | a    |", "| two  | b    |", ""].join(
	"\n",
);

function transcript(image: Chat.Image): Chat.Entry[] {
	return [
		{
			id: "person",
			author: { kind: "member", handle: "ben" },
			text: "The notes are in [the design note](https://example.com/design).",
			ts: 1_700_000_001,
			reactions: [{ emoji: "✅", handles: ["ben"] }],
		},
		{
			id: "picture",
			author: { kind: "agent" },
			text: "A picture.",
			ts: 1_700_000_002,
			images: [image],
		},
	];
}

function chat(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat", exact: true });
}

function message(page: Page, id: string): Locator {
	return chat(page).locator(`[data-chat-message-id="${id}"]`);
}

type Under = { cursor: string; inside: boolean; under: string };

/** What the browser finds under (x, y), its cursor, and whether it is `target` or inside it. */
async function under(target: Locator, x: number, y: number): Promise<Under> {
	return target.evaluate((element, [x, y]) => {
		let found = document.elementFromPoint(x!, y!);
		return {
			cursor: found ? getComputedStyle(found).cursor : "",
			inside: !!found && (element === found || element.contains(found)),
			under: found ? `${found.tagName.toLowerCase()}.${found.className}` : "nothing",
		};
	}, [x, y]);
}

async function centre(target: Locator): Promise<{ x: number; y: number }> {
	await target.scrollIntoViewIfNeeded();
	let box = (await target.boundingBox())!;
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function cursorOver(page: Page, target: Locator): Promise<string> {
	let { x, y } = await centre(target);
	await page.mouse.move(x, y);
	let hit = await under(target, x, y);
	expect(hit.inside, `the mouse finds ${hit.under}, not the control`).toBe(true);
	return hit.cursor;
}

async function open(page: Page): Promise<void> {
	await expect(chat(page)).toBeVisible();
	await expect(message(page, "picture").locator("[data-chat-image]")).toHaveAttribute(
		"data-load",
		"shown",
	);
}

test("nothing a click acts on shows the arrow, and each control is the thing under the mouse", async ({ baseURL, join, room, seed }) => {
	let src = await seedChannelImage(Number(new URL(baseURL!).port), room, PNG, "image/png");
	await seed(`# Cursors\n\nSee [the guide](https://example.com/guide).\n\n${TABLE}`, {
		transcript: transcript({ src, alt: "A sketch", width: 600, height: 400 }),
	});
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await open(page);

	// Every enabled control on the page, whatever drew it, says it can be clicked.
	let arrows = await page.evaluate(() =>
		[
			...document.querySelectorAll<HTMLElement>(
				'button, a[href], summary, select, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"]',
			),
		]
			.filter(element =>
				element.getClientRects().length > 0
				&& !element.matches(':disabled, [aria-disabled="true"], [data-disabled]')
				&& ["auto", "default"].includes(getComputedStyle(element).cursor)
			)
			.map(element => element.getAttribute("aria-label") ?? element.textContent?.trim())
	);
	expect(arrows).toEqual([]);

	let views = page.getByRole("button", { name: "Decisions", exact: true });
	let person = message(page, "person");
	let pointers: [string, Locator][] = [
		["a view tab", views],
		["a reaction pill", person.getByRole("button", { name: /✅/ }).first()],
		["a link in a message", person.getByRole("link", { name: "the design note" })],
		["the composer's toolbar", chat(page).getByRole("button", { name: "Bold", exact: true })],
	];
	for (let [name, control] of pointers) {
		expect(await cursorOver(page, control), name).toBe("pointer");
	}

	// The message's own toolbar, shown on hover, and its menu.
	await person.hover();
	let toolbar = person.getByRole("toolbar", { name: "Reactions and actions" });
	await expect(toolbar).toHaveCSS("opacity", "1");
	let add = toolbar.getByRole("button", { name: "Add reaction" });
	expect(await cursorOver(page, add), "the message toolbar").toBe("pointer");
	await toolbar.getByRole("button", { name: "Message actions" }).click();
	let item = page.getByRole("menuitem").first();
	await expect(item).toBeVisible();
	expect(await cursorOver(page, item), "a message menu item").toBe("pointer");
	await page.keyboard.press("Escape");
	await expect(item).toBeHidden();

	// A picture opens the viewer.
	let picture = message(page, "picture").locator('[data-slot="image-preview"]');
	expect(await cursorOver(page, picture), "a picture").toBe("zoom-in");

	// Send is the arrow until there is something to send, then the pointer.
	let send = chat(page).getByRole("button", { name: "Send message" });
	await expect(send).toBeDisabled();
	expect(await cursorOver(page, send), "an empty send").toBe("default");
	let draft = chat(page).locator('[contenteditable="true"]').first();
	expect(await cursorOver(page, draft), "the draft").toMatch(/^(auto|text)$/);
	await draft.click();
	await page.keyboard.type("Ready");
	await expect(send).toBeEnabled();
	expect(await cursorOver(page, send), "send").toBe("pointer");

	// The document's text, and its link: a plain click there places the caret, as in any editor,
	// so the browser's text cursor is the honest one (⌘-click follows it).
	expect(await cursorOver(page, content(page).getByRole("heading", { name: "Cursors" })))
		.toMatch(/^(auto|text)$/);
	expect(await cursorOver(page, content(page).getByRole("link", { name: "the guide" })))
		.toBe("text");
});

test("a table grip is the open hand, and the closed one stays over the page while it is held", async ({ join, seed }) => {
	await seed(`# Grips\n\n${TABLE}`);
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	await content(page).getByRole("cell", { name: "one" }).hover();
	let grip = page.locator('[data-plan-rail="row"]').getByRole("button", {
		name: "Move row 2",
		exact: true,
	});
	await expect(grip).toHaveCSS("opacity", "1");
	expect(await cursorOver(page, grip)).toBe("grab");

	let { x, y } = await centre(grip);
	await page.mouse.down();
	await page.mouse.move(x + 120, y + 30, { steps: 6 });
	// Off the grip, over the table's text: still the closed hand.
	let cell = content(page).getByRole("cell", { name: "two" });
	let over = await under(cell, x + 120, y + 30);
	expect(over.cursor, `over ${over.under}`).toBe("grabbing");
	await page.mouse.up();
	await expect(page.locator("[data-drag-cursor]")).toHaveCount(0);
	expect((await under(cell, x + 120, y + 30)).cursor).not.toBe("grabbing");
});

test("a divider is the resize cursor, and a drag keeps it wherever the pointer goes", async ({ join, seed }) => {
	await seed("# Divider\n\nSome prose to drag over.\n");
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	for (let name of ["Resize chat", "Resize Projects sidebar"]) {
		let divider = page.getByRole("separator", { name });
		expect(await cursorOver(page, divider), name).toBe("col-resize");
	}

	let divider = page.getByRole("separator", { name: "Resize chat" });
	let { x, y } = await centre(divider);
	await page.mouse.down();
	// Past where the divider can follow, over the document's editable text and its controls.
	for (let [dx, dy] of [[24, 0], [300, -200], [500, 250]] as const) {
		await page.mouse.move(x + dx, y + dy, { steps: 4 });
		let found = await page.evaluate(([x, y]) => {
			let element = document.elementFromPoint(x!, y!);
			return element && { cursor: getComputedStyle(element).cursor, tag: element.tagName };
		}, [x + dx, y + dy]);
		expect(found, `something is under ${dx},${dy}`).not.toBeNull();
		expect(found!.cursor, `over ${found!.tag} at ${dx},${dy}`).toBe("col-resize");
	}
	await page.mouse.up();
	await expect(page.locator("[data-drag-cursor]")).toHaveCount(0);
	let prose = content(page).getByText("Some prose to drag over.");
	expect(await cursorOver(page, prose)).toMatch(/^(auto|text)$/);
});
