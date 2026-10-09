/**
 * Two people in one room.
 *
 * `apps/web/src/collab.test.ts` already runs two providers against a real
 * server over real sockets, and it cannot see any of this: with no document to
 * paint into, convergence is asserted on the Yjs tree rather than on the
 * prose, and presence and carets are not asserted at all. What only exists
 * once there is a browser is what this file is for.
 *
 * Each person has an isolated browser context because identity uses an authenticated
 * login session cookie. They still meet in one repository-authorized channel.
 */

import { content, expect, ready, test, written } from "./room";

test("an edit by one appears for the other", async ({ join }) => {
	let ana = await join("ana");
	let bo = await join("bo");

	await content(ana).click();
	await ana.keyboard.type("Storage goes on disk as MDX.");

	await expect(content(bo)).toContainText("Storage goes on disk as MDX.");

	// Both ways: the second client is a peer, not a viewer.
	await content(bo).click();
	await bo.keyboard.press("End");
	await bo.keyboard.type(" Readable and diffable.");

	await expect(content(ana)).toContainText("Readable and diffable.");
});

test("typing faster than the server takes updates still reaches everyone", async ({ join, room }) => {
	let ana = await join("ana");
	let bo = await join("bo");

	// Without a delay this is well past the 200 updates a second the server
	// accepts from one socket. The excess used to be dropped, and everything
	// typed afterwards was stranded behind it.
	await content(ana).click();
	await ana.keyboard.type("Typed faster than anybody types. ".repeat(8).trim());
	await ana.keyboard.type(" Then the rest.", { delay: 50 });

	await expect(content(bo)).toContainText("anybody types. Then the rest.");
	await written(ana, room, "anybody types. Then the rest.");
});

test("the header represents everyone here as faces", async ({ join }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	let header = ana.getByRole("banner");

	await expect(header.getByRole("img", { name: "ana" })).toHaveCount(1);
	await expect(header.getByRole("img", { name: "bo" })).toHaveCount(1);
	await expect(ana.getByRole("img", { name: "ana" })).toHaveCount(1);
	await expect(ana.getByRole("img", { name: "bo" })).toHaveCount(1);
	await expect(header).not.toContainText("@ana");
	await expect(header).not.toContainText("@bo");

	await bo.close();

	// A roster that keeps naming somebody who closed the tab is worse than no
	// roster, because it is what you check before assuming you are alone.
	await expect(ana.getByRole("img", { name: "bo" })).toHaveCount(0);
});

test("the header represents one account once across its open tabs", async ({ join }) => {
	let first = await join("e2e");
	let second = await first.context().newPage();
	let third = await first.context().newPage();
	await Promise.all([second.goto(first.url()), third.goto(first.url())]);
	await Promise.all([ready(second), ready(third)]);

	let people = first.getByRole("banner").getByRole("group", {
		exact: true,
		name: "People here: e2e",
	});
	await expect(people.getByRole("img", { name: "e2e" })).toHaveCount(1);

	await first.close();
	let remaining = third.getByRole("banner").getByRole("group", {
		exact: true,
		name: "People here: e2e",
	});
	await expect(remaining.getByRole("img", { name: "e2e" })).toHaveCount(1);
});

test("a peer's caret is drawn, and named", async ({ join }) => {
	let ana = await join("ana");
	let bo = await join("bo");

	await content(ana).click();
	await ana.keyboard.type("Somewhere to put a caret.");
	await expect(content(bo)).toContainText("Somewhere to put a caret.");

	await content(bo).click();
	await bo.keyboard.press("End");

	// A person's caret is one of several and its owner is watching it, so the
	// name is what tells everyone else whose it is.
	await expect(ana.getByRole("region", { name: "Document" }).getByText("bo", { exact: true }))
		.toBeVisible();
});

test("nobody sees their own caret twice", async ({ join }) => {
	let ana = await join("ana");

	await content(ana).click();
	await ana.keyboard.type("Alone in here.");

	// Awareness reflects every socket including your own, so a mirror that
	// fails to exclude the local client paints a second caret exactly where
	// the real one is — invisible until somebody selects a word.
	await expect(ana.getByRole("region", { name: "Document" }).getByText("ana", { exact: true }))
		.toHaveCount(0);
});

for (let reducedMotion of ["no-preference", "reduce"] as const) {
	test(`a peer's name flashes intermittently and returns on hover (${reducedMotion})`, async ({ join }) => {
		let ana = await join("ana");
		let bo = await join("bo");
		await bo.emulateMedia({ reducedMotion });

		await content(ana).click();
		await ana.keyboard.type("Somewhere to type for a while.");
		await expect(content(bo)).toContainText("Somewhere to type for a while.");

		let name = bo.getByRole("region", { name: "Document" }).getByText("ana", { exact: true });
		await ana.keyboard.type(" Start");
		await expect(name).toHaveCSS("opacity", "1");
		let typing = ana.keyboard.type("word ".repeat(16), { delay: 50 });

		// Continued typing, including line wrapping, must not renew the name.
		await bo.waitForTimeout(2500);
		await expect(name).toHaveCSS("opacity", "0");
		await typing;
		await expect(name).toHaveCSS("opacity", "0");

		// A new inline text node is still the same block.
		await ana.keyboard.press("ControlOrMeta+b");
		await ana.keyboard.type("bold");
		await expect(name).toHaveCSS("opacity", "0");
		await ana.keyboard.press("ControlOrMeta+b");

		// Enter changes the block without an idle pause.
		await ana.keyboard.press("Enter");
		await ana.keyboard.type("Another block.");
		await expect(name).toHaveCSS("opacity", "1");

		await expect(name).toHaveCSS("opacity", "0", { timeout: 5000 });
		await bo.waitForTimeout(1700);
		await ana.keyboard.type(" Resumed.");
		await expect(name).toHaveCSS("opacity", "1");
		await expect(name).toHaveCSS("opacity", "0", { timeout: 5000 });

		let caret = await bo.evaluate(() => {
			let box = document.querySelector(".plan-cursor")!.getBoundingClientRect();
			return { x: box.left, y: box.top + box.height / 2 };
		});
		await bo.mouse.move(caret.x + 2, caret.y);
		await expect(name).toHaveCSS("opacity", "1");
		await bo.mouse.move(0, 0);
		await expect(name).toHaveCSS("opacity", "0");
	});
}
