/**
 * The card a GitHub pill opens: on hover, and through the caret's link preview.
 *
 * `github-card.test.tsx` covers the card's rows; only a browser shows the
 * delayed hover, its anchoring, and that the hover card and the caret's link
 * preview never show the same pill twice.
 */

import { content, expect, test } from "./room";

const BASE = "https://github.com/octo-org/score";

const SOURCE = [
	`Shipped [Render decision cards](${BASE}/pull/2) last week.`,
	"",
	`Still open: [Links lose their context](${BASE}/issues/5) end`,
].join("\n");

test("hovering a pill opens its card", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	let pill = content(page).getByRole("link", {
		name: "Pull request: Render decision cards #2, merged",
	});
	await expect(pill).toHaveAttribute("data-gh-state", "pr-merged");

	await pill.hover();
	let state = page.getByRole("img", { name: "Merged pull request" });
	await expect(state).toBeVisible();
	await expect(page.getByText("topic-2", { exact: true })).toBeVisible();
	await expect(page.getByText("octocat", { exact: true })).toBeVisible();
	// Pull requests never show labels.
	await expect(page.getByText("documents", { exact: true })).toHaveCount(0);

	await content(page).getByText("last week").hover();
	await expect(state).toBeHidden();
});

test("the caret in a pill shows its card once, inside the link preview", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	let pill = content(page).getByRole("link", { name: /Links lose their context #5, open/ });
	await expect(pill).toHaveAttribute("data-gh-state", "issue-open");

	await content(page).getByText("end", { exact: true }).click();
	await page.keyboard.press("End");
	let preview = page.getByRole("dialog", { name: "Link" });
	// Walk back into the link: its far edge counts as outside, so step until the preview answers.
	await expect(async () => {
		await page.keyboard.press("ArrowLeft");
		await expect(preview).toBeVisible({ timeout: 500 });
	}).toPass({ timeout: 10_000 });
	await expect(preview.getByRole("img", { name: "Open issue" })).toBeVisible();
	await expect(preview.getByText("documents", { exact: true })).toBeVisible();
	await expect(preview.getByRole("button", { name: "Edit" })).toBeVisible();

	// Hovering the same pill adds nothing: the preview already speaks for it.
	await pill.hover();
	await page.waitForTimeout(700);
	await expect(page.getByRole("img", { name: "Open issue" })).toHaveCount(1);
});

test("pressing a hovered pill hands its card to the link preview", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	let pill = content(page).getByRole("link", { name: /Render decision cards #2, merged/ });
	await pill.hover();
	await expect(page.getByRole("img", { name: "Merged pull request" })).toBeVisible();

	await pill.click();
	let preview = page.getByRole("dialog", { name: "Link" });
	await expect(preview.getByRole("img", { name: "Merged pull request" })).toBeVisible();
	await expect(page.getByRole("img", { name: "Merged pull request" })).toHaveCount(1);
});
