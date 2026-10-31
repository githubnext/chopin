/**
 * A decision option carries its own visual: an image of the document's, a Mermaid diagram or a
 * small table, framed under the option on every card surface, so members compare choices by
 * looking at them. A card whose preview was joined into the option's description before looks as
 * it did.
 */
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";

import { storedQuestion } from "../apps/server/src/testing/plan";
import { seedChannelImage } from "./database";
import { expect, ready, test } from "./room";

import type { SeedState } from "../apps/server/src/testing/plan";
import type { Locator, Page } from "@playwright/test";

const THROUGH = readFileSync(new URL("./fixtures/option-write-through.png", import.meta.url));
const BACK = readFileSync(new URL("./fixtures/option-write-back.png", import.meta.url));
const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const DESKTOP = { viewport: { width: 1440, height: 1000 } };
/** Set to a directory to keep the screenshots a pull request shows. */
const SHOTS = process.env.CHOPIN_SHOTS;

const CACHE = "How should writes reach the cache?";
const RELEASE = "Which release path do we take?";
const LEGACY = "Which store do we use?";
const SCORED = "Where should onboarding progress live?";

type Option = { id: string; label: string; description: string; preview?: string };
type Item = {
	widget: string;
	question: string;
	header: string;
	prompt: string;
	options: Option[];
	criteria?: { id: string; label: string }[];
};

/** An attribute value as the document source writes it. */
function attribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function seeded(items: Item[]): { source: string; state: SeedState } {
	let questions: unknown[] = [];
	let openQuestions: unknown[] = [];
	let blocks = items.map(item => {
		let definition = {
			questions: [{
				id: item.question,
				header: item.header,
				question: item.prompt,
				multiple: false,
				options: item.options,
				...(item.criteria ? { criteria: item.criteria } : {}),
			}],
		};
		questions.push({
			id: item.widget,
			definition,
			status: "open",
			origin: "planner",
			history: [],
			optionOrigins: {},
			editors: [],
		});
		openQuestions.push({
			definition,
			id: item.widget,
			model: storedQuestion(definition),
			revision: 0,
			widget: item.widget,
		});
		let options = item.options.map(option =>
			`<Option id="${option.id}" label="${attribute(option.label)}"${
				option.description ? ` description="${attribute(option.description)}"` : ""
			}${option.preview ? ` preview="${attribute(option.preview)}"` : ""} />`
		);
		let criteria = (item.criteria ?? []).map(criterion =>
			`<Criterion id="${criterion.id}" label="${criterion.label}" />`
		);
		return `<Questionnaire id="${item.widget}">
<Question id="${item.question}" header="${item.header}" prompt="${
			attribute(item.prompt)
		}" multiple="false">
${[...options, ...criteria].join("\n")}
</Question>
</Questionnaire>`;
	});
	return {
		source: `# Cache\n\nHow writes reach it.\n\n${blocks.join("\n\n")}\n`,
		state: { revision: 1, questions, openQuestions },
	};
}

const DIAGRAM = (flow: string[]) => ["```mermaid", "flowchart LR", ...flow, "```"].join("\n");

/** The decisions a test needs, in the order the document holds them. */
function cards(
	through: string,
	back: string,
	...which: (typeof CACHE | typeof RELEASE | typeof LEGACY | typeof SCORED)[]
): { source: string; state: SeedState } {
	let all: Item[] = [
		{
			widget: "01K0N4TR8K7JGM4R1J7PW4R8P0",
			question: "01K0N4V4E7Y6P4MJ5WD8XZF3P0",
			header: "Cache",
			prompt: CACHE,
			options: [
				{
					id: "01K0N4W3B7P27CBAEC7A8C8WP0",
					label: "Write-through",
					description: "Safe, slower writes.",
					preview:
						`![Write-through: the write reaches the database before it is acknowledged](${through})`,
				},
				{
					id: "01K0N4W3B7P27CBAEC7A8C8WP1",
					label: "Write-back",
					description: "Fast, can lose a flush.",
					preview: `![Write-back: the write is acknowledged first and flushed later](${back})`,
				},
				{
					id: "01K0N4W3B7P27CBAEC7A8C8WP2",
					label: "Skip the cache",
					description: "Simplest.",
				},
			],
		},
		{
			widget: "01K0N4TR8K7JGM4R1J7PW4R8P1",
			question: "01K0N4V4E7Y6P4MJ5WD8XZF3P1",
			header: "Release",
			prompt: RELEASE,
			options: [
				{
					id: "01K0N4W3B7P27CBAEC7A8C8WP3",
					label: "One queue",
					description: "Everyone waits in line.",
					preview: DIAGRAM(["A[Change] --> B[Shared queue] --> C[Release]"]),
				},
				{
					id: "01K0N4W3B7P27CBAEC7A8C8WP4",
					label: "A queue per team",
					description: "Teams ship on their own.",
					preview: [
						DIAGRAM(["A[Change] --> B[Team queue] --> C[Release]"]),
						"",
						"| Cost | Risk |",
						"| --- | --- |",
						"| Higher | Teams drift |",
					].join("\n"),
				},
			],
		},
		{
			widget: "01K0N4TR8K7JGM4R1J7PW4R8P2",
			question: "01K0N4V4E7Y6P4MJ5WD8XZF3P2",
			header: "Store",
			prompt: LEGACY,
			options: [
				{
					id: "01K0N4W3B7P27CBAEC7A8C8WP5",
					label: "Postgres",
					// A card from before: the sketch was joined into the description.
					description: "Durable.\n\n```sql\ncreate table sessions (id text);\n```",
				},
				{ id: "01K0N4W3B7P27CBAEC7A8C8WP6", label: "Memory", description: "Fast." },
			],
		},
		{
			widget: "01K0N4TR8K7JGM4R1J7PW4R8P3",
			question: "01K0N4V4E7Y6P4MJ5WD8XZF3P3",
			header: "Progress",
			prompt: SCORED,
			options: [
				{
					id: "01K0N4W3B7P27CBAEC7A8C8WP7",
					label: "Stored with the account",
					description: "",
					preview: `![Write-through: stored with the account](${through})`,
				},
				{ id: "01K0N4W3B7P27CBAEC7A8C8WP8", label: "Kept in the browser", description: "" },
			],
			criteria: [
				{ id: "01K0N4W3B7P27CBAEC7A8C8WQ1", label: "New device" },
				{ id: "01K0N4W3B7P27CBAEC7A8C8WQ2", label: "Easy reset" },
			],
		},
	];
	return seeded(which.map(prompt => all.find(item => item.prompt === prompt)!));
}

function card(page: Page, view: string, heading: string): Locator {
	return page.locator(`[data-document-view="${view}"] article[data-plan-sidecar-questionnaire]`)
		.filter({ has: page.locator(".question-title", { hasText: heading }) });
}

async function showDecisions(page: Page) {
	let decisions = page.getByRole("button", { name: /^Decisions/ }).first();
	if (await decisions.getAttribute("aria-pressed") !== "true") await decisions.click();
}

async function shoot(target: Locator | Page, name: string) {
	if (!SHOTS) return;
	await mkdir(SHOTS, { recursive: true });
	// Let a deck's fade and a phone's slide finish before the picture is taken.
	await new Promise(resolve => setTimeout(resolve, 400));
	if ("page" in target) {
		await expect.poll(() =>
			target.evaluate(element => {
				let opacity = 1;
				for (let node: Element | null = element; node; node = node.parentElement) {
					opacity *= Number(getComputedStyle(node).opacity);
				}
				return opacity;
			})
		).toBeGreaterThan(0.99);
	}
	await target.screenshot({ path: `${SHOTS}/${name}.png`, animations: "disabled" });
}

function preview(scope: Locator, label: string): Locator {
	return scope.getByRole("group", { name: `Preview of ${label}`, exact: true });
}

/** An image that loaded, sat inside its frame, and is no taller than the preview allows. */
async function expectPicture(frame: Locator, alt: RegExp, tallest: number) {
	let picture = frame.getByRole("img", { name: alt });
	await expect(picture).toBeVisible();
	await expect.poll(() => picture.evaluate(element => (element as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);
	// Both rectangles are read in one turn: a phone's pages slide while they settle.
	let { inside, height } = await frame.evaluate(element => {
		let box = element.getBoundingClientRect();
		let image = element.querySelector("img")!.getBoundingClientRect();
		return {
			inside: image.left >= box.left - 1 && image.right <= box.right + 1,
			height: image.height,
		};
	});
	expect(inside).toBe(true);
	expect(height).toBeLessThanOrEqual(tallest + 1);
	await expect(frame.getByRole("button", { name: /^View larger: / })).toBeVisible();
}

/** The two options with a picture have a frame each, and the third, with none, has no frame. */
async function expectComparison(scope: Locator, tallest = 256) {
	await expectPicture(
		preview(scope, "Write-through"),
		/^Write-through: the write reaches/,
		tallest,
	);
	await expectPicture(
		preview(scope, "Write-back"),
		/^Write-back: the write is acknowledged/,
		tallest,
	);
	await expect(scope.getByRole("group", { name: /^Preview of / })).toHaveCount(2);
	await expect(scope.getByText("Skip the cache", { exact: true })).toBeVisible();
}

test("an option's picture shows framed under it, opens large without choosing it, and is kept once answered", async ({ baseURL, join, room, seed }) => {
	test.setTimeout(120_000);
	let port = Number(new URL(baseURL!).port);
	let through = await seedChannelImage(port, room, THROUGH, "image/png");
	let back = await seedChannelImage(port, room, BACK, "image/png");
	let fixture = cards(through, back, CACHE);
	await seed(fixture.source, fixture.state);
	let page = await join("ana", DESKTOP);

	let inline = card(page, "plan", CACHE);
	await expect(inline).toBeVisible();
	await expectComparison(inline);
	// Assistive technology names an option by its label and description, not by the picture's words.
	await expect(inline.getByRole("radio", { name: "Write-back Fast, can lose a flush." }))
		.toBeAttached();
	await expect(inline.getByRole("radio", { name: "Skip the cache Simplest." })).toBeAttached();
	await inline.scrollIntoViewIfNeeded();
	await shoot(inline, "decision-option-previews-inline");

	// A click on the picture opens it large, and never picks the option it belongs to.
	let enlarge = preview(inline, "Write-through").getByRole("button", { name: /^View larger: / });
	await enlarge.click();
	let dialog = page.getByRole("dialog", { name: "Image preview" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("img", { name: /^Write-through: the write reaches/ }))
		.toBeVisible();
	await shoot(page, "decision-option-previews-large");
	await expect(inline.getByRole("radio", { name: /^Write-through/ })).not.toBeChecked();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(enlarge).toBeFocused();
	await expect(inline.getByRole("radio", { name: /^Write-through/ })).not.toBeChecked();

	// The keyboard chooses by name: the option is one radio, whatever it shows.
	let backRadio = inline.getByRole("radio", { name: /^Write-back/ });
	await backRadio.focus();
	await page.keyboard.press("Space");
	await expect(backRadio).toBeChecked();
	await inline.getByRole("button", { name: "Save", exact: true }).click();
	// A decided card leaves the document, and a fresh visit lists it answered.
	await expect(card(page, "plan", CACHE)).toHaveCount(0);
	await page.reload();
	await ready(page);
	await showDecisions(page);
	await expect(page.getByRole("button", { name: "1 resolved" })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	// Every option still has its picture, and the chosen one is marked.
	let answered = card(page, "decisions", CACHE);
	await expect(answered).toBeVisible();
	await expect(answered.locator(".question-option[data-selected]")).toContainText("Write-back");
	await expectComparison(answered);
	await shoot(answered, "decision-option-previews-answered");
});

test("Decisions, the decision page and the phone sheet show the same pictures", async ({ baseURL, join, room, seed }) => {
	test.setTimeout(120_000);
	let port = Number(new URL(baseURL!).port);
	let through = await seedChannelImage(port, room, THROUGH, "image/png");
	let back = await seedChannelImage(port, room, BACK, "image/png");
	let fixture = cards(through, back, CACHE);
	await seed(fixture.source, fixture.state);

	let page = await join("ana", DESKTOP);
	await showDecisions(page);
	let listed = card(page, "decisions", CACHE);
	await expect(listed).toBeVisible();
	await expectComparison(listed);
	await shoot(listed, "decision-option-previews-decisions");

	await listed.getByRole("button", { name: "Expand decision" }).click();
	let decisionPage = page.locator("[data-question-page]");
	await expect(decisionPage.getByRole("heading", { level: 1, name: CACHE })).toBeVisible();
	await expectComparison(decisionPage);
	await shoot(page, "decision-option-previews-page");

	let phone = await join("ben", PHONE);
	await showDecisions(phone);
	let sheet = card(phone, "decisions", CACHE).filter({ visible: true });
	// The Decisions page slides in from the side; wait until it has arrived.
	await expect(sheet.getByRole("heading", { name: CACHE })).toBeInViewport();
	// A picture gets less of a small screen, and nothing widens it.
	await expectComparison(sheet, 192);
	expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	let frame = (await preview(sheet, "Write-back").boundingBox())!;
	expect(frame.width).toBeLessThanOrEqual(390);
	await preview(sheet, "Write-back").getByRole("button", { name: /^View larger: / }).click();
	await expect(phone.getByRole("dialog", { name: "Image preview" })).toBeVisible();
	await shoot(phone, "decision-option-previews-phone-large");
	await phone.keyboard.press("Escape");
	await expect(phone.getByRole("dialog", { name: "Image preview" })).toHaveCount(0);
	await sheet.scrollIntoViewIfNeeded();
	await shoot(phone, "decision-option-previews-phone");
});

test("a Mermaid diagram and a table are an option's visual too, on a card and on a phone", async ({ join, seed }) => {
	test.setTimeout(120_000);
	let fixture = cards("/images/unused.png", "/images/unused.png", RELEASE);
	await seed(fixture.source, fixture.state);

	let page = await join("ana", DESKTOP);
	await showDecisions(page);
	let listed = card(page, "decisions", RELEASE);
	await expect(listed).toBeVisible();
	let one = preview(listed, "One queue");
	let teams = preview(listed, "A queue per team");
	for (let frame of [one, teams]) {
		await expect(frame.locator('[data-question-diagram="drawn"] .plan-diagram svg')).toBeVisible({
			timeout: 15_000,
		});
		await expect(frame).not.toContainText("flowchart LR");
	}
	// The diagram sits inside the option's own column, and the table scrolls inside the frame.
	let box = (await teams.boundingBox())!;
	let svg = (await teams.locator("svg").first().boundingBox())!;
	expect(svg.x + svg.width).toBeLessThanOrEqual(box.x + box.width + 1);
	await expect(teams.getByRole("columnheader")).toHaveText(["Cost", "Risk"]);
	await expect(teams.getByRole("cell")).toHaveText(["Higher", "Teams drift"]);
	await expect(one.getByRole("table")).toHaveCount(0);
	await shoot(listed, "decision-option-previews-diagrams");

	let phone = await join("ben", PHONE);
	await showDecisions(phone);
	let sheet = card(phone, "decisions", RELEASE).filter({ visible: true });
	await expect(sheet.getByRole("heading", { name: RELEASE })).toBeInViewport();
	await expect(sheet.locator('[data-question-diagram="drawn"] svg').first()).toBeVisible({
		timeout: 15_000,
	});
	expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	let narrow = (await preview(sheet, "A queue per team").boundingBox())!;
	expect(narrow.width).toBeLessThanOrEqual(390);
	await sheet.scrollIntoViewIfNeeded();
	await shoot(phone, "decision-option-previews-diagrams-phone");
});

test("a card whose preview was joined into its description looks as it did, and a criteria row shows a thumbnail", async ({ baseURL, join, room, seed }) => {
	test.setTimeout(120_000);
	let port = Number(new URL(baseURL!).port);
	let through = await seedChannelImage(port, room, THROUGH, "image/png");
	let back = await seedChannelImage(port, room, BACK, "image/png");
	let fixture = cards(through, back, LEGACY, SCORED);
	await seed(fixture.source, fixture.state);

	let page = await join("ana", DESKTOP);
	await showDecisions(page);
	let legacy = card(page, "decisions", LEGACY);
	await expect(legacy).toBeVisible();
	await expect(legacy.locator("[data-question-preview]")).toHaveCount(0);
	// The sketch is the description's own Markdown, as before.
	await expect(legacy.locator(".question-desc pre code")).toContainText("create table sessions");
	await expect(legacy.getByRole("radio", { name: /^Postgres/ })).toBeAttached();

	// Beside criteria an option's picture is a small thumbnail, never a layout of its own.
	await page.locator('[data-document-view="decisions"]').getByRole("button", {
		name: "Next decision",
	}).click();
	let scored = card(page, "decisions", SCORED);
	await expect(scored).toBeVisible();
	let thumbnail = preview(scored, "Stored with the account");
	await expect(thumbnail).toBeVisible();
	await expectPicture(thumbnail, /^Write-through: stored with the account/, 64);
	await shoot(scored, "decision-option-previews-criteria");
});
