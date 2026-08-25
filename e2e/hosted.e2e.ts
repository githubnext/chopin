import { createChannel } from "./database";
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
	await page.goto(`/documents/octo-org/score/${recoveryChannel.slug}`);
}

function addProjectDialog(page: Parameters<typeof authenticate>[0]) {
	return page.getByRole("dialog", { name: "Add Project" });
}

function repositoryOption(page: Parameters<typeof authenticate>[0], name: string) {
	return addProjectDialog(page).getByRole("button").filter({ hasText: name });
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

test("an authenticated user adds a Project and creates its first document", async ({ baseURL, page }) => {
	await authenticate(page, "project-creator", baseURL!);
	await page.goto("/");

	let dialog = addProjectDialog(page);
	let search = dialog.getByRole("textbox", { name: "Search repositories" });
	await expect(dialog).toBeVisible();
	await expect(search).toBeFocused();
	await repositoryOption(page, "score").click();
	let projects = page.getByRole("complementary", { name: "Projects" });
	await expect(projects.getByRole("button", { name: "score", exact: true })).toBeVisible();
	await projects.getByRole("button", { name: "New document in score" }).click();

	await expect(page).toHaveURL(/\/documents\/octo-org\/score\/[a-z]+-[a-z]+$/);
	let activeRoute = page.locator("[data-content-swap-state]:not([inert])").filter({
		has: page.getByRole("banner", { includeHidden: true }),
	});
	await expect(activeRoute.getByRole("complementary", { name: "Conversation" })).toBeVisible();
	await expect(activeRoute.getByRole("textbox", { name: "editable markdown" })).toBeVisible();
	await expect(activeRoute.locator("[data-plan-decisions-scroll]")).toBeAttached();
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

test("a stale outgoing route cannot canonicalize or publish over the active document", async ({ baseURL, page, room }) => {
	let stale = {
		...recoveryChannel,
		descriptionRevision: 0,
		id: "33333333-3333-4333-8333-333333333333",
		slug: "stale-outgoing",
		title: "Stale outgoing",
	};
	let captured = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let visits: string[] = [];
	page.on("request", request => {
		if (request.method() !== "PATCH" || new URL(request.url()).pathname !== "/api/navigation") {
			return;
		}
		let body = request.postDataJSON() as { documentId?: unknown };
		if (typeof body.documentId === "string") visits.push(body.documentId);
	});
	await page.route(new RegExp(`/api/channels/${stale.id}$`), async route => {
		captured.resolve();
		await release.promise;
		await route.fulfill({
			json: { canEdit: true, canManage: false, channel: stale, repository: score },
		});
	});
	await authenticate(page, "stale-route", baseURL!);
	await page.goto(`/channels/${stale.id}`);
	await captured.promise;
	await page.locator("body").dispatchEvent("pointerover", { pointerType: "mouse" });
	let activePath = roomPath(room);
	await page.evaluate(path => {
		history.pushState(null, "", path);
		dispatchEvent(new PopStateEvent("popstate"));
	}, activePath);
	let routes = page.locator(".document-route-swap > [data-content-swap-state]:not([hidden])");
	let outgoing = page.locator(
		'.document-route-swap > [data-content-swap-state="outgoing"]:not([hidden])',
	);
	await expect(routes).toHaveCount(2);
	await expect(outgoing).toHaveAttribute("inert", "");
	await expect.poll(() => visits).toEqual([room]);

	let staleResponse = page.waitForResponse(response =>
		new URL(response.url()).pathname === `/api/channels/${stale.id}`
	);
	release.resolve();
	await staleResponse;
	await page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
	await expect(page).toHaveURL(activePath);
	expect(visits).toEqual([room]);
});

test("outgoing WebSocket metadata cannot canonicalize the active document", async ({ baseURL, page, room }) => {
	let stale = crypto.randomUUID();
	await createChannel(Number(new URL(baseURL!).port), stale);
	let captured = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let title = `Renamed outgoing ${stale.slice(0, 8)}`;
	let slug = `renamed-outgoing-${stale.slice(0, 8)}`;
	await page.routeWebSocket("**/ws?**", route => {
		let channel = new URL(route.url()).searchParams.get("channel");
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (channel === stale && typeof message === "string") {
				let frame = JSON.parse(message) as { kind?: string } & Record<string, unknown>;
				if (frame.kind === "session:hello") {
					captured.resolve();
					void release.promise.then(() =>
						route.send(JSON.stringify({
							...frame,
							slug,
							title,
							updatedAt: "2099-08-25T18:00:00.000Z",
						}))
					);
					return;
				}
			}
			route.send(message);
		});
	});

	await authenticate(page, "stale-socket", baseURL!);
	await page.goto(`/channels/${stale}`);
	await captured.promise;
	let projects = page.getByRole("complementary", { name: "Projects" });
	await expect(projects.getByRole("link", {
		name: `Test ${stale.slice(0, 8)}`,
		exact: true,
	})).toBeVisible();

	await page.locator("body").dispatchEvent("pointerover", { pointerType: "mouse" });
	let activePath = roomPath(room);
	await page.evaluate(path => {
		history.pushState(null, "", path);
		dispatchEvent(new PopStateEvent("popstate"));
	}, activePath);
	let active = page.locator(
		".document-route-swap > [data-content-swap-state]:not([hidden]):not([inert])",
	);
	await expect(active.getByRole("banner")).toContainText(`Test ${room.slice(0, 8)}`);
	await expect(page.locator(
		'.document-route-swap > [data-content-swap-state="outgoing"]:not([hidden])',
	)).toHaveCount(1);

	release.resolve();
	await expect(projects.getByRole("link", { name: title, exact: true })).toBeVisible();
	await expect(page).toHaveURL(activePath);
});

test("a legacy repository path renders the global navigation shell", async ({ baseURL, page }) => {
	await authenticate(page, "legacy-route", baseURL!);
	await page.route(
		"**/api/repositories/OCTO-ORG/SCORE/channels*",
		route => route.fulfill({ json: { canEdit: true, channels: [], repository: score } }),
	);
	await page.goto("/repositories/OCTO-ORG/SCORE?view=list#documents");

	await expect(page).toHaveURL("/repositories/OCTO-ORG/SCORE?view=list#documents");
	await expect(addProjectDialog(page)).toBeVisible();
});

test("a known deleted channel keeps its context and routes back without retry", async ({ baseURL, page }) => {
	await authenticate(page, "deleted-document", baseURL!);
	let deleted = false;
	await page.route(
		"**/api/repositories/octo-org/score/documents/release-readiness",
		route =>
			deleted
				? route.fulfill({ status: 404, json: { error: "channel not found" } })
				: route.fulfill({
					json: { canEdit: true, channel: recoveryChannel, repository: score },
				}),
	);
	await showKnownChannel(page);
	await expect(page.getByRole("banner").getByLabel(`Document: ${recoveryChannel.title}`))
		.toBeVisible();
	deleted = true;
	await page.reload();

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
	await expect(addProjectDialog(page)).toBeVisible();
});

test("a transient channel failure retries the safe read", async ({ baseURL, page }) => {
	await authenticate(page, "transient-document", baseURL!);
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

	await expect(page.getByText("storage is unavailable", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(page.getByRole("banner").getByLabel(`Document: ${recoveryChannel.title}`))
		.toBeVisible();
	expect(attempts).toBe(2);
});

test("an unknown direct channel link stays privacy-safe", async ({ baseURL, page }) => {
	await authenticate(page, "unknown-document", baseURL!);
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

test("the Add Project dialog traps focus, dismisses, and filters repositories", async ({ baseURL, page }) => {
	await authenticate(page, "project-dialog", baseURL!);
	await page.goto("/");

	let dialog = addProjectDialog(page);
	let search = dialog.getByRole("textbox", { name: "Search repositories" });
	await expect(search).toBeFocused();
	await search.press("Tab");
	expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();

	let trigger = page.getByRole("button", { name: "Add Project" });
	await trigger.click();
	await expect(search).toBeFocused();
	await search.fill("notes");
	await expect(repositoryOption(page, "notes")).toBeVisible();
	await expect(repositoryOption(page, "score")).toHaveCount(0);
});

test("the Add Project dialog reuses a fresh tab cache", async ({ baseURL, page }) => {
	await authenticate(page, "paged", baseURL!);
	await page.goto("/");
	await expect(repositoryOption(page, "archive-12")).toBeVisible();
	await expect.poll(() =>
		page.evaluate(() => {
			let user = sessionStorage.getItem("chopin:repositories:active-user")!;
			let key = `chopin:repositories:${encodeURIComponent(user)}`;
			return (JSON.parse(sessionStorage.getItem(key)!) as { validatedAt: number }).validatedAt;
		})
	).toBeGreaterThan(0);
	await page.keyboard.press("Escape");

	let requests = 0;
	page.on("request", request => {
		if (request.url().includes("/api/github/installations")) requests++;
	});
	await page.getByRole("button", { name: "Add Project" }).click();
	await expect(repositoryOption(page, "archive-12")).toBeVisible();
	await page.evaluate(() =>
		new Promise<void>(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
		)
	);
	expect(requests).toBe(0);
});

test("Add Project search stays reachable in a narrow visual viewport", async ({ baseURL, page }) => {
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
	await authenticate(page, "narrow-project-dialog", baseURL!);
	await page.goto("/");

	let dialog = addProjectDialog(page);
	let search = dialog.getByRole("textbox", { name: "Search repositories" });
	await expect(search).toBeFocused();
	await expectInsideViewport(search);
	await expectNoHorizontalOverflow(page);
});

test("an authorized user without an installation can manage repository access", async ({ baseURL, page }) => {
	await authenticate(page, "no-installation", baseURL!);
	await page.route(
		"**/api/github/installations?*",
		route => route.fulfill({ json: { installations: [] } }),
	);
	await page.goto("/");

	await expect(page.getByRole("link", { name: "Manage repository access" })).toHaveAttribute(
		"href",
		"/auth/github/install",
	);
});

test("returning from GitHub App setup invalidates the tab cache", async ({ baseURL, page }) => {
	await authenticate(page, "paged", baseURL!);
	await page.goto("/");
	await expect(repositoryOption(page, "archive-12")).toBeVisible();
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
	await expect(repositoryOption(page, "archive-12")).toBeVisible();
});

test("repository search includes pages loaded in the background", async ({ baseURL, page }) => {
	await authenticate(page, "paged", baseURL!);
	await page.goto("/");

	let search = addProjectDialog(page).getByRole("textbox", { name: "Search repositories" });
	await search.fill("archive-12");
	await expect(repositoryOption(page, "archive-12")).toBeVisible();
	await expect(page.getByRole("button", { name: /More from/ })).toHaveCount(0);
});

test("the Add Project dialog retries and appends unique background pages", async ({ baseURL, page }) => {
	await authenticate(page, "retry-project-dialog", baseURL!);
	let fail = true;
	await page.route("**/api/github/installations?*", async route => {
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
	await page.route("**/api/github/installations/101/repositories?*", async route => {
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

	await expect(page.getByRole("alert")).toBeVisible();
	await page.getByRole("button", { name: "Try again" }).click();
	await expect(repositoryOption(page, "score")).toBeVisible();
	await expect(repositoryOption(page, "archive")).toBeVisible();
	await expect(repositoryOption(page, "score")).toHaveCount(1);
});

test("the tab cache revalidates stale repository pages with etags", async ({ baseURL, page }) => {
	await authenticate(page, "paged", baseURL!);
	await page.goto("/");
	await expect(repositoryOption(page, "archive-12")).toBeVisible();

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
	await expect(repositoryOption(page, "archive-12")).toBeVisible();
	await addProjectDialog(page).getByRole("textbox", { name: "Search repositories" })
		.fill("archive-12");
	await expect.poll(() => validators.length).toBeGreaterThanOrEqual(4);
	await expect(repositoryOption(page, "archive-12")).toBeVisible();
});

test("expired GitHub authorization returns to sign in without losing the document", async ({ baseURL, page, room }) => {
	let path = roomPath(room);
	await authenticate(page, "expired", baseURL!);
	await page.goto(path);

	await expect(page.getByRole("link", { name: "Continue with GitHub" })).toBeVisible();
	await expect(page).toHaveURL(path);
});
