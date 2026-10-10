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

test("document diagrams retain their descriptive node labels", async ({ seed, join }) => {
	await seed(`# Descriptive diagram\n\n\`\`\`seecode\n${
		JSON.stringify({
			...first,
			nodes: [{ id: "web", label: "Web", sub: "Browser client" }, { id: "api", label: "API" }],
		})
	}\n\`\`\`\n`);
	let page = await join("ana");
	let preview = content(page).getByRole("region", { name: "Diagram preview" });
	await expect(preview.getByRole("button", { name: "Web, Browser client", exact: true }))
		.toBeVisible();
});

test(
	"a wide diagram derives a readable narrower view with bounded zoom and unchanged source",
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
			await expect(content(page).getByRole("button", { name: "Show source" })).toHaveCount(0);
			await expect(preview.getByText(/Scroll sideways/)).toHaveCount(0);
			await expect(stage).toHaveCSS("border-width", "0px");
			await expect(content(page).locator('[data-plan-presentation="diagram"]')).toHaveCSS(
				"border-width",
				"0px",
			);
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
			expect(geometry.viewBoxWidth).toBeLessThanOrEqual(1100);
			expect(geometry.scale).toBeGreaterThanOrEqual(1);
			if (geometry.viewBoxWidth <= geometry.stageWidth) {
				expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.stageWidth + 1);
			} else {
				expect(geometry.scrollWidth).toBeGreaterThan(geometry.stageWidth);
			}
			expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.pageWidth + 1);
			expect(geometry.documentScrollWidth).toBeLessThanOrEqual(geometry.documentWidth + 1);
			expect(geometry.stageLeft).toBeGreaterThanOrEqual(geometry.documentLeft - 1);
			expect(geometry.stageRight).toBeLessThanOrEqual(geometry.documentRight + 1);
			if (geometry.scrollWidth <= geometry.stageWidth + 1) continue;
			await expect(stage).toHaveAttribute("tabindex", "0");
			await stage.focus();
			await stage.evaluate(element => {
				element.setAttribute("data-keyboard-scroll-complete", "false");
				element.addEventListener("scrollend", () => {
					element.setAttribute("data-keyboard-scroll-complete", "true");
				}, { once: true });
			});
			await stage.press("ArrowRight");
			await expect.poll(() => stage.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
			await expect(stage).toHaveAttribute("data-keyboard-scroll-complete", "true");
			let end = await stage.evaluate(element => {
				element.scrollLeft = element.scrollWidth;
				return { actual: element.scrollLeft, maximum: element.scrollWidth - element.clientWidth };
			});
			expect(end.actual).toBeGreaterThanOrEqual(end.maximum - 1);
			await stage.evaluate(element => element.scrollLeft = 0);
			await expect.poll(() => stage.evaluate(element => element.scrollLeft)).toBe(0);
			await page.screenshot({ path: testInfo.outputPath(`astro-${viewport.width}.png`) });
		}

		await svg.getByRole("button", { name: "Astro project", exact: true }).click();
		await expect(preview.getByRole("complementary", { name: "Diagram details" }))
			.toBeVisible();
		let nativeWidth = await svg.evaluate(element => element.getBoundingClientRect().width);
		await preview.getByRole("button", { name: "Fit to width", exact: true }).click();
		await expect(preview.getByLabel("Diagram zoom", { exact: true })).toHaveText("85%");
		await expect.poll(() => svg.evaluate(element => element.getBoundingClientRect().width))
			.toBeCloseTo(nativeWidth * 0.85, 0);
		await preview.getByRole("button", { name: "Zoom in diagram", exact: true }).click();
		await expect(preview.getByLabel("Diagram zoom", { exact: true })).toHaveText("100%");
		await preview.getByRole("button", { name: "Zoom in diagram", exact: true }).click();
		await expect(preview.getByLabel("Diagram zoom", { exact: true })).toHaveText("115%");
		await page.setViewportSize({ width: 1452, height: 895 });
		await expect(
			preview.getByRole("complementary", { name: "Diagram details" })
				.getByRole("heading", { name: "Astro project", exact: true }),
		).toBeVisible();
		await expect(preview.getByLabel("Diagram zoom", { exact: true })).toHaveText("115%");
		await preview.getByRole("button", { name: "Actual size", exact: true }).click();
		await expect.poll(() =>
			svg.evaluate(element =>
				element.getBoundingClientRect().width / (element as SVGSVGElement).viewBox.baseVal.width
			)
		)
			.toBeCloseTo(1, 2);
		await page.reload();
		await expect(preview.locator("svg.sc-svg")).toBeVisible();
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
		await expect(preview(page).locator("svg.sc-svg")).toBeVisible();
		await expect(preview(page).locator("svg.sc-svg")).toHaveAttribute(
			"data-sc-type",
			"architecture",
		);
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
	await expect(content(ana).getByRole("button", { name: "Show source" })).toHaveCount(0);
	if (process.env.SEECODE_INTERACTION_EVIDENCE_PATH) {
		await ana.screenshot({ path: process.env.SEECODE_INTERACTION_EVIDENCE_PATH });
	}
	await preview(ana).getByRole("button", { name: "Close diagram details", exact: true }).click();
	await expect(preview(ana).getByRole("complementary", { name: "Diagram details" }))
		.toHaveCount(0);
	await expect(content(ana).locator("[data-plan-source]")).toBeHidden();
	let web = preview(ana).getByRole("button", { name: "Web", exact: true });
	await web.focus();
	await web.press("Enter");
	await expect(preview(ana).getByRole("complementary", { name: "Diagram details" }))
		.toBeVisible();
	await expect(content(ana).locator("[data-plan-source]")).toBeHidden();

	await preview(ana).focus();
	await preview(ana).press("Enter");
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
	let preview = content(page).getByRole("region", { name: "Diagram preview", exact: true });
	await expect(preview.locator("svg.sc-svg")).toBeVisible();
	await preview.focus();
	await preview.press("Enter");
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
	await expect(content(page).getByRole("region", { name: "Diagram preview" }).locator("svg.sc-svg"))
		.toBeVisible();
});

test("diagram controls never move the document, and Restart replays from the first step", async ({ join, seed }) => {
	let prose = Array.from(
		{ length: 12 },
		(_, index) => `Paragraph ${index + 1} keeps the document taller than the window.`,
	).join("\n\n");
	await seed(
		`# Diagram controls\n\n${prose}\n\n\`\`\`seecode\n${
			JSON.stringify(astro)
		}\n\`\`\`\n\nAfter the diagram.\n\n${prose}\n`,
	);
	let page = await join("ana");
	let preview = content(page).getByRole("region", { name: "Diagram preview", exact: true });
	let controls = preview.getByRole("group", { name: "Diagram controls", exact: true });
	let button = (name: string) => controls.getByRole("button", { name, exact: true });
	let svg = preview.locator("svg.sc-svg");
	await expect(svg).toBeVisible();
	let total = Number(await svg.getAttribute("data-sc-steps"));
	expect(total).toBeGreaterThan(2);
	let counter = (step: number) => controls.getByText(`${step} / ${total}`, { exact: true });

	// An author reading the diagram has left the caret in nearby prose.
	await content(page).getByText("After the diagram.", { exact: true }).click();
	// The document keeps its lower 30% clear for the caret (scroll-padding), so a
	// control there is exactly where any scroll-into-view would move the page.
	let scroller = page.locator("[data-plan-scroll]");
	let bar = (await controls.boundingBox())!;
	let frame = (await scroller.boundingBox())!;
	await scroller.evaluate(
		(element, delta) => element.scrollTop += delta,
		bar.y - (frame.y + frame.height * 0.8),
	);
	let position = () =>
		scroller.evaluate(element => ({ document: element.scrollTop, window: window.scrollY }));
	let start = await position();
	expect(start.document).toBeGreaterThan(0);
	let unmoved = async () => expect(await position()).toEqual(start);
	// A pointer click at the control, as a reader makes it. Locator clicks first
	// scroll their target into view, which would hide the very movement under test.
	let press = async (name: string) => {
		let box = (await button(name).boundingBox())!;
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	};

	await expect(button("Play diagram")).toBeVisible({ timeout: 10_000 });
	await expect(counter(total)).toBeVisible();
	await press("Previous step");
	await expect(counter(total - 1)).toBeVisible();
	await unmoved();
	await press("Next step");
	await expect(counter(total)).toBeVisible();
	await expect(button("Next step")).toBeDisabled();
	await expect(button("Next step")).toBeFocused();
	await unmoved();

	await press("Restart diagram");
	await expect(counter(1)).toBeVisible();
	await expect(button("Pause diagram")).toBeVisible();
	// The last step waits for its turn again, so the entrance really replays.
	let last = svg.locator(
		`[data-sc-node][data-sc-step="${total}"], [data-sc-edge][data-sc-step="${total}"]`,
	).first();
	expect(await last.evaluate(element => getComputedStyle(element).opacity)).toBe("0");
	await unmoved();
	await press("Pause diagram");
	await expect(button("Play diagram")).toBeVisible();
	await unmoved();
	await press("Play diagram");
	await expect(counter(total)).toBeVisible({ timeout: 10_000 });
	await unmoved();
	await expect(content(page).locator("[data-plan-source]")).toBeHidden();
});
