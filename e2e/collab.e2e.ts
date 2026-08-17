/**
 * Two people in one room.
 *
 * `apps/web/src/collab.test.ts` already runs two providers against a real
 * server over real sockets, and it cannot see any of this: with no document to
 * paint into, convergence is asserted on the Yjs tree rather than on the
 * prose, and presence and carets are not asserted at all. What only exists
 * once there is a browser is what this file is for.
 *
 * Each person has an isolated browser context because identity is an encrypted
 * login session cookie. They still meet in one repository-authorized channel.
 */

import { content, expect, test } from "./room";

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

test("the header represents everyone here as faces", async ({ join }) => {
	let ana = await join("ana");
	let bo = await join("bo");
	let header = ana.locator("header").first();

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
	await expect(ana.locator(".plan-cursor")).toHaveCount(1);
	await expect(ana.locator(".plan-cursor-name")).toHaveText("bo");
});

test("nobody sees their own caret twice", async ({ join }) => {
	let ana = await join("ana");

	await content(ana).click();
	await ana.keyboard.type("Alone in here.");

	// Awareness reflects every socket including your own, so a mirror that
	// fails to exclude the local client paints a second caret exactly where
	// the real one is — invisible until somebody selects a word.
	await expect(ana.locator(".plan-cursor")).toHaveCount(0);
});
