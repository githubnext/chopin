import { storedQuestion } from "../apps/server/src/testing/plan";

import type { SeedState } from "../apps/server/src/testing/plan";

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
	options: { separated?: boolean } = {},
): { source: string; state: SeedState; prompts: string[]; ids: string[] } {
	let ids: string[] = [];
	let cards: string[] = [];
	let questions: unknown[] = [];
	let openQuestions: unknown[] = [];
	for (let index = 0; index < count; index++) {
		let widget = `01K0N4TR8K7JGM4R1J7PW4R8Y${index}`;
		let question = `01K0N4V4E7Y6P4MJ5WD8XZF3B${index}`;
		let option = `01K0N4W3B7P27CBAEC7A8C8WE${index}`;
		let definition = {
			questions: [{
				id: question,
				header: HEADERS[index]!,
				question: PROMPTS[index]!,
				multiple: false,
				options: [{ id: option, label: `Option ${index + 1}`, description: "" }],
			}],
		};
		ids.push(widget);
		cards.push(`<Questionnaire id="${widget}">
<Question id="${question}" header="${HEADERS[index]}" prompt="${PROMPTS[index]}" multiple="false">
<Option id="${option}" label="Option ${index + 1}" />
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
