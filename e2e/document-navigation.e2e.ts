import { authenticate, expect, test } from "./room";

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

test("renaming the current document updates collaborators and survives reload", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	let title = `Launch plan ${room.slice(0, 8)}`;
	let anaTrigger = ana.getByRole("banner").getByRole("button", { name: /^Document:/ });
	let boTrigger = bo.getByRole("banner").getByRole("button", { name: /^Document:/ });

	await ana.setViewportSize({ width: 320, height: 568 });
	await anaTrigger.click();
	await ana.getByRole("button", { name: "Rename document" }).click();
	let input = ana.getByRole("textbox", { name: "Document title" });
	await expect(input).toBeFocused();
	await input.fill(title);
	await ana.getByRole("button", { name: "Save" }).click();

	await expect(anaTrigger).toHaveAccessibleName(`Document: ${title}`);
	await expect(boTrigger).toHaveAccessibleName(`Document: ${title}`);
	await ana.reload();
	await expect(ana.getByRole("banner").getByRole("button", { name: `Document: ${title}` }))
		.toBeVisible();
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
	let anaTrigger = ana.getByRole("banner").getByRole("button", { name: /^Document:/ });
	let boTrigger = bo.getByRole("banner").getByRole("button", { name: /^Document:/ });

	await anaTrigger.click();
	await ana.getByRole("button", { name: "Rename document" }).click();
	await ana.getByRole("textbox", { name: "Document title" }).fill(first);
	await ana.getByRole("button", { name: "Save" }).click();
	await expect(boTrigger).toHaveAccessibleName(`Document: ${first}`);

	await boTrigger.click();
	await bo.getByRole("button", { name: "Rename document" }).click();
	await bo.getByRole("textbox", { name: "Document title" }).fill(latest);
	await bo.getByRole("button", { name: "Save" }).click();
	await expect(anaTrigger).toHaveAccessibleName(`Document: ${latest}`);

	release.resolve();
	await expect(ana.getByRole("button", { name: "Rename document" })).toBeVisible();
	await expect(anaTrigger).toHaveAccessibleName(`Document: ${latest}`);
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
	await expect(page.getByRole("button", { name: "Rename document" })).toHaveCount(0);
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
	let trigger = page.getByRole("banner").getByRole("button", { name: /^Document:/ });
	await trigger.click();
	await page.getByRole("button", { name: "Rename document" }).click();
	let input = page.getByRole("textbox", { name: "Document title" });
	await input.fill(title);
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByRole("alert")).toHaveText("rename is unavailable");
	await expect(input).toHaveValue(title);

	await page.getByRole("button", { name: "Save" }).click();
	await expect(trigger).toHaveAccessibleName(`Document: ${title}`);
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
