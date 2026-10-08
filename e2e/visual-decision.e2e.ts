import { expect } from "./room";
import {
	card,
	createDecision,
	durableProjection,
	durableState,
	openWire,
	request,
	showDecisions,
	state,
	test,
} from "./visual-decision.helpers";

import type { VisualDecision } from "../packages/protocol/index";
import type { Page, WebSocketRoute } from "@playwright/test";

async function padding(page: Page, value: 4 | 6 | 8) {
	let field = card(page).getByRole("slider", { name: "Option vertical padding", exact: true });
	await field.focus();
	await page.keyboard.press("Home");
	if (value >= 6) await page.keyboard.press("ArrowRight");
	if (value === 8) await page.keyboard.press("ArrowRight");
	await expect(field).toHaveValue(String(value));
	await expect(card(page).getByRole("button", { name: "Save decision", exact: true }))
		.toBeEnabled();
}

test("collaborators converge per control, reconnect, then save attributed values durably", async ({ join, page, room }) => {
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			let kind = typeof message === "string" ? JSON.parse(message).kind : undefined;
			if (kind === "visual-decision:edit" || kind === "visual-decision:changed") {
				setTimeout(() => route.send(message), 150);
			} else route.send(message);
		});
	});
	let ana = await join("ana");
	let id = await createDecision(ana);
	let ben = await join("ben");
	let offline = false;
	let sockets: WebSocketRoute[] = [];
	await ben.routeWebSocket("**/ws?**", socket => {
		if (offline) return socket.close();
		socket.connectToServer();
		sockets.push(socket);
	});
	await ben.reload();
	await showDecisions(ben);
	await expect(card(ben)).toBeVisible();
	await Promise.all([
		padding(ana, 8),
		card(ben).getByRole("textbox", { name: "Selected-option colour", exact: true }).fill("#AABBCC"),
	]);
	await expect(card(ana).getByRole("textbox", { name: "Selected-option colour", exact: true }))
		.toHaveValue("#AABBCC");
	await expect(card(ben).getByRole("slider", { name: "Option vertical padding", exact: true }))
		.toHaveValue("8");
	await padding(ben, 4);
	await expect(card(ana).getByRole("slider", { name: "Option vertical padding", exact: true }))
		.toHaveValue("4");
	await padding(ana, 6);
	await expect(card(ben).getByRole("slider", { name: "Option vertical padding", exact: true }))
		.toHaveValue("6");
	await openWire(ana, room);
	await openWire(ben, room);
	let replies = await Promise.all([4, 8].map((value, index) =>
		request(index ? ben : ana, {
			kind: "visual-decision:edit",
			id,
			key: `${crypto.randomUUID()}:1`,
			patch: { optionPadding: value },
		})
	));
	for (let reply of replies) expect(reply.ok).toBe(true);
	let accepted = replies.map(reply => reply.state as VisualDecision.State)
		.sort((a, b) => b.revision - a.revision)[0]!;
	for (let peer of [ana, ben]) {
		await expect(card(peer).getByRole("slider", { name: "Option vertical padding", exact: true }))
			.toHaveValue(String(accepted.values.optionPadding));
	}
	let color = card(ana).getByRole("textbox", { name: "Selected-option colour", exact: true });
	for (let unfinished of ["#AB", ""]) {
		await color.fill(unfinished);
		await padding(ben, unfinished ? 6 : 4);
		await expect(card(ana).getByRole("slider", { name: "Option vertical padding", exact: true }))
			.toHaveValue(unfinished ? "6" : "4");
		await expect(color).toHaveValue(unfinished);
		await expect(card(ana).getByRole("button", { name: "Save decision", exact: true }))
			.toBeDisabled();
	}
	await color.fill("#AABBCC");
	await expect(card(ana).getByRole("button", { name: "Save decision", exact: true }))
		.toBeEnabled();

	offline = true;
	await Promise.all(sockets.map(socket => socket.close()));
	await expect(card(ben).getByRole("button", { name: "Save decision", exact: true }))
		.toBeDisabled();
	await padding(ana, 8);
	offline = false;
	await expect(card(ben).getByRole("slider", { name: "Option vertical padding", exact: true }))
		.toHaveValue("8");
	await expect(card(ben).getByRole("button", { name: "Save decision", exact: true })).toBeEnabled();
	await ben.reload();
	await showDecisions(ben);
	await expect(card(ben).getByRole("slider", { name: "Option vertical padding", exact: true }))
		.toHaveValue("8");
	await expect(card(ben).getByRole("textbox", { name: "Selected-option colour", exact: true }))
		.toHaveValue("#AABBCC");

	await openWire(ana, room);
	let before = await state(ana, id);
	await card(ben).getByRole("button", { name: "Save decision", exact: true }).click();
	await expect(card(ben)).toContainText("@ben");
	await expect.poll(async () => (await state(ana, id)).saved).toMatchObject({
		revision: before.revision,
		values: { optionPadding: 8, selectedColor: "#AABBCC" },
		by: "ben",
		at: expect.any(String),
	});
	await expect.poll(() => durableState(room)).toMatchObject({
		visualDecisions: [expect.objectContaining({
			id,
			saved: expect.objectContaining({
				by: "ben",
				values: { optionPadding: 8, selectedColor: "#AABBCC" },
			}),
		})],
	});
	let source = await durableProjection(room);
	expect(source).toContain('by="ben"');
	expect(source).toContain("Option vertical padding: 8 px; selected-option colour: #AABBCC");
	await ben.reload();
	await showDecisions(ben);
	// Resolved visual decisions remain discoverable alongside ordinary decision history.
	let history = ben.getByRole("button", { name: /resolved/i });
	await expect(history).toBeVisible();
	if (!await card(ben).isVisible()) await history.click();
	await expect(card(ben)).toContainText("@ben");
	await expect(card(ben).getByRole("textbox", { name: "Selected-option colour", exact: true }))
		.toHaveValue("#AABBCC");
	await expect(card(ben)).toContainText("8 px");
	await expect(card(ben).getByRole("button", { name: "Save decision", exact: true })).toHaveCount(
		0,
	);
});

for (let destination of ["decisions", "plan"]) {
	test(`a brief reconnect restores missed values and acknowledges the outbox in ${destination}`, async ({ join, page, room }) => {
		let lost = Promise.withResolvers<void>();
		let resume = Promise.withResolvers<void>();
		let rejoined = Promise.withResolvers<void>();
		let drop = false;
		let lostAt: number | undefined;
		let rejoinedAt: number | undefined;
		let edits: string[] = [];
		await page.routeWebSocket("**/ws?**", async route => {
			if (lostAt !== undefined) await resume.promise;
			let server = route.connectToServer();
			route.onMessage(message => {
				if (typeof message === "string") {
					let frame = JSON.parse(message);
					if (frame.kind === "visual-decision:edit") edits.push(frame.key);
				}
				server.send(message);
			});
			server.onMessage(message => {
				let kind = typeof message === "string" ? JSON.parse(message).kind : undefined;
				if (drop && (kind === "visual-decision:edit" || kind === "visual-decision:changed")) {
					if (kind === "visual-decision:edit") {
						drop = false;
						lostAt = Date.now();
						route.close();
						server.close();
						lost.resolve();
					}
					return;
				}
				if (lostAt !== undefined && kind === "session:hello") {
					rejoinedAt = Date.now();
					rejoined.resolve();
				}
				route.send(message);
			});
		});
		let ana = await join("ana");
		let id = await createDecision(ana);
		let ben = await join("ben");
		await openWire(ben, room);
		await ana.getByRole("button", {
			name: destination === "plan" ? "Document" : /^Decisions/,
			exact: destination === "plan",
		}).click();
		let specimen = ana.locator(`[data-document-view="${destination}"]`).getByRole("article", {
			name: "Visual decision",
			exact: true,
		});
		let color = specimen.getByRole("textbox", { name: "Selected-option colour", exact: true });
		drop = true;
		await color.fill("#112233");
		await lost.promise;
		let latest = await request(ben, {
			kind: "visual-decision:edit",
			id,
			key: `${crypto.randomUUID()}:1`,
			patch: { optionPadding: 8, selectedColor: "#AABBCC" },
		});
		expect(latest.ok).toBe(true);
		resume.resolve();
		await rejoined.promise;
		expect(rejoinedAt! - lostAt!).toBeLessThan(1_500);
		await expect(specimen.getByRole("slider", { name: "Option vertical padding", exact: true }))
			.toHaveValue("8");
		await expect(color).toHaveValue("#AABBCC");
		await expect(specimen.getByRole("button", { name: "Save decision", exact: true }))
			.toBeEnabled();
		expect(edits).toHaveLength(2);
		expect(edits[1]).toBe(edits[0]);
		expect((await state(ben, id)).values).toEqual({ optionPadding: 8, selectedColor: "#AABBCC" });
	});
}

test("a concurrent accepted edit makes Save refuse the stale revision for review", async ({ join, page, room }) => {
	let hold = false;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (
				typeof message === "string" && hold
				&& JSON.parse(message).kind === "visual-decision:changed"
			) return;
			route.send(message);
		});
	});
	let ana = await join("ana");
	let id = await createDecision(ana);
	let ben = await join("ben");
	await showDecisions(ben);
	await openWire(ben, room);
	let original = await state(ben, id);
	hold = true;
	await padding(ben, 8);
	await expect(card(ana).getByRole("slider", { name: "Option vertical padding", exact: true }))
		.toHaveValue("6");
	await card(ana).getByRole("button", { name: "Save decision", exact: true }).click();
	await expect(card(ana).getByRole("alert")).toContainText(/changed|review|latest/i);
	await expect(card(ana).getByRole("slider", { name: "Option vertical padding", exact: true }))
		.toHaveValue("8");
	let latest = await state(ben, id);
	expect(latest.revision).toBeGreaterThan(original.revision);
	expect(latest.saved).toBeUndefined();
	expect((await durableState(room))?.visualDecisions).toEqual([expect.objectContaining({
		values: { optionPadding: 8, selectedColor: latest.values.selectedColor },
	})]);
	hold = false;
	await card(ana).getByRole("button", { name: "Save decision", exact: true }).click();
	await expect(card(ana)).toContainText("@ana");
});

test("viewers observe live values but raw mutation requests and controls require write access", async ({ join, room }) => {
	let ana = await join("ana");
	let id = await createDecision(ana);
	let reader = await join("readonly");
	await showDecisions(reader);
	await expect(card(reader)).toBeVisible();
	await expect(card(reader).getByRole("slider", { name: "Option vertical padding", exact: true }))
		.toBeDisabled();
	await expect(card(reader).getByRole("textbox", { name: "Selected-option colour", exact: true }))
		.toBeDisabled();
	await expect(card(reader).getByRole("button", { name: "Save decision", exact: true }))
		.toBeDisabled();
	await padding(ana, 8);
	await expect(card(reader).getByRole("slider", { name: "Option vertical padding", exact: true }))
		.toHaveValue("8");
	await openWire(reader, room);
	let latest = await state(reader, id);
	for (
		let frame of [
			{ kind: "visual-decision:create", key: crypto.randomUUID() },
			{
				kind: "visual-decision:edit",
				id,
				key: `${crypto.randomUUID()}:1`,
				patch: { optionPadding: 4 },
			},
			{ kind: "visual-decision:save", id, revision: latest.revision },
		]
	) {
		expect(await request(reader, frame)).toMatchObject({
			kind: "session:error",
			message: expect.stringMatching(/write access/),
		});
	}
	expect((await state(reader, id)).values).toEqual(latest.values);
	expect((await state(reader, id)).saved).toBeUndefined();
});
