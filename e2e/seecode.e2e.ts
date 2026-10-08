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

let astro = {
	type: "architecture",
	nodes: [
		{ id: "project", label: "Astro project", row: 0, col: 0 },
		{ id: "cli", label: "Astro CLI", row: 0, col: 1 },
		{ id: "deps", label: "CLI dependencies", row: 1, col: 1 },
		{ id: "builder", label: "Builder stage", row: 0, col: 2 },
		{ id: "dist", label: "SSR build output", row: 0, col: 3 },
		{ id: "release", label: "Release stage", row: 1, col: 3 },
		{ id: "entry", label: "Server entry", row: 1, col: 4 },
	],
	edges: [
		["project", "cli", "installs"],
		["cli", "deps", "requires at runtime"],
		["builder", "cli", "runs astro build"],
		["builder", "dist", "produces"],
		["release", "dist", "copies"],
		["release", "entry", "runs node"],
		["project", "release", "production install may include CLI deps"],
	],
};

test(
	"a saved wide diagram keeps native label scale inside its own scroller",
	async ({ join, room, seed }, testInfo) => {
		let source =
			`# Astro runtime\n\nThe build and release stages have different dependencies.\n\n\`\`\`seecode\n${
				JSON.stringify(astro)
			}\n\`\`\`\n\nThe runtime package split remains a proposal.\n`;
		await seed(source);
		let page = await join("ana");
		await page.emulateMedia({ reducedMotion: "reduce" });
		let preview = content(page).getByRole("region", { name: "Diagram preview" });
		let stage = preview.locator(".ch-diagram__stage");
		let svg = stage.locator("svg");

		for (let viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
			await page.setViewportSize(viewport);
			await expect(svg).toBeVisible();
			await expect(svg.locator("[data-sc-node]")).toHaveCount(7);
			await expect(svg.getByRole("button", { name: "Astro project", exact: true }))
				.toBeVisible();
			let geometry = await stage.evaluate(element => {
				let svg = element.querySelector("svg")!;
				let viewBox = svg.viewBox.baseVal;
				let scale = svg.getBoundingClientRect().width / viewBox.width;
				let documentPane = element.closest("[data-plan-scroll]");
				let stageBounds = element.getBoundingClientRect();
				let documentBounds = documentPane?.getBoundingClientRect();
				return {
					viewBoxWidth: viewBox.width,
					scale,
					stageWidth: element.clientWidth,
					scrollWidth: element.scrollWidth,
					pageWidth: document.documentElement.clientWidth,
					pageScrollWidth: document.documentElement.scrollWidth,
					documentWidth: documentPane?.clientWidth ?? 0,
					documentScrollWidth: documentPane?.scrollWidth ?? 0,
					stageLeft: stageBounds.left,
					stageRight: stageBounds.right,
					documentLeft: documentBounds?.left ?? 0,
					documentRight: documentBounds?.right ?? 0,
				};
			});
			expect(geometry.viewBoxWidth).toBe(1204);
			expect(geometry.scale).toBeGreaterThanOrEqual(1);
			expect(geometry.scrollWidth).toBeGreaterThan(geometry.stageWidth);
			expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.pageWidth + 1);
			expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentWidth + 1);
			expect(geometry.stageLeft).toBeGreaterThanOrEqual(geometry.documentLeft - 1);
			expect(geometry.stageRight).toBeLessThanOrEqual(geometry.documentRight + 1);
			await expect(stage).toHaveAttribute("tabindex", "0");
			await stage.focus();
			await stage.press("ArrowRight");
			await expect.poll(() => stage.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
			let end = await stage.evaluate(element => {
				element.scrollLeft = element.scrollWidth;
				return { actual: element.scrollLeft, maximum: element.scrollWidth - element.clientWidth };
			});
			expect(end.actual).toBeGreaterThanOrEqual(end.maximum - 1);
			await stage.evaluate(element => element.scrollLeft = 0);
			await expect.poll(() => stage.evaluate(element => element.scrollLeft)).toBe(0);
			await page.screenshot({ path: testInfo.outputPath(`astro-${viewport.width}.png`) });
		}

		await page.reload();
		await expect(preview.locator("svg")).toBeVisible();
		await written(page, room, /production install may include CLI deps/);
	},
);

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
	let small = await preview(ana).locator(".ch-diagram__stage").evaluate(element => ({
		width: element.clientWidth,
		scrollWidth: element.scrollWidth,
		svgWidth: element.querySelector("svg")!.getBoundingClientRect().width,
	}));
	expect(small.svgWidth).toBeGreaterThanOrEqual(344);
	expect(small.scrollWidth).toBeLessThanOrEqual(small.width + 1);
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
