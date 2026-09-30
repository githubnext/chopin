import { jsonSchema, tool } from "ai";
import { cardToolContext } from "./card-tool-context";
import { answer, cardToolSchema } from "./scoped-tool-result";
import { reviseOpenDecision } from "./revise-open-decision";

export function createDirectTools() {
	return {
		revise_open_decision: tool({
			description: "In a direct member-requested Chat turn, perform exactly one action "
				+ "on one existing open decision explicitly named in that action's clause: "
				+ "either reword its question or add evidence-backed options with rationales. "
				+ "Use separate calls for separate actions, reading the revision again between calls. "
				+ "Never create a card, rename an existing option, or choose an answer.",
			inputSchema: jsonSchema<Record<string, unknown>>({
				type: "object",
				properties: {
					revision: { type: "integer", minimum: 0 },
					id: { type: "string" },
					title: {
						type: "string",
						minLength: 1,
						maxLength: 80,
						description: "Only for a question retitle call; omit add_options.",
					},
					add_options: {
						type: "array",
						description: "Only for an option addition call; omit title.",
						minItems: 1,
						maxItems: 10,
						items: {
							type: "object",
							properties: {
								label: { type: "string", minLength: 1, maxLength: 200 },
								rationale: { type: "string", minLength: 1, maxLength: 300 },
							},
							required: ["label", "rationale"],
							additionalProperties: false,
						},
					},
				},
				required: ["revision", "id"],
				additionalProperties: false,
			}),
			contextSchema: cardToolSchema,
			execute: (raw, { context: { room } }) => {
				let context = cardToolContext(room);

				let turn = context.plan.chat.turn;
				return answer("revise_open_decision", () => reviseOpenDecision(context, turn, raw));
			},
		}),
	};
}
