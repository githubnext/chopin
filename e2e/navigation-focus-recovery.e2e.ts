import { expect, test } from "./room";

test("Projects does not reclaim focus after it intentionally leaves the open drawer", async ({ join, page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	let release = Promise.withResolvers<void>();
	await page.route(/\/assets\/project-sidebar-[^/]+\.js$/, async route => {
		await release.promise;
		await route.continue();
	});
	try {
		await join("ana");
		let opener = page.getByRole("button", { name: "Open Projects sidebar" });
		await opener.click();
		let drawer = page.getByRole("dialog", { name: "Projects", exact: true });
		await expect(drawer.getByRole("status")).toContainText("Loading projects");
		await expect(drawer.getByRole("button", { name: "Collapse Projects sidebar" })).toBeFocused();

		// Simulate a host moving focus outside the drawer, then returning it to body.
		await page.getByRole("banner").getByRole("button", { name: /^Actions for / })
			.evaluate(element => {
				let button = element as HTMLButtonElement;
				button.focus();
				button.blur();
			});
		await expect.poll(() => page.evaluate(() => document.activeElement === document.body))
			.toBe(true);

		release.resolve();
		await expect(drawer.getByRole("navigation", { name: "Projects" })).toBeVisible();
		await expect.poll(() => page.evaluate(() => document.activeElement === document.body))
			.toBe(true);
	} finally {
		release.resolve();
	}
});
