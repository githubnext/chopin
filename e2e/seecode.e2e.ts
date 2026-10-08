import { content, expect, test, written } from "./room";

let first = {
	type: "architecture",
	title: "Request path",
	motion: "none",
	nodes: [
		{ id: "web", label: "Web", row: 0, col: 0 },
		{ id: "api", label: "API", row: 0, col: 1 },
	],
	edges: [["web", "api"]],
};

test("a saved SeeCode block renders for two readers and revises through shared source", async ({ join, room, seed }) => {
	await seed(
		`# Request path\n\nThe web client sends requests to the API.\n\n\`\`\`seecode\n${
			JSON.stringify(first)
		}\n\`\`\`\n`,
	);
	let ana = await join("ana");
	let bo = await join("bo");
	let preview = (page: typeof ana) =>
		content(page).getByRole("region", {
			name: "Diagram preview",
			exact: true,
		});

	for (let page of [ana, bo]) {
		await expect(preview(page).locator("svg")).toBeVisible();
		await expect(preview(page).locator("svg")).toHaveAttribute("data-sc-type", "architecture");
		await expect(preview(page).getByRole("button", { name: "API", exact: true }))
			.toBeVisible();
		await expect(content(page).locator("[data-plan-source]")).toBeHidden();
	}
	if (process.env.SEECODE_EVIDENCE_PATH) {
		await ana.setViewportSize({ width: 1800, height: 900 });
		await ana.screenshot({
			path: process.env.SEECODE_EVIDENCE_PATH,
			clip: { x: 760, y: 95, width: 1020, height: 500 },
		});
	}

	await preview(ana).getByRole("button", { name: "Web", exact: true }).click();
	await expect(preview(ana).getByRole("complementary", { name: "Diagram details" }))
		.toBeVisible();
	await expect(content(ana).locator("[data-plan-source]")).toBeHidden();
	await expect(preview(bo).getByRole("complementary", { name: "Diagram details" }))
		.toHaveCount(0);

	await content(ana).getByRole("button", { name: "Show source" }).click();
	let source = content(ana).locator("[data-plan-source]");
	await source.selectText();
	await ana.keyboard.insertText(JSON.stringify({ ...first, title: "Revised request path" }));
	await written(ana, room, /Revised request path/);
	await expect(preview(bo).locator("title")).toHaveText("Revised request path");

	await bo.reload();
	await expect(preview(bo).locator("title")).toHaveText("Revised request path");
	await expect(content(bo)).toContainText("The web client sends requests to the API.");
});

test("malformed source shows a bounded error while prose remains usable", async ({ join, room, seed }) => {
	await seed(
		`# Readable prose\n\nThis paragraph remains available.\n\n\`\`\`seecode\n${
			JSON.stringify(first)
		}\n\`\`\`\n`,
	);
	let page = await join("ana");
	await content(page).getByRole("button", { name: "Show source" }).click();
	await content(page).locator("[data-plan-source]").selectText();
	await page.keyboard.insertText("{broken");
	await written(page, room, /```seecode\n\{broken\n```/);
	let error = content(page).locator("[data-plan-error]");
	await expect(error).toContainText("Diagram source must be valid JSON.");
	await expect(content(page)).toContainText("This paragraph remains available.");
	await expect(content(page).locator("[data-plan-source]")).toBeVisible();

	await content(page).locator("[data-plan-source]").selectText();
	await page.keyboard.insertText(JSON.stringify(first));
	await written(page, room, /```seecode\n\{"type":"architecture"/);
	await expect(content(page).getByRole("region", { name: "Diagram preview" }).locator("svg"))
		.toBeVisible();
});
