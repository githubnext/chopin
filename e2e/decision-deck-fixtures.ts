import { storedQuestion } from "../apps/server/src/testing/plan";
import { expect } from "./room";

import type { SeedState } from "../apps/server/src/testing/plan";
import type { Page } from "@playwright/test";

/** The digest of a paragraph reading exactly `Anchored paragraph.` */
export const ANCHORED_DIGEST =
	"sha256:3ccc3e648811df8180799f8b012c6934bcf44a306f5eb8b8c9d2676b0493ccf4";
const HEADERS = ["Storage", "Scope", "Rollout", "Naming"];
const PROMPTS = [
	"Where should room state live?",
	"What belongs in the first cut?",
	"How should we deploy?",
	"What should we call it?",
];

/** Seed `count` open Planner cards with records, next to each other unless separated. */
export function deckSeed(
	prose: { before?: string; after?: string },
	count: number,
	options: { separated?: boolean; optionCounts?: number[]; anchored?: number[] } = {},
): { source: string; state: SeedState; prompts: string[]; ids: string[] } {
	let ids: string[] = [];
	let cards: string[] = [];
	let questions: unknown[] = [];
	let openQuestions: unknown[] = [];
	for (let index = 0; index < count; index++) {
		let widget = `01K0N4TR8K7JGM4R1J7PW4R8Y${index}`;
		let question = `01K0N4V4E7Y6P4MJ5WD8XZF3B${index}`;
		let extra = (options.optionCounts?.[index] ?? 1) - 1;
		let choices = Array.from({ length: extra + 1 }, (_, at) => ({
			id: `01K0N4W3B7P27CBAEC7A8C8W${"EFGHJKMNPQRS"[at]}${index}`,
			label: at === 0 ? `Option ${index + 1}` : `Extra option ${at}`,
			description: at === 0 ? "" : "A longer option that adds height to the card.",
		}));
		let definition = {
			questions: [{
				id: question,
				header: HEADERS[index]!,
				question: PROMPTS[index]!,
				multiple: false,
				options: choices,
			}],
		};
		ids.push(widget);
		cards.push(`<Questionnaire id="${widget}">
<Question id="${question}" header="${HEADERS[index]}" prompt="${PROMPTS[index]}" multiple="false">
${choices.map(choice => `<Option id="${choice.id}" label="${choice.label}" />`).join("\n")}
</Question>
</Questionnaire>`);
		questions.push({
			id: widget,
			definition,
			status: "open",
			origin: "planner",
			history: [],
			optionOrigins: {},
			editors: [],
			...(options.anchored?.includes(index)
				? {
					anchors: {
						widget,
						questions: {
							[question]: {
								anchors: [{ epoch: "stale", position: "", digest: ANCHORED_DIGEST }],
								pending: false,
							},
						},
					},
				}
				: {}),
		});
		openQuestions.push({
			definition,
			id: widget,
			model: storedQuestion(definition),
			revision: 0,
			widget,
		});
	}
	let joiner = options.separated ? "\n\nProse between decisions.\n\n" : "\n\n";
	let source = [prose.before, cards.join(joiner), prose.after].filter(Boolean).join("\n\n") + "\n";
	return {
		source,
		state: { revision: 1, questions, openQuestions },
		prompts: PROMPTS.slice(0, count),
		ids,
	};
}

/** The desktop Decisions deck slot holding a decision, on top or waiting behind. */
export function deckSlot(page: Page, prompt: string, view: "decisions" | "plan" = "decisions") {
	return page.locator(`[data-document-view="${view}"] [data-deck-slot]`).filter({
		hasText: prompt,
	});
}

/** Page through a decision deck until a decision is on top and answerable. */
export async function bringForward(
	page: Page,
	prompt: string,
	view: "decisions" | "plan" = "decisions",
) {
	let slot = deckSlot(page, prompt, view);
	let deck = page.locator(`[data-document-view="${view}"] [data-deck]`);
	let next = deck.getByRole("button", { name: "Next decision" });
	let previous = deck.getByRole("button", { name: "Previous decision" });
	// The deck stops at its ends, so turn back once the last card is reached.
	await expect(async () => {
		if (await slot.getAttribute("data-deck-top") === null) {
			await (await next.isDisabled() ? previous : next).click();
		}
		await expect(slot).toHaveAttribute("data-deck-top", "", { timeout: 1_000 });
	}).toPass();
}

/** Wait for a prepared card, then open Document for tests that exercise its inline projection. */
export async function openDecisionDocument(page: Page) {
	await expect(
		page.locator('[data-document-view="plan"] article[data-plan-sidecar-questionnaire]').first(),
	)
		.toBeAttached();
	await page.getByRole("group", { name: "Document view" })
		.getByRole("button", { name: /^Document(?:,|$)/ }).click();
}
