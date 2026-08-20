import { authenticate, expect, test } from "./room";
import { renameChannel } from "./database";

function channel(id: string, title: string) {
	return {
		createdAt: "2026-08-19T12:00:00.000Z",
		createdBy: "U_ana",
		id,
		repositoryId: "R_score",
		repositoryName: "score",
		repositoryOwner: "octo-org",
		revision: 0,
		title,
		updatedAt: "2026-08-19T12:00:00.000Z",
	};
}

const repository = {
	defaultBranch: "main",
	fullName: "octo-org/score",
	id: "R_score",
	name: "score",
	owner: "octo-org",
	ownerAvatarUrl: "https://example.invalid/octo-org.png",
	permissions: { admin: false, pull: true, push: true },
	private: true,
	url: "https://github.com/octo-org/score",
};

test("the document trigger fits short labels without widening its menu", async ({ join }) => {
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	let trigger = page.getByRole("banner").getByRole("button", { name: /^Document:/ });
	let triggerBox = await trigger.boundingBox();
	expect(triggerBox).toBeTruthy();
	expect(triggerBox!.width).toBeLessThan(200);

	await trigger.click();
	let popupId = await trigger.getAttribute("aria-controls");
	let panel = page.locator(`[id="${popupId}"]`);
	let panelBox = await panel.boundingBox();
	expect(panelBox).toBeTruthy();
	expect(panelBox!.width).toBe(360);
});

test("a long document label truncates at desktop and before compact presence controls", async ({ baseURL, join, room }) => {
	let title = "A deliberately long document title that must stay clear of everyone present";
	await renameChannel(Number(new URL(baseURL!).port), room, title);
	let page = await join("ana", { viewport: { width: 1440, height: 900 } });
	let header = page.getByRole("banner");
	let trigger = header.getByRole("button", { name: `Document: ${title}` });
	let people = header.getByRole("group", { name: /People here:/ });
	let desktopBox = await trigger.boundingBox();
	let desktopText = await trigger.locator("span").evaluate(element => ({
		clientWidth: element.clientWidth,
		scrollWidth: element.scrollWidth,
	}));
	expect(desktopBox).toBeTruthy();
	expect(desktopBox!.width).toBeLessThan(360);
	expect(desktopText.scrollWidth).toBeGreaterThan(desktopText.clientWidth);

	await page.setViewportSize({ width: 320, height: 568 });
	let [triggerBox, peopleBox, textOverflow] = await Promise.all([
		trigger.boundingBox(),
		people.boundingBox(),
		trigger.locator("span").evaluate(element => ({
			clientWidth: element.clientWidth,
			scrollWidth: element.scrollWidth,
		})),
	]);
	expect(triggerBox).toBeTruthy();
	expect(peopleBox).toBeTruthy();
	expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(peopleBox!.x);
	expect(textOverflow.scrollWidth).toBeGreaterThan(textOverflow.clientWidth);
});

test("the room header switches documents with keyboard focus and creates one immediately", async ({ join }) => {
	let page = await join("ana");
	let header = page.getByRole("banner");
	let repository = header.getByRole("button", { name: "Repository: octo-org/score" });
	let trigger = header.getByRole("button", { name: /^Document:/ });

	await expect(repository).toContainText("score");
	await expect(repository).toHaveAttribute("title", "octo-org/score");
	await expect(header.getByRole("button", { name: /planner session/i })).toHaveCount(0);
	await trigger.click();
	let search = page.getByRole("combobox", { name: "Search documents" });
	await expect(search).toBeFocused();
	await expect(page.getByRole("listbox", { name: "Documents" })).toBeVisible();
	await expect(page.getByRole("option", { selected: true })).toHaveCount(1);
	await search.press("Escape");
	await expect(trigger).toBeFocused();

	await trigger.click();
	await page.getByRole("button", { name: "Create new document" }).click();
	await expect(page).toHaveURL(/\/channels\/[0-9a-f-]{36}$/);
	await expect(header.getByRole("button", { name: /^Document: [a-z]+-[a-z]+$/ })).toBeVisible();
});

test("the document picker searches beyond the first page in a capped result list", async ({ join }) => {
	let page = await join("ana");
	let requests: URL[] = [];
	let first = Array.from(
		{ length: 50 },
		(_, index) =>
			channel(
				`${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
				`Note ${index + 1}`,
			),
	);
	let searched = channel("aaaaaaaa-0000-4000-8000-000000000000", "Search needle");
	let continued = channel("bbbbbbbb-0000-4000-8000-000000000000", "Continued document");
	await page.route("**/api/repositories/octo-org/score/channels*", async route => {
		let url = new URL(route.request().url());
		requests.push(url);
		let query = url.searchParams.get("query");
		let body = query === "needle"
			? { canEdit: true, channels: [searched], repository }
			: url.searchParams.get("cursor") === "next"
			? { canEdit: true, channels: [continued], repository }
			: { canEdit: true, channels: first, nextCursor: "next", repository };
		await route.fulfill({ json: body });
	});

	let trigger = page.getByRole("banner").getByRole("button", { name: /^Document:/ });
	await trigger.click();
	let search = page.getByRole("combobox", { name: "Search documents" });
	let scroller = page.locator("[data-document-scroll]");
	await expect(page.getByRole("option", { name: "Note 50" })).toBeVisible();
	expect(await scroller.evaluate(node => getComputedStyle(node).overflowY)).toBe("auto");
	expect(await scroller.evaluate(node => node.getBoundingClientRect().height)).toBeLessThanOrEqual(
		384,
	);
	await scroller.evaluate(node => {
		node.scrollTop = node.scrollHeight;
		node.dispatchEvent(new Event("scroll"));
	});
	await expect(page.getByRole("option", { name: "Continued document" })).toBeVisible();
	await search.fill("needle");
	await expect(page.getByRole("option", { name: "Search needle" })).toBeVisible();
	expect(requests.some(url => url.searchParams.get("query") === "needle")).toBe(true);
});

test("read-only visitors can browse documents without a creation action", async ({ baseURL, page, room }) => {
	await authenticate(page, "readonly", baseURL!);
	await page.goto(`/channels/${room}`);
	await expect(page.getByRole("banner")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "editable markdown" })).toHaveAttribute(
		"contenteditable",
		"false",
	);
	await page.getByRole("banner").getByRole("button", { name: /^Document:/ }).click();
	await expect(page.getByRole("combobox", { name: "Search documents" })).toBeFocused();
	await expect(page.getByRole("button", { name: "Create new document" })).toHaveCount(0);
});

test("document picker keeps failures open and makes creation retryable", async ({ join }) => {
	let page = await join("ana");
	let listFailed = true;
	let creationFailed = true;
	await page.route("**/api/repositories/octo-org/score/channels*", async route => {
		if (route.request().method() === "GET" && listFailed) {
			listFailed = false;
			await route.fulfill({ status: 503, json: { error: "documents are unavailable" } });
			return;
		}
		if (route.request().method() === "POST" && creationFailed) {
			creationFailed = false;
			await route.fulfill({ status: 503, json: { error: "creation is unavailable" } });
			return;
		}
		await route.continue();
	});

	let trigger = page.getByRole("banner").getByRole("button", { name: /^Document:/ });
	await trigger.click();
	await expect(page.getByRole("alert")).toHaveText("documents are unavailable");
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	let create = page.getByRole("button", { name: "Create new document" });
	await create.click();
	await expect(page.getByRole("alert")).toHaveText("creation is unavailable");
	await expect(create).toBeEnabled();
	await create.click();
	await expect(page).toHaveURL(/\/channels\/[0-9a-f-]{36}$/);
});
