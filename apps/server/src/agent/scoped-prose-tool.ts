import { jsonSchema, tool } from "ai";
import { cardToolContext } from "./card-tool-context";
import { answer, cardToolSchema } from "./scoped-tool-result";
import { write } from "./decision-prose";
import { runJobTool } from "./job-scope";

export function createProseTools() {
	return {
		write_decision_prose: tool({
			description: "Background job only. Write one grounded paragraph for a saved conversation "
				+ "decision. At most 600 characters; inline Markdown is allowed. Re-decisions replace the "
				+ "existing paragraph.",
			inputSchema: jsonSchema<Record<string, unknown>>({
				type: "object",
				properties: {
					revision: { type: "integer", minimum: 0 },
					id: { type: "string" },
					text: { type: "string", minLength: 1, maxLength: 600 },
				},
				required: ["revision", "id", "text"],
				additionalProperties: false,
			}),
			contextSchema: cardToolSchema,
			execute: (raw, { context: { room } }) => {
				let context = cardToolContext(room);
				return answer("write_decision_prose", () => {
					let turn = context.plan.chat.turn;
					return runJobTool(
						context.plan.chat,
						"write_decision_prose",
						job => write(context, job, turn, raw),
					);
				});
			},
		}),
	};
}
