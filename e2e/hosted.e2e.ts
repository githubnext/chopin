import { authenticate, expect, test } from "./room";
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

	await expect(page).toHaveURL(/\/channels\/[0-9a-f-]{36}$/);
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
	await expect(page).toHaveURL("/repositories/octocat/notes");
	await expect(page.getByRole("heading", { name: "Planning channels" })).toBeVisible();
	await expect(page.getByRole("button", { name: /octocat\/notes/ })).toBeVisible();
	await expect(page.getByRole("button", { name: "New channel" })).toHaveCount(0);
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
	await expect(page).toHaveURL("/repositories/octocat/notes");
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

test("the repository picker repositions as repository results and pagination errors arrive", async ({ baseURL, page }) => {
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
						: { repositories: [] },
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

	let more = page.getByRole("button", { name: "More from octo-org" });
	await more.click();
	await expect(page.getByRole("button", { name: "Loading..." })).toBeDisabled();
	await expect.poll(() => releaseSecond !== undefined).toBe(true);
	releaseSecond!();
	await expect(page.getByRole("alert")).toHaveText("Could not load more repositories.");
	let failed = await popup.boundingBox();
	expect(failed).toBeTruthy();
	expect(failed!.height).toBeGreaterThan(loaded!.height);
	expect(failed!.y).toBeLessThan(loaded!.y);
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
						title:
							"A planning channel title long enough to wrap beside a deliberately visible date",
						updatedAt: "2026-08-14T12:00:00.000Z",
					}],
					repository: score,
				},
			});
		});
		await page.goto("/repositories/octo-org/score");
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

test("GitHub installation pagination reaches the repository picker", async ({ baseURL, page }) => {
	await authenticate(page, "paged", baseURL!);
	await page.goto("/");

	await expect(page.getByRole("option", { name: /octo-org\/score/ })).toBeVisible();
	await page.getByRole("button", { name: "More from octo-org" }).click();
	await expect(page.getByRole("option", { name: /^octo-org\/archive-1\b/ })).toBeVisible();
});

test("the repository picker retries and appends unique pages", async ({ baseURL, page }) => {
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
	await page.getByRole("button", { name: "More from octo-org" }).click();
	await expect(page.getByRole("option", { name: /octo-org\/archive/ })).toBeVisible();
	await expect(page.getByRole("option", { name: /octo-org\/score/ })).toHaveCount(1);
});

test("expired GitHub authorization returns to sign in", async ({ baseURL, page }) => {
	await authenticate(page, "expired", baseURL!);
	await page.goto("/");

	await expect(page.getByRole("link", { name: "Continue with GitHub" })).toBeVisible();
});
