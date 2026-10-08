import { expect, test } from "./room";
import { card, createDecision, openWire, state } from "./visual-decision.helpers";

test("bridge rejects peer, stale, malformed and oversized replies without changing authority", async ({ join, room }) => {
	let ana = await join("ana");
	let id = await createDecision(ana);
	await openWire(ana, room);
	await expect(card(ana).locator('[data-visual-preview-state="ready"]')).toBeVisible();
	let iframe = card(ana).locator("iframe");
	let child = (await (await iframe.elementHandle())!.contentFrame())!;
	await child.evaluate(() => {
		window.addEventListener("message", event => {
			if (event.source === parent) {
				(window as typeof window & { __envelope?: unknown }).__envelope = event.data;
			}
		});
	});
	await card(ana).getByRole("textbox", { name: "Selected-option colour", exact: true }).fill(
		"#AABBCC",
	);
	await expect(card(ana).getByRole("button", { name: "Save decision", exact: true })).toBeEnabled();
	await expect.poll(() =>
		child.evaluate(() =>
			(window as typeof window & { __envelope?: { values: { selectedColor: string } } }).__envelope
				?.values.selectedColor
		)
	).toBe("#AABBCC");
	let envelope = await child.evaluate(() =>
		(window as typeof window & { __envelope?: Record<string, unknown> }).__envelope!
	);
	let accepted = await state(ana, id);
	await child.evaluate(
		data => parent.postMessage({ ...data, type: "size", height: 501 }, "*"),
		envelope,
	);
	await expect(iframe).toHaveCSS("height", "501px");
	let invalid = [
		{ ...envelope, type: "size", height: 502, extra: true },
		{ ...envelope, type: "size", height: 4097 },
		{ ...envelope, type: "size", height: 0 },
		{ ...envelope, type: "size", height: 502, session: "old_session_123456789" },
		{ ...envelope, type: "size", height: 502, revision: -1 },
		{
			...envelope,
			type: "size",
			height: 502,
			values: { optionPadding: 8, selectedColor: "#FFFFFF" },
		},
		{ ...envelope, type: "size", height: 502, extra: "x".repeat(1_000_000) },
	];
	await child.evaluate(messages => {
		for (let data of messages) parent.postMessage(data, "*");
	}, invalid);
	await expect(iframe).toHaveCSS("height", "501px");
	let src = await iframe.getAttribute("src");
	await ana.evaluate(source => {
		let peer = document.createElement("iframe");
		peer.title = "Boundary peer";
		peer.sandbox.add("allow-scripts");
		peer.src = source!;
		peer.style.display = "none";
		document.body.append(peer);
	}, src);
	let peer = ana.frameLocator('iframe[title="Boundary peer"]');
	await expect(peer.getByText("How should people sign in to this prototype?", { exact: true }))
		.toBeAttached();
	await peer.locator("body").evaluate(
		(_element, data) => parent.postMessage({ ...data, type: "size", height: 502 }, "*"),
		envelope,
	);
	await expect(iframe).toHaveCSS("height", "501px");
	await ana.locator('iframe[title="Boundary peer"]').evaluate(element => element.remove());

	// After a real bundle reload, the same frame has a new handshake session.
	await child.evaluate(() => location.reload());
	await expect(card(ana).locator('[data-visual-preview-state="ready"]')).toBeVisible();
	let reloaded = (await (await iframe.elementHandle())!.contentFrame())!;
	await expect(reloaded.getByText("How should people sign in to this prototype?", { exact: true }))
		.toBeVisible();
	await reloaded.evaluate(
		data => parent.postMessage({ ...data, type: "size", height: 502 }, "*"),
		envelope,
	);
	await expect(iframe).not.toHaveCSS("height", "502px");
	expect(await state(ana, id)).toEqual(accepted);
});

test("wrong bytes fail verification, and missing handshakes stop after bounded replacement with Retry", async ({ join, page }) => {
	let corrupted = true;
	let noHandshake = false;
	let navigations = 0;
	await page.route("**/bundles/*/bundle.html", async route => {
		let response = await route.fetch();
		if (route.request().isNavigationRequest()) {
			navigations++;
			if (noHandshake) {
				await route.fulfill({ response, body: "<!doctype html><title>No handshake</title>" });
				return;
			}
		} else if (corrupted) {
			let body = await response.body();
			body[0] = body[0]! ^ 1;
			await route.fulfill({ response, body });
			return;
		}
		await route.fulfill({ response });
	});
	let ana = await join("ana");
	await createDecision(ana);
	await expect(card(ana).getByRole("alert")).toContainText("Preview bundle changed");
	expect(navigations).toBe(0);
	corrupted = false;
	noHandshake = true;
	await card(ana).getByRole("button", { name: "Retry preview", exact: true }).click();
	await expect(card(ana).getByRole("alert")).toContainText("Preview could not reconnect", {
		timeout: 12_000,
	});
	expect(navigations).toBe(3);
	noHandshake = false;
	await card(ana).getByRole("button", { name: "Retry preview", exact: true }).click();
	await expect(card(ana).locator('[data-visual-preview-state="ready"]')).toBeVisible();
	await expect(card(ana).locator("iframe:visible")).toHaveCount(1);
});
