/**
 * GitHub pull request and issue links drawn as state pills.
 *
 * The fake GitHub serves octo-org/score pulls 1–4 (open, merged, closed, draft)
 * and issues 5–7 (open, completed, not planned); anything else is not found.
 * Unit tests cover the state mapping; only a browser shows the real route,
 * batching, Lexical's DOM and a real paste event working together.
 */

import { content, expect, test, written } from "./room";

import type { Page } from "@playwright/test";

const BASE = "https://github.com/octo-org/score";

const SOURCE = [
	`Shipped [Add document outline](${BASE}/pull/1) and [Render decision cards](${BASE}/pull/2).`,
	"",
	`Dropped [Try a sidebar rewrite](${BASE}/pull/3); [octo-org/score#4](${BASE}/pull/4) waits.`,
	"",
	`Issues: [Links lose their context](${BASE}/issues/5), [Outline jumps on load](${BASE}/issues/6),`
	+ ` [Support GitLab links](${BASE}/issues/7) and [acme/private#9](https://github.com/acme/private/pull/9).`,
	"",
	"Elsewhere: [a plain link](https://example.com).",
].join("\n");

async function paste(page: Page, text: string) {
	await content(page).evaluate((root, text) => {
		let data = new DataTransfer();
		data.setData("text/plain", text);
		root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
	}, text);
}

test("reference links show their GitHub state", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	let pills = [
		["Pull request: Add document outline #1, open", "pr-open"],
		["Pull request: Render decision cards #2, merged", "pr-merged"],
		["Pull request: Try a sidebar rewrite #3, closed", "pr-closed"],
		["Pull request: octo-org/score#4, draft", "pr-draft"],
		["Issue: Links lose their context #5, open", "issue-open"],
		["Issue: Outline jumps on load #6, completed", "issue-completed"],
		["Issue: Support GitLab links #7, not planned", "issue-not-planned"],
		["Pull request: acme/private#9, no access", "unavailable"],
	] as const;
	for (let [name, state] of pills) {
		await expect(content(page).getByRole("link", { name, exact: true }))
			.toHaveAttribute("data-gh-state", state);
	}
	// The number is drawn beside a title, never repeated after authored `#N`.
	await expect(content(page).getByRole("link", { name: /Add document outline/ }))
		.toHaveAttribute("data-gh-number", "#1");
	await expect(content(page).getByRole("link", { name: /octo-org\/score#4/ }))
		.not.toHaveAttribute("data-gh-number");
	await expect(content(page).getByRole("link", { name: "a plain link" }))
		.not.toHaveAttribute("data-gh-state");
});

test("a pasted reference URL becomes a titled link", async ({ join, room }) => {
	let page = await join("ana");
	await content(page).click();
	await page.keyboard.type("See ");
	await paste(page, `${BASE}/issues/6`);
	await expect(
		content(page).getByRole("link", { name: "Issue: Outline jumps on load #6, completed" }),
	).toBeVisible();
	await page.keyboard.type(" next");
	await written(page, room, `See [Outline jumps on load](${BASE}/issues/6) next`);

	await page.keyboard.press("Enter");
	await paste(page, "https://github.com/acme/private/pull/9");
	await expect(content(page).getByRole("link", { name: "Pull request: acme/private#9, no access" }))
		.toHaveAttribute("data-gh-state", "unavailable");
	await written(page, room, "[acme/private#9](https://github.com/acme/private/pull/9)");
});

test("the caret can edit inside a pill", async ({ join, room, seed }) => {
	await seed(`Shipped [Add document outline](${BASE}/pull/1).`);
	let page = await join("ana");
	let pill = content(page).getByRole("link", { name: /Add document outline #1/ });
	await expect(pill).toHaveAttribute("data-gh-state", "pr-open");
	// The middle of the title is the middle of "document".
	await pill.getByText("Add document outline").dblclick();
	await expect(pill).toHaveAttribute("data-gh-editing", "");
	await page.keyboard.type("draft");
	await written(page, room, `Shipped [Add draft outline](${BASE}/pull/1).`);
	let edited = content(page).getByRole("link", { name: /Add draft outline #1/ });
	await expect(edited).toHaveAttribute("data-gh-state", "pr-open");

	// Home leaves the pill for the start of the line, as it would in prose.
	await page.keyboard.press("Home");
	await expect(edited).not.toHaveAttribute("data-gh-editing");
	await page.keyboard.type("Now ");
	await written(page, room, `Now Shipped [Add draft outline](${BASE}/pull/1).`);
});
