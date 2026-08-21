import { content, expect, test } from "./room";
import { readDocument } from "./database";
import { expectFocusIndicator } from "./focus";
import * as Room from "../apps/server/src/plan/room";
import {
	COMPACT_SURFACES_SOURCE,
	expectNoHorizontalOverflow,
	RESPONSIVE_IMAGE_URL,
	RESPONSIVE_SOURCE,
	RESPONSIVE_VIEWPORTS,
} from "./responsive";

import type { Plan } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

function center(box: { left: number; right: number }): number {
	return (box.left + box.right) / 2;
}

async function routeResponsiveImage(page: Page): Promise<void> {
	await page.route(RESPONSIVE_IMAGE_URL, route =>
		route.fulfill({
			body:
				`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600"><rect width="1200" height="600" fill="#dbeafe"/><text x="60" y="300" font-size="56">Responsive workspace reference</text></svg>`,
			contentType: "image/svg+xml",
		}));
}

async function injectAgentChange(
	page: Page,
	checkpoint: { epoch: string; source: string; update: Uint8Array },
) {
	let send: ((frame: Plan.Changes) => void) | undefined;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		send = frame => route.send(JSON.stringify(frame));
		route.onMessage(message => server.send(message));
		server.onMessage(message => route.send(message));
	});

	return {
		async addedAtEnd() {
			let document = await Room.restore(
				checkpoint.epoch,
				checkpoint.update,
				checkpoint.source,
				[],
			);
			try {
				let digests = Room.digests(document);
				let index = digests.length - 1;
				send?.({
					kind: "plan:changes",
					ts: 0,
					epoch: checkpoint.epoch,
					changes: [{
						kind: "added",
						at: Room.anchorAt(document, index, digests[index]!),
						preview:
							"AgentChangeExcerptThatIsDeliberatelyLongEnoughToRequireTheChangeListToScrollOrTruncateInsideItsOwnContainedChrome",
						type: "paragraph",
					}],
				});
			} finally {
				document.doc.destroy();
			}
		},
	};
}

async function expectInsideDocumentWidth(
	name: string,
	surface: ReturnType<Page["locator"]>,
): Promise<void> {
	await expect.poll(() => surface.count(), { message: `${name} must be rendered` }).toBeGreaterThan(
		0,
	);
	await expect.poll(async () =>
		await surface.evaluateAll(nodes => {
			let documentBox = globalThis.document.querySelector("[data-plan-scroll]")
				?.getBoundingClientRect();
			if (!documentBox) return [{ reason: "missing document" }];
			return nodes.flatMap(node => {
				let element = node as HTMLElement;
				let style = getComputedStyle(element);
				let rectangle = element.getBoundingClientRect();
				let bounds = {
					document: { left: documentBox.left, right: documentBox.right },
					left: rectangle.left,
					right: rectangle.right,
				};
				if (
					style.display === "none" || style.visibility === "hidden" || rectangle.width === 0
					|| rectangle.height === 0
				) return [{ ...bounds, reason: "not visible" }];
				return rectangle.left >= documentBox.left && rectangle.right <= documentBox.right
					? []
					: [{ ...bounds, reason: "outside document" }];
			});
		}), { message: `${name} must have visible bounds inside the document` }).toEqual([]);
}

async function expectIntrinsicWidth(
	name: string,
	surface: ReturnType<Page["locator"]>,
): Promise<void> {
	let widths = await surface.evaluateAll(nodes => {
		let host = nodes[0]?.closest<HTMLElement>('[contenteditable="true"]');
		if (!host) return [];
		let documentWidth = host.getBoundingClientRect().width;
		return nodes.map(node => {
			let copy = node.cloneNode(true) as HTMLElement;
			copy.style.setProperty("display", "inline-block", "important");
			copy.style.setProperty("inline-size", "max-content", "important");
			copy.style.setProperty("max-inline-size", "none", "important");
			copy.style.setProperty("white-space", "nowrap", "important");
			copy.style.setProperty("visibility", "hidden", "important");
			copy.style.setProperty("position", "absolute", "important");
			host.append(copy);
			let width = copy.getBoundingClientRect().width;
			copy.remove();
			return { documentWidth, width };
		});
	});
	expect(widths.length, `${name} must be rendered before measuring its intrinsic width`)
		.toBeGreaterThan(0);
	expect(
		widths.every(value => value.width > value.documentWidth),
		`${name} must be intrinsically wide`,
	).toBe(true);
}

async function expectVisibleMermaidSvg(page: Page): Promise<void> {
	let result = await content(page).getByRole("region", { name: "Diagram preview" }).evaluateAll(
		regions => {
			let documentBox = globalThis.document.querySelector("[data-plan-scroll]")
				?.getBoundingClientRect();
			let visible = regions.flatMap(region => {
				let svg = region.querySelector("svg");
				if (!svg) return [];
				let style = getComputedStyle(svg);
				let rectangle = svg.getBoundingClientRect();
				let regionBox = region.getBoundingClientRect();
				if (
					style.display === "none" || style.visibility === "hidden" || rectangle.width === 0
					|| rectangle.height === 0
				) return [];
				return [{
					inside: !!documentBox && regionBox.left >= documentBox.left
						&& regionBox.right <= documentBox.right,
					intrinsicWidth: svg.viewBox.baseVal.width || svg.width.baseVal.value,
					documentWidth: documentBox?.width ?? 0,
					overflows: region.scrollWidth > region.clientWidth,
				}];
			});
			return { all: regions.length, visible };
		},
	);
	expect(result.all, "Mermaid must create SVG output").toBeGreaterThan(0);
	expect(result.visible.length, "Mermaid must paint a visible SVG").toBeGreaterThan(0);
	expect(result.visible.every(value => value.inside), "Mermaid scrollers must fit the document")
		.toBe(true);
	expect(
		result.visible.every(value => value.overflows),
		"wide Mermaid diagrams must scroll internally",
	)
		.toBe(true);
	expect(
		result.visible.some(value => value.intrinsicWidth > value.documentWidth),
		"Mermaid fixture must be intrinsically wider than the document",
	).toBe(true);
}

async function expectOwnScroller(
	name: string,
	surface: ReturnType<Page["locator"]>,
): Promise<void> {
	await expect(surface.first(), `${name} must be rendered`).toBeAttached();
	expect(await surface.count(), `${name} must be rendered`).toBeGreaterThan(0);
	expect(
		await surface.evaluateAll(nodes => nodes.every(node => node.scrollWidth > node.clientWidth)),
		`${name} must overflow internally`,
	).toBe(true);
}

async function expectHorizontalScroll(
	name: string,
	surface: ReturnType<Page["locator"]>,
): Promise<void> {
	await surface.first().evaluate(node => {
		node.scrollLeft = node.scrollWidth;
	});
	await expect.poll(
		() => surface.first().evaluate(node => node.scrollLeft),
		{ message: `${name} must allow its hidden content to be reached` },
	).toBeGreaterThan(0);
}

async function expectPerceptibleHorizontalOverflow(
	name: string,
	surface: ReturnType<Page["locator"]>,
): Promise<void> {
	await expectOwnScroller(name, surface);
	let geometry = await surface.evaluateAll(nodes =>
		nodes.map(node => {
			let style = getComputedStyle(node);
			return {
				overflow: style.overflowX,
				thumb: getComputedStyle(node, "::-webkit-scrollbar-thumb").backgroundColor,
				track: Number.parseFloat(getComputedStyle(node, "::-webkit-scrollbar").height),
			};
		})
	);
	expect(
		geometry.every(value =>
			value.overflow === "auto" && value.track >= 6
			&& value.thumb !== "rgba(0, 0, 0, 0)" && value.thumb !== "transparent"
		),
		`${name} must expose a persistent horizontal overflow affordance (${JSON.stringify(geometry)})`,
	).toBe(true);
}

async function expectWrapped(name: string, surface: ReturnType<Page["locator"]>): Promise<void> {
	let geometry = await surface.evaluate(node => {
		let style = getComputedStyle(node);
		let line = Number.parseFloat(style.lineHeight);
		let box = node.getBoundingClientRect();
		let documentBox = node.closest("[data-plan-scroll]")!.getBoundingClientRect();
		return {
			height: box.height,
			inside: box.left >= documentBox.left && box.right <= documentBox.right,
			line,
		};
	});
	expect(geometry.inside, `${name} must stay inside the document`).toBe(true);
	expect(geometry.height, `${name} must wrap onto more than one line`).toBeGreaterThan(
		geometry.line * 1.5,
	);
}

async function expectTabInsideStrip(tab: ReturnType<Page["getByRole"]>) {
	await expect.poll(() =>
		tab.evaluate(node => {
			let strip = node.closest('[role="tablist"]')!.getBoundingClientRect();
			let box = node.getBoundingClientRect();
			return box.left >= strip.left - 1 && box.right <= strip.right + 1;
		})
	).toBe(true);
}

async function selectLastTab(tabs: ReturnType<Page["getByRole"]>) {
	await tabs.first().focus();
	await tabs.first().press("End");
	let last = tabs.last();
	await expect(last).toHaveAttribute("aria-selected", "true");
	await expect(last).toBeFocused();
	await expectTabInsideStrip(last);
}

type Join = (handle: string) => Promise<Page>;
type Seed = (source: string) => Promise<void>;

const LONG_HANDLE = "collaborator-with-a-name-long-enough-to-overflow-the-contained-cursor-label";

async function expectRepresentativeSurfaces(
	baseURL: string,
	join: Join,
	page: Page,
	room: string,
	seed: Seed,
): Promise<void> {
	await routeResponsiveImage(page);
	await seed(RESPONSIVE_SOURCE);
	let checkpoint = await readDocument(Number(new URL(baseURL).port), room);
	let changes = await injectAgentChange(page, checkpoint);
	let ana = await join("ana");
	let document = content(ana);
	let surfaces = [
		{
			name: "long link",
			locator: document.getByRole("link", {
				name:
					"TheCompleteArchitectureDecisionRecordForResponsiveWorkspaceContainmentMustWrapWithoutWideningTheDocument",
			}),
		},
		{
			name: "wide image",
			locator: document.getByRole("img", { name: "Responsive workspace reference" }),
		},
		{
			name: "Mermaid preview",
			locator: document.locator("[data-plan-language='mermaid'] [data-plan-preview]"),
		},
		{ name: "display math", locator: document.locator('[data-plan-inline="false"]') },
		{ name: "tab strip", locator: document.getByRole("tablist") },
		{ name: "tab panels", locator: document.locator("[data-plan-panels]") },
		{ name: "callout", locator: document.locator("[data-plan-type='warning']") },
		{
			name: "callout title",
			locator: document.getByRole("textbox", { name: "Callout title" }),
		},
		{ name: "inline code", locator: document.locator(":not(pre) > code") },
	];

	for (let surface of surfaces) await expectInsideDocumentWidth(surface.name, surface.locator);
	await expectIntrinsicWidth("long link", surfaces[0]!.locator);
	await expectIntrinsicWidth("inline code", surfaces.at(-1)!.locator);
	let image = surfaces[1]!.locator;
	expect(
		await image.evaluate(node => {
			let documentWidth = node.closest("[data-plan-scroll]")!.getBoundingClientRect().width;
			return (node as HTMLImageElement).naturalWidth > documentWidth;
		}),
		"image fixture must be intrinsically wider than the document",
	).toBe(true);
	await expectVisibleMermaidSvg(ana);
	await expectOwnScroller(
		"display math",
		document.locator('[data-plan-inline="false"] [data-plan-preview]'),
	);
	await expectOwnScroller("tab strip", document.getByRole("tablist"));
	let table = document.locator("table");
	await expect(table).toHaveCount(1);
	await expectOwnScroller("wide table", table);
	await expect(document.locator("[data-plan-source]")).not.toHaveCount(0);
	await expect(ana.getByRole("button", { name: /Comment on/ })).toBeAttached();
	await changes.addedAtEnd();
	let chip = ana.locator("[data-side]");
	await expect(chip).toBeVisible();
	await expectInsideDocumentWidth("agent change chip", chip);
	let disclosure = chip.getByRole("button", { name: "What the agent changed" });
	await ana.keyboard.press("Tab");
	await disclosure.focus();
	await expectFocusIndicator(disclosure);
	await disclosure.click();
	await expectOwnScroller(
		"agent change excerpt",
		chip.getByText(
			"AgentChangeExcerptThatIsDeliberatelyLongEnoughToRequireTheChangeListToScrollOrTruncateInsideItsOwnContainedChrome",
		),
	);

	let bo = await join(LONG_HANDLE);
	await content(bo).getByText(
		"This deliberately long opening paragraph gives the fixture comment injector enough ordinary prose to quote while a reader can still find its argument among the richer blocks below.",
		{ exact: true },
	).click({ position: { x: 1, y: 8 } });
	await bo.keyboard.type(" ");
	let cursor = ana.getByText(LONG_HANDLE, { exact: true });
	await expect(cursor).toHaveText(LONG_HANDLE);
	await expectInsideDocumentWidth("remote cursor label", cursor);
	await expectOwnScroller("remote cursor label", cursor);
}

for (let viewport of RESPONSIVE_VIEWPORTS) {
	test(`${viewport.name} exposes every required responsive surface`, async ({ baseURL, join, page, room, seed }) => {
		await page.setViewportSize(viewport);
		await expectRepresentativeSurfaces(baseURL!, join, page, room, seed);
	});
}

test("compact and desktop documents render the intended gutter and reading measure", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let compact = await join("ana", { viewport: { width: 390, height: 844 } });
	let compactGeometry = await content(compact).evaluate(node => {
		let style = getComputedStyle(node);
		return {
			content: node.getBoundingClientRect().width,
			left: Number.parseFloat(style.paddingLeft),
			prose: node.querySelector("p")!.getBoundingClientRect().width,
			right: Number.parseFloat(style.paddingRight),
		};
	});
	expect(compactGeometry.left).toBe(16);
	expect(compactGeometry.right).toBe(16);
	expect(compactGeometry.prose).toBeCloseTo(
		compactGeometry.content - compactGeometry.left - compactGeometry.right,
		0,
	);

	let desktop = await join("bo", { viewport: { width: 1440, height: 900 } });
	let desktopGeometry = await content(desktop).evaluate(node => {
		let style = getComputedStyle(node);
		let contentBox = node.getBoundingClientRect();
		let documentBox = node.closest("[data-plan-scroll]")!.getBoundingClientRect();
		return {
			content: contentBox.width,
			documentLeft: contentBox.left - documentBox.left,
			documentRight: documentBox.right - contentBox.right,
			left: Number.parseFloat(style.paddingLeft),
			prose: node.querySelector("p")!.getBoundingClientRect().width,
			right: Number.parseFloat(style.paddingRight),
		};
	});
	expect(desktopGeometry.left).toBe(32);
	expect(desktopGeometry.right).toBe(32);
	expect(desktopGeometry.prose).toBeCloseTo(640, 0);
	expect(desktopGeometry.content).toBeCloseTo(704, 0);
	expect(desktopGeometry.documentLeft).toBeCloseTo(desktopGeometry.documentRight, 0);
});

for (let viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
	test(`${viewport.width}px keeps hostile rich content readable and navigable`, async ({ join, seed }) => {
		await seed(RESPONSIVE_SOURCE);
		let page = await join(`reader-${viewport.width}`, { viewport });
		let document = content(page);
		await expectWrapped(
			"normal heading",
			document.getByRole("heading", {
				name:
					"A deliberately detailed authored heading that must wrap at normal word boundaries inside a compact document",
			}),
		);
		await expectWrapped(
			"unbroken heading",
			document.getByRole("heading", {
				name:
					"CompactDocumentMeasureMustRemainReadableWithoutForcingTheViewportWiderThanTheDocument",
			}),
		);
		let code = document.locator("[data-plan-language='typescript'] [data-plan-preview] > div");
		let table = document.locator("table");
		if (viewport.width === 390) {
			await expectPerceptibleHorizontalOverflow("long code line", code);
			await expectPerceptibleHorizontalOverflow("wide table", table);
			await expectHorizontalScroll("long code line", code);
			await expectHorizontalScroll("wide table", table);
		} else {
			await expectInsideDocumentWidth("long code line", code);
			await expectOwnScroller("wide table", table);
		}

		let strip = document.getByRole("tablist");
		if (viewport.width === 390) await expectPerceptibleHorizontalOverflow("tab strip", strip);
		else await expectOwnScroller("tab strip", strip);
		await selectLastTab(strip.getByRole("tab"));

		let callout = document.locator("[data-plan-type='warning']");
		await expectInsideDocumentWidth("callout", callout);
		await expectWrapped("callout title", callout.getByRole("textbox", { name: "Callout title" }));
		await expectNoHorizontalOverflow(page);
	});
}

test("reduced motion reveals a keyboard-selected tab immediately", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("reduced-motion-reader", {
		reducedMotion: "reduce",
		viewport: { width: 390, height: 844 },
	});
	let tabs = content(page).getByRole("tablist").getByRole("tab");
	await selectLastTab(tabs);
});

test("a selected tab follows strip layout changes without moving the document", async ({ join, seed }) => {
	await seed(RESPONSIVE_SOURCE);
	let page = await join("resized-tab-reader", { viewport: { width: 390, height: 844 } });
	let scroller = page.locator("[data-plan-scroll]");
	let tabs = content(page).getByRole("tablist").getByRole("tab");
	await selectLastTab(tabs);
	await scroller.evaluate(node => {
		node.scrollTop = node.scrollHeight;
	});
	expect(
		await scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop),
	).toBeLessThanOrEqual(1);
	await tabs.first().evaluate(node => {
		node.textContent = "A preceding collaborative tab label that became dramatically wider";
	});
	await expectTabInsideStrip(tabs.last());
	await page.setViewportSize({ width: 320, height: 844 });
	await expectTabInsideStrip(tabs.last());
	await expect.poll(() =>
		scroller.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)
	).toBeLessThanOrEqual(1);
});

test("compact tables and diagrams stay centered without stretching", async ({ join, page, seed }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await seed(COMPACT_SURFACES_SOURCE);
	page = await join("compact-surface-reader");
	let document = content(page);
	await expect(document.getByRole("region", { name: "Diagram preview" })).toBeVisible();
	let geometry = await document.evaluate(root => {
		// oxlint-disable-next-line unicorn(consistent-function-scoping) -- The callback executes in the browser realm.
		let rectangle = (element: Element | null) => {
			if (!element) throw new Error("compact surface is missing");
			let box = element.getBoundingClientRect();
			return { left: box.left, right: box.right, width: box.width };
		};
		let table = root.querySelector(":scope > table");
		let row = table?.querySelector("tr") ?? null;
		let preview = root.querySelector(":scope > [data-plan-language='mermaid'] .plan-diagram");
		let svg = preview?.querySelector("svg") ?? null;
		let scroller = root.closest("[data-plan-scroll]");
		return {
			document: rectangle(scroller),
			preview: rectangle(preview),
			row: rectangle(row),
			svg: rectangle(svg),
			table: {
				...rectangle(table),
				clientWidth: table?.clientWidth ?? 0,
				scrollWidth: table?.scrollWidth ?? 0,
			},
		};
	});

	expect(geometry.table.width).toBeLessThan(geometry.preview.width);
	expect(geometry.table.scrollWidth).toBe(geometry.table.clientWidth);
	expect(Math.abs(geometry.table.width - geometry.row.width)).toBeLessThan(2);
	expect(Math.abs(center(geometry.table) - center(geometry.document))).toBeLessThan(2);
	expect(geometry.svg.width).toBeLessThan(geometry.preview.width);
	expect(Math.abs(center(geometry.svg) - center(geometry.preview))).toBeLessThan(2);
	expect(Math.abs(center(geometry.svg) - center(geometry.document))).toBeLessThan(2);
	await expectNoHorizontalOverflow(page);
});

test("top-level rich surfaces use the document width while nested surfaces stay contained", async ({ join, page, seed }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await routeResponsiveImage(page);
	await seed(RESPONSIVE_SOURCE);
	page = await join("wide-surface-reader");
	let document = content(page);
	await expect(document.getByRole("img", { name: "Responsive workspace reference" })).toBeVisible();
	await expect(document.getByRole("img", { name: "Mixed prose reference" })).toBeVisible();
	await expect(document.getByRole("img", { name: "Contained callout reference" })).toBeVisible();
	await expect(document.getByRole("region", { name: "Diagram preview" })).toBeVisible();
	let geometry = await document.evaluate(root => {
		// oxlint-disable-next-line unicorn(consistent-function-scoping) -- The callback executes in the browser realm.
		let rectangle = (element: Element | null) => {
			if (!element) throw new Error("responsive surface is missing");
			let box = element.getBoundingClientRect();
			return { left: box.left, right: box.right, width: box.width };
		};
		let image = root.querySelector<HTMLImageElement>(
			'img[alt="Responsive workspace reference"]',
		);
		let imageRow = image?.closest("p") ?? null;
		let mixedImage = root.querySelector<HTMLImageElement>('img[alt="Mixed prose reference"]');
		let mixed = mixedImage?.closest("p") ?? null;
		let nested = root.querySelector<HTMLImageElement>(
			'img[alt="Contained callout reference"]',
		);
		let callout = nested?.closest('[data-plan-type="warning"]') ?? null;
		let mermaid = root.querySelector('[aria-label="Diagram preview"]')
			?.closest('[data-plan-language="mermaid"]') ?? null;
		let scroller = root.closest("[data-plan-scroll]");
		let style = getComputedStyle(root);
		return {
			callout: rectangle(callout),
			document: rectangle(scroller),
			gutter: Number.parseFloat(style.paddingInlineStart),
			image: { ...rectangle(image), naturalWidth: image?.naturalWidth ?? 0 },
			imageRow: rectangle(imageRow),
			mermaid: rectangle(mermaid),
			mixed: rectangle(mixed),
			mixedImage: rectangle(mixedImage),
			nested: rectangle(nested),
			prose: rectangle(root.querySelector(":scope > p")),
			table: rectangle(root.querySelector(":scope > table")),
		};
	});

	let left = geometry.document.left + geometry.gutter;
	let right = geometry.document.right - geometry.gutter;
	for (let surface of [geometry.table, geometry.imageRow, geometry.mermaid]) {
		expect(Math.abs(surface.left - left)).toBeLessThan(2);
		expect(Math.abs(surface.right - right)).toBeLessThan(2);
		expect(surface.width).toBeGreaterThan(geometry.prose.width);
	}
	expect(
		Math.abs(geometry.image.width - Math.min(geometry.image.naturalWidth, geometry.imageRow.width)),
	).toBeLessThan(2);
	expect(geometry.image.width).toBeGreaterThan(geometry.prose.width);
	expect(
		Math.abs(
			(geometry.image.left + geometry.image.right) / 2
				- (geometry.imageRow.left + geometry.imageRow.right) / 2,
		),
	).toBeLessThan(2);
	expect(geometry.mixed.width).toBeCloseTo(geometry.prose.width, 0);
	expect(geometry.mixedImage.left).toBeGreaterThanOrEqual(geometry.mixed.left);
	expect(geometry.mixedImage.right).toBeLessThanOrEqual(geometry.mixed.right);
	expect(geometry.callout.width).toBeCloseTo(geometry.prose.width, 0);
	expect(geometry.nested.left).toBeGreaterThanOrEqual(geometry.callout.left);
	expect(geometry.nested.right).toBeLessThanOrEqual(geometry.callout.right);
	await expectNoHorizontalOverflow(page);
});

test("narrow documents keep equal inline gutters", async ({ join, page, seed }) => {
	await routeResponsiveImage(page);
	await seed(RESPONSIVE_SOURCE);
	page = await join("narrow-gutter-reader");
	for (let width of [390, 611]) {
		await page.setViewportSize({ width, height: 844 });
		let document = content(page);
		await expect(document.getByRole("img", { name: "Responsive workspace reference" }))
			.toBeVisible();
		await expect(document.getByRole("region", { name: "Diagram preview" })).toBeVisible();
		let padding = await document.evaluate(node => {
			let style = getComputedStyle(node);
			return {
				left: Number.parseFloat(style.paddingLeft),
				right: Number.parseFloat(style.paddingRight),
			};
		});
		expect(padding.left).toBeGreaterThanOrEqual(16);
		expect(padding.left).toBeLessThanOrEqual(24);
		expect(padding.right).toBe(padding.left);
		let geometry = await document.evaluate(root => {
			// oxlint-disable-next-line unicorn(consistent-function-scoping) -- The callback executes in the browser realm.
			let rectangle = (element: Element | null) => {
				if (!element) throw new Error("responsive surface is missing");
				let box = element.getBoundingClientRect();
				return { left: box.left, right: box.right, width: box.width };
			};
			let style = getComputedStyle(root);
			let image = root.querySelector<HTMLImageElement>(
				'img[alt="Responsive workspace reference"]',
			);
			let mermaid = root.querySelector('[aria-label="Diagram preview"]')
				?.closest('[data-plan-language="mermaid"]') ?? null;
			return {
				document: rectangle(root.closest("[data-plan-scroll]")),
				gutter: Number.parseFloat(style.paddingInlineStart),
				surfaces: [
					rectangle(root.querySelector(":scope > table")),
					rectangle(image?.closest("p") ?? null),
					rectangle(mermaid),
				],
			};
		});
		let left = geometry.document.left + geometry.gutter;
		let right = geometry.document.right - geometry.gutter;
		for (let surface of geometry.surfaces) {
			expect(Math.abs(surface.left - left)).toBeLessThan(2);
			expect(Math.abs(surface.right - right)).toBeLessThan(2);
		}
	}
});

for (let viewport of RESPONSIVE_VIEWPORTS) {
	test(`${viewport.name} keeps wide content in its own scrollers`, async ({ join, page, seed }) => {
		await page.setViewportSize(viewport);
		await routeResponsiveImage(page);
		await seed(RESPONSIVE_SOURCE);
		page = await join("ana");
		let table = content(page).locator("table");

		expect(await table.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
		expect((await table.locator("th").first().boundingBox())!.width).toBeGreaterThanOrEqual(112);
		await expectNoHorizontalOverflow(page);
		await expectInsideDocumentWidth("wide table", table);
	});
}
