import { expect } from "./room";
import {
	card,
	durableState,
	openWire,
	request,
	showDecisions,
	state,
	test,
} from "./visual-decision.helpers";

test("two component definitions use the same controls, preview bridge and durable Save", async ({ join, room }) => {
	let ana = await join("ana", { viewport: { width: 1440, height: 1000 } });
	await showDecisions(ana);
	let billing = card(ana, "Billing card");
	let profile = card(ana, "Profile banner");
	await expect(billing).toBeVisible();
	await expect(profile).toBeVisible();
	await expect(billing.locator('[data-visual-preview-state="ready"]')).toBeVisible();
	await expect(profile.locator('[data-visual-preview-state="ready"]')).toBeVisible();
	let billingId = (await billing.getAttribute("data-visual-decision"))!;
	let profileId = (await profile.getAttribute("data-visual-decision"))!;
	await openWire(ana, room);
	let first = await state(ana, billingId);
	let second = await state(ana, profileId);
	expect(first.definition.controls.map(control => control.id)).toEqual([
		"cardSpacing",
		"accentColor",
	]);
	expect(second.definition.controls.map(control => control.id)).toEqual([
		"cornerRadius",
		"surfaceColor",
	]);
	expect(first.definition.artifact.digest).not.toBe(second.definition.artifact.digest);

	let spacing = billing.getByRole("slider", { name: "Card spacing", exact: true });
	await spacing.focus();
	await ana.keyboard.press("End");
	await billing.getByRole("textbox", { name: "Accent colour", exact: true }).fill("#AABBCC");
	await expect.poll(async () => (await state(ana, billingId)).values).toEqual({
		cardSpacing: 24,
		accentColor: "#AABBCC",
	});
	let price = billing.frameLocator("iframe").locator("#billing-price");
	await expect(price).toHaveText("$72 / month");
	let accepted = await state(ana, billingId);
	let peek = billing.getByRole("button", { name: "Show baseline", exact: true });
	let box = (await peek.boundingBox())!;
	await ana.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await ana.mouse.down();
	await expect(price).toHaveText("$48 / month");
	expect(await state(ana, billingId)).toEqual(accepted);
	await ana.mouse.up();
	await expect(price).toHaveText("$72 / month");
	await billing.getByRole("button", { name: "Save decision", exact: true }).click();
	await expect(billing).toContainText("@ana");
	let saved = (await state(ana, billingId)).saved;
	expect(saved).toMatchObject({
		decisionId: billingId,
		requestId: first.definition.requestId,
		definitionRevision: first.definition.definitionRevision,
		artifactDigest: first.definition.artifact.digest,
		values: { cardSpacing: 24, accentColor: "#AABBCC" },
		by: "ana",
	});

	let radius = profile.getByRole("slider", { name: "Corner radius", exact: true });
	await radius.focus();
	await ana.keyboard.press("End");
	await profile.getByRole("textbox", { name: "Surface colour", exact: true }).fill("#CCDDEE");
	await expect(profile.frameLocator("iframe").locator("#profile-caption"))
		.toHaveText("20px corners");
	await expect.poll(async () => (await state(ana, profileId)).values).toEqual({
		cornerRadius: 20,
		surfaceColor: "#CCDDEE",
	});
	await expect.poll(() => durableState(room)).toMatchObject({
		visualDecisions: expect.arrayContaining([
			expect.objectContaining({ id: billingId, saved: expect.objectContaining({ by: "ana" }) }),
			expect.objectContaining({
				id: profileId,
				values: { cornerRadius: 20, surfaceColor: "#CCDDEE" },
			}),
		]),
	});
	await ana.reload();
	await showDecisions(ana);
	await expect(card(ana, "Billing card")).toContainText("@ana");
	await expect(
		card(ana, "Profile banner").getByRole("slider", {
			name: "Corner radius",
			exact: true,
		}),
	).toHaveValue("20");
});

test("concurrent peer edits converge and make a version-bound Save stale", async ({ join, room }) => {
	let ana = await join("ana");
	let ben = await join("ben");
	await showDecisions(ana);
	await showDecisions(ben);
	let id = (await card(ana, "Billing card").getAttribute("data-visual-decision"))!;
	await openWire(ana, room);
	await openWire(ben, room);
	let before = await state(ana, id);
	let updates = await Promise.all([
		request(ana, {
			kind: "visual-decision:edit",
			id,
			key: `${crypto.randomUUID()}:1`,
			patch: { accentColor: "#AABBCC" },
		}),
		request(ben, {
			kind: "visual-decision:edit",
			id,
			key: `${crypto.randomUUID()}:1`,
			patch: { cardSpacing: 20 },
		}),
	]);
	expect(updates.every(update => update.ok)).toBe(true);
	await expect.poll(async () => (await state(ana, id)).values).toEqual({
		cardSpacing: 20,
		accentColor: "#AABBCC",
	});
	await expect.poll(async () => (await state(ben, id)).values).toEqual({
		cardSpacing: 20,
		accentColor: "#AABBCC",
	});
	let stale = await request(ana, {
		kind: "visual-decision:save",
		id,
		revision: before.revision,
		definitionRevision: before.definition.definitionRevision,
	});
	expect(stale).toMatchObject({ ok: false, reason: "stale" });
	await expect(
		card(ana, "Billing card").getByRole("slider", {
			name: "Card spacing",
			exact: true,
		}),
	).toHaveValue("20");
	let latest = await state(ana, id);
	expect(latest.saved).toBeUndefined();
	let invalidVersion = await request(ana, {
		kind: "visual-decision:save",
		id,
		revision: latest.revision,
		definitionRevision: "sha256:" + "0".repeat(64),
	});
	expect(invalidVersion).toMatchObject({ ok: false, reason: "stale" });
});

test("viewers see shared values but cannot edit or save", async ({ join, room }) => {
	let ana = await join("ana");
	let reader = await join("readonly");
	await showDecisions(ana);
	await showDecisions(reader);
	let id = (await card(ana, "Billing card").getAttribute("data-visual-decision"))!;
	let preview = card(reader, "Billing card");
	await expect(preview.getByRole("slider", { name: "Card spacing", exact: true }))
		.toBeDisabled();
	await expect(preview.getByRole("textbox", { name: "Accent colour", exact: true }))
		.toBeDisabled();
	await expect(preview.getByRole("button", { name: "Save decision", exact: true }))
		.toBeDisabled();
	await openWire(reader, room);
	let before = await state(reader, id);
	for (
		let frame of [
			{
				kind: "visual-decision:edit",
				id,
				key: `${crypto.randomUUID()}:1`,
				patch: { cardSpacing: 24 },
			},
			{
				kind: "visual-decision:save",
				id,
				revision: before.revision,
				definitionRevision: before.definition.definitionRevision,
			},
		]
	) {
		expect(await request(reader, frame)).toMatchObject({
			kind: "session:error",
			message: expect.stringMatching(/write access/),
		});
	}
	expect((await state(reader, id)).values).toEqual(before.values);
});
