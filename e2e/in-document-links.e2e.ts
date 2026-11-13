/**
 * Links inside a document, as a reader expects them from GitHub or Notion.
 *
 * A link to a section of the same document (`#whats-new`, or the document's own address with that
 * hash) scrolls there in the same tab, marks the heading for a moment, puts the hash in the address
 * and comes back with Back. A link to another Chopin document opens it in the app, at its section
 * when it names one. Only a link to another site opens a new tab. The same holds for links in Chat
 * and in a document opened for reading, and a modified click still opens a new tab. The anchors
 * are the ones Chopin gives a heading everywhere else: its text as GitHub slugs it, `-1` after a
 * repeat.
 */

import { chatInput } from "./chat-input";
import { createChannel, seedChannel, testChannelPath } from "./database";
import { content, expect, test } from "./room";

import type { Locator, Page } from "@playwright/test";

/** Enough prose that a heading below it starts out of sight. */
function filler(label: string, count = 30): string {
	return Array.from(
		{ length: count },
		(_, index) => `${label} paragraph ${index + 1} keeps the next heading well below the fold.`,
	).join("\n\n");
}

function linksSource(other: string): string {
	return [
		"# Links",
		"",
		"Jump to [what is new](#whats-new), [the café](#über-café), [the second notes](#notes-1),"
		+ ` [nowhere](#nowhere), [the other document](${other}), [its deep section](${other}#deep-section)`
		+ " and [a site](https://example.com/docs).",
		"",
		filler("Opening"),
		"",
		"## Notes",
		"",
		filler("First notes", 8),
		"",
		"## What's new?",
		"",
		filler("New"),
		"",
		"## Notes",
		"",
		filler("Second notes"),
		"",
		"## Über café",
		"",
		filler("Café"),
	].join("\n");
}

/** Titled as the channel is, so the document keeps the address it was created with. */
const otherSource = (id: string) =>
	[
		`# Test ${id.slice(0, 8)}`,
		"",
		"The other document starts here.",
		"",
		filler("Elsewhere"),
		"",
		"## Deep section",
		"",
		filler("Deep"),
	].join("\n");

function port(url: string): number {
	return Number(new URL(url).port);
}

/** Two documents in one repository: this test's room, which links to a second one. */
async function seedDocuments(
	baseURL: string,
	room: string,
): Promise<{ other: string }> {
	let otherId = crypto.randomUUID();
	await createChannel(port(baseURL), otherId);
	await seedChannel(port(baseURL), otherId, otherSource(otherId));
	let other = testChannelPath(otherId);
	await seedChannel(port(baseURL), room, linksSource(other));
	return { other };
}

/** Counts the tabs the context opens from here on. */
function tabsOpened(page: Page): () => number {
	let opened = 0;
	page.context().on("page", () => opened++);
	return () => opened;
}

/** The heading sits at the top of the document's view, where a jump to it puts it. */
async function expectAtTop(page: Page, heading: Locator): Promise<void> {
	await expect(heading).toBeInViewport();
	await expect.poll(async () => {
		let box = await heading.boundingBox();
		let scroller = await page.locator("[data-plan-scroll]").first().boundingBox();
		return box && scroller ? Math.round(box.y - scroller.y) : undefined;
	}).toBeLessThan(160);
}

function heading(page: Page, name: string, index = 0): Locator {
	return content(page).getByRole("heading", { name, exact: true }).nth(index);
}

test("a link to a section scrolls there in the same tab, marks it and comes back with Back", async ({ baseURL, join, room }) => {
	await seedDocuments(baseURL!, room);
	let page = await join("ana");
	let tabs = tabsOpened(page);
	let path = new URL(page.url()).pathname;
	let link = (name: string) => content(page).getByRole("link", { name, exact: true });

	// Punctuation dropped from the slug.
	await expect(heading(page, "What's new?")).not.toBeInViewport();
	await link("what is new").click();
	await expect(page).toHaveURL(`${path}#whats-new`);
	await expectAtTop(page, heading(page, "What's new?"));
	await expect(heading(page, "What's new?")).toHaveAttribute("data-heading-linked", "");
	await expect(heading(page, "What's new?")).not.toHaveAttribute("data-heading-linked", "", {
		timeout: 5_000,
	});

	// Back returns to the address and the place the link was followed from.
	await page.goBack();
	await expect(page).toHaveURL(path);
	await expect(link("what is new")).toBeInViewport();
	await page.goForward();
	await expect(page).toHaveURL(`${path}#whats-new`);
	await expectAtTop(page, heading(page, "What's new?"));

	// A repeated heading takes `-1`; a heading in another script keeps its letters.
	await page.goBack();
	await link("the second notes").click();
	await expectAtTop(page, heading(page, "Notes", 1));
	await page.goBack();
	await link("the café").click();
	await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe("#über-café");
	await expectAtTop(page, heading(page, "Über café"));

	// Nothing has left the document or opened a tab, and the document is still the editable one.
	expect(new URL(page.url()).pathname).toBe(path);
	expect(tabs()).toBe(0);
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	await expect(page.getByRole("dialog", { name: "Link" })).toHaveCount(0);
});

test("a link to a section that is not there stays put in the same tab", async ({ baseURL, join, room }) => {
	await seedDocuments(baseURL!, room);
	let page = await join("ana");
	let tabs = tabsOpened(page);
	let path = new URL(page.url()).pathname;
	let link = content(page).getByRole("link", { name: "nowhere", exact: true });

	await link.click();
	await expect(page).toHaveURL(`${path}#nowhere`);
	await expect(link).toBeInViewport();
	expect(tabs()).toBe(0);
});

test("a link to another document opens it in the app, at its section when it names one", async ({ baseURL, join, room }) => {
	let { other } = await seedDocuments(baseURL!, room);
	let page = await join("ana");
	let tabs = tabsOpened(page);
	let path = new URL(page.url()).pathname;

	await content(page).getByRole("link", { name: "the other document", exact: true }).click();
	await expect(page).toHaveURL(other);
	await expect(content(page).getByText("The other document starts here.")).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL(path);
	await expect(heading(page, "Links")).toBeVisible();

	await content(page).getByRole("link", { name: "its deep section", exact: true }).click();
	await expect(page).toHaveURL(`${other}#deep-section`);
	await expectAtTop(page, heading(page, "Deep section"));
	expect(tabs()).toBe(0);
});

test("a modified click opens a new tab, without a way back to this page", async ({ baseURL, join, room }) => {
	await seedDocuments(baseURL!, room);
	let page = await join("ana");
	await page.context().route(
		"https://example.com/**",
		route => route.fulfill({ contentType: "text/html", body: "<title>Docs</title>" }),
	);
	let path = new URL(page.url()).pathname;

	let popup = page.waitForEvent("popup");
	await content(page).getByRole("link", { name: "a site", exact: true })
		.click({ modifiers: ["ControlOrMeta"] });
	let opened = await popup;
	await expect(opened).toHaveURL("https://example.com/docs");
	expect(await opened.evaluate(() => window.opener)).toBeNull();
	await opened.close();

	popup = page.waitForEvent("popup");
	await content(page).getByRole("link", { name: "what is new", exact: true })
		.click({ modifiers: ["ControlOrMeta"] });
	opened = await popup;
	await expect(opened).toHaveURL(`${path}#whats-new`);
	await opened.close();
	await expect(page).toHaveURL(path);
});

test("Open on a section link goes there in the same tab", async ({ baseURL, join, room }) => {
	await seedDocuments(baseURL!, room);
	let page = await join("ana");
	let tabs = tabsOpened(page);
	let path = new URL(page.url()).pathname;

	// The caret reaches the link from the keyboard, which brings up its preview.
	await content(page).getByText("Jump to").click();
	await page.keyboard.press("Home");
	for (let step = 0; step < "Jump to wh".length; step++) await page.keyboard.press("ArrowRight");
	let preview = page.getByRole("dialog", { name: "Link" });
	await expect(preview).toContainText("#whats-new");
	await preview.getByRole("button", { name: "Open" }).click();
	await expect(page).toHaveURL(`${path}#whats-new`);
	await expectAtTop(page, heading(page, "What's new?"));
	expect(tabs()).toBe(0);
});

test("links in Chat that point into the document go there in the same tab", async ({ baseURL, join, room }) => {
	let { other } = await seedDocuments(baseURL!, room);
	let page = await join("ana");
	let tabs = tabsOpened(page);
	let path = new URL(page.url()).pathname;
	let chat = page.getByRole("complementary", { name: "Chat", exact: true });
	await chatInput(chat).fill(
		`See [what is new](#whats-new), [the café here](${baseURL}${path}#über-café),`
			+ ` [the deep one](${other}#deep-section) and [a site](https://example.com/docs).`,
	);
	await chat.getByRole("button", { name: "Send message" }).click();
	let link = (name: string) => chat.getByRole("link", { name, exact: true });

	await expect(link("a site")).toHaveAttribute("target", "_blank");
	await expect(link("a site")).toHaveAttribute("rel", /noopener/);

	await link("what is new").click();
	await expect(page).toHaveURL(`${path}#whats-new`);
	await expectAtTop(page, heading(page, "What's new?"));

	await link("the café here").click();
	await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe("#über-café");
	await expectAtTop(page, heading(page, "Über café"));
	expect(tabs()).toBe(0);

	// A modified click is left to the browser, whose own action is a new tab: the page neither
	// follows it nor stops that action.
	await page.evaluate(() => {
		addEventListener("click", event => {
			(window as { modifiedClickTaken?: boolean }).modifiedClickTaken = event.defaultPrevented;
		}, { once: true });
	});
	let before = page.url();
	await link("what is new").click({ modifiers: ["ControlOrMeta"] });
	await expect.poll(() =>
		page.evaluate(() => (window as { modifiedClickTaken?: boolean }).modifiedClickTaken)
	)
		.toBe(false);
	expect(page.url()).toBe(before);

	await link("the deep one").click();
	await expect(page).toHaveURL(`${other}#deep-section`);
	await expectAtTop(page, heading(page, "Deep section"));
});

test("a web address pasted into Chat is a link, and one into the document is followed in the same tab", async ({ baseURL, join, room }) => {
	let { other } = await seedDocuments(baseURL!, room);
	let page = await join("ana");
	let tabs = tabsOpened(page);
	let path = new URL(page.url()).pathname;
	let chat = page.getByRole("complementary", { name: "Chat", exact: true });
	let here = `${baseURL}${path}#über-café`;
	let deep = `${baseURL}${other}#deep-section`;
	await chatInput(chat).fill(
		`Pasted: ${here}, then ${deep} and https://example.com/docs. Not www.example.com or \`https://code.example\`.`,
	);
	await chat.getByRole("button", { name: "Send message" }).click();
	let message = chat.locator("[data-chat-message-id]").filter({ hasText: "Pasted:" });
	let link = (name: string) => message.getByRole("link", { name, exact: true });

	// The comma and full stop after an address are the sentence's, not the link's.
	await expect(message.getByRole("link")).toHaveCount(3);
	await expect(link("https://example.com/docs")).toHaveAttribute("target", "_blank");
	await expect(link("https://example.com/docs")).toHaveAttribute("rel", /noopener/);
	await expect(message).toContainText("Not www.example.com or https://code.example.");
	await expect(message.locator("code")).toHaveText("https://code.example");

	await expect(link(here)).not.toHaveAttribute("target", /./);
	await link(here).click();
	await expect.poll(() => decodeURIComponent(new URL(page.url()).hash)).toBe("#über-café");
	await expectAtTop(page, heading(page, "Über café"));

	await link(deep).click();
	await expect(page).toHaveURL(`${other}#deep-section`);
	await expectAtTop(page, heading(page, "Deep section"));
	expect(tabs()).toBe(0);
});

test("a reader's tap on a section link goes there in the same tab", async ({ baseURL, join, room }) => {
	await seedDocuments(baseURL!, room);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	let tabs = tabsOpened(page);
	let path = new URL(page.url()).pathname;
	await expect(content(page)).toHaveAttribute("contenteditable", "false");

	await content(page).getByRole("link", { name: "what is new", exact: true }).tap();
	await expect(page).toHaveURL(`${path}#whats-new`);
	await expectAtTop(page, heading(page, "What's new?"));
	expect(tabs()).toBe(0);

	// Another site is the one link that opens a tab, with no way back to this page.
	await page.context().route(
		"https://example.com/**",
		route => route.fulfill({ contentType: "text/html", body: "<title>Docs</title>" }),
	);
	await page.goBack();
	let opened = page.context().waitForEvent("page");
	await content(page).getByRole("link", { name: "a site", exact: true }).tap();
	let tab = await opened;
	await expect(tab).toHaveURL("https://example.com/docs");
	expect(await tab.evaluate(() => window.opener)).toBeNull();
	await expect(page).toHaveURL(path);
});
