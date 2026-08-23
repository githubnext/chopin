import { authenticate, expect, roomPath, test } from "./room";

function channel(id: string, title: string) {
	return {
		createdAt: "2026-08-19T12:00:00.000Z",
		createdBy: "U_ana",
		id,
		repositoryId: "R_score",
		repositoryName: "score",
		repositoryOwner: "octo-org",
		revision: 0,
		slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
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

function sidebar(page: import("@playwright/test").Page) {
	return page.getByRole("complementary", { name: "Projects" });
}

function headerDocument(page: import("@playwright/test").Page) {
	return page.getByRole("banner").locator('[aria-label^="Document:"]');
}

function headerRename(page: import("@playwright/test").Page) {
	return page.getByRole("banner").getByRole("button", { name: /^Rename / });
}

test("the room header renames the current document and the sidebar creates one immediately", async ({ join }) => {
	let page = await join("ana");
	let header = page.getByRole("banner");
	let trigger = headerRename(page);
	let projects = sidebar(page);

	await expect(headerDocument(page)).toBeVisible();
	await expect(projects.locator('[aria-current="page"]')).toHaveCount(1);
	await expect(header.getByRole("button", { name: /planner session/i })).toHaveCount(0);
	await trigger.click();
	let title = page.getByRole("textbox", { name: "Document title" });
	await expect(title).toBeFocused();
	await title.press("Escape");
	await expect(trigger).toBeFocused();

	await projects.getByRole("button", { name: "New document", exact: true }).click();
	await expect(page).toHaveURL(/\/documents\/octo-org\/score\/[a-z]+-[a-z]+$/);
	await expect(headerDocument(page)).toHaveAccessibleName(/^Document: [a-z]+-[a-z]+$/);
});

test("the sidebar paginates documents and global search queries beyond the loaded page", async ({ join, page }) => {
	let requests: URL[] = [];
	let first = Array.from(
		{ length: 2 },
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

	page = await join("ana");
	let projects = sidebar(page);
	await expect(projects.getByRole("link", { name: "Note 2", exact: true })).toBeVisible();
	await projects.getByRole("button", { name: "Load more documents in score" }).click();
	await expect(projects.getByRole("link", { name: "Continued document", exact: true }))
		.toBeVisible();
	await projects.getByRole("button", { name: "Search", exact: true }).click();
	let dialog = page.getByRole("dialog", { name: "Search documents" });
	let search = dialog.getByRole("textbox", { name: "Search documents" });
	await expect(search).toBeFocused();
	await search.fill("needle");
	await expect(dialog.getByRole("button", { name: /Search needle/ })).toBeVisible();
	expect(requests.some(url => url.searchParams.get("query") === "needle")).toBe(true);
});

test("renaming the current document updates collaborators and survives reload", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	let title = `Launch plan ${room.slice(0, 8)}`;
	let previousPath = roomPath(room);
	let renamedPath = `/documents/octo-org/score/${title.toLowerCase().replaceAll(" ", "-")}`;
	let anaTrigger = headerRename(ana);

	await ana.setViewportSize({ width: 320, height: 568 });
	await anaTrigger.click();
	let input = ana.getByRole("textbox", { name: "Document title" });
	await expect(input).toBeFocused();
	await input.fill(title);
	await ana.getByRole("button", { name: "Save" }).click();

	await expect(headerDocument(ana)).toHaveAccessibleName(`Document: ${title}`);
	await expect(headerDocument(bo)).toHaveAccessibleName(`Document: ${title}`);
	await expect(ana).toHaveURL(renamedPath);
	await expect(bo).toHaveURL(renamedPath);
	await ana.reload();
	await expect(ana.getByRole("banner").locator(`[aria-label="Document: ${title}"]`))
		.toBeVisible();
	await ana.goto(previousPath);
	await expect(ana).toHaveURL(renamedPath);
});

test("a delayed rename response cannot overwrite a newer collaborator rename", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	let release = Promise.withResolvers<void>();
	let delay = true;
	await ana.route(`**/api/channels/${room}`, async route => {
		if (route.request().method() !== "PATCH" || !delay) return route.continue();
		delay = false;
		let response = await route.fetch();
		await release.promise;
		await route.fulfill({ response });
	});
	let first = `First rename ${room.slice(0, 8)}`;
	let latest = `Latest rename ${room.slice(0, 8)}`;
	let anaTrigger = headerRename(ana);
	let boTrigger = headerRename(bo);

	await anaTrigger.click();
	await ana.getByRole("textbox", { name: "Document title" }).fill(first);
	await ana.getByRole("button", { name: "Save" }).click();
	await expect(headerDocument(bo)).toHaveAccessibleName(`Document: ${first}`);

	await boTrigger.click();
	await bo.getByRole("textbox", { name: "Document title" }).fill(latest);
	await bo.getByRole("button", { name: "Save" }).click();
	await expect(headerDocument(ana)).toHaveAccessibleName(`Document: ${latest}`);

	release.resolve();
	await expect(headerDocument(ana)).toHaveAccessibleName(`Document: ${latest}`);
});

test("read-only visitors can browse documents while mutation actions stay disabled", async ({ baseURL, page, room }) => {
	await authenticate(page, "readonly", baseURL!);
	await page.goto(roomPath(room));
	await expect(page.getByRole("banner")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "editable markdown" })).toHaveAttribute(
		"contenteditable",
		"false",
	);
	await expect(headerRename(page)).toBeDisabled();
	await expect(sidebar(page).getByRole("button", { name: "New document", exact: true }))
		.toBeDisabled();
	await sidebar(page).getByRole("button", { name: "Search", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Search documents" })).toBeFocused();
});

test("document rename failures preserve the draft and can be retried", async ({ join, room }) => {
	let page = await join("ana");
	let failed = true;
	await page.route("**/api/channels/*", async route => {
		if (route.request().method() === "PATCH" && failed) {
			failed = false;
			await route.fulfill({ status: 503, json: { error: "rename is unavailable" } });
			return;
		}
		await route.continue();
	});
	let title = `Retry rename ${room.slice(0, 8)}`;
	let trigger = headerRename(page);
	await trigger.click();
	let input = page.getByRole("textbox", { name: "Document title" });
	await input.fill(title);
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(input).toHaveValue(title);

	await page.getByRole("button", { name: "Save" }).click();
	await expect(headerDocument(page)).toHaveAccessibleName(`Document: ${title}`);
});

test("sidebar creation failures remain retryable", async ({ join, page }) => {
	let creationFailed = true;
	await page.route("**/api/repositories/octo-org/score/channels*", async route => {
		if (route.request().method() === "POST" && creationFailed) {
			creationFailed = false;
			await route.fulfill({ status: 503, json: { error: "creation is unavailable" } });
			return;
		}
		await route.continue();
	});

	page = await join("ana");
	let create = sidebar(page).getByRole("button", { name: "New document", exact: true });
	await create.click();
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(create).toBeEnabled();
	await create.click();
	await expect(page).toHaveURL(/\/documents\/octo-org\/score\/[a-z]+-[a-z]+$/);
});
