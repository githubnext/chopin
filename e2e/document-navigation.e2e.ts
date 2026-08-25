import { authenticate, content, expect, roomPath, test } from "./room";

function channel(id: string, title: string, description?: string) {
	return {
		createdAt: "2026-08-19T12:00:00.000Z",
		createdBy: "U_ana",
		id,
		repositoryId: "R_score",
		repositoryName: "score",
		repositoryOwner: "octo-org",
		revision: 0,
		descriptionRevision: description ? 1 : 0,
		...(description ? { description } : {}),
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

function headerActions(page: import("@playwright/test").Page) {
	return page.getByRole("banner").getByRole("button", { name: /^Actions for / });
}

async function headerAction(page: import("@playwright/test").Page, action: string) {
	await headerActions(page).click();
	await page.getByRole("menuitem", { name: action, exact: true }).click();
}

test("document action menu motion follows its pointer trigger and survives interruption", async ({ join }) => {
	let page = await join("ana");
	let trigger = headerActions(page);
	await trigger.click();
	let menu = page.getByRole("menu", { name: /^Actions for / });
	let retainedMenu = page.getByRole("menu", { includeHidden: true });
	await expect(menu).toBeVisible();

	let [triggerBox, menuLayout] = await Promise.all([
		trigger.boundingBox(),
		menu.evaluate(element => {
			let menu = element as HTMLElement;
			return {
				height: menu.offsetHeight,
				left: menu.offsetLeft,
				origin: getComputedStyle(element).transformOrigin,
				top: menu.offsetTop,
				width: menu.offsetWidth,
			};
		}),
	]);
	expect(triggerBox).not.toBeNull();
	let [originX, originY] = menuLayout.origin.split(" ").map(Number.parseFloat);
	let triggerX = triggerBox!.x + triggerBox!.width / 2;
	let triggerY = triggerBox!.y + triggerBox!.height / 2;
	expect(menuLayout.left + originX!).toBeCloseTo(
		Math.min(menuLayout.left + menuLayout.width, Math.max(menuLayout.left, triggerX)),
		0,
	);
	expect(menuLayout.top + originY!).toBeCloseTo(
		Math.min(menuLayout.top + menuLayout.height, Math.max(menuLayout.top, triggerY)),
		0,
	);

	await trigger.click();
	await expect(retainedMenu).toHaveAttribute("aria-hidden", "true");
	await expect(retainedMenu).toHaveAttribute("inert", "");
	await expect(trigger).toBeFocused();
	await trigger.click();
	await expect(retainedMenu).not.toHaveAttribute("aria-hidden", "true");
	await expect(retainedMenu).not.toHaveAttribute("inert", "");
	await expect(retainedMenu).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
});

test("document action menu motion settles keyboard opening immediately", async ({ join }) => {
	let page = await join("ana");
	let trigger = headerActions(page);
	await trigger.focus();
	await trigger.press("ArrowDown");
	let menu = page.getByRole("menu", { name: /^Actions for / });
	await expect(page.getByRole("menuitem", { name: "Rename", exact: true })).toBeFocused();
	await expect(menu).toHaveCSS("transition-duration", "0s");
	await page.keyboard.press("ArrowDown");
	await expect(page.getByRole("menuitem", { name: "Archive", exact: true })).toBeFocused();
});

test("the room header renames the current document and the sidebar creates one immediately", async ({ join }) => {
	let page = await join("ana");
	let header = page.getByRole("banner");
	let trigger = headerActions(page);
	let projects = sidebar(page);

	await expect(headerDocument(page)).toBeVisible();
	await expect(projects.locator('[aria-current="page"]')).toHaveCount(1);
	await expect(header.getByRole("button", { name: /planner session/i })).toHaveCount(0);
	await headerAction(page, "Rename");
	let title = page.getByRole("textbox", { name: "Document title" });
	await expect(title).toBeFocused();
	await title.press("Escape");
	await expect(trigger).toBeFocused();

	await projects.getByRole("button", { name: "New document", exact: true }).click();
	await expect(page).toHaveURL(/\/documents\/octo-org\/score\/[a-z]+-[a-z]+$/);
	await expect(headerDocument(page)).toHaveAccessibleName(/^Document: [a-z]+-[a-z]+$/);
});

test("a pointer-dismissed navigation dialog releases focus while it exits", async ({ join }) => {
	let page = await join("ana");
	let trigger = sidebar(page).getByRole("button", { name: "Search", exact: true });
	await trigger.click();
	await expect(page.getByRole("textbox", { name: "Search documents" })).toBeFocused();
	let modal = page.locator(".navigation-modal");
	await page.getByRole("button", { name: "Close Search documents" }).click({
		position: { x: 8, y: 8 },
	});

	await expect(modal).toHaveAttribute("aria-hidden", "true");
	await expect(modal).toHaveAttribute("inert", "");
	await expect(trigger).toBeFocused();
	await expect(modal).toHaveCount(0);
});

test("sidebar titles stay readable until hover reveals controls", async ({ join, page }) => {
	let title = "Complete the implementation";
	let listed = channel("cccccccc-0000-4000-8000-000000000000", title);
	await page.route(
		"**/api/repositories/octo-org/score/channels*",
		route => route.fulfill({ json: { canEdit: true, channels: [listed], repository } }),
	);

	page = await join("ana");
	let projects = sidebar(page);
	let link = projects.getByRole("link", { name: title, exact: true });
	let titleText = link.locator("span").last();
	let row = link.locator("..");
	let actions = projects.getByRole("button", { name: `Actions for ${title}` });
	let clipped = () => titleText.evaluate(element => element.scrollWidth > element.clientWidth);

	await expect(actions).toBeHidden();
	expect(await clipped()).toBe(false);

	await row.hover();
	await expect(actions).toBeVisible();
	expect(await clipped()).toBe(true);
	let [rowBox, actionsBox] = await Promise.all([row.boundingBox(), actions.boundingBox()]);
	expect(rowBox!.x + rowBox!.width - actionsBox!.x - actionsBox!.width).toBeLessThanOrEqual(8);
});

test("a stale catalogue response cannot remove a newly created document", async ({ join, page }) => {
	let captured = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let intercepted = false;
	await page.route("**/api/repositories/octo-org/score/channels*", async route => {
		if (intercepted || route.request().method() !== "GET") {
			await route.continue();
			return;
		}
		intercepted = true;
		let response = await route.fetch();
		captured.resolve();
		await release.promise;
		await route.fulfill({ response });
	});

	page = await join("ana");
	await captured.promise;
	let projects = sidebar(page);
	await projects.getByRole("button", { name: "New document", exact: true }).click();
	await expect(page).toHaveURL(/\/documents\/octo-org\/score\/[a-z]+-[a-z]+$/);
	let created = projects.locator('a[aria-current="page"]');
	await expect(created).toBeVisible();
	let createdTitle = (await created.textContent())!.trim();
	await expect(projects.getByText("Loading more…", { exact: true })).toBeVisible();

	release.resolve();
	await expect(projects.getByText("Loading more…", { exact: true })).toHaveCount(0);
	await expect(projects.getByRole("link", { name: createdTitle, exact: true }))
		.toHaveAttribute("aria-current", "page");
	await expect(projects.locator('a[aria-current="page"]')).toHaveCount(1);
});

test("document switches preserve navigation state and avoid catalogue reloads", async ({ join, page }) => {
	let requested: Array<{ method: string; path: string }> = [];
	page.on("request", request =>
		requested.push({
			method: request.method(),
			path: new URL(request.url()).pathname,
		}));
	page = await join("ana");
	let initialNavigationRequests =
		requested.filter(request => request.method === "GET" && request.path === "/api/navigation")
			.length;
	let projects = sidebar(page);
	let original = projects.locator('a[aria-current="page"]');
	let originalTitle = (await original.textContent())!.trim();
	let originalPath = await original.getAttribute("href");
	expect(originalPath).toBeTruthy();

	await projects.getByRole("button", { name: "New document", exact: true }).click();
	await expect(page).toHaveURL(/\/documents\/octo-org\/score\/[a-z]+-[a-z]+$/);
	let created = projects.locator('a[aria-current="page"]');
	let createdTitle = (await created.textContent())!.trim();
	await expect(projects.getByRole("link", { name: originalTitle, exact: true })).toBeVisible();
	expect(
		requested.filter(request => request.method === "GET" && request.path === "/api/navigation"),
	).toHaveLength(initialNavigationRequests);

	let release = Promise.withResolvers<void>();
	await page.route("**/api/repositories/octo-org/score/documents/*", async route => {
		await release.promise;
		await route.continue();
	});
	requested.length = 0;
	await page.evaluate(() => {
		(window as Window & { __chopinNavigationSentinel?: string }).__chopinNavigationSentinel =
			"preserved";
	});
	await projects.getByRole("link", { name: originalTitle, exact: true }).click();

	await expect(page.getByText("Opening channel...", { exact: true })).toBeVisible();
	await expect(projects.getByRole("link", { name: createdTitle, exact: true })).toBeVisible();
	expect(
		await page.evaluate(() =>
			(window as Window & { __chopinNavigationSentinel?: string }).__chopinNavigationSentinel
		),
	).toBe("preserved");
	release.resolve();
	await expect(headerDocument(page)).toHaveAccessibleName(`Document: ${originalTitle}`);
	await expect(page).toHaveURL(originalPath!);

	expect(requested.filter(request => request.path === "/api/session")).toHaveLength(0);
	expect(
		requested.filter(request => request.method === "GET" && request.path === "/api/navigation"),
	).toHaveLength(0);
	await expect.poll(() =>
		requested.filter(request => request.method === "PATCH" && request.path === "/api/navigation")
			.length
	).toBe(1);
	expect(requested.filter(request => request.path === "/api/repositories/octo-org/score/channels"))
		.toHaveLength(0);
	await expect.poll(() =>
		requested.filter(request =>
			request.path === "/api/repositories/octo-org/score/research-workspaces"
		).length
	).toBe(1);

	await page.evaluate(() => history.back());
	await expect(headerDocument(page)).toHaveAccessibleName(`Document: ${createdTitle}`);
	await page.evaluate(() => history.forward());
	await expect(headerDocument(page)).toHaveAccessibleName(`Document: ${originalTitle}`);
});

test("the archive view refreshes catalogues without reopening the document", async ({ join, page }) => {
	let sockets = 0;
	await page.routeWebSocket("**/ws?**", route => {
		sockets++;
		route.connectToServer();
	});
	page = await join("ana");
	let initialSockets = sockets;
	let path = page.url();
	let catalogue = (endpoint: string, includeArchived: boolean) =>
		page.waitForResponse(response => {
			let url = new URL(response.url());
			return response.request().method() === "GET"
				&& url.pathname === `/api/repositories/octo-org/score/${endpoint}`
				&& (url.searchParams.get("includeArchived") === "true") === includeArchived;
		});
	let projects = sidebar(page);

	let archived = Promise.all([
		catalogue("channels", true),
		catalogue("research-workspaces", true),
	]);
	await projects.getByRole("button", { name: "Archived chats", exact: true }).click();
	await archived;
	expect(page.url()).toBe(path);
	expect(sockets).toBe(initialSockets);

	let active = Promise.all([
		catalogue("channels", false),
		catalogue("research-workspaces", false),
	]);
	await projects.getByRole("button", { name: "Back to active docs", exact: true }).click();
	await active;
	expect(page.url()).toBe(path);
	expect(sockets).toBe(initialSockets);
});

test("the sidebar paginates documents and global search queries beyond the loaded page", async ({ join, page }) => {
	let requests: URL[] = [];
	let first = Array.from(
		{ length: 2 },
		(_, index) =>
			channel(
				`${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
				`Note ${index + 1}`,
				index === 0 ? "Plan for note taking" : undefined,
			),
	);
	let searched = channel(
		"aaaaaaaa-0000-4000-8000-000000000000",
		"Search needle",
		"RFC about catalogue search",
	);
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
	await expect(projects.getByText("Plan for note taking", { exact: true })).toBeVisible();
	await projects.getByRole("button", { name: "Load more documents in score" }).click();
	await expect(projects.getByRole("link", { name: "Continued document", exact: true }))
		.toBeVisible();
	await projects.getByRole("button", { name: "Search", exact: true }).click();
	let dialog = page.getByRole("dialog", { name: "Search documents" });
	let search = dialog.getByRole("textbox", { name: "Search documents" });
	await expect(search).toBeFocused();
	await search.fill("needle");
	await expect(dialog.getByRole("button", { name: /Search needle/ })).toBeVisible();
	await expect(dialog.getByText("RFC about catalogue search", { exact: true })).toBeVisible();
	expect(requests.some(url => url.searchParams.get("query") === "needle")).toBe(true);
});

test("renaming the current document updates collaborators and survives reload", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	let title = `Launch plan ${room.slice(0, 8)}`;
	let previousPath = roomPath(room);
	let renamedPath = `/documents/octo-org/score/${title.toLowerCase().replaceAll(" ", "-")}`;

	await ana.setViewportSize({ width: 320, height: 568 });
	await headerAction(ana, "Rename");
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

	await headerAction(ana, "Rename");
	await ana.getByRole("textbox", { name: "Document title" }).fill(first);
	await ana.getByRole("button", { name: "Save" }).click();
	await expect(headerDocument(bo)).toHaveAccessibleName(`Document: ${first}`);

	await headerAction(bo, "Rename");
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
	await expect(headerActions(page)).toHaveCount(0);
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
	await headerAction(page, "Rename");
	let input = page.getByRole("textbox", { name: "Document title" });
	await input.fill(title);
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(input).toHaveValue(title);

	await page.getByRole("button", { name: "Save" }).click();
	await expect(headerDocument(page)).toHaveAccessibleName(`Document: ${title}`);
});

test("writers can archive, restore, and permanently delete a document", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	let title = `Test ${room.slice(0, 8)}`;
	let path = roomPath(room);
	let projects = sidebar(ana);

	await headerAction(ana, "Archive");
	await expect(ana.getByText("Archived, read-only", { exact: true })).toBeVisible();
	await expect(bo.getByText("Archived, read-only", { exact: true })).toBeVisible();
	await expect(content(ana)).toHaveAttribute("contenteditable", "false");
	await expect(content(bo)).toHaveAttribute("contenteditable", "false");
	await expect(projects.getByRole("link", { name: title, exact: true })).toHaveCount(0);

	await bo.reload();
	await expect(bo).toHaveURL(path);
	await expect(content(bo)).toHaveAttribute("contenteditable", "false");

	await projects.getByRole("button", { name: "Archived chats", exact: true }).click();
	let back = projects.getByRole("button", { name: "Back to active docs", exact: true });
	await expect(back).toBeFocused();
	await expect(projects.getByRole("link", { name: title, exact: true })).toBeVisible();
	await back.click();
	let archivedChats = projects.getByRole("button", { name: "Archived chats", exact: true });
	await expect(archivedChats).toBeFocused();
	await archivedChats.click();

	await headerAction(ana, "Restore");
	await expect(content(ana)).toHaveAttribute("contenteditable", "true");
	await expect(content(bo)).toHaveAttribute("contenteditable", "true");
	await expect(ana.getByText("Archived, read-only", { exact: true })).toHaveCount(0);
	await expect(projects.getByRole("button", { name: "Archived chats", exact: true })).toBeVisible();
	await expect(projects.getByRole("link", { name: title, exact: true })).toBeVisible();

	await headerAction(ana, "Archive");
	await expect(content(ana)).toHaveAttribute("contenteditable", "false");
	await headerAction(ana, "Delete permanently");
	let confirmation = ana.getByRole("dialog", { name: "Delete document permanently?" });
	await confirmation.getByRole("button", { name: "Delete permanently", exact: true }).click();
	await expect(ana).not.toHaveURL(path);
	await expect(bo).not.toHaveURL(path);
	let unavailable = await ana.request.get(`/api/channels/${room}`);
	expect(unavailable.status()).toBe(404);
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
