import { authenticate, expect, roomPath, test } from "./room";

import type { Agenda } from "../packages/protocol";

const SCOPE =
	"Explore public evidence about how collaborative writing tools explain open and resolved decisions, and help people discover manual decision creation.";

test("agenda scope is explicitly saved, persists on reload, and cannot launch while agents are off", async ({ join, room, baseURL }) => {
	let page = await join("ana");
	let endpoint = `/api/channels/${room}/research-agenda`;
	let initial = await page.request.get(endpoint);
	expect(initial.ok()).toBe(true);
	let empty = await initial.json() as Agenda.Response;
	expect(empty.agenda).toBeNull();
	expect(empty.available).toBe(false);

	await page.getByRole("button", { name: /^Actions for / }).last().click();
	await page.getByRole("menuitem", { name: "Research agenda", exact: true }).click();
	let dialog = page.getByRole("dialog", { name: "Research agenda", exact: true });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("textbox", { name: "Public research scope", exact: true }).fill(SCOPE);
	await expect(dialog.getByRole("button", { name: "Allow public research", exact: true }))
		.toBeDisabled();
	await dialog.getByRole("button", { name: "Save paused", exact: true }).click();
	await expect(dialog.getByText(SCOPE, { exact: true })).toBeVisible();
	await page.reload();
	await page.getByRole("button", { name: /^Actions for / }).last().click();
	await page.getByRole("menuitem", { name: "Research agenda", exact: true }).click();
	await expect(dialog.getByText(SCOPE, { exact: true })).toBeVisible();

	let saved = await (await page.request.get(endpoint)).json() as Agenda.Response;
	expect(saved.agenda?.state).toBe("paused");
	expect(saved.agenda?.investigations).toBe(0);
	let denied = await page.request.post(`${endpoint}/activate`, {
		headers: { origin: baseURL! },
		data: { expectedRevision: saved.agenda!.revision },
	});
	expect(denied.status()).toBe(503);
	await page.keyboard.press("Escape");
	await expect(dialog).not.toBeVisible();
});

test("readers can inspect an agenda but cannot edit or delegate it; foreign origins are refused", async ({ join, room, browser, baseURL }) => {
	let writer = await join("ana");
	let endpoint = `/api/channels/${room}/research-agenda`;
	let saved = await writer.request.put(endpoint, {
		headers: { origin: baseURL! },
		data: { expectedRevision: 0, scope: SCOPE, questions: [] },
	});
	expect(saved.ok()).toBe(true);
	let latest = await saved.json() as Agenda.Response;
	let revision = latest.agenda!.revision;
	let badOrigin = await writer.request.put(endpoint, {
		headers: { origin: "https://untrusted.invalid" },
		data: {
			expectedRevision: revision,
			scope: "Research a different public topic safely.",
			questions: [],
		},
	});
	expect(badOrigin.status()).toBe(403);
	let context = await browser.newContext({ baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		await reader.getByRole("button", { name: /^Actions for / }).last().click();
		await reader.getByRole("menuitem", { name: "Research agenda", exact: true }).click();
		let dialog = reader.getByRole("dialog", { name: "Research agenda", exact: true });
		await expect(dialog.getByText(SCOPE, { exact: true })).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Allow public research", exact: true }))
			.toHaveCount(0);
		await expect(dialog.getByRole("textbox")).toHaveCount(0);
		for (let action of ["activate", "pause"]) {
			let denied = await reader.request.post(`${endpoint}/${action}`, {
				headers: { origin: baseURL! },
				data: action === "pause"
					? { expectedGeneration: latest.agenda!.generation }
					: { expectedRevision: revision },
			});
			expect(denied.status()).toBe(403);
		}
		let denied = await reader.request.put(endpoint, {
			headers: { origin: baseURL! },
			data: { expectedRevision: revision, scope: SCOPE, questions: [] },
		});
		expect(denied.status()).toBe(403);
	} finally {
		await context.close();
	}
	let unchanged = await (await writer.request.get(endpoint)).json() as Agenda.Response;
	expect(unchanged.agenda?.revision).toBe(revision);
});
