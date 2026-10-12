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
	if (await decisions.getAttribute("aria-current") !== "page") await decisions.click();
	await expect(decisions).toHaveAttribute("aria-current", "page");
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

		// Not the top bar's Documents button.
		let documentTab = page.getByRole("button", { name: /^Document(?!s)/ });
		await expect(documentTab).toHaveAccessibleName("Document");
		await rewrite(baseURL!, room, "# Title\n\nRevised paragraph.\n");

		await expect(documentTab).toHaveAccessibleName("Document, new changes");
		await expect(documentTab.locator("[data-document-activity='unseen']")).toBeVisible();
		if (name === "desktop") {
			// A still dot after the label, inside the tab and centred on its text.
			let dot = documentTab.locator("[data-document-activity='unseen']");
			await expect(dot).toHaveCSS("animation-name", "none");
			let mark = (await dot.boundingBox())!;
			let tab = (await documentTab.boundingBox())!;
			expect(mark.x + mark.width).toBeLessThanOrEqual(tab.x + tab.width);
			expect(Math.abs(mark.y + mark.height / 2 - (tab.y + tab.height / 2))).toBeLessThanOrEqual(1);
		}

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
