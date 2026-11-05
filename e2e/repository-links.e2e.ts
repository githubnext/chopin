/**
 * Links that name a path in the document's repository.
 *
 * Lexical draws `docs/review.md` as the host `docs`, and `./docs/review.md` would open on the
 * Chopin page it sits in. Every test room belongs to octo-org/score, whose fake GitHub says its
 * default branch is main. Unit tests cover the resolution itself; only a browser shows the anchor
 * Lexical draws, the click that follows it, and the tab a browser really opens.
 */

import { chatInput } from "./chat-input";
import { readSource } from "./database";
import { content, expect, test, written } from "./room";

import type { Page } from "@playwright/test";

const BLOB = "https://github.com/octo-org/score/blob/main";

const SOURCE = [
	"Read [the review](docs/review.md), [the entry point](./src/app.ts) and"
	+ " [these lines](docs/review.md#L10-L20).",
	"",
	"Elsewhere: [a site](https://example.com/docs), [a mailbox](mailto:ana@example.com),"
	+ " [a section](#read), [another document](/documents/octo-org/score/elsewhere)"
	+ " and [a path above](../secrets.md).",
].join("\n");

/** GitHub is not reachable from the harness; the tab a link opens only has to name it. */
async function stubGitHub(page: Page): Promise<void> {
	await page.context().route(
		"https://github.com/**",
		route => route.fulfill({ contentType: "text/html", body: "<title>GitHub</title>" }),
	);
}

test("a repository path is drawn as the file on GitHub and stored as the path", async ({ join, room, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	let link = (name: string) => content(page).getByRole("link", { name, exact: true });

	await expect(link("the review")).toHaveAttribute("href", `${BLOB}/docs/review.md`);
	await expect(link("the entry point")).toHaveAttribute("href", `${BLOB}/src/app.ts`);
	await expect(link("these lines")).toHaveAttribute("href", `${BLOB}/docs/review.md#L10-L20`);

	// Every other link is drawn as it was, and a path out of the repository is not opened on GitHub.
	await expect(link("a site")).toHaveAttribute("href", "https://example.com/docs");
	await expect(link("a mailbox")).toHaveAttribute("href", "mailto:ana@example.com");
	await expect(link("a section")).toHaveAttribute("href", "#read");
	await expect(link("another document")).toHaveAttribute(
		"href",
		"/documents/octo-org/score/elsewhere",
	);
	await expect(link("a path above")).toHaveAttribute("href", "../secrets.md");

	// An edit round-trips the document; the stored target is still the path that was written.
	await content(page).getByText("Elsewhere:").click();
	await page.keyboard.press("End");
	await page.keyboard.type(" Done.");
	await written(page, room, /Done\./);
	let stored = await readSource(Number(new URL(page.url()).port), room);
	expect(stored).toContain("[the review](docs/review.md)");
	expect(stored).toContain("[the entry point](./src/app.ts)");
	expect(stored).toContain("[these lines](docs/review.md#L10-L20)");
	expect(stored).not.toContain("github.com");
});

test("Open on a repository path opens the file in a new tab, and so does the keyboard", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	await stubGitHub(page);

	await content(page).getByRole("link", { name: "the review", exact: true }).click();
	let preview = page.getByRole("dialog", { name: "Link" });
	// The preview names what was written, and Open goes where that means.
	await expect(preview).toContainText("docs/review.md");
	let popup = page.waitForEvent("popup");
	await preview.getByRole("button", { name: "Open" }).click();
	let opened = await popup;
	await expect(opened).toHaveURL(`${BLOB}/docs/review.md`);
	await opened.close();

	await content(page).getByRole("link", { name: "the entry point", exact: true }).click();
	await expect(preview).toContainText("./src/app.ts");
	popup = page.waitForEvent("popup");
	await page.keyboard.press("ControlOrMeta+Enter");
	opened = await popup;
	await expect(opened).toHaveURL(`${BLOB}/src/app.ts`);
	await opened.close();

	// A modified click follows at once, without the preview.
	popup = page.waitForEvent("popup");
	await content(page).getByRole("link", { name: "these lines", exact: true })
		.click({ modifiers: ["ControlOrMeta"] });
	opened = await popup;
	await expect(opened).toHaveURL(`${BLOB}/docs/review.md#L10-L20`);
	await opened.close();

	// A link that was never a repository path opens where it always did.
	await page.context().route(
		"https://example.com/**",
		route => route.fulfill({ contentType: "text/html", body: "<title>Docs</title>" }),
	);
	await content(page).getByRole("link", { name: "a site", exact: true }).click();
	await expect(preview).toContainText("https://example.com/docs");
	popup = page.waitForEvent("popup");
	await page.keyboard.press("ControlOrMeta+Enter");
	opened = await popup;
	await expect(opened).toHaveURL("https://example.com/docs");
});

test("a link someone adds, and the one a collaborator sees, are drawn as the file", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");

	await content(ana).click();
	await ana.keyboard.type("Start with the guide.");
	await ana.keyboard.press("Shift+Home");
	await ana.keyboard.press("ControlOrMeta+k");
	let adding = ana.getByRole("form", { name: "Add link" });
	await adding.getByRole("textbox", { name: "Link URL" }).fill("docs/guide.md");
	await ana.keyboard.press("Enter");
	await expect(adding).toHaveCount(0);

	await expect(content(ana).getByRole("link", { name: "Start with the guide." }))
		.toHaveAttribute("href", `${BLOB}/docs/guide.md`);
	await written(ana, room, /^\[Start with the guide\.\]\(docs\/guide\.md\)$/m);
	await expect(content(bo).getByRole("link", { name: "Start with the guide." }))
		.toHaveAttribute("href", `${BLOB}/docs/guide.md`);

	// Pointing it at another path draws the new one.
	await content(ana).getByRole("link", { name: "Start with the guide." }).click();
	await ana.getByRole("dialog", { name: "Link" }).getByRole("button", { name: "Edit" }).click();
	let editing = ana.getByRole("form", { name: "Edit link" });
	await editing.getByRole("textbox", { name: "Link URL" }).fill("./docs/other.md");
	await ana.keyboard.press("Enter");
	await expect(content(bo).getByRole("link", { name: "Start with the guide." }))
		.toHaveAttribute("href", `${BLOB}/docs/other.md`);
});

test("a reader's tap on a repository path opens the file", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 },
	});
	await stubGitHub(page);
	await expect(content(page)).toHaveAttribute("contenteditable", "false");

	let opened = page.context().waitForEvent("page");
	await page.getByRole("link", { name: "the review", exact: true }).tap();
	expect((await opened).url()).toBe(`${BLOB}/docs/review.md`);
	await expect(page.getByRole("dialog", { name: "Link" })).toHaveCount(0);
});

test("a repository path in Chat opens the file on GitHub", async ({ join }) => {
	let page = await join("ana");
	let chat = page.getByRole("complementary", { name: "Chat", exact: true });
	let draft = chatInput(chat);
	await draft.fill(
		"Compare [the review](docs/review.md#L10-L20) with [the site](https://example.com).",
	);
	await chat.getByRole("button", { name: "Send message" }).click();

	await expect(chat.getByRole("link", { name: "the review", exact: true }))
		.toHaveAttribute("href", `${BLOB}/docs/review.md#L10-L20`);
	await expect(chat.getByRole("link", { name: "the site", exact: true }))
		.toHaveAttribute("href", "https://example.com");
});
