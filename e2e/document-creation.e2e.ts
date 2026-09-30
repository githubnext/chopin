import { authenticate, expect, test } from "./room";
import { createChannel } from "./database";

import type { Page } from "@playwright/test";
import type { ChannelDetail } from "../apps/web/src/api";

function sidebar(page: Page) {
	return page.getByRole("complementary", { name: "Projects", exact: true });
}

function createButton(page: Page) {
	return sidebar(page).getByRole("button", { name: "New document", exact: true });
}

function creationRequests(page: Page) {
	let requests: string[] = [];
	page.on("request", request => {
		let path = new URL(request.url()).pathname;
		if (request.method() === "POST" && /^\/api\/repositories\/[^/]+\/[^/]+\/channels$/.test(path)) {
			requests.push(path);
		}
	});
	return requests;
}

async function emptyCatalogues(page: Page) {
	// Other tests share these repositories; retain real authorization but start with empty lists.
	await page.route("**/api/navigation", async route => {
		if (route.request().method() !== "GET") return route.fallback();
		let response = await route.fetch();
		let navigation = await response.json();
		delete navigation.lastDocumentId;
		await route.fulfill({ response, json: navigation });
	});
	await page.route("**/api/repositories/*/*/channels*", async route => {
		if (route.request().method() !== "GET") return route.fallback();
		let response = await route.fetch();
		await route.fulfill({
			response,
			json: { ...await response.json(), channels: [], nextCursor: undefined },
		});
	});
}

async function start(page: Page, baseURL: string, names = ["score"]) {
	await emptyCatalogues(page);
	await authenticate(page, `document-creator-${crypto.randomUUID()}`, baseURL);
	for (let repository of names) {
		let response = await page.request.post("/api/navigation/projects", {
			data: { owner: repository === "notes" ? "octocat" : "octo-org", repository },
			headers: { origin: baseURL },
		});
		expect(response.status()).toBe(201);
	}
	await page.goto("/");
}

for (let action of ["global", "pencil", "empty"] as const) {
	test(`first document creation through the ${action} action after adding a project`, async ({ baseURL, page }) => {
		if (action === "empty") await page.setViewportSize({ width: 390, height: 844 });
		await emptyCatalogues(page);
		await authenticate(page, `document-creator-${crypto.randomUUID()}`, baseURL!);
		let posts = creationRequests(page);
		await page.goto("/");
		let add = page.getByRole("dialog", { name: "Add Project", exact: true });
		await add.getByRole("button", { name: "score octo-org Add", exact: true }).click();
		let projects = sidebar(page);
		await expect(projects.getByText("No documents yet.", { exact: true })).toBeVisible();
		let pencil = projects.getByRole("button", { name: "New document in score", exact: true });
		await expect(pencil).toHaveAttribute("title", "New document in score");
		let trigger = action === "global"
			? createButton(page)
			: action === "pencil"
			? pencil
			: projects.getByRole("button", { name: "Create document", exact: true });
		await trigger.click();
		await expect(page).toHaveURL(/\/documents\/octo-org\/score\/[a-z]+-[a-z]+$/);
		await expect(page.getByRole("textbox", { name: "editable markdown" })).toHaveAttribute(
			"contenteditable",
			"true",
		);
		expect(posts).toEqual(["/api/repositories/octo-org/score/channels"]);
	});
}

test("first-document creation stays guarded through both POST and opening", async ({ baseURL, page }) => {
	await start(page, baseURL!);
	await expect(sidebar(page).getByText("No documents yet.")).toBeVisible();
	let posted = Promise.withResolvers<void>();
	let releasePost = Promise.withResolvers<void>();
	let opening = Promise.withResolvers<void>();
	let releaseOpen = Promise.withResolvers<void>();
	let posts = creationRequests(page);
	await page.route("**/api/repositories/octo-org/score/channels", async route => {
		if (route.request().method() !== "POST") return route.fallback();
		let response = await route.fetch();
		posted.resolve();
		await releasePost.promise;
		await route.fulfill({ response });
	});
	await page.route("**/api/repositories/octo-org/score/documents/*", async route => {
		opening.resolve();
		await releaseOpen.promise;
		await route.continue();
	});
	let global = createButton(page);
	let pencil = sidebar(page).getByRole("button", { name: "New document in score", exact: true });
	// Two synchronous activations also exercise the guard before React disables the DOM button.
	await global.evaluate(button => {
		(button as HTMLButtonElement).click();
		(button as HTMLButtonElement).click();
	});
	await posted.promise;
	await expect(global).toBeDisabled();
	await expect(pencil).toBeDisabled();
	await expect(sidebar(page).getByRole("button", { name: "Create document", exact: true }))
		.toBeDisabled();
	await expect(sidebar(page).getByRole("status").filter({ hasText: "Creating document…" }))
		.toBeVisible();

	releasePost.resolve();
	await opening.promise;
	await expect(global).toBeDisabled();
	await expect(pencil).toBeDisabled();
	await expect(sidebar(page).getByRole("status").filter({ hasText: "Opening document…" }))
		.toBeVisible();
	await pencil.evaluate(button => (button as HTMLButtonElement).click());
	await page.mouse.move(900, 500);
	await expect(sidebar(page).getByRole("status").filter({ hasText: "Opening document…" }))
		.toBeVisible();
	expect(posts).toHaveLength(1);

	releaseOpen.resolve();
	await expect(page.getByRole("textbox", { name: "editable markdown" })).toHaveAttribute(
		"contenteditable",
		"true",
	);
	await expect(global).toBeEnabled();
	await expect(pencil).toBeEnabled();
	expect(posts).toHaveLength(1);
});

test("the project chooser supports keyboard selection and retry in the chosen project", async ({ baseURL, page }) => {
	await start(page, baseURL!, ["score", "archive-1", "notes"]);
	let posts = creationRequests(page);
	let fail = true;
	await page.route("**/api/repositories/octo-org/archive-1/channels", async route => {
		if (route.request().method() !== "POST") return route.fallback();
		if (fail) {
			fail = false;
			return route.fulfill({ status: 503, json: { error: "Creation temporarily unavailable" } });
		}
		await route.continue();
	});
	let global = createButton(page);
	await global.focus();
	await global.press("Enter");
	let dialog = page.getByRole("dialog", { name: "New document", exact: true });
	let search = dialog.getByRole("textbox", { name: "Search projects", exact: true });
	await expect(search).toBeFocused();
	await expect(dialog.getByRole("button", { name: "score octo-org Create document", exact: true }))
		.toBeVisible();
	await expect(dialog.getByRole("button", { name: /notes/ })).toHaveCount(0);
	await page.keyboard.press("Escape");
	await expect(global).toBeFocused();
	await global.press("Enter");
	await search.fill("archive-1");
	await expect(dialog.getByRole("button", { name: "score octo-org Create document", exact: true }))
		.toHaveCount(0);
	await search.press("Tab");
	let option = dialog.getByRole("button", {
		name: "archive-1 octo-org Create document",
		exact: true,
	});
	await expect(option).toBeFocused();
	await option.press("Enter");
	await expect(dialog.getByRole("alert")).toHaveText(/Creation temporarily unavailable/);
	await dialog.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(page).toHaveURL(/\/documents\/octo-org\/archive-1\/[a-z]+-[a-z]+$/);
	await expect(page.getByRole("textbox", { name: "editable markdown" })).toHaveAttribute(
		"contenteditable",
		"true",
	);
	expect(posts).toEqual(Array(2).fill("/api/repositories/octo-org/archive-1/channels"));
	await createButton(page).click();
	await expect.poll(() => posts.length).toBe(3);
	expect(posts[2]).toBe("/api/repositories/octo-org/archive-1/channels");
	await expect(dialog).toHaveCount(0);
});

test("compact creation restores focus on dismissal and shows progress after the drawer closes", async ({ baseURL, page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await start(page, baseURL!, ["score", "archive-1"]);
	let opener = page.getByRole("button", { name: "Open Projects sidebar", exact: true });
	await opener.click();
	await createButton(page).click();
	let dialog = page.getByRole("dialog", { name: "New document", exact: true });
	await expect(dialog.getByRole("textbox", { name: "Search projects" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(opener).toBeFocused();
	await opener.click();
	await createButton(page).click();
	let opening = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	await page.route("**/api/repositories/octo-org/score/documents/*", async route => {
		opening.resolve();
		await release.promise;
		await route.continue();
	});
	await dialog.getByRole("button", { name: "score octo-org Create document", exact: true }).click();
	await opening.promise;
	await expect(page.getByRole("status").filter({ hasText: "Opening document… score" }))
		.toBeVisible();
	release.resolve();
	await expect(page.getByRole("textbox", { name: "editable markdown" })).toHaveAttribute(
		"contenteditable",
		"true",
	);
	await expect(page.getByRole("status").filter({ hasText: "Opening document… score" })).toHaveCount(
		0,
	);
});

test("a failed opening retries the created document without another POST", async ({ join }) => {
	let page = await join("ana");
	let posts = creationRequests(page);
	let fail = true;
	await page.route("**/api/repositories/octo-org/score/documents/*", async route => {
		if (fail) {
			fail = false;
			return route.fulfill({ status: 503, json: { error: "Opening temporarily unavailable" } });
		}
		await route.continue();
	});
	await createButton(page).click();
	await expect(page.getByRole("heading", { name: "Cannot open Chopin", exact: true }))
		.toBeVisible();
	await expect(createButton(page)).toBeEnabled();
	let path = page.url();
	await page.getByRole("button", { name: "Try again", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "editable markdown" })).toHaveAttribute(
		"contenteditable",
		"true",
	);
	expect(page.url()).toBe(path);
	expect(posts).toHaveLength(1);
});

test("overlapping creations keep separate guards and open the latest requested project", async ({ baseURL, page }) => {
	await start(page, baseURL!, ["score", "archive-1"]);
	let firstPosted = Promise.withResolvers<ChannelDetail>();
	let secondPosted = Promise.withResolvers<ChannelDetail>();
	let releaseFirst = Promise.withResolvers<void>();
	let releaseSecond = Promise.withResolvers<void>();
	let posts = creationRequests(page);
	await page.route("**/api/repositories/octo-org/*/channels", async route => {
		if (route.request().method() !== "POST") return route.fallback();
		let response = await route.fetch();
		let first = new URL(route.request().url()).pathname.includes("/score/");
		(first ? firstPosted : secondPosted).resolve(await response.json());
		await (first ? releaseFirst : releaseSecond).promise;
		await route.fulfill({ response });
	});
	let first = sidebar(page).getByRole("button", { name: "New document in score", exact: true });
	let second = sidebar(page).getByRole("button", {
		name: "New document in archive-1",
		exact: true,
	});
	await first.click();
	let firstDocument = await firstPosted.promise;
	await second.click();
	let secondDocument = await secondPosted.promise;
	await expect(first).toBeDisabled();
	await expect(second).toBeDisabled();
	releaseFirst.resolve();
	await expect(sidebar(page).getByRole("link", { name: firstDocument.channel.title, exact: true }))
		.toBeVisible();
	await expect(first).toBeEnabled();
	await expect(second).toBeDisabled();
	releaseSecond.resolve();
	await expect(page).toHaveURL(`/documents/octo-org/archive-1/${secondDocument.channel.slug}`);
	await expect(page.getByRole("banner").locator('[aria-label^="Document:"]'))
		.toHaveAccessibleName(`Document: ${secondDocument.channel.title}`);
	await expect(second).toBeEnabled();
	expect(posts).toEqual([
		"/api/repositories/octo-org/score/channels",
		"/api/repositories/octo-org/archive-1/channels",
	]);
});

test("global creation without projects explains the next step", async ({ baseURL, page }) => {
	await authenticate(page, `document-creator-${crypto.randomUUID()}`, baseURL!);
	let posts = creationRequests(page);
	await page.goto("/");
	await expect(page.getByRole("dialog", { name: "Add Project", exact: true })).toBeVisible();
	await page.keyboard.press("Escape");
	await createButton(page).click();
	let dialog = page.getByRole("dialog", { name: "New document", exact: true });
	await expect(dialog.getByText("Add a project to create your first document.")).toBeVisible();
	await dialog.getByRole("button", { name: "Add Project", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Add Project", exact: true })).toBeVisible();
	expect(posts).toHaveLength(0);
});

test("a rejected creation refreshes project permissions and offers access guidance", async ({ baseURL, page }) => {
	await start(page, baseURL!);
	await expect(sidebar(page).getByText("No documents yet.")).toBeVisible();
	let posts = creationRequests(page);
	await page.route("**/api/navigation", async route => {
		if (route.request().method() !== "GET") return route.fallback();
		let response = await route.fetch();
		let navigation = await response.json();
		delete navigation.lastDocumentId;
		for (let project of navigation.projects) {
			project.repository.permissions.push = false;
			project.repository.permissions.admin = false;
		}
		await route.fulfill({ response, json: navigation });
	});
	await page.route("**/api/repositories/octo-org/score/channels", async route => {
		if (route.request().method() !== "POST") return route.fallback();
		await route.fulfill({ status: 403, json: { error: "repository write access is required" } });
	});
	await createButton(page).click();
	await expect(page.getByRole("alert")).toHaveText("repository write access is required");
	await expect(sidebar(page).getByRole("button", { name: "New document in score", exact: true }))
		.toHaveCount(0);
	await createButton(page).click();
	let dialog = page.getByRole("dialog", { name: "New document", exact: true });
	await expect(
		dialog.getByText("You need write access to an available project to create a document."),
	).toBeVisible();
	await expect(dialog.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
	expect(posts).toHaveLength(1);
});

test("leaving a pending opening releases its guard without letting stale readiness clear a new one", async ({ join }) => {
	let page = await join("ana");
	let originalTitle = (await sidebar(page).locator('a[aria-current="page"]').textContent())!.trim();
	let firstOpening = Promise.withResolvers<void>();
	let secondOpening = Promise.withResolvers<void>();
	let releaseFirst = Promise.withResolvers<void>();
	let releaseSecond = Promise.withResolvers<void>();
	let firstReleased = Promise.withResolvers<void>();
	let reads = 0;
	await page.route("**/api/repositories/octo-org/score/documents/*", async route => {
		let first = ++reads === 1;
		let response = await route.fetch();
		(first ? firstOpening : secondOpening).resolve();
		await (first ? releaseFirst : releaseSecond).promise;
		await route.fulfill({ response });
		if (first) firstReleased.resolve();
	});
	await createButton(page).click();
	await firstOpening.promise;
	await expect(createButton(page)).toBeDisabled();
	await sidebar(page).getByRole("link", { name: originalTitle, exact: true }).click();
	await expect(createButton(page)).toBeEnabled();
	await createButton(page).click();
	await secondOpening.promise;
	releaseFirst.resolve();
	await firstReleased.promise;
	await expect(createButton(page)).toBeDisabled();
	await expect(sidebar(page).getByRole("status").filter({ hasText: "Opening document…" }))
		.toBeVisible();
	releaseSecond.resolve();
	await expect(createButton(page)).toBeEnabled();
	await expect(page.getByRole("banner").locator('[aria-label^="Document:"]'))
		.not.toHaveAccessibleName(`Document: ${originalTitle}`);
});

for (let returnToOrigin of [false, true]) {
	test(`a late creation does not take over newer navigation${returnToOrigin ? " back to its origin" : ""}`, async ({ baseURL, join }) => {
		let destination = crypto.randomUUID();
		await createChannel(Number(new URL(baseURL!).port), destination);
		let page = await join("ana");
		let original = sidebar(page).locator('a[aria-current="page"]');
		let originalTitle = (await original.textContent())!.trim();
		let posted = Promise.withResolvers<ChannelDetail>();
		let release = Promise.withResolvers<void>();
		await page.route("**/api/repositories/octo-org/score/channels", async route => {
			if (route.request().method() !== "POST") return route.fallback();
			let response = await route.fetch();
			posted.resolve(await response.json());
			await release.promise;
			await route.fulfill({ response });
		});
		await createButton(page).click();
		let created = await posted.promise;
		let target = `Test ${destination.slice(0, 8)}`;
		await sidebar(page).getByRole("link", { name: target, exact: true }).click();
		await expect(page.getByRole("banner").locator('[aria-label^="Document:"]'))
			.toHaveAccessibleName(`Document: ${target}`);
		if (returnToOrigin) {
			await sidebar(page).getByRole("link", { name: originalTitle, exact: true }).click();
			await expect(page.getByRole("banner").locator('[aria-label^="Document:"]'))
				.toHaveAccessibleName(`Document: ${originalTitle}`);
		}
		let path = page.url();
		release.resolve();
		await expect(sidebar(page).getByRole("link", { name: created.channel.title, exact: true }))
			.toBeVisible();
		await expect(createButton(page)).toBeEnabled();
		expect(page.url()).toBe(path);
		await expect(sidebar(page).getByRole("link", { name: created.channel.title, exact: true })).not
			.toHaveAttribute("aria-current", "page");
	});
}
