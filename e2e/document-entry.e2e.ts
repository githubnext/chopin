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
	let parentSlug = child.path.split("/children/")[0]!.split("/").at(-1)!;
	let parentUrl = `/api/repositories/octo-org/score/documents/${parentSlug}`;
	let childUrl = `/api/repositories/octo-org/score/documents/${child.slug}`;
	let reads: string[] = [];
	page.on("request", request => {
		if (request.method() !== "GET") return;
		let pathname = new URL(request.url()).pathname;
		if (pathname === parentUrl || pathname === childUrl) reads.push(pathname);
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
	await expect(surface).toContainText("Opening child document…");
	// The parent's editor exists before the child response and no metadata read repeats.
	expect(reads.filter(path => path === parentUrl)).toHaveLength(1);
	expect(reads.filter(path => path === childUrl)).toHaveLength(1);
	releaseChild();
	await expect(surface).toContainText("Couldn't open this document");
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
	await surface.getByRole("button", { name: "Try again" }).click();
	await expect(surface.locator(`[data-workspace-room="${child.id}"]`)).toBeVisible();
	await expect(parent).toHaveAttribute("data-mount-token", "preserved");
	expect(reads.filter(path => path === parentUrl)).toHaveLength(2);
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
	let parentPath = child.path.split("/children/")[0]!;
	await page.getByRole("button", { name: `Back to Test ${room.slice(0, 8)}` }).click();
	await expect(page).toHaveURL(url => url.pathname === parentPath);
	releaseChild();
	await expect(page.locator(".anchored-child-card")).toHaveCount(0);
	await expect(parent).toBeVisible();
});
