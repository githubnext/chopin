import { jsonSchema, tool } from "ai";
import { cardToolContext } from "./card-tool-context";
import { answer, cardToolSchema } from "./scoped-tool-result";
import { refineDecision } from "./refine-tool";
import { runJobTool } from "./job-scope";

export function createRefineTools() {
	return {
		refine_decision: tool({
			description: "Background job only. Improve one open decision: a refine job may reword its "
				+ "question and place it after related prose; a suggest job may only add reasoned "
				+ "options. Adding no option is valid when the evidence supports none.",
			inputSchema: jsonSchema<Record<string, unknown>>({
				type: "object",
				properties: {
					revision: { type: "integer", minimum: 0 },
					id: { type: "string" },
					title: { type: "string", minLength: 1, maxLength: 80 },
					add_options: {
						type: "array",
						maxItems: 10,
						items: {
							type: "object",
							properties: {
								label: { type: "string", minLength: 1, maxLength: 200 },
								rationale: { type: "string", minLength: 1, maxLength: 300 },
								source: {
									type: "object",
									properties: {
										messageId: { type: "string" },
										author: {
											type: "object",
											properties: {
												kind: { type: "string", enum: ["member", "agent"] },
												handle: { type: "string" },
											},
											required: ["kind"],
											additionalProperties: false,
										},
										quote: { type: "string" },
										start: { type: "integer", minimum: 0 },
										end: { type: "integer", minimum: 1 },
										role: { type: "string", enum: ["option", "question"] },
									},
									required: ["messageId", "author", "quote", "start", "end", "role"],
									additionalProperties: false,
								},
							},
							required: ["label", "rationale"],
							additionalProperties: false,
						},
					},
					place_after: {
						type: "object",
						properties: {
							index: { type: "integer", minimum: 0 },
							digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
						},
						required: ["index", "digest"],
						additionalProperties: false,
					},
				},
				required: ["revision", "id"],
				additionalProperties: false,
			}),
			contextSchema: cardToolSchema,
			execute: (raw, { context: { room } }) => {
				let context = cardToolContext(room);
				return answer("refine_decision", () => {
					let turn = context.plan.chat.turn;
					return runJobTool(
						context.plan.chat,
						"refine_decision",
						job => refineDecision(context, job, turn, raw),
					);
				});
			},
		}),
	};
}
