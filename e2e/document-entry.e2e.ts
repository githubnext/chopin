import { seedChildChannel } from "./database";
import { authenticate, expect, test } from "./room";

test("a direct child opens its parent from one read and recovers after a child failure", async ({ baseURL, page, room, seed }) => {
	await seed("# Parent document\n\nA passage to keep visible.\n");
	let title = `Source review ${room.slice(0, 8)}`;
	let child = await seedChildChannel(
		Number(new URL(baseURL!).port),
		room,
		crypto.randomUUID(),
		title,
		"# Source review\n\nChild passage.\n",
	);
	let childUrl = `/api/repositories/octo-org/score/documents/${child.slug}`;
	let reads: string[] = [];
	page.on("request", request => {
		if (request.method() !== "GET") return;
		let pathname = new URL(request.url()).pathname;
		if (pathname.startsWith("/api/repositories/octo-org/score/documents/")) reads.push(pathname);
	});
	let releaseChild!: () => void;
	let childHeld = new Promise<void>(resolve => {
		releaseChild = resolve;
	});
	let attempts = 0;
	await page.route(`**${childUrl}`, async route => {
		if (attempts++ === 0) {
			await childHeld;
			await route.fulfill({
				body: JSON.stringify({ error: "Child temporarily unavailable" }),
				contentType: "application/json",
				status: 503,
			});
		} else {
			await route.continue();
		}
	});
	await authenticate(page, "ana", baseURL!);
	await page.goto(child.path);
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	await expect(parent).toBeVisible();
	await parent.evaluate(element => element.setAttribute("data-mount-token", "preserved"));
	let surface = page.locator(".anchored-child-card");
	await expect(parent.getByRole("heading", { name: "Parent document", exact: true })).toBeVisible();
	await expect(page).toHaveURL(/\/parent-document(?:-\d+)?\/children\//);
	await expect(surface).toContainText("Opening child document…");
	// The parent's editor exists before the child response and no metadata read repeats.
	expect(reads.filter(path => path !== childUrl)).toHaveLength(1);
	expect(reads.filter(path => path === childUrl)).toHaveLength(1);
	releaseChild();
	await expect(surface).toContainText("Couldn't open this document");
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
	await surface.getByRole("button", { name: "Try again" }).click();
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
	expect(reads.filter(path => path !== childUrl)).toHaveLength(2);
	expect(reads.filter(path => path === childUrl)).toHaveLength(2);
});

test("a delayed direct child cannot reopen after returning to its parent", async ({ baseURL, page, room, seed }) => {
	await seed("# Parent document\n\nA passage to keep visible.\n");
	let child = await seedChildChannel(
		Number(new URL(baseURL!).port),
		room,
		crypto.randomUUID(),
		`Delayed child ${room.slice(0, 8)}`,
		"# Delayed child\n",
	);
	let releaseChild!: () => void;
	let childHeld = new Promise<void>(resolve => {
		releaseChild = resolve;
	});
	await page.route(`**/api/repositories/octo-org/score/documents/${child.slug}`, async route => {
		let response = await route.fetch();
		await childHeld;
		await route.fulfill({ response }).catch(() => {});
	});
	await authenticate(page, "ana", baseURL!);
	await page.goto(child.path);
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	await expect(parent).toBeVisible();
	await expect(page.locator(".anchored-child-card")).toContainText("Opening child document…");
	await expect(page).toHaveURL(/\/parent-document(?:-\d+)?\/children\//);
	let parentPath = new URL(page.url()).pathname.split("/children/")[0]!;
	await page.getByRole("button", { name: "Back to Parent document", exact: true }).click();
	await expect(page).toHaveURL(url => url.pathname === parentPath);
	releaseChild();
	await expect(page.locator(".anchored-child-card")).toHaveCount(0);
	await expect(parent).toBeVisible();
});

test("canonical title changes preserve a pending child request and both editor mounts", async ({ baseURL, page, room, seed }) => {
	await seed("# Parent document\n\nA passage to keep visible.\n");
	let port = Number(new URL(baseURL!).port);
	let child = await seedChildChannel(
		port,
		room,
		crypto.randomUUID(),
		"Child document",
		"# Child document\n\nChild passage.\n",
	);
	let reads = 0;
	page.on("request", request => {
		if (
			request.method() === "GET"
			&& new URL(request.url()).pathname.startsWith("/api/repositories/octo-org/score/documents/")
		) reads++;
	});
	let held = Promise.withResolvers<void>();
	await page.route(`**/api/repositories/octo-org/score/documents/${child.slug}`, async route => {
		let response = await route.fetch();
		await held.promise;
		await route.fulfill({ response });
	});
	await authenticate(page, "ana", baseURL!);
	await page.goto(child.path);
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	await expect(parent.getByRole("heading", { name: "Parent document", exact: true })).toBeVisible();
	await parent.evaluate(element => element.setAttribute("data-mount-token", "parent-preserved"));
	await expect(page).toHaveURL(/\/parent-document(?:-\d+)?\/children\//);
	let surface = page.locator(".anchored-child-card");
	await expect(surface).toContainText("Opening child document…");
	expect(reads).toBe(2);
	held.resolve();
	let opened = surface.locator(`[data-workspace-room="${child.id}"]`);
	await expect(opened.getByRole("heading", { name: "Child document", exact: true })).toBeVisible();
	await expect(parent).toHaveAttribute("data-mount-token", "parent-preserved");
	await expect(parent.getByRole("heading", { name: "Parent document", exact: true })).toBeVisible();
	await expect(page).toHaveURL(url =>
		url.pathname.endsWith(`/children/${child.slug}`)
		&& /\/parent-document(?:-\d+)?\/children\//.test(url.pathname)
	);
	await opened.evaluate(element => element.setAttribute("data-mount-token", "child-preserved"));
	await opened.getByRole("heading", { name: "Child document", exact: true }).selectText();
	await page.keyboard.type("Renamed child");
	await expect(page).toHaveURL(/\/parent-document(?:-\d+)?\/children\/renamed-child(?:-\d+)?$/);
	await expect(opened).toHaveAttribute("data-mount-token", "child-preserved");
	await expect(parent).toHaveAttribute("data-mount-token", "parent-preserved");
	expect(reads).toBe(2);
});

test("a parent rename while its child closes publishes the parent as the visited document", async ({ baseURL, page, room, seed }) => {
	await seed("# Parent document\n\nParent passage.\n");
	let child = await seedChildChannel(
		Number(new URL(baseURL!).port),
		room,
		crypto.randomUUID(),
		"Child document",
		"# Child document\n\nChild passage.\n",
	);
	let visits: string[] = [];
	page.on("request", request => {
		if (request.method() !== "PATCH" || new URL(request.url()).pathname !== "/api/navigation") {
			return;
		}
		let body = request.postDataJSON() as { documentId?: string };
		if (body.documentId) visits.push(body.documentId);
	});
	await authenticate(page, "ana", baseURL!);
	await page.goto(child.path);
	let parent = page.locator(`[data-workspace-room="${room}"]`);
	await expect(page.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	// Catch the close at its commit, before the pointer action's waiting can outlast the motion.
	await page.evaluate(() => {
		let observer = new MutationObserver(() => {
			let host = document.querySelector('[data-child-presentation="closing"]');
			let animations = host?.getAnimations({ subtree: true }) ?? [];
			if (!animations.length) return;
			for (let animation of animations) animation.pause();
			observer.disconnect();
		});
		observer.observe(document.body, {
			attributes: true,
			attributeFilter: ["data-child-presentation"],
			subtree: true,
		});
	});
	await page.getByRole("button", { name: "Back to Parent document", exact: true }).click();
	await expect(page.locator('[data-child-presentation="closing"]')).toHaveCount(1);
	await expect.poll(() => visits.at(-1)).toBe(room);
	visits.length = 0;
	let renamed = `Renamed parent ${room.slice(0, 8)}`;
	let response = await page.context().request.patch(`/api/channels/${room}`, {
		headers: { origin: new URL(baseURL!).origin },
		data: { title: renamed },
	});
	expect(response.ok()).toBe(true);
	let detail = await response.json() as { channel: { slug: string } };
	await expect(page).toHaveURL(url =>
		url.pathname === `/documents/octo-org/score/${detail.channel.slug}`
	);
	await expect(parent.getByRole("group", { name: `Document: ${renamed}`, exact: true }))
		.toBeVisible();
	expect(visits.every(id => id === room)).toBe(true);
	await expect(page.locator('[data-child-presentation="closing"]')).toHaveCount(1);
	await page.evaluate(() => {
		for (
			let animation of document.querySelector('[data-child-presentation="closing"]')!
				.getAnimations({ subtree: true })
		) animation.play();
	});
	await expect(page.locator(".anchored-child-card")).toHaveCount(0);
	expect(visits.every(id => id === room)).toBe(true);
	await expect.poll(async () => {
		let navigation = await page.context().request.get("/api/navigation");
		return (await navigation.json() as { lastDocumentId?: string }).lastDocumentId;
	}).toBe(room);
	await expect(
		page.getByRole("complementary", { name: "Projects" })
			.locator('[aria-current="page"]'),
	).toHaveAccessibleName(renamed);
});
