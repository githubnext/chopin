import { authenticate, expect, roomPath, test } from "./room";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { installVisualViewport } from "./visual-viewport";

const score = {
	id: "R_score",
	owner: "octo-org",
	name: "score",
	fullName: "octo-org/score",
	private: true,
	url: "https://github.com/octo-org/score",
	defaultBranch: "main",
	permissions: { pull: true, push: true, admin: false },
};

const recoveryChannel = {
	createdAt: "2026-08-14T12:00:00.000Z",
	createdBy: "U_octocat",
	id: "11111111-1111-4111-8111-111111111111",
	repositoryId: score.id,
	repositoryName: score.name,
	repositoryOwner: score.owner,
	revision: 1,
	slug: "release-readiness",
	title: "Release readiness",
	updatedAt: "2026-08-14T12:00:00.000Z",
};

async function showKnownChannel(page: Parameters<typeof authenticate>[0]) {
	await page.route("**/api/repositories/octo-org/score/channels*", route =>
		route.fulfill({
			json: {
				canEdit: true,
				channels: [recoveryChannel],
				repository: score,
			},
		}));
	await page.goto("/documents/octo-org/score");
	await page.getByRole("link", { name: recoveryChannel.title }).click();
}

test("organization admission rejects outsiders and pending members", async ({ baseURL }) => {
	for (let handle of ["outsider", "pending"]) {
		let started = await fetch(`${baseURL}/auth/github`, { redirect: "manual" });
		let authorization = new URL(started.headers.get("location")!);
		let state = authorization.searchParams.get("state");
		let stateCookie = (started.headers as Headers & { getSetCookie(): string[] })
			.getSetCookie()[0]!.split(";", 1)[0]!;
		let callback = await fetch(
			`${baseURL}/auth/github/callback?code=e2e-${handle}&state=${state}`,
			{ headers: { cookie: stateCookie }, redirect: "manual" },
		);

		expect(callback.status).toBe(403);
		expect(await callback.json()).toEqual({
			error: "GitHub account is not allowed to use this Chopin instance",
		});
		expect(
			(callback.headers as Headers & { getSetCookie(): string[] }).getSetCookie()
				.some(value => value.startsWith("chopin_session=")),
		).toBe(false);
	}
});

test("an authenticated repository creates a channel workspace", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	await page.goto("/");

	let search = page.getByRole("combobox", { name: "Search repositories" });
	await expect(search).toBeFocused();
	await page.getByRole("option", { name: /octo-org\/score/ }).click();
	await expect(page.getByRole("heading", { name: "Planning channels" })).toBeVisible();
	let channelTitle = page.getByLabel("Channel title");
	expect((await channelTitle.boundingBox())!.height).toBeLessThan(44);
	let title = `Release readiness ${crypto.randomUUID()}`;
	await channelTitle.fill(title);
	await page.getByRole("button", { name: "New channel" }).click();

	await expect(page).toHaveURL(
		`/documents/octo-org/score/${title.toLowerCase().replaceAll(" ", "-")}`,
	);
	await expect(page.locator("#pane-chat")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "editable markdown" })).toBeVisible();
	await expect(page.locator(".plan-decisions")).toBeAttached();
	await expect(page.getByRole("button", { name: /octo-org\/score/ })).toBeVisible();
	await expect(page.getByText(title, { exact: true })).toBeVisible();

	await page.setViewportSize({ width: 320, height: 480 });
	let workspacePicker = page.getByRole("button", { name: /octo-org\/score/ });
	let pickerBounds = await workspacePicker.boundingBox();
	expect(pickerBounds).toBeTruthy();
	expect(pickerBounds!.width).toBeGreaterThan(80);
	await expect(page.getByText(title, { exact: true })).toBeVisible();
	await workspacePicker.click();
	await expect(search).toBeFocused();
	await search.fill("notes");
	await expect(page.getByRole("option", { name: /octocat\/notes/ })).toBeVisible();
	await search.press("Enter");
	await expect(page).toHaveURL("/documents/octocat/notes");
	await expect(page.getByRole("heading", { name: "Planning channels" })).toBeVisible();
	await expect(page.getByRole("button", { name: /octocat\/notes/ })).toBeVisible();
	await expect(page.getByRole("button", { name: "New channel" })).toHaveCount(0);
});

test("a signed-out document link returns to the document after OAuth", async ({ baseURL, page, room }) => {
	let path = roomPath(room);
	await page.goto(path);
	await expect(page).toHaveURL(path);
	let login = page.getByRole("link", { name: "Continue with GitHub" });
	let href = await login.getAttribute("href");
	let returnTo = new URL(href!, baseURL).searchParams.get("return_to");
	expect(returnTo).toBe(path);

	let destination = await authenticate(page, "octocat", baseURL!, returnTo!);
	expect(destination).toBe(path);
	await page.goto(destination);
	await expect(page).toHaveURL(path);
	await expect(page.getByRole("banner")).toBeVisible();
});

test("an editor renames a channel from the repository list", async ({ join, room }) => {
	let page = await join("ana");
	let before = `Test ${room.slice(0, 8)}`;
	let after = `Repository rename ${room.slice(0, 8)}`;
	await page.goto("/documents/octo-org/score");
	await expect(page.getByRole("heading", { name: "Planning channels" })).toBeVisible();

	await page.setViewportSize({ width: 320, height: 568 });
	await page.getByRole("button", { name: `Rename ${before}` }).click();
	let input = page.getByRole("textbox", { name: "Document title" });
	await expect(input).toHaveValue(before);
	await expectNoHorizontalOverflow(page);
	await input.fill(after);
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByText(after, { exact: true })).toBeVisible();
	await expect(page.getByText(before, { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: `Rename ${after}` })).toBeFocused();

	await page.reload();
	await expect(page.getByText(after, { exact: true })).toBeVisible();
});

test("a legacy repository path adopts the resolved repository casing", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	await page.route(
		"**/api/repositories/OCTO-ORG/SCORE/channels*",
		route => route.fulfill({ json: { canEdit: true, channels: [], repository: score } }),
	);
	await page.goto("/repositories/OCTO-ORG/SCORE?view=list#documents");

	await expect(page).toHaveURL("/documents/octo-org/score?view=list#documents");
	await expect(page.getByText("No planning channels yet")).toBeVisible();
});

test("a known deleted channel keeps its context and routes back without retry", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	await page.route(
		"**/api/repositories/octo-org/score/documents/release-readiness",
		route => route.fulfill({ status: 404, json: { error: "channel not found" } }),
	);
	await showKnownChannel(page);

	await expect(page.getByRole("heading", { name: "Cannot open Chopin" })).toBeVisible();
	await expect(page.getByText(recoveryChannel.title, { exact: true })).toBeVisible();
	await expect(page.getByText(recoveryChannel.id, { exact: true })).toHaveCount(0);
	await expect(page.getByText(recoveryChannel.slug, { exact: true })).toBeVisible();
	await expect(page.getByText(score.fullName, { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
	let channels = page.getByRole("link", { name: `View ${score.fullName} channels` });
	await expect(channels).toHaveAttribute("href", "/documents/octo-org/score");
	await channels.click();
	await expect(page).toHaveURL("/documents/octo-org/score");
	await expect(page.getByRole("heading", { name: "Planning channels" })).toBeVisible();
});

test("a transient channel failure retries the safe read", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	let attempts = 0;
	await page.route(
		"**/api/repositories/octo-org/score/documents/release-readiness",
		async route => {
			attempts++;
			if (attempts === 1) {
				await route.fulfill({ status: 503, json: { error: "storage is unavailable" } });
				return;
			}
			await route.fulfill({
				json: { canEdit: true, channel: recoveryChannel, repository: score },
			});
		},
	);
	await showKnownChannel(page);

	await expect(page.getByText(recoveryChannel.title, { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByRole("button", { name: `Document: ${recoveryChannel.title}` }))
		.toBeVisible();
	expect(attempts).toBe(2);
});

test("an unknown direct channel link stays privacy-safe", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	await page.route(
		"**/api/repositories/octo-org/score/documents/release-readiness",
		route => route.fulfill({ status: 404, json: { error: "channel not found" } }),
	);
	await showKnownChannel(page);
	await expect(page.getByText(recoveryChannel.title, { exact: true })).toBeVisible();
	let unknown = "22222222-2222-4222-8222-222222222222";
	await page.route(
		new RegExp(`/api/channels/${unknown}$`),
		route => route.fulfill({ status: 404, json: { error: "channel not found" } }),
	);
	await page.goto(`/channels/${unknown}`);

	await expect(page.getByText(unknown, { exact: true })).toHaveCount(0);
	await expect(page.getByText(recoveryChannel.title, { exact: true })).toHaveCount(0);
	await expect(page.getByText(score.fullName, { exact: true })).toHaveCount(0);
	await expect(page.getByRole("link", { name: /channels$/ })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
	await expect(page.getByRole("link", { name: "Back to repositories" })).toBeVisible();
});

test("the repository picker supports dismissal and keyboard selection", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	await page.goto("/");

	let trigger = page.getByRole("button", { name: "Choose repository" });
	let search = page.getByRole("combobox", { name: "Search repositories" });
	await expect(search).toBeFocused();
	expect((await search.boundingBox())!.height).toBeLessThan(44);
	await search.press("Escape");
	await expect(page.getByRole("listbox", { name: "Repositories" })).toBeHidden();
	await expect(trigger).toBeFocused();

	await trigger.click();
	await expect(search).toBeFocused();
	let scrolled = page.locator("[data-repository-scroll]").evaluate(node =>
		new Promise<void>(resolve => {
			node.addEventListener("scroll", () => resolve(), { once: true });
		})
	);
	for (let index = 0; index < 12; index++) await search.press("ArrowDown");
	await scrolled;
	let activeId = await search.getAttribute("aria-activedescendant");
	expect(activeId).toBeTruthy();
	let panelId = await trigger.getAttribute("aria-controls");
	await expect.poll(() =>
		page.evaluate(({ activeId, panelId }) => {
			let option = document.getElementById(activeId!);
			let scroller = option?.closest<HTMLElement>("[data-repository-scroll]");
			let panel = document.getElementById(panelId!);
			if (!option || !scroller || !panel) return false;
			let optionBox = option.getBoundingClientRect();
			let scrollerBox = scroller.getBoundingClientRect();
			let panelBox = panel.getBoundingClientRect();
			let viewport = window.visualViewport;
			let viewportTop = viewport?.offsetTop ?? 0;
			let viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
			return optionBox.top >= Math.max(scrollerBox.top, panelBox.top)
				&& optionBox.bottom <= Math.min(scrollerBox.bottom, panelBox.bottom)
				&& optionBox.top >= viewportTop
				&& optionBox.bottom <= viewportBottom;
		}, { activeId, panelId })
	).toBe(true);
	await search.fill("notes");
	await expect(page.getByRole("option", { name: /octocat\/notes/ })).toBeVisible();
	await search.press("Enter");
	await expect(page).toHaveURL("/documents/octocat/notes");
});

test("the repository picker stays inside a narrow visual viewport", async ({ baseURL, page }) => {
	await page.setViewportSize({ width: 320, height: 568 });
	await installVisualViewport(page, {
		height: 300,
		offsetLeft: 0,
		offsetTop: 84,
		pageLeft: 0,
		pageTop: 0,
		scale: 1,
		width: 320,
	});
	await authenticate(page, "octocat", baseURL!);
	await page.goto("/");

	let trigger = page.getByRole("button", { name: "Choose repository" });
	let search = page.getByRole("combobox", { name: "Search repositories" });
	await expect(search).toBeFocused();
	let popupId = await trigger.getAttribute("aria-controls");
	let bounds = await page.locator(`[id="${popupId}"]`).boundingBox();
	expect(bounds).toBeTruthy();
	expect(bounds!.x).toBeGreaterThanOrEqual(0);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
	expect(bounds!.y).toBeGreaterThanOrEqual(84);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(384);
	await expectInsideViewport(search);

	await trigger.evaluate(node => {
		node.style.transform = "translateY(500px)";
	});
	await page.evaluate(() => dispatchEvent(new Event("resize")));
	let popup = page.locator(`[id="${popupId}"]`);
	await expect.poll(() => popup.evaluate(node => node.getBoundingClientRect().height))
		.toBeGreaterThan(0);
	let geometry = await popup.evaluate(node => {
		let bounds = node.getBoundingClientRect();
		let viewport = visualViewport!;
		return {
			bottom: bounds.bottom,
			height: bounds.height,
			left: bounds.left,
			right: bounds.right,
			top: bounds.top,
			viewportBottom: viewport.offsetTop + viewport.height,
			viewportLeft: viewport.offsetLeft,
			viewportRight: viewport.offsetLeft + viewport.width,
			viewportTop: viewport.offsetTop,
		};
	});
	expect(geometry.height).toBeGreaterThan(0);
	expect(geometry.left).toBeGreaterThanOrEqual(geometry.viewportLeft);
	expect(geometry.right).toBeLessThanOrEqual(geometry.viewportRight);
	expect(geometry.top).toBeGreaterThanOrEqual(geometry.viewportTop);
	expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportBottom);
	await expect(search).toBeFocused();
	await expect.poll(() =>
		search.evaluate(node => {
			let bounds = node.getBoundingClientRect();
			let viewport = visualViewport!;
			return bounds.top >= viewport.offsetTop
				&& bounds.bottom <= viewport.offsetTop + viewport.height;
		})
	).toBe(true);
});

test("the repository picker repositions as background results and errors arrive", async ({ baseURL, page }) => {
	await page.setViewportSize({ width: 320, height: 568 });
	await authenticate(page, "octocat", baseURL!);
	let releaseInitial: (() => void) | undefined;
	let releaseSecond: (() => void) | undefined;
	let initial = new Promise<void>(resolve => {
		releaseInitial = resolve;
	});
	await page.route(
		/\/api\/github\/installations\/(101|102)\/repositories\?page=\d+$/,
		async route => {
			let installation = /\/installations\/(\d+)\/repositories/.exec(route.request().url())?.[1];
			let requested = new URL(route.request().url()).searchParams.get("page");
			if (requested === "1") {
				await initial;
				await route.fulfill({
					json: installation === "101"
						? { repositories: [score], nextPage: 2 }
						: {
							repositories: [{
								...score,
								id: "R_notes",
								owner: "octocat",
								name: "notes",
								fullName: "octocat/notes",
								private: false,
								permissions: { pull: true, push: false, admin: false },
							}],
						},
				});
				return;
			}
			await new Promise<void>(resolve => {
				releaseSecond = resolve;
			});
			await route.fulfill({ status: 503, json: { error: "temporary failure" } });
		},
	);
	await page.goto("/");

	let trigger = page.getByRole("button", { name: "Choose repository" });
	let popupId = await trigger.getAttribute("aria-controls");
	expect(popupId).toBeTruthy();
	let popup = page.locator(`[id="${popupId}"]`);
	await expect(page.getByText("Loading installed repositories...", { exact: true })).toBeVisible();
	await trigger.evaluate(node => {
		node.style.transform = "translateY(350px)";
	});
	await page.evaluate(() => dispatchEvent(new Event("resize")));
	let loading = await popup.boundingBox();
	expect(loading).toBeTruthy();

	releaseInitial!();
	await expect(page.getByRole("option", { name: /octo-org\/score/ })).toBeVisible();
	let loaded = await popup.boundingBox();
	expect(loaded).toBeTruthy();
	expect(loaded!.height).toBeGreaterThan(loading!.height + 40);
	expect(loaded!.y).toBeLessThan(loading!.y - 40);

	await expect.poll(() => releaseSecond !== undefined).toBe(true);
	releaseSecond!();
	await expect(page.getByRole("alert")).toContainText("Could not load all repositories.");
	await expect(page.getByRole("option", { name: /octocat\/notes/ })).toBeVisible();
	let failed = await popup.boundingBox();
	expect(failed).toBeTruthy();
	expect(failed!.height).toBeGreaterThan(0);
	expect(failed!.y).toBeGreaterThanOrEqual(0);
	expect(failed!.y + failed!.height).toBeLessThanOrEqual(568);
});

test("narrow coarse hosted controls and channel content remain reachable", async ({ baseURL, browser }) => {
	let context = await browser.newContext({
		baseURL,
		hasTouch: true,
		isMobile: true,
		viewport: { width: 320, height: 568 },
	});
	try {
		let page = await context.newPage();
		await page.goto("/");
		await expectNoHorizontalOverflow(page);
		await expectInsideViewport(page.getByRole("link", { name: "Continue with GitHub" }));

		await authenticate(page, "octocat", baseURL!);
		let state: "channels" | "empty" | "error" | "loading" = "loading";
		await page.route("**/api/repositories/octo-org/score/channels*", async route => {
			let requested = state;
			if (requested === "loading") {
				await new Promise(resolve => setTimeout(resolve, 200));
			}
			if (requested === "error") {
				await route.fulfill({ status: 503, json: { error: "Repositories are unavailable." } });
				return;
			}
			await route.fulfill({
				json: {
					canEdit: true,
					channels: requested === "empty" ? [] : [{
						createdAt: "2026-08-14T12:00:00.000Z",
						createdBy: "U_octocat",
						id: "11111111-1111-4111-8111-111111111111",
						repositoryId: score.id,
						repositoryName: score.name,
						repositoryOwner: score.owner,
						revision: 1,
						slug: "a-planning-channel-title-long-enough-to-wrap-beside-a-deliberately-visible-date",
						title:
							"A planning channel title long enough to wrap beside a deliberately visible date",
						updatedAt: "2026-08-14T12:00:00.000Z",
					}],
					repository: score,
				},
			});
		});
		await page.goto("/documents/octo-org/score");
		await expect(page.getByText("Loading channels...")).toBeVisible();

		for (
			let control of [
				page.getByRole("button", { name: /Repository: octo-org\/score/ }),
				page.getByRole("button", { name: "Sign out" }),
			]
		) {
			let box = await control.boundingBox();
			expect(box).toBeTruthy();
			expect(box!.height).toBeGreaterThanOrEqual(44);
		}

		let input = page.getByPlaceholder("Plan the next release");
		await expect(input).toBeVisible();
		let picker = page.getByRole("button", { name: /Repository: octo-org\/score/ });
		await picker.click();
		let search = page.getByRole("combobox", { name: "Search repositories" });
		await expect(search).toBeFocused();
		for (let control of [search, input]) {
			expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		}
		await search.press("Escape");
		let longTitle = page.getByText(
			"A planning channel title long enough to wrap beside a deliberately visible date",
			{ exact: true },
		);
		let longDate = page.getByText(new Date("2026-08-14T12:00:00.000Z").toLocaleDateString(), {
			exact: true,
		});
		await expect(longTitle).toBeVisible();
		await expect(longDate).toBeVisible();
		let form = page.locator("form").filter({ has: input });
		expect(await form.evaluate(node => getComputedStyle(node).flexDirection)).toBe("column");
		await expectInsideViewport(input);
		await expectInsideViewport(page.getByRole("button", { name: "New channel" }));
		await expectNoHorizontalOverflow(page);

		await page.setViewportSize({ width: 390, height: 844 });
		await picker.click();
		await expect(search).toBeFocused();
		for (let control of [search, input]) {
			expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		}
		await search.press("Escape");
		await expect(longTitle).toBeVisible();
		await expect(longDate).toBeVisible();
		await expectInsideViewport(longTitle);
		await expectInsideViewport(longDate);
		await expectNoHorizontalOverflow(page);

		state = "empty";
		await page.reload();
		await expect(page.getByText("No planning channels yet")).toBeVisible();
		await expectNoHorizontalOverflow(page);

		state = "error";
		await page.reload();
		await expect(page.getByRole("heading", { name: "Cannot open Chopin" })).toBeVisible();
		await expectInsideViewport(page.getByRole("link", { name: "Back to repositories" }));
	} finally {
		await context.close();
	}
});

test("an authorized user without an installation is sent to install the App", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	await page.route(
		"**/api/github/installations?*",
		route => route.fulfill({ json: { installations: [] } }),
	);
	await page.goto("/");

	await expect(page.getByRole("link", { name: "Install GitHub App" })).toHaveAttribute(
		"href",
		"/auth/github/install",
	);
});

test("returning from GitHub App setup invalidates the tab cache", async ({ baseURL, page }) => {
	await authenticate(page, "paged", baseURL!);
	await page.goto("/");
	await expect(page.getByRole("option", { name: /^octo-org\/archive-12\b/ })).toBeVisible();
	await page.evaluate(() => {
		let user = sessionStorage.getItem("chopin:repositories:active-user")!;
		let key = `chopin:repositories:${encodeURIComponent(user)}`;
		let snapshot = JSON.parse(sessionStorage.getItem(key)!) as {
			validatedAt: number;
			installationPages: Array<{ value: { installations: unknown[] } }>;
			repositoryPages: Record<string, unknown>;
		};
		snapshot.validatedAt = Date.now();
		snapshot.installationPages[0]!.value.installations = [];
		snapshot.repositoryPages = {};
		sessionStorage.setItem(key, JSON.stringify(snapshot));
	});

	await page.goto("/auth/github/setup?installation_id=101");
	await expect(page).toHaveURL("/");
	await expect(page.getByRole("option", { name: /^octo-org\/archive-12\b/ })).toBeVisible();
});

test("repository search includes pages loaded in the background", async ({ baseURL, page }) => {
	await authenticate(page, "paged", baseURL!);
	await page.goto("/");

	let search = page.getByRole("combobox", { name: "Search repositories" });
	await search.fill("archive-12");
	await expect(page.getByRole("option", { name: /^octo-org\/archive-12\b/ })).toBeVisible();
	await expect(page.getByRole("button", { name: /More from/ })).toHaveCount(0);
});

test("the repository picker retries and appends unique background pages", async ({ baseURL, page }) => {
	await authenticate(page, "octocat", baseURL!);
	let fail = true;
	await page.route(/\/api\/github\/installations\?page=\d+$/, async route => {
		if (fail) {
			fail = false;
			await route.fulfill({ status: 503, json: { error: "temporary failure" } });
		} else {
			await route.fulfill({
				json: {
					installations: [{
						id: "101",
						account: { login: "octo-org", avatarUrl: "", type: "organization" },
						repositorySelection: "selected",
						configureUrl: "https://github.com/settings/installations/101",
						suspended: false,
						permissions: {
							contents: true,
							pullRequests: true,
							checks: true,
							statuses: true,
						},
					}],
				},
			});
		}
	});
	await page.route(/\/api\/github\/installations\/101\/repositories\?page=\d+$/, async route => {
		let requested = new URL(route.request().url()).searchParams.get("page");
		if (requested === "1") {
			await route.fulfill({ json: { repositories: [score], nextPage: 2 } });
		} else {
			await route.fulfill({
				json: {
					repositories: [score, {
						...score,
						id: "R_archive",
						name: "archive",
						fullName: "octo-org/archive",
					}],
				},
			});
		}
	});
	await page.goto("/");

	await expect(page.getByRole("alert")).toHaveText("Could not load repositories.");
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByRole("option", { name: /octo-org\/score/ })).toBeVisible();
	await expect(page.getByRole("option", { name: /octo-org\/archive/ })).toBeVisible();
	await expect(page.getByRole("option", { name: /octo-org\/score/ })).toHaveCount(1);
});

test("the tab cache revalidates stale repository pages with etags", async ({ baseURL, page }) => {
	await authenticate(page, "paged", baseURL!);
	await page.goto("/");
	await expect(page.getByRole("option", { name: /^octo-org\/archive-12\b/ })).toBeVisible();

	let cachedAt = await page.evaluate(() => {
		let user = sessionStorage.getItem("chopin:repositories:active-user")!;
		let key = `chopin:repositories:${encodeURIComponent(user)}`;
		let snapshot = JSON.parse(sessionStorage.getItem(key)!) as { validatedAt: number };
		snapshot.validatedAt = 0;
		sessionStorage.setItem(key, JSON.stringify(snapshot));
		return snapshot.validatedAt;
	});
	expect(cachedAt).toBe(0);

	let validators: string[] = [];
	page.on("request", async request => {
		if (!request.url().includes("/api/github/installations")) return;
		let validator = await request.headerValue("if-none-match");
		if (validator) validators.push(validator);
	});
	await page.reload();
	await expect(page.getByRole("option", { name: /^octo-org\/archive-12\b/ })).toBeVisible();
	await page.getByRole("combobox", { name: "Search repositories" }).fill("archive-12");
	await expect.poll(() => validators.length).toBeGreaterThanOrEqual(4);
	await expect(page.getByText("Refreshing repositories...", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("option", { name: /^octo-org\/archive-12\b/ })).toBeVisible();
});

test("expired GitHub authorization returns to sign in without losing the document", async ({ baseURL, page, room }) => {
	let path = roomPath(room);
	await authenticate(page, "expired", baseURL!);
	await page.goto(path);

	await expect(page.getByRole("link", { name: "Continue with GitHub" })).toBeVisible();
	await expect(page).toHaveURL(path);
});
