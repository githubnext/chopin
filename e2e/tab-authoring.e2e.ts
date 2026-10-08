import { content, expect, test, written } from "./room";

import type { WebSocketRoute } from "@playwright/test";

const TABS = "01K0N4TR8K7JGM4R1J7PW4R8YA";
const FIRST = "01K0N4V4E7Y6P4MJ5WD8XZF3BA";
const SECOND = "01K0N4V4E7Y6P4MJ5WD8XZF3BB";

const SOURCE = `Before the tabs.

<Tabs id="${TABS}">
<Tab id="${FIRST}" label="Mobile">

Queue in memory only.

</Tab>
<Tab id="${SECOND}" label="Desktop">

</Tab>
</Tabs>

After the tabs.
`;

test("tabs are renamed, added and removed in place, and the document keeps them", async ({ join, room, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	let strip = content(page).getByRole("tablist");
	let tabs = strip.getByRole("tab");
	await expect(tabs).toHaveText(["Mobile", "Desktop"]);

	// Rename by double-click. Typing in the field never reaches the document.
	await strip.getByRole("tab", { name: "Desktop", exact: true }).dblclick();
	let field = content(page).getByRole("textbox", { name: "Tab name", exact: true });
	await expect(field).toBeFocused();
	await page.keyboard.type("Wide screens");
	await page.keyboard.press("Enter");
	await expect(field).toHaveCount(0);
	await expect(tabs).toHaveText(["Mobile", "Wide screens"]);
	await expect(strip.getByRole("tab", { name: "Wide screens" })).toBeFocused();
	await written(page, room, /<Tab id="[^"]+" label="Wide screens"/);
	await expect(content(page)).toContainText("Before the tabs.");
	await expect(content(page)).not.toContainText("Before the tabs.Wide");

	// Enter renames from the keyboard; Escape and an empty label keep the old one.
	await page.keyboard.press("Enter");
	await expect(field).toBeFocused();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.press("Delete");
	await page.keyboard.press("Enter");
	await expect(tabs).toHaveText(["Mobile", "Wide screens"]);

	// Add from the strip's end, which opens the new tab's name for editing.
	await content(page).locator(".planTabs").hover();
	await content(page).getByRole("button", { name: "Add tab", exact: true }).click();
	await expect(field).toBeFocused();
	await expect(field).toHaveValue("Tab 3");
	await page.keyboard.type("Tablet");
	await page.keyboard.press("Enter");
	await expect(tabs).toHaveText(["Mobile", "Wide screens", "Tablet"]);
	await expect(strip.getByRole("tab", { name: "Tablet" })).toHaveAttribute("aria-selected", "true");
	await written(page, room, /label="Wide screens"[\s\S]*<Tab id="[A-Z0-9]{26}" label="Tablet"/);

	// An empty tab goes at once from the keyboard.
	await strip.getByRole("tab", { name: "Tablet" }).press("Delete");
	await expect(tabs).toHaveText(["Mobile", "Wide screens"]);
	await expect(strip.getByRole("tab", { name: "Wide screens" })).toBeFocused();

	// A tab with content goes at once and can be recovered with Undo.
	await strip.getByRole("tab", { name: "Mobile" }).hover();
	await content(page).getByRole("button", { name: "Remove Mobile", exact: true }).click();
	await expect(tabs).toHaveText(["Wide screens"]);
	await written(page, room, /<Tabs id="[^"]+">\s*<Tab id="[^"]+" label="Wide screens"/);
	await expect.poll(async () => (await content(page).textContent()) ?? "").not.toContain(
		"Queue in memory only.",
	);

	// The last tab cannot be removed.
	await expect(content(page).getByRole("button", { name: /^Remove / })).toHaveCount(0);
	await strip.getByRole("tab", { name: "Wide screens" }).press("Delete");
	await expect(tabs).toHaveText(["Wide screens"]);

	await page.reload();
	await expect(content(page).getByRole("tablist").getByRole("tab")).toHaveText(["Wide screens"]);
});

test("undo restores a removed tab with its content", async ({ join, room, seed }) => {
	await seed(SOURCE);
	let page = await join("ana");
	let strip = content(page).getByRole("tablist");
	let tabs = strip.getByRole("tab");

	await strip.getByRole("tab", { name: "Mobile", exact: true }).press("Delete");
	await expect(tabs).toHaveText(["Desktop"]);
	await written(page, room, /<Tab id="[^"]+" label="Desktop"/);

	await content(page).locator("p").filter({ hasText: "After the tabs." }).click();
	await page.keyboard.press("ControlOrMeta+z");
	await expect(tabs).toHaveText(["Mobile", "Desktop"]);
	await strip.getByRole("tab", { name: "Mobile", exact: true }).click();
	await expect(content(page).getByText("Queue in memory only.")).toBeVisible();
	await written(page, room, /<Tab id="[^"]+" label="Mobile">[\s\S]*Queue in memory only\./);

	await page.reload();
	await expect(content(page).getByRole("tablist").getByRole("tab")).toHaveText([
		"Mobile",
		"Desktop",
	]);
	await expect(content(page).getByText("Queue in memory only.")).toBeVisible();
});

test("touch removes the selected tab with one tap", async ({ join, seed }) => {
	await seed(SOURCE);
	let page = await join("ana", {
		viewport: { width: 390, height: 844 },
		hasTouch: true,
		isMobile: true,
	});
	let strip = content(page).getByRole("tablist");
	let remove = content(page).getByRole("button", { name: "Remove Mobile", exact: true });
	await expect(remove).toHaveCSS("opacity", "1");
	await remove.tap();
	await expect(strip.getByRole("tab")).toHaveText(["Desktop"]);
});

test("a locked document offers no tab authoring", async ({ join, page, seed }) => {
	let sockets: WebSocketRoute[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		route.connectToServer();
		sockets.push(route);
	});
	await seed(SOURCE);
	await join("ana");
	let strip = content(page).getByRole("tablist");
	await strip.getByRole("tab", { name: "Desktop" }).hover();
	await expect(content(page).getByRole("button", { name: "Remove Desktop" })).toBeAttached();

	await sockets.at(-1)!.close();
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	await expect(content(page).getByRole("button", { name: "Add tab" })).toHaveCount(0);
	await expect(content(page).getByRole("button", { name: /^Remove / })).toHaveCount(0);
	await strip.getByRole("tab", { name: "Desktop" }).dblclick();
	await expect(content(page).getByRole("textbox", { name: "Tab name" })).toHaveCount(0);
	await expect(strip.getByRole("tab", { name: "Desktop" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
});
