import { seedChildChannel } from "./database";
import { authenticate, expect, test } from "./room";

const PARENT_SOURCE = `# Parent document

${Array.from({ length: 36 }, (_, index) => `Parent passage ${index + 1}.`).join("\n\n")}
`;

const CHILD_SOURCE = `# Source review

This ordinary child has its own editable document, Decisions, and Conversation.
`;

function port(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

test("an in-app child preserves and restores its mounted parent", async ({ baseURL, join, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Source review ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await page.addInitScript(() => localStorage.setItem("chopin:pane:chat:open", "true"));
	await join("ana");

	let parent = page.locator(`[data-workspace-room="${room}"]`);
	let parentScroll = parent.locator("[data-plan-scroll]");
	await parent.evaluate(element => element.setAttribute("data-mount-token", "preserved"));
	await parentScroll.evaluate(element => element.scrollTop = 240);
	let originalScroll = await parentScroll.evaluate(element => element.scrollTop);
	await page.evaluate(() => history.replaceState({ navigation: 4 }, "", "?view=plan#note"));
	let childLink = page.getByRole("complementary", { name: "Projects" })
		.getByRole("link", { name: childTitle, exact: true });
	await childLink.focus();
	await childLink.click();

	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(page).toHaveURL(url => url.pathname === child.path);
	await expect(surface).toBeVisible();
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
	await expect(parent.locator("..")).toHaveAttribute("inert", "");
	await expect(parent.locator("..")).toHaveAttribute("aria-hidden", "true");
	await expect(surface.getByRole("button", { name: "Show conversation pane" })).toBeVisible();
	await expect(surface.getByRole("button", { name: "Decisions", exact: true })).toBeVisible();
	await expect(surface.getByRole("button", { name: "Background Work", exact: true })).toHaveCount(
		0,
	);
	await expect(surface.getByRole("button", { name: "Tasks & Progress", exact: true })).toHaveCount(
		0,
	);
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();

	await surface.getByRole("button", { name: "Decisions", exact: true }).click();
	await expect(surface.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(parent.locator('[data-document-view="decisions"]')).toHaveAttribute("hidden", "");
	await surface.getByRole("button", { name: "Document", exact: true }).click();
	await surface.getByRole("button", { name: "Show conversation pane" }).click();
	await expect(surface.getByRole("button", { name: "Hide conversation pane" })).toBeVisible();
	await expect(parent.locator('button[aria-label^="Hide conversation pane"]')).toHaveCount(1);
	await surface.getByRole("button", { name: "Hide conversation pane" }).click();
	await expect(surface.getByRole("button", { name: "Show conversation pane" })).toBeVisible();
	await surface.getByRole("button", { name: `Actions for ${childTitle}` }).click();
	await expect(page.getByRole("menu", { name: `Actions for ${childTitle}` })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(surface).toBeVisible();
	await expect(page.getByRole("menu", { name: `Actions for ${childTitle}` })).toHaveCount(0);

	await page.keyboard.press("Escape");
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/test-${room.slice(0, 8)}`)
		&& url.search === "?view=plan"
		&& url.hash === "#note"
	);
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
	await expect.poll(() => parentScroll.evaluate(element => element.scrollTop)).toBe(originalScroll);

	await childLink.click();
	await expect(surface).toBeVisible();
	await page.goBack();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();

	await childLink.click();
	await expect(surface).toBeVisible();
	await surface.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(surface).toHaveCount(0);
	await expect(childLink).toBeFocused();
});

test("a direct compact child fills the canvas and reduces motion to a crossfade", async ({ baseURL, page, room, seed }) => {
	await seed(PARENT_SOURCE);
	let childTitle = `Source review ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		port(baseURL!),
		room,
		crypto.randomUUID(),
		childTitle,
		CHILD_SOURCE,
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	await authenticate(page, "ana", baseURL!);
	await page.goto(child.path);

	let surface = page.getByRole("region", { name: `Child document: ${childTitle}` });
	await expect(surface).toBeVisible();
	let geometry = await surface.evaluate(element => {
		let style = getComputedStyle(element);
		let box = element.getBoundingClientRect();
		return {
			animationName: style.animationName,
			left: box.left,
			right: innerWidth - box.right,
			transform: style.transform,
		};
	});
	expect(geometry).toEqual({
		animationName: "anchored-child-fade",
		left: 0,
		right: 0,
		transform: "none",
	});

	await surface.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(page).toHaveURL(url => url.pathname.endsWith(`/test-${room.slice(0, 8)}`));
});
