import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

async function rewrite(baseURL: string, room: string, plan: string): Promise<void> {
	let call = async (id: number, name: string, arguments_: unknown) => {
		let response = await fetch(`${baseURL}/mcp`, {
			method: "POST",
			headers: {
				authorization: "Bearer ghu_e2e_ana_1",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id,
				method: "tools/call",
				params: { name, arguments: arguments_ },
			}),
		});
		expect(response.status).toBe(200);
		return (await response.json()).result.structuredContent;
	};
	let current = await call(1, "read_document", { id: room });
	await call(2, "update_document", {
		id: room,
		revision: current.revision,
		plan,
		idempotencyKey: `e2e-document-activity-${current.revision}`,
	});
}

async function showDecisions(page: Page): Promise<void> {
	let decisions = page.getByRole("button", { name: /^Decisions/ });
	if (await decisions.getAttribute("aria-pressed") !== "true") await decisions.click();
	await expect(decisions).toHaveAttribute("aria-pressed", "true");
}

for (
	let [name, options] of [
		["desktop", { viewport: { width: 1440, height: 900 } }],
		["phone", { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } }],
	] as const
) {
	test(`${name}: changes written out of view mark the Document tab until it is viewed`, async ({ baseURL, join, room, seed }) => {
		await seed("# Title\n\nOriginal paragraph.\n");
		let page = await join("ana", options);
		await expect(content(page)).toContainText("Original paragraph.");
		await showDecisions(page);

		let documentTab = page.getByRole("button", { name: /^Document/ });
		await expect(documentTab).toHaveAccessibleName("Document");
		await rewrite(baseURL!, room, "# Title\n\nRevised paragraph.\n");

		await expect(documentTab).toHaveAccessibleName("Document, new changes");
		await expect(documentTab.locator("[data-document-activity='unseen']")).toBeVisible();

		await documentTab.click();
		await expect(content(page)).toContainText("Revised paragraph.");
		await expect(documentTab.locator("[data-document-activity]")).toHaveCount(0);
		await showDecisions(page);
		await expect(documentTab).toHaveAccessibleName("Document");
	});
}

test("changes made while the Document is in view leave no cue", async ({ baseURL, join, room, seed }) => {
	await seed("# Title\n\nOriginal paragraph.\n");
	let page = await join("ana");
	await expect(content(page)).toContainText("Original paragraph.");
	await rewrite(baseURL!, room, "# Title\n\nRevised paragraph.\n");
	await expect(content(page)).toContainText("Revised paragraph.");
	await showDecisions(page);
	await expect(page.locator("[data-document-activity]")).toHaveCount(0);
});

test("discarding a decision out of view leaves the Document tab quiet", async ({ join, seed }) => {
	await seed("# Title\n\nOriginal paragraph.\n");
	let page = await join("ana");
	await showDecisions(page);
	let card = page.getByRole("region", { name: "Decisions" })
		.locator("article[data-plan-sidecar-questionnaire]").first();
	await card.getByRole("button", { name: "Discard", exact: true }).click();
	await card.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(page.getByRole("button", { name: /resolved$/ })).toBeVisible();
	await expect(page.getByRole("button", { name: "Document", exact: true })).toBeVisible();
	await expect(page.locator("[data-document-activity]")).toHaveCount(0);
});
