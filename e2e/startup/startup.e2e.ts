import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";

let feedbackModule = /\/agentation(?:\.js|\/dist\/index\.js)(?:\?|$)/;

async function localLogin(page: Page) {
	let sessions = 0;
	await page.route("**/api/session", route => {
		sessions++;
		return route.fulfill({ json: { user: null, agent: false, auth: "local" } });
	});
	await page.route("**/auth/device", route =>
		route.fulfill({
			json: route.request().method() === "POST"
				? {
					status: "waiting",
					userCode: "START-UP",
					verificationUri: "https://github.com/login/device",
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				}
				: { status: "cancelled" },
		}));
	return () => sessions;
}

test("slow developer feedback permits sign-in and preserves its state when it arrives", async ({ page }) => {
	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	let requested = false;
	await page.route(feedbackModule, async route => {
		requested = true;
		await gate;
		await route.continue();
	});
	let sessions = await localLogin(page);
	await page.goto("/", { waitUntil: "commit" });
	try {
		await expect.poll(() => requested, { timeout: 25_000 }).toBe(true);
		await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click({
			timeout: 10_000,
		});
		await expect(page.getByText("START-UP", { exact: true })).toBeVisible();
		let before = sessions();
		let code = await page.getByText("START-UP", { exact: true }).elementHandle();
		release();
		await expect(page.getByRole("button", { name: "Start feedback mode", exact: true }))
			.toBeVisible();
		await expect(page.getByText("START-UP", { exact: true })).toBeVisible();
		expect(await code!.evaluate(element => element.isConnected)).toBe(true);
		expect(sessions()).toBe(before);
	} finally {
		release();
	}
});

test("failed developer feedback leaves sign-in usable", async ({ page }) => {
	await page.route(feedbackModule, route => route.abort("failed"));
	await localLogin(page);
	await page.goto("/", { waitUntil: "domcontentloaded" });
	await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).click();
	await expect(page.getByText("START-UP", { exact: true })).toBeVisible();
});

test("navigation without an open document does not load the collaborative editor", async ({ page }) => {
	let editorRequests: string[] = [];
	page.on("request", request => {
		let path = new URL(request.url()).pathname;
		if (
			/\/packages\/(?:dialect\/src|editor\/src\/(?:index|plan-editor|collaboration|widgets))/.test(
				path,
			)
		) {
			editorRequests.push(path);
		}
	});
	await page.route("**/api/session", route =>
		route.fulfill({
			json: {
				user: { id: "startup", login: "startup", avatarUrl: "" },
				agent: false,
			},
		}));
	await page.route("**/api/navigation", route => route.fulfill({ json: { projects: [] } }));
	await page.goto("/", { waitUntil: "networkidle" });
	await expect(page.getByRole("heading", { name: "No document open", exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
	expect(editorRequests).toEqual([]);
});

test("document code loads while metadata waits and cannot reopen a route left behind", async ({ page }) => {
	let release!: () => void;
	let gate = new Promise<void>(resolve => release = resolve);
	let metadataRequested = false;
	let metadataReleased = false;
	let workspaceRequested = false;
	let channelSocket = false;
	let repository = {
		id: "startup-repository",
		owner: "startup",
		name: "repo",
		fullName: "startup/repo",
		permissions: { pull: true, push: true, admin: true },
	};
	let channel = {
		id: "00000000-0000-0000-0000-000000000001",
		repositoryId: repository.id,
		repositoryOwner: repository.owner,
		repositoryName: repository.name,
		title: "Waiting document",
		slug: "waiting",
		descriptionRevision: 0,
	};
	page.on("request", request => {
		if (new URL(request.url()).pathname === "/src/room-workspace.tsx") {
			workspaceRequested = true;
		}
	});
	page.on("websocket", socket => {
		if (new URL(socket.url()).searchParams.has("channel")) channelSocket = true;
	});
	await page.route("**/api/session", route =>
		route.fulfill({
			json: { user: { id: "startup", login: "startup", avatarUrl: "" }, agent: false },
		}));
	await page.route("**/api/navigation", route =>
		route.fulfill({
			json: {
				projects: [{
					repositoryId: repository.id,
					repositoryOwner: repository.owner,
					repositoryName: repository.name,
					position: 0,
					available: true,
					repository,
				}],
			},
		}));
	await page.route(
		"**/api/repositories/startup/repo/channels",
		route => route.fulfill({ json: { repository, canEdit: true, channels: [channel] } }),
	);
	await page.route("**/api/repositories/startup/repo/documents/waiting", async route => {
		metadataRequested = true;
		await gate;
		await route.fulfill({ json: { repository, channel, canEdit: true, canManage: true } });
		metadataReleased = true;
	});
	await page.routeWebSocket("**/ws/sidebar", () => {});
	await page.goto("/documents/startup/repo", { waitUntil: "domcontentloaded" });
	await expect(page.getByRole("heading", { name: "No document open", exact: true })).toBeVisible();
	await page.getByRole("link", { name: "Waiting document", exact: true }).click();
	try {
		await expect.poll(() => metadataRequested).toBe(true);
		await expect.poll(() => workspaceRequested).toBe(true);
		expect(metadataReleased).toBe(false);
		await page.goBack();
		await expect(page.getByRole("heading", { name: "No document open", exact: true }))
			.toBeVisible();
		release();
		await expect.poll(() => metadataReleased).toBe(true);
		await expect(page).toHaveURL(/\/documents\/startup\/repo$/);
		expect(channelSocket).toBe(false);
	} finally {
		release();
	}
});
