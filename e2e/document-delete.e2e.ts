import { content, expect, ready, test } from "./room";
import { createChannel, seedChildChannel, testChannelPath } from "./database";

import type { Page } from "@playwright/test";

/** The document is created by `e2e`, the creator; `score-admin-` people administer its repository. */
const CREATOR = "e2e";

function sidebar(page: Page) {
	return page.getByRole("complementary", { name: "Projects" });
}

function headerActions(page: Page) {
	return page.getByRole("group", { name: /^Document: / }).getByRole("button", {
		name: /^Actions for /,
	});
}

async function menuItems(page: Page): Promise<string[]> {
	await headerActions(page).click();
	let menu = page.getByRole("menu", { name: /^Actions for / });
	await expect(menu).toBeVisible();
	let names = await menu.getByRole("menuitem").allTextContents();
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	return names.map(name => name.trim());
}

test("Delete is offered under Archive to the creator and a repository admin, never to another writer", async ({ join, room }) => {
	let creator = await join(CREATOR);
	let admin = await join(`score-admin-${crypto.randomUUID().slice(0, 8)}`);
	let writer = await join("ana");

	for (let page of [creator, admin]) {
		let names = await menuItems(page);
		expect(names.at(-1)).toBe("Delete…");
		expect(names.at(-2)).toBe("Archive");
		await headerActions(page).click();
		let remove = page.getByRole("menuitem", { name: "Delete…", exact: true });
		// The destructive ink, as Discard decision's.
		await expect(remove).toHaveAttribute("data-tone", "destructive");
		expect(
			await remove.evaluate(element => {
				let ink = document.createElement("span");
				ink.style.color = "var(--color-destructive-ink)";
				document.body.append(ink);
				let expected = getComputedStyle(ink).color;
				ink.remove();
				return getComputedStyle(element).color === expected;
			}),
		).toBe(true);
		await page.keyboard.press("Escape");
	}

	let names = await menuItems(writer);
	expect(names).toContain("Archive");
	expect(names).not.toContain("Delete…");
	// The sidebar's menu follows the same rule.
	let row = sidebar(writer).locator(`[data-document-id="${room}"]`);
	await row.hover();
	await row.getByRole("button", { name: /^Actions for / }).click();
	await expect(writer.getByRole("menuitem", { name: "Archive", exact: true })).toBeVisible();
	await expect(writer.getByRole("menuitem", { name: "Delete…", exact: true })).toHaveCount(0);
});

test(
	"the delete dialog names the document and what goes with it, starts on Cancel and backs out",
	async ({ join, room, baseURL }, testInfo) => {
		let child = crypto.randomUUID();
		await seedChildChannel(
			Number(new URL(baseURL!).port),
			room,
			child,
			"Startup comparison",
			"Caching halves startup.\n",
		);
		let page = await join(CREATOR);
		let title = `Test ${room.slice(0, 8)}`;

		await headerActions(page).click();
		let menu = page.getByRole("menu", { name: /^Actions for / });
		await expect(menu.getByRole("menuitem", { name: "Delete…", exact: true })).toBeVisible();
		await page.screenshot({ path: testInfo.outputPath("delete-menu.png") });
		await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
		let dialog = page.getByRole("dialog", { name: "Delete document?" });
		await expect(dialog).toBeVisible();
		await expect.poll(() => dialog.evaluate(element => element.getAnimations().length)).toBe(0);
		await page.screenshot({ path: testInfo.outputPath("delete-dialog.png") });
		await expect(dialog).toContainText(
			`${title} is deleted for everyone, with its Chat and threads, its Decisions, its history and `
				+ "its research document Startup comparison. This cannot be undone.",
		);
		let cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
		let remove = dialog.getByRole("button", { name: "Delete document", exact: true });
		await expect(cancel).toBeFocused();
		await expect(remove).toHaveCSS("background-color", "oklch(0.588 0.17178 24.175)");
		// Focus stays inside it.
		await page.keyboard.press("Tab");
		await expect(remove).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(cancel).toBeFocused();

		// Escape backs out, and nothing is deleted.
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(headerActions(page)).toBeFocused();
		await headerActions(page).click();
		await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		expect((await page.request.get(`/api/channels/${room}`)).status()).toBe(200);
		expect((await page.request.get(`/api/channels/${child}`)).status()).toBe(200);
		await expect(content(page)).toHaveAttribute("contenteditable", "true");
	},
);

test("deleting a document sends everyone who has it open to its project's list, saying who deleted it, with no Undo, and drops it from every sidebar", async ({ baseURL, join, room }) => {
	let title = `Test ${room.slice(0, 8)}`;
	let child = crypto.randomUUID();
	let databasePort = Number(new URL(baseURL!).port);
	await seedChildChannel(databasePort, room, child, "Startup comparison", "Caching helps.\n");
	let other = crypto.randomUUID();
	await createChannel(databasePort, other);

	let creator = await join(CREATOR);
	let reader = await join("ana");
	// Someone on another document of the project sees it leave their sidebar.
	let elsewhere = await join("bo");
	await elsewhere.goto(testChannelPath(other));
	await ready(elsewhere);
	for (let page of [creator, reader, elsewhere]) {
		await expect(sidebar(page).getByRole("link", { name: title, exact: true })).toBeVisible();
	}

	await headerActions(creator).click();
	await creator.getByRole("menuitem", { name: "Delete…", exact: true }).click();
	await creator.getByRole("dialog", { name: "Delete document?" })
		.getByRole("button", { name: "Delete document", exact: true }).click();

	let project = "/documents/octo-org/score";
	await expect(creator).toHaveURL(project);
	await expect(reader).toHaveURL(project);
	let own = creator.getByRole("status").filter({ hasText: `Deleted ${title}` });
	let told = reader.getByRole("status").filter({ hasText: `${CREATOR} deleted ${title}` });
	await expect(own).toBeVisible();
	await expect(told).toBeVisible();
	// Deleting is for good: unlike Archive, there is nothing to undo.
	await expect(own.getByRole("button")).toHaveCount(0);
	await expect(told.getByRole("button")).toHaveCount(0);
	await expect(reader.getByText("No document open", { exact: true })).toBeVisible();

	for (let page of [creator, reader, elsewhere]) {
		await expect(sidebar(page).getByRole("link", { name: title, exact: true })).toHaveCount(0);
	}
	await expect(elsewhere).toHaveURL(testChannelPath(other));

	// Its research document went with it.
	for (let id of [room, child]) {
		expect((await creator.request.get(`/api/channels/${id}`)).status()).toBe(404);
	}
});
