/**
 * The harness proving itself.
 *
 * Everything else in this directory assumes a handle in the URL opens a named
 * room and leaves an editable plan on screen. If that is not true the rest of
 * the suite fails in six different ways with six different explanations, so it
 * is worth one file that fails in one.
 */

import { content, expect, ready, test } from "./room";

test("a handle in the URL joins without the form", async ({ join, room }) => {
	let page = await join("ana");

	await expect(page.getByRole("heading", { name: "GitHub handle" })).toHaveCount(0);
	await expect(page.getByLabel("GitHub handle")).toHaveCount(0);
	await expect(page.locator("header").first()).toContainText(`/r/${room}`);
	await expect(page.locator("header").first()).toContainText("@ana");
});

test("the address bar keeps the handle and loses the key", async ({ page, room }) => {
	await page.goto(`/r/${room}?as=ana&key=hunter2`);
	await ready(page);

	// The handle is not a secret and seeing it helps when two windows are open.
	// The key is, and these sessions get screen shared.
	expect(page.url()).toContain("as=ana");
	expect(page.url()).not.toContain("hunter2");
});

test("a visitor with no handle is asked for one", async ({ page }) => {
	await page.goto("/");

	await expect(page.getByLabel("GitHub handle")).toBeVisible();
	await expect(page.getByRole("button", { name: "Join" })).toBeDisabled();

	await page.getByLabel("GitHub handle").fill("ana");
	await expect(page.getByRole("button", { name: "Join" })).toBeEnabled();
	await page.getByRole("button", { name: "Join" }).click();

	await ready(page);
});

test("a path with no room becomes the default room", async ({ page }) => {
	await page.goto("/?as=ana");
	await ready(page);

	// Rewritten rather than offered as a choice, and rewritten in place: a
	// reload has to land on the same room, not on the chooser again.
	await expect(page).toHaveURL(/\/r\/main(\?|$)/);
});

test("the three panes are all present", async ({ join }) => {
	let page = await join("ana");

	await expect(page.getByText("Planner", { exact: true })).toBeVisible();
	await expect(content(page)).toBeVisible();
	await expect(page.locator(".plan-decisions")).toBeVisible();
});

test("an empty room settles rather than loading forever", async ({ join }) => {
	let page = await join("ana");

	// "Saved" is the resting state and it draws nothing, so the assertion is
	// on the label the status pane keeps for a screen reader either way.
	await expect(page.locator(".plan-status")).toContainText("Saved");
	await expect(page.locator(".plan-status")).toHaveAttribute("data-level", "hidden");
});
