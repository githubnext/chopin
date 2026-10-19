/**
 * Decision cards read their question as Markdown on every surface: the first line is the
 * heading and the rest is the body, with lists, line breaks, a Mermaid diagram drawn by the
 * document's own renderer and only the document's own images.
 */
import { readFileSync } from "node:fs";

import { storedQuestion } from "../apps/server/src/testing/plan";
import { seedChannelImage } from "./database";
import { expect, ready, test } from "./room";

import type { SeedState } from "../apps/server/src/testing/plan";
import type { Locator, Page } from "@playwright/test";

const PICTURE = readFileSync(new URL("./fixtures/the-cap.webp", import.meta.url));
const PHONE = { hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } };
const DESKTOP = { viewport: { width: 1440, height: 1000 } };
const HEADING = "Confirm the rollout plan";
const PLAIN = "Use *nix paths, snake_case_names or 2 * 3 retries?";
const REMOTE = "https://images.example.com/mockup.png";
const TALL_HEADING = "Which release steps stay?";
const TALL = [
	TALL_HEADING,
	"",
	"```mermaid",
	"flowchart TD",
	...Array.from(
		{ length: 11 },
		(_, index) => `S${index}[Step ${index + 1}] --> S${index + 1}[Step ${index + 2}]`,
	),
	"```",
].join("\n");

function prompt(image: string): string {
	return [
		HEADING,
		"",
		"(1) Storage stays in PostgreSQL",
		"(2) The pilot starts with one team",
		"",
		"- **Before:** one shared queue",
		"- **After:** a queue per team",
		"",
		"```mermaid",
		"flowchart LR",
		"A[Shared queue] --> B[Queue per team]",
		"```",
		"",
		`![The refund cap, drawn](${image})`,
		"",
		`![Remote mockup](${REMOTE})`,
	].join("\n");
}

/** One Markdown decision and one plain one-line decision, open, as a Planner records them. */
function cards(image: string): { source: string; state: SeedState } {
	let items = [
		{
			widget: "01K0N4TR8K7JGM4R1J7PW4R8M0",
			question: "01K0N4V4E7Y6P4MJ5WD8XZF3M0",
			header: "Rollout",
			prompt: prompt(image),
			options: [
				{
					id: "01K0N4W3B7P27CBAEC7A8C8WM0",
					label: "Confirm **all**",
					description: "Keeps:\n(1) storage\n(2) pilot",
				},
				{ id: "01K0N4W3B7P27CBAEC7A8C8WM1", label: "Change some", description: "" },
			],
		},
		{
			widget: "01K0N4TR8K7JGM4R1J7PW4R8M2",
			question: "01K0N4V4E7Y6P4MJ5WD8XZF3M2",
			header: "Steps",
			prompt: TALL,
			options: [
				{ id: "01K0N4W3B7P27CBAEC7A8C8WM4", label: "Keep every step", description: "" },
				{ id: "01K0N4W3B7P27CBAEC7A8C8WM5", label: "Merge some", description: "" },
			],
		},
		{
			widget: "01K0N4TR8K7JGM4R1J7PW4R8M1",
			question: "01K0N4V4E7Y6P4MJ5WD8XZF3M1",
			header: "Paths",
			prompt: PLAIN,
			options: [
				{ id: "01K0N4W3B7P27CBAEC7A8C8WM2", label: "Keep them", description: "" },
				{ id: "01K0N4W3B7P27CBAEC7A8C8WM3", label: "Rename", description: "" },
			],
		},
	];
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
			`<Option id="${option.id}" label="${option.label}"${
				option.description ? ` description="${option.description}"` : ""
			} />`
		);
		return `<Questionnaire id="${item.widget}">
<Question id="${item.question}" header="${item.header}" prompt="${item.prompt}" multiple="false">
${options.join("\n")}
</Question>
</Questionnaire>`;
	});
	return {
		source: `# Rollout\n\nThe pilot plan.\n\n${blocks.join("\n\n")}\n`,
		state: { revision: 1, questions, openQuestions },
	};
}

function card(page: Page, view: string, heading: string): Locator {
	return page.locator(`[data-document-view="${view}"] article[data-plan-sidecar-questionnaire]`)
		.filter({ has: page.locator(".question-title", { hasText: heading }) });
}

async function showDecisions(page: Page) {
	let decisions = page.getByRole("button", { name: /^Decisions/ }).first();
	if (await decisions.getAttribute("aria-pressed") !== "true") await decisions.click();
}

/** What a reader sees of the card's Markdown, with the drawing's generated IDs left out. */
function reading(scope: Locator) {
	return scope.locator(".question-body").first().evaluate(body => {
		let copy = body.cloneNode(true) as HTMLElement;
		for (let diagram of copy.querySelectorAll(".question-diagram")) diagram.replaceChildren();
		return copy.innerHTML;
	});
}

async function expectMarkdown(scope: Locator, image: string) {
	let body = scope.locator(".question-body");
	await expect(scope.locator(".question-title")).toHaveText(HEADING);
	await expect(body.locator("ul > li")).toHaveText([
		"Before: one shared queue",
		"After: a queue per team",
	]);
	await expect(body.locator("ul strong").first()).toHaveText("Before:");
	// A typed line break stays one, so each numbered line keeps its own line.
	await expect(body.locator("p").first()).toContainText("(1) Storage stays in PostgreSQL");
	expect(await body.locator("p").first().locator("br").count()).toBe(1);
	let lines = await body.locator("p").first().evaluate(paragraph =>
		Math.round(
			paragraph.getBoundingClientRect().height / parseFloat(getComputedStyle(paragraph).lineHeight),
		)
	);
	expect(lines).toBe(2);
	// The document's Mermaid renderer drew the fence, in a bounded frame.
	await expect(body.locator('[data-question-diagram="drawn"] .plan-diagram svg')).toBeVisible({
		timeout: 15_000,
	});
	await expect(body).not.toContainText("flowchart LR");
	await expect(body.getByRole("button", { name: "Show whole diagram" })).toHaveCount(0);
	// Only the document's own upload loads; the remote picture is its alternative text.
	let own = body.getByRole("img", { name: "The refund cap, drawn" });
	await expect(own).toHaveAttribute("src", new RegExp(`^${image}\\?document=`));
	await expect.poll(() => own.evaluate(element => (element as HTMLImageElement).naturalWidth))
		.toBeGreaterThan(0);
	await expect(body.locator(`img[src*="images.example.com"]`)).toHaveCount(0);
	await expect(body.locator('[data-question-image="refused"]')).toHaveText("Remote mockup");
	// An option's description is Markdown too; its label is one inline phrase.
	await expect(scope.locator(".question-label strong")).toHaveText("all");
	await expect(scope.locator("div.question-desc br")).toHaveCount(2);
}

test("a Markdown decision reads the same inline in the document and in Decisions", async ({ baseURL, join, room, seed }) => {
	test.setTimeout(90_000);
	let image = await seedChannelImage(Number(new URL(baseURL!).port), room, PICTURE, "image/webp");
	let fixture = cards(image);
	await seed(fixture.source, fixture.state);
	let remote: string[] = [];
	let page = await join("ana", DESKTOP);
	page.on("request", request => {
		if (request.url().startsWith("https://images.example.com")) remote.push(request.url());
	});

	let inline = card(page, "plan", HEADING);
	await expect(inline).toBeVisible();
	await expectMarkdown(inline, image);
	// A plain one-line question is the heading it always was, with no surprise formatting.
	let plain = card(page, "plan", PLAIN).locator(".question-title");
	await expect(plain).toHaveText(PLAIN);
	await expect(plain.locator("em, strong, ol, ul, li")).toHaveCount(0);
	await inline.scrollIntoViewIfNeeded();
	await test.info().attach("decision-markdown-inline", {
		body: await inline.screenshot({ animations: "disabled" }),
		contentType: "image/png",
	});

	// A tall drawing is held to a bounded height until the reader asks for all of it.
	let tall = card(page, "plan", TALL_HEADING);
	await page.locator('[data-document-view="plan"]').getByRole("button", { name: "Next decision" })
		.click();
	let frame = tall.locator(".question-diagram-frame");
	await expect(tall.locator('[data-question-diagram="drawn"] svg')).toBeVisible({
		timeout: 15_000,
	});
	let bounded = (await frame.boundingBox())!.height;
	expect(bounded).toBeLessThanOrEqual(18 * 16 + 1);
	let whole = tall.getByRole("button", { name: "Show whole diagram" });
	await expect(whole).toHaveAttribute("aria-expanded", "false");
	await test.info().attach("decision-markdown-tall-diagram", {
		body: await tall.screenshot({ animations: "disabled" }),
		contentType: "image/png",
	});
	await whole.click();
	await expect(tall.getByRole("button", { name: "Show less" })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	expect((await frame.boundingBox())!.height).toBeGreaterThan(bounded + 100);

	await showDecisions(page);
	let listed = card(page, "decisions", HEADING);
	await expect(listed).toBeVisible();
	await expectMarkdown(listed, image);
	expect(await reading(listed)).toBe(await reading(inline));
	await test.info().attach("decision-markdown-decisions", {
		body: await listed.screenshot({ animations: "disabled" }),
		contentType: "image/png",
	});

	// Answered, the card keeps its body, folded behind a disclosure because it is long.
	await listed.getByText("Change some", { exact: true }).click();
	await listed.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("status").filter({ hasText: /^Decided\./ })).toBeAttached();
	// The deck keeps a card it settled until the reader moves on; a fresh visit lists it resolved.
	await page.reload();
	await ready(page);
	await showDecisions(page);
	await expect(page.getByRole("button", { name: "1 resolved" })).toHaveAttribute(
		"aria-expanded",
		"true",
	);
	let answered = card(page, "decisions", HEADING);
	await expect(answered.locator(".question-option[data-selected]")).toContainText("Change some");
	let more = answered.getByRole("button", { name: "Show details" });
	await expect(more).toHaveAttribute("aria-expanded", "false");
	await expect(answered.locator(".question-body ul")).toBeHidden();
	await more.click();
	await expect(answered.locator(".question-body ul > li")).toHaveCount(2);
	await expect(answered.locator('[data-question-diagram="drawn"] svg')).toBeVisible();
	await test.info().attach("decision-markdown-answered", {
		body: await answered.screenshot({ animations: "disabled" }),
		contentType: "image/png",
	});
	expect(remote).toEqual([]);
});

test("phone: the Decisions sheet reads the Markdown decision the same way", async ({ baseURL, join, room, seed }) => {
	test.setTimeout(90_000);
	let image = await seedChannelImage(Number(new URL(baseURL!).port), room, PICTURE, "image/webp");
	let fixture = cards(image);
	await seed(fixture.source, fixture.state);
	let page = await join("ana", PHONE);
	// The document keeps a one-line chip, whose name is the heading alone.
	await expect(page.getByRole("button", { name: `Decision: ${HEADING}, answer in Decisions` }))
		.toBeVisible();
	await showDecisions(page);
	let listed = card(page, "decisions", HEADING).filter({ visible: true });
	await expectMarkdown(listed, image);
	let box = (await listed.locator(".question-body").boundingBox())!;
	expect(box.width).toBeLessThanOrEqual(390);
	await test.info().attach("decision-markdown-phone", {
		body: await page.screenshot({ animations: "disabled" }),
		contentType: "image/png",
	});
});
