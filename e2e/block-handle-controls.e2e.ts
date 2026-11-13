/**
 * The block handle (⋮⋮) always stands in one place, 4px left of a block's content, and what a block
 * draws of its own sits beside it, never under it: a resolved decision's marker stands left of the
 * handle on the same line, and an image's resize corner, a table's rails and the controls of a
 * decision, research card, callout, code block, columns and tabs keep clear of it.
 *
 * Each place is read on a wide desktop, a narrow window and a phone, where the handle stands beside
 * blocks selected as blocks rather than the block under the pointer. Geometry is the browser's, so
 * this runs in Chromium.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { deckSeed } from "./decision-deck-fixtures";
import { seedChildChannel } from "./database";
import {
	markResearchPublished,
	seedCompletedResearchWorkspace,
} from "./research-recovery-database";
import { content, edit, expect, ready, test } from "./room";
import { researchReportSource } from "../apps/server/src/research/publication";

import type { BrowserContextOptions, Locator, Page } from "@playwright/test";
import type { SeedState } from "../apps/server/src/testing/plan";

const DESKTOP = { viewport: { width: 1280, height: 900 } };
const NARROW = { viewport: { width: 390, height: 844 } };
const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const PLACES: Array<[string, BrowserContextOptions]> = [
	["desktop", DESKTOP],
	["a narrow window", NARROW],
	["a phone", PHONE],
];

/** What a person can press. The handle itself and the editor's own text are left out. */
const CONTROLS = [
	"button",
	"a[href]",
	"input",
	"select",
	"[role=button]",
	"[role=combobox]",
	"[role=slider]",
	"[role=tab]",
].join(", ");

type Box = { name: string; left: number; top: number; right: number; bottom: number };
type Reading = { handle?: Box; handleTakesPress: boolean; overlapping: Box[]; covered: Box[] };

/**
 * The handle's box, every visible control it overlaps, and every visible control near it that a
 * press at its centre does not reach.
 */
function read(page: Page): Promise<Reading> {
	return page.evaluate(selector => {
		let box = (element: Element): Box => {
			let rect = element.getBoundingClientRect();
			return {
				name: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40) ?? "",
				left: Math.round(rect.left),
				top: Math.round(rect.top),
				right: Math.round(rect.right),
				bottom: Math.round(rect.bottom),
			};
		};
		let handle = document.querySelector<HTMLElement>("[data-block-handle]");
		if (!handle) return { handleTakesPress: false, overlapping: [], covered: [] };
		let h = handle.getBoundingClientRect();
		let takes = (element: Element, rect: DOMRect) => {
			let hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			return !!hit && (element === hit || element.contains(hit));
		};
		let overlapping: Box[] = [];
		let covered: Box[] = [];
		for (let element of document.querySelectorAll(selector)) {
			if (element === handle || handle.contains(element)) continue;
			let rect = element.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) continue;
			if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
			if (getComputedStyle(element).pointerEvents === "none") continue;
			let near = rect.right > h.left - 40 && rect.left < h.right + 40 && rect.bottom > h.top - 40
				&& rect.top < h.bottom + 40;
			if (!near || rect.bottom < 0 || rect.top > innerHeight) continue;
			if (
				rect.left < h.right && rect.right > h.left && rect.top < h.bottom && rect.bottom > h.top
			) {
				overlapping.push(box(element));
			}
			if (!takes(element, rect)) covered.push(box(element));
		}
		return { handle: box(handle), handleTakesPress: takes(handle, h), overlapping, covered };
	}, CONTROLS);
}

/** Read until the handle and the controls have settled where they will stay. */
async function settled(page: Page): Promise<Reading> {
	let last = "";
	let reading: Reading | undefined;
	await expect.poll(async () => {
		reading = await read(page);
		let now = JSON.stringify(reading);
		let same = now === last;
		last = now;
		return same && !!reading.handle;
	}, { intervals: [150] }).toBe(true);
	return reading!;
}

function expectApart(reading: Reading, where: string) {
	expect(reading.handle, `${where}: the handle shows`).toBeTruthy();
	expect(reading.overlapping, `${where}: nothing lies under the handle`).toEqual([]);
	expect(reading.handleTakesPress, `${where}: the handle takes a press`).toBe(true);
	expect(reading.covered, `${where}: every control beside the handle takes a press`).toEqual([]);
}

/** Open a document as a writer: on a phone, switch to editing as a writer would. */
async function open(page: Page, phone: boolean) {
	if (phone) await edit(page);
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
}

/**
 * Bring the handle to a block: the pointer over it on a desktop, or, on a phone, the block selected
 * as a block (a press on its text, then Escape).
 */
async function point(page: Page, x: number, y: number, phone: boolean) {
	if (!phone) return page.mouse.move(x, y, { steps: 2 });
	await page.mouse.click(x, y);
	await page.keyboard.press("Escape");
	await expect(page.locator("[data-block-selected]")).toHaveCount(1);
}

const PROSE = "The rollout goes team by team, starting with the docs team.";
const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";
const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";
const LABELS = ["All at once", "Team by team"];
const AT = "2026-09-23T15:13:00.000Z";

function optionId(index: number): string {
	return `${QUESTION.slice(0, 22)}${QUESTION.slice(-2)}0${index}`;
}

/** A decision answered and linked to the paragraph it produced, drawn as a marker beside it. */
const RESOLVED = `${PROSE}\n\n<Questionnaire id="${WIDGET}" by="ana" at="${AT}">\n`
	+ `<Question id="${QUESTION}" header="Rollout" prompt="How should we roll this out?" multiple="false">\n`
	+ LABELS.map((label, index) => `<Option id="${optionId(index)}" label="${label}" />`).join("\n")
	+ `\n<Answer value="Team by team" />\n</Question>\n</Questionnaire>\n\nAfter the rollout.\n`;

const RESOLVED_STATE = {
	revision: 1,
	questions: [{
		id: WIDGET,
		status: "answered",
		definition: {
			questions: [{
				id: QUESTION,
				header: "Rollout",
				question: "How should we roll this out?",
				multiple: false,
				options: LABELS.map((label, index) => ({ id: optionId(index), label, description: "" })),
			}],
		},
		answers: { [QUESTION]: "Team by team" },
		resolver: "ana",
		at: Date.parse(AT) / 1_000,
		anchors: {
			widget: WIDGET,
			questions: {
				[QUESTION]: {
					anchors: [{
						epoch: "stale",
						position: "",
						digest: `sha256:${createHash("sha256").update(`${PROSE}\n`).digest("hex")}`,
					}],
					pending: false,
				},
			},
		},
	}],
} as unknown as SeedState;

for (let [place, options] of PLACES) {
	let phone = options === PHONE;

	test(`on ${place}, a resolved decision's marker stands left of the handle on its line`, async ({ join, seed }) => {
		await seed(RESOLVED, RESOLVED_STATE);
		let page = await join("ana", options);
		await open(page, phone);
		let marker = page.getByRole("button", { name: "Decision: Team by team" });
		await expect(marker).toBeVisible();
		let line = (await content(page).getByText(PROSE).boundingBox())!;
		await point(page, line.x + 40, line.y + 8, phone);
		let reading = await settled(page);
		expectApart(reading, place);

		// In order on the first line: the marker, 4px, the handle, 4px, the prose. The handle keeps
		// its place beside the prose, and the marker stands left of it, sharing its centre.
		let mark = (await marker.locator(".plan-decision-disc").boundingBox())!;
		let handle = reading.handle!;
		expect(Math.abs(line.x - handle.right - 4)).toBeLessThanOrEqual(1);
		expect(Math.abs(handle.left - (mark.x + mark.width) - 4)).toBeLessThanOrEqual(1);
		expect(Math.abs(mark.y + mark.height / 2 - (handle.top + handle.bottom) / 2))
			.toBeLessThanOrEqual(1);

		// Both take a press, and both keep their keyboard path.
		await page.locator("[data-block-handle]").click();
		let menu = page.getByRole("menu", { name: "Block" });
		await expect(menu).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await marker.click();
		await expect(marker).toHaveAttribute("aria-expanded", "true");
		await page.keyboard.press("Escape");
		await expect(marker).toHaveAttribute("aria-expanded", "false");
		await content(page).getByText(PROSE).click();
		await page.keyboard.press("ControlOrMeta+/");
		await expect(menu).toBeVisible();
		await page.keyboard.press("Escape");
		await marker.focus();
		await page.keyboard.press("Enter");
		await expect(marker).toHaveAttribute("aria-expanded", "true");
	});
}

const IMAGE = readFileSync(new URL("./fixtures/gallery-document.svg", import.meta.url));
const IMAGE_URL = "https://example.com/block-handle-controls.svg";
const REPORT = {
	title: "Storage options",
	summary: "A complete report grounded in the discovered sources.",
	findings: [{
		text: "The source supports the report.",
		sourceUrls: ["https://example.com/source"],
	}],
	caveats: ["The evidence has a limited scope."],
};

/** Every block that draws controls of its own, one after another. */
function blocks(research: string) {
	return `<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note" title="Note">

Body text.

</Callout>

\`\`\`ts
let ready = true;
\`\`\`

| Name | Value |
| --- | --- |
| One | 1 |
| Two | 2 |

![A picture](${IMAGE_URL})

<Columns id="01K0N4W3B7P27CBAEC7A8C8WEB">
<Column id="01K0N4W3B7P27CBAEC7A8C8WEC">

First column.

</Column>
<Column id="01K0N4W3B7P27CBAEC7A8C8WED">

Second column.

</Column>
</Columns>

<Tabs id="01K0N4W3B7P27CBAEC7A8C8WEE">
<Tab id="01K0N4W3B7P27CBAEC7A8C8WEF" label="Mobile">

Tab body.

</Tab>
</Tabs>

<Research id="${research}" />

Closing paragraph.`;
}

for (let [place, options] of PLACES) {
	let phone = options === PHONE;

	test(`on ${place}, the handle keeps its place beside every block and clear of its controls`, async ({ baseURL, join, room, seed }) => {
		let research = `workspace-${crypto.randomUUID()}`;
		let fixture = deckSeed({ before: "Before the decision.", after: blocks(research) }, 1, {
			optionCounts: [2],
		});
		let port = Number(new URL(baseURL!).port);
		let child = await seedChildChannel(
			port,
			room,
			crypto.randomUUID(),
			REPORT.title,
			researchReportSource(REPORT, [{ title: "Source", url: "https://example.com/source" }]),
		);
		await seed(fixture.source, fixture.state);
		await seedCompletedResearchWorkspace(port, room, {
			workspaceId: research,
			question: "Where should room state live?",
			report: {
				title: REPORT.title,
				summary: REPORT.summary,
				finding: REPORT.findings[0]!.text,
				caveat: REPORT.caveats[0]!,
				source: { title: "Source", url: "https://example.com/source" },
			},
		});
		await markResearchPublished(port, room, research, child.id);
		let page = await join("ana", options);
		await page.route(
			IMAGE_URL,
			route => route.fulfill({ contentType: "image/svg+xml", body: IMAGE }),
		);
		await page.reload();
		await ready(page);
		await open(page, phone);
		await expect(page.getByRole("article", { name: "Research" })).toHaveAttribute(
			"data-stage",
			"ready",
		);
		await expect(content(page).getByRole("img", { name: "A picture" })).toBeVisible();

		// Each block's first line, and the places within it where its own controls show, with the
		// content whose left edge the handle stands beside.
		type Spot = { name: string; point: Locator; dx: number; dy: number; content: Locator };
		let doc = content(page);
		let card = doc.locator("article[data-plan-sidecar-questionnaire]").first();
		let image = doc.getByRole("img", { name: "A picture" });
		let code = doc.locator(".planCode");
		let table = doc.locator("table");
		let researchCard = page.getByRole("article", { name: "Research" });
		let spots: Spot[] = [
			{ name: "the decision", point: card, dx: 40, dy: 12, content: card },
			{
				name: "the callout",
				point: doc.locator("aside[data-plan-type]"),
				dx: 40,
				dy: 12,
				content: doc.locator("aside[data-plan-type]"),
			},
			{ name: "the code block", point: code, dx: 20, dy: 12, content: code },
			{
				name: "the table's header",
				point: table.locator("th").first(),
				dx: 20,
				dy: 8,
				content: table,
			},
			{
				name: "the table's first row",
				point: table.locator("td").first(),
				dx: 20,
				dy: 8,
				content: table,
			},
			{ name: "the image's corner", point: image, dx: 20, dy: 20, content: image },
			{ name: "the image's middle", point: image, dx: -1, dy: -1, content: image },
			{
				name: "the columns",
				point: doc.getByText("First column."),
				dx: 20,
				dy: 8,
				content: doc.getByText("First column."),
			},
			{
				name: "the tabs",
				point: doc.getByRole("tablist"),
				dx: 20,
				dy: 8,
				content: doc.locator(".planTabs"),
			},
			{ name: "the research card", point: researchCard, dx: 40, dy: 12, content: researchCard },
		];

		if (phone) {
			// A phone shows the handle beside blocks selected as blocks: walk them one by one.
			let selected = page.locator("[data-block-selected]");
			let first = (await doc.getByText("Before the decision.").boundingBox())!;
			await point(page, first.x + 20, first.y + 8, true);
			let seen: string[] = [];
			for (let step = 0; step < 30; step++) {
				await expect(selected).toHaveCount(1);
				let name = (await selected.innerText()).trim().split("\n")[0]!.slice(0, 30);
				await selected.scrollIntoViewIfNeeded();
				let reading = await settled(page);
				let where = `${place}, ${name || "a block"}`;
				expectApart(reading, where);
				let left = (await selected.boundingBox())!.x;
				expect(Math.abs(left - reading.handle!.right - 4), `${where}: the handle's place`)
					.toBeLessThanOrEqual(1);
				seen.push(name);
				if (name.startsWith("Closing paragraph.")) break;
				await page.keyboard.press("ArrowDown");
			}
			// Every block, the image and the inner blocks of the callout, columns and tabs included.
			expect(seen).toHaveLength(14);
			expect(seen.at(-1)).toBe("Closing paragraph.");
			return;
		}

		for (let spot of spots) {
			let where = `${place}, ${spot.name}`;
			await spot.point.scrollIntoViewIfNeeded();
			let box = (await spot.point.boundingBox())!;
			let x = box.x + (spot.dx < 0 ? box.width / 2 : spot.dx);
			let y = box.y + (spot.dy < 0 ? box.height / 2 : spot.dy);
			await page.mouse.move(x, y, { steps: 2 });
			let reading = await settled(page);
			expectApart(reading, where);
			// The handle stands in the same place beside every kind of block: 4px left of its content.
			let left = (await spot.content.boundingBox())!.x;
			expect(Math.abs(left - reading.handle!.right - 4), `${where}: the handle's place`)
				.toBeLessThanOrEqual(1);
		}
	});
}
